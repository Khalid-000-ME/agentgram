// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title AgentLineRegistry
 * @notice On-chain identity, key directory, handles, conversations, groups and channels
 *         for AgentLine ("WhatsApp for agents").
 *
 * Design notes (see PRD §5):
 *  - Only small, rarely-written state lives here. Message ciphertext goes to Hedera
 *    Consensus Service topics; this contract stores the mappings that let any agent
 *    re-derive a conversation without trusting the gateway.
 *  - Conversation ids are derived off-chain from both agent ids (keccak over the sorted
 *    pair, plus a salt in sealed mode), so each party recomputes the id offline. Open
 *    conversations publish their participants; sealed ones publish only the id, keeping
 *    the social graph private.
 *  - Writes are relayed: the gateway submits on an agent's behalf but must present the
 *    agent's owner address, and only the owner (or an authorised relayer) can mutate an
 *    agent's record. Agents may also call directly and pay their own gas.
 */
contract AgentLineRegistry {
    /* ------------------------------------------------------------------ types */

    enum Status { NONE, ACTIVE, SUSPENDED, DELETED }

    uint16 internal constant FLAG_ACCEPTS_UNKNOWN_DMS = 1 << 0;
    uint16 internal constant FLAG_BUSINESS            = 1 << 1;
    uint16 internal constant FLAG_VERIFIED            = 1 << 2;
    uint16 internal constant FLAG_RECEIPTS_OFF        = 1 << 3;

    struct Agent {
        bytes32 agentId;
        address owner;
        bytes32 ed25519IdentityKey;
        bytes32 x25519IdentityKey;
        uint64  inboxTopic;      // HCS topic num (shard.realm implied 0.0)
        uint64  profileTopic;    // HCS-11 profile topic
        uint32  keyEpoch;
        uint8   status;
        uint16  flags;
        uint8   dmPolicy;        // 0 everyone, 1 contacts, 2 paid_only, 3 allowlist
        uint64  registeredAt;
    }

    struct ExternalLink { bytes32 kind; string value; }

    struct Conversation {
        uint64 topic;
        uint8  kind;   // 0 dm, 1 group, 2 channel
        uint8  mode;   // 0 open, 1 sealed
        uint64 createdAt;
        bytes16 tag;   // blinded routing tag for sharded sealed topics
    }

    struct Group {
        bytes32 groupId;
        bytes32 membersRoot;
        uint64  topic;
        uint32  epoch;
        uint32  memberCount;
        address owner;
        bytes32 creator;
        uint16  settings;   // bit0 onlyAdminsSend, bit1 adminsAddOnly, bit2 sealedMembership
        uint64  createdAt;
    }

    struct Channel {
        bytes32 channelId;
        bytes32 owner;
        uint64  topic;
        uint64  followers;
        bool    encrypted;
        uint64  createdAt;
    }

    struct KeyBundlePointer {
        bytes32 bundleId;
        bytes32 signedPrekeyHash;
        uint32  keyEpoch;
        uint32  oneTimeRemaining;
        uint64  updatedAt;
    }

    /* ------------------------------------------------------------------ storage */

    address public admin;
    mapping(address => bool) public relayer;

    mapping(bytes32 => Agent)   public agents;
    mapping(address => bytes32) public agentByOwner;
    mapping(bytes32 => bytes32) public agentByHandleHash;   // keccak(handle) -> agentId
    mapping(bytes32 => bytes32) public handleOfAgent;
    mapping(bytes32 => uint64)  public handleExpiry;
    mapping(bytes32 => bytes32[]) public devicesOf;
    mapping(bytes32 => ExternalLink[]) internal _linksOf;
    mapping(bytes32 => KeyBundlePointer) public keyBundleOf;   // deviceId -> pointer

    mapping(bytes32 => Conversation) public conversations;
    mapping(bytes32 => bytes32[])    internal _convsOfAgent;   // open mode only

    mapping(bytes32 => Group) public groups;
    mapping(bytes32 => mapping(bytes32 => bool)) public isGroupMember;  // gid -> agentId
    mapping(bytes32 => mapping(bytes32 => bool)) public isGroupAdmin;
    mapping(bytes32 => bytes32) public groupOfInvite;   // keccak(inviteCode) -> gid
    mapping(bytes32 => uint64)  public inviteExpiry;
    mapping(bytes32 => uint32)  public inviteUsesLeft;

    mapping(bytes32 => Channel) public channels;
    mapping(bytes32 => mapping(bytes32 => bool)) public isFollower;

    /* ------------------------------------------------------------------ events */

    event AgentRegistered(bytes32 indexed agentId, address indexed owner, uint64 inboxTopic, uint64 profileTopic);
    event AgentUpdated(bytes32 indexed agentId, uint8 dmPolicy, uint16 flags);
    event AgentTombstoned(bytes32 indexed agentId);
    event KeysRotated(bytes32 indexed agentId, uint32 epoch, bytes32 ed25519IdentityKey, bytes32 x25519IdentityKey);
    event HandleClaimed(bytes32 indexed agentId, bytes32 indexed handleHash, uint64 expiry);
    event DeviceAdded(bytes32 indexed agentId, bytes32 indexed deviceId);
    event DeviceRemoved(bytes32 indexed agentId, bytes32 indexed deviceId);
    event PrekeysPublished(bytes32 indexed deviceId, bytes32 bundleId, uint32 oneTimeRemaining);
    event ExternalLinkAdded(bytes32 indexed agentId, bytes32 kind, string value);

    event ConversationOpened(bytes32 indexed cid, bytes32 indexed a, bytes32 indexed b, uint64 topic, uint8 mode);
    event GroupCreated(bytes32 indexed groupId, bytes32 indexed creator, uint64 topic, bytes32 membersRoot);
    event GroupMembershipChanged(bytes32 indexed groupId, uint32 epoch, bytes32 membersRoot, uint32 memberCount);
    event GroupSettingsChanged(bytes32 indexed groupId, uint16 settings);
    event InviteCreated(bytes32 indexed groupId, bytes32 indexed inviteHash, uint64 expiry, uint32 maxUses);
    event InviteRedeemed(bytes32 indexed groupId, bytes32 indexed inviteHash, bytes32 agentId);
    event ChannelCreated(bytes32 indexed channelId, bytes32 indexed owner, uint64 topic, bool encrypted);
    event ChannelFollowed(bytes32 indexed channelId, bytes32 indexed agentId, bool following);
    event RelayerSet(address indexed relayer, bool allowed);

    /* ------------------------------------------------------------------ errors */

    error NotAuthorized();
    error AlreadyExists();
    error UnknownAgent();
    error HandleTaken();
    error InviteInvalid();

    constructor() {
        admin = msg.sender;
        relayer[msg.sender] = true;
        emit RelayerSet(msg.sender, true);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    /// Either the agent's owner calling directly, or a whitelisted relayer acting for it.
    modifier onlyAgentController(bytes32 agentId) {
        Agent storage a = agents[agentId];
        if (a.status == uint8(Status.NONE)) revert UnknownAgent();
        if (msg.sender != a.owner && !relayer[msg.sender]) revert NotAuthorized();
        _;
    }

    function setRelayer(address who, bool allowed) external onlyAdmin {
        relayer[who] = allowed;
        emit RelayerSet(who, allowed);
    }

    function setAdmin(address who) external onlyAdmin { admin = who; }

    /* ------------------------------------------------------------------ identity */

    function registerAgent(
        bytes32 agentId,
        address owner,
        bytes32 ed25519IdentityKey,
        bytes32 x25519IdentityKey,
        uint64  inboxTopic,
        uint64  profileTopic,
        uint8   dmPolicy,
        uint16  flags,
        bytes32 handleHash
    ) external {
        if (msg.sender != owner && !relayer[msg.sender]) revert NotAuthorized();
        if (agents[agentId].status != uint8(Status.NONE)) revert AlreadyExists();

        agents[agentId] = Agent({
            agentId: agentId,
            owner: owner,
            ed25519IdentityKey: ed25519IdentityKey,
            x25519IdentityKey: x25519IdentityKey,
            inboxTopic: inboxTopic,
            profileTopic: profileTopic,
            keyEpoch: 1,
            status: uint8(Status.ACTIVE),
            flags: flags,
            dmPolicy: dmPolicy,
            registeredAt: uint64(block.timestamp)
        });
        if (agentByOwner[owner] == bytes32(0)) agentByOwner[owner] = agentId;
        emit AgentRegistered(agentId, owner, inboxTopic, profileTopic);

        if (handleHash != bytes32(0)) _claimHandle(agentId, handleHash, 365 days);
    }

    function updateAgent(bytes32 agentId, uint8 dmPolicy, uint16 flags)
        external onlyAgentController(agentId)
    {
        Agent storage a = agents[agentId];
        a.dmPolicy = dmPolicy;
        a.flags = flags;
        emit AgentUpdated(agentId, dmPolicy, flags);
    }

    function setTopics(bytes32 agentId, uint64 inboxTopic, uint64 profileTopic)
        external onlyAgentController(agentId)
    {
        Agent storage a = agents[agentId];
        if (inboxTopic != 0) a.inboxTopic = inboxTopic;
        if (profileTopic != 0) a.profileTopic = profileTopic;
    }

    /**
     * @notice Rotate identity keys. Requires the owner ("guardian") address, never a
     *         relayer alone, because key substitution is the core MITM risk (PRD §7.7).
     */
    function rotateKeys(bytes32 agentId, bytes32 newEd25519, bytes32 newX25519) external {
        Agent storage a = agents[agentId];
        if (a.status == uint8(Status.NONE)) revert UnknownAgent();
        if (msg.sender != a.owner) revert NotAuthorized();
        a.ed25519IdentityKey = newEd25519;
        a.x25519IdentityKey = newX25519;
        a.keyEpoch += 1;
        emit KeysRotated(agentId, a.keyEpoch, newEd25519, newX25519);
    }

    /// Tombstone: the ciphertext on HCS stays, but keys are shredded off-chain (PRD D6).
    function tombstoneAgent(bytes32 agentId) external onlyAgentController(agentId) {
        Agent storage a = agents[agentId];
        a.status = uint8(Status.DELETED);
        bytes32 h = handleOfAgent[agentId];
        if (h != bytes32(0)) {
            delete agentByHandleHash[h];
            delete handleOfAgent[agentId];
            delete handleExpiry[h];
        }
        emit AgentTombstoned(agentId);
    }

    function claimHandle(bytes32 agentId, bytes32 handleHash, uint64 duration)
        external onlyAgentController(agentId)
    {
        _claimHandle(agentId, handleHash, duration == 0 ? 365 days : duration);
    }

    function _claimHandle(bytes32 agentId, bytes32 handleHash, uint64 duration) internal {
        bytes32 current = agentByHandleHash[handleHash];
        if (current != bytes32(0) && current != agentId && handleExpiry[handleHash] > block.timestamp) {
            revert HandleTaken();
        }
        bytes32 previous = handleOfAgent[agentId];
        if (previous != bytes32(0) && previous != handleHash) {
            delete agentByHandleHash[previous];
            delete handleExpiry[previous];
        }
        agentByHandleHash[handleHash] = agentId;
        handleOfAgent[agentId] = handleHash;
        uint64 base = handleExpiry[handleHash] > block.timestamp ? handleExpiry[handleHash] : uint64(block.timestamp);
        handleExpiry[handleHash] = base + duration;
        emit HandleClaimed(agentId, handleHash, handleExpiry[handleHash]);
    }

    function addDevice(bytes32 agentId, bytes32 deviceId) external onlyAgentController(agentId) {
        bytes32[] storage list = devicesOf[agentId];
        for (uint256 i; i < list.length; ++i) if (list[i] == deviceId) return;
        list.push(deviceId);
        emit DeviceAdded(agentId, deviceId);
    }

    function removeDevice(bytes32 agentId, bytes32 deviceId) external onlyAgentController(agentId) {
        bytes32[] storage list = devicesOf[agentId];
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == deviceId) {
                list[i] = list[list.length - 1];
                list.pop();
                delete keyBundleOf[deviceId];
                emit DeviceRemoved(agentId, deviceId);
                return;
            }
        }
    }

    /// Commit to the published prekey bundle so clients can detect a substituted bundle.
    function publishPrekeys(
        bytes32 agentId,
        bytes32 deviceId,
        bytes32 bundleId,
        bytes32 signedPrekeyHash,
        uint32  oneTimeRemaining
    ) external onlyAgentController(agentId) {
        keyBundleOf[deviceId] = KeyBundlePointer({
            bundleId: bundleId,
            signedPrekeyHash: signedPrekeyHash,
            keyEpoch: agents[agentId].keyEpoch,
            oneTimeRemaining: oneTimeRemaining,
            updatedAt: uint64(block.timestamp)
        });
        emit PrekeysPublished(deviceId, bundleId, oneTimeRemaining);
    }

    function addExternalLink(bytes32 agentId, bytes32 kind, string calldata value)
        external onlyAgentController(agentId)
    {
        _linksOf[agentId].push(ExternalLink({ kind: kind, value: value }));
        emit ExternalLinkAdded(agentId, kind, value);
    }

    /* ------------------------------------------------------------------ conversations */

    /**
     * @param a,b participants — pass bytes32(0) for both in sealed mode so the public
     *            record reveals no social graph (PRD §5.3).
     */
    function openConversation(
        bytes32 cid,
        bytes32 a,
        bytes32 b,
        uint64  topic,
        uint8   kind,
        uint8   mode,
        bytes16 tag
    ) external {
        if (!relayer[msg.sender]) {
            bytes32 caller = agentByOwner[msg.sender];
            if (caller == bytes32(0) || (caller != a && caller != b)) revert NotAuthorized();
        }
        if (conversations[cid].createdAt != 0) revert AlreadyExists();
        conversations[cid] = Conversation({
            topic: topic, kind: kind, mode: mode, createdAt: uint64(block.timestamp), tag: tag
        });
        if (mode == 0) {
            if (a != bytes32(0)) _convsOfAgent[a].push(cid);
            if (b != bytes32(0)) _convsOfAgent[b].push(cid);
        }
        emit ConversationOpened(cid, mode == 0 ? a : bytes32(0), mode == 0 ? b : bytes32(0), topic, mode);
    }

    function setConversationTopic(bytes32 cid, uint64 topic) external {
        if (!relayer[msg.sender]) revert NotAuthorized();
        conversations[cid].topic = topic;
    }

    /* ------------------------------------------------------------------ groups */

    function createGroup(
        bytes32 groupId,
        bytes32 creator,
        uint64  topic,
        bytes32 membersRoot,
        bytes32[] calldata members,
        uint16  settings
    ) external {
        if (msg.sender != agents[creator].owner && !relayer[msg.sender]) revert NotAuthorized();
        if (groups[groupId].createdAt != 0) revert AlreadyExists();
        groups[groupId] = Group({
            groupId: groupId, membersRoot: membersRoot, topic: topic, epoch: 0,
            memberCount: uint32(members.length), owner: agents[creator].owner, creator: creator,
            settings: settings, createdAt: uint64(block.timestamp)
        });
        for (uint256 i; i < members.length; ++i) isGroupMember[groupId][members[i]] = true;
        isGroupMember[groupId][creator] = true;
        isGroupAdmin[groupId][creator] = true;
        emit GroupCreated(groupId, creator, topic, membersRoot);
        emit GroupMembershipChanged(groupId, 0, membersRoot, uint32(members.length));
    }

    function commitMembership(
        bytes32 groupId,
        bytes32 actor,
        bytes32[] calldata added,
        bytes32[] calldata removed,
        bytes32 membersRoot,
        uint32  memberCount
    ) external {
        Group storage g = groups[groupId];
        if (g.createdAt == 0) revert UnknownAgent();
        bool selfLeave = added.length == 0 && removed.length == 1 && removed[0] == actor;
        if (!relayer[msg.sender]) {
            if (agentByOwner[msg.sender] != actor) revert NotAuthorized();
            if (!isGroupAdmin[groupId][actor] && !selfLeave) revert NotAuthorized();
        }
        for (uint256 i; i < added.length; ++i) isGroupMember[groupId][added[i]] = true;
        for (uint256 i; i < removed.length; ++i) {
            isGroupMember[groupId][removed[i]] = false;
            isGroupAdmin[groupId][removed[i]] = false;
        }
        g.epoch += 1;
        g.membersRoot = membersRoot;
        g.memberCount = memberCount;
        emit GroupMembershipChanged(groupId, g.epoch, membersRoot, memberCount);
    }

    function setGroupAdmin(bytes32 groupId, bytes32 actor, bytes32 target, bool isAdmin) external {
        if (!relayer[msg.sender] && agentByOwner[msg.sender] != actor) revert NotAuthorized();
        if (!isGroupAdmin[groupId][actor]) revert NotAuthorized();
        isGroupAdmin[groupId][target] = isAdmin;
    }

    function setGroupSettings(bytes32 groupId, bytes32 actor, uint16 settings) external {
        if (!relayer[msg.sender] && agentByOwner[msg.sender] != actor) revert NotAuthorized();
        if (!isGroupAdmin[groupId][actor]) revert NotAuthorized();
        groups[groupId].settings = settings;
        emit GroupSettingsChanged(groupId, settings);
    }

    function createInvite(bytes32 groupId, bytes32 actor, bytes32 inviteHash, uint64 expiry, uint32 maxUses)
        external
    {
        if (!relayer[msg.sender] && agentByOwner[msg.sender] != actor) revert NotAuthorized();
        if (!isGroupAdmin[groupId][actor]) revert NotAuthorized();
        groupOfInvite[inviteHash] = groupId;
        inviteExpiry[inviteHash] = expiry;
        inviteUsesLeft[inviteHash] = maxUses;
        emit InviteCreated(groupId, inviteHash, expiry, maxUses);
    }

    function redeemInvite(bytes32 inviteHash, bytes32 agentId, bytes32 membersRoot, uint32 memberCount) external {
        bytes32 gid = groupOfInvite[inviteHash];
        if (gid == bytes32(0)) revert InviteInvalid();
        if (inviteExpiry[inviteHash] != 0 && inviteExpiry[inviteHash] < block.timestamp) revert InviteInvalid();
        if (inviteUsesLeft[inviteHash] == 0) revert InviteInvalid();
        if (!relayer[msg.sender] && agentByOwner[msg.sender] != agentId) revert NotAuthorized();
        inviteUsesLeft[inviteHash] -= 1;
        isGroupMember[gid][agentId] = true;
        Group storage g = groups[gid];
        g.epoch += 1;
        g.membersRoot = membersRoot;
        g.memberCount = memberCount;
        emit InviteRedeemed(gid, inviteHash, agentId);
        emit GroupMembershipChanged(gid, g.epoch, membersRoot, memberCount);
    }

    /* ------------------------------------------------------------------ channels */

    function createChannel(bytes32 channelId, bytes32 owner, uint64 topic, bool encrypted) external {
        if (msg.sender != agents[owner].owner && !relayer[msg.sender]) revert NotAuthorized();
        if (channels[channelId].createdAt != 0) revert AlreadyExists();
        channels[channelId] = Channel({
            channelId: channelId, owner: owner, topic: topic, followers: 0,
            encrypted: encrypted, createdAt: uint64(block.timestamp)
        });
        emit ChannelCreated(channelId, owner, topic, encrypted);
    }

    /// Follower identities are kept private off-chain; only the count is public.
    function setFollowing(bytes32 channelId, bytes32 agentId, bool following) external {
        if (!relayer[msg.sender] && agentByOwner[msg.sender] != agentId) revert NotAuthorized();
        bool was = isFollower[channelId][agentId];
        if (was == following) return;
        isFollower[channelId][agentId] = following;
        Channel storage c = channels[channelId];
        c.followers = following ? c.followers + 1 : c.followers - 1;
        emit ChannelFollowed(channelId, agentId, following);
    }

    /* ------------------------------------------------------------------ views */

    function getAgent(bytes32 agentId) external view returns (Agent memory) { return agents[agentId]; }

    function resolveHandle(bytes32 handleHash) external view returns (bytes32 agentId, uint64 expiry) {
        return (agentByHandleHash[handleHash], handleExpiry[handleHash]);
    }

    function devices(bytes32 agentId) external view returns (bytes32[] memory) { return devicesOf[agentId]; }

    function links(bytes32 agentId) external view returns (ExternalLink[] memory) { return _linksOf[agentId]; }

    function conversationsOf(bytes32 agentId) external view returns (bytes32[] memory) {
        return _convsOfAgent[agentId];
    }

    function getConversation(bytes32 cid) external view returns (Conversation memory) {
        return conversations[cid];
    }

    function getGroup(bytes32 groupId) external view returns (Group memory) { return groups[groupId]; }

    function getChannel(bytes32 channelId) external view returns (Channel memory) { return channels[channelId]; }
}
