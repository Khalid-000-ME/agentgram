/**
 * Registry service — the on-chain source of truth for identity and mappings (PRD §5.2).
 *
 * Writes are relayed to the AgentLineRegistry contract (Base Sepolia by default) and
 * mirrored into the local snapshot so reads stay fast while a tx confirms. When no
 * contract address / relayer key is configured the service runs in "local" mode: the
 * mirror is authoritative, so the gateway is fully functional before deployment and the
 * same code path is exercised by tests.
 */
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { handleHash, idToBytes32, normalizeHandle, b64, hexs } from '@agentline/crypto';
import { config, registryMode } from '../config.ts';
import { store, type AgentRecord } from '../lib/store.ts';
import { raiseAlert } from './alerts.ts';
import registryArtifact from '../abi/registry.json' with { type: 'json' };

export const REGISTRY_ABI = registryArtifact.abi as unknown as Abi;
export const REGISTRY_BYTECODE = registryArtifact.bytecode as Hex;

const DM_POLICIES = ['everyone', 'contacts', 'paid_only', 'allowlist'] as const;
export type DmPolicy = (typeof DM_POLICIES)[number];

export const FLAG = {
  acceptsUnknownDms: 1 << 0,
  business: 1 << 1,
  verified: 1 << 2,
  receiptsOff: 1 << 3,
} as const;

export function encodeFlags(f: AgentRecord['flags']): number {
  return (f.acceptsUnknownDms ? FLAG.acceptsUnknownDms : 0)
    | (f.business ? FLAG.business : 0)
    | (f.verified ? FLAG.verified : 0)
    | (f.receiptsOff ? FLAG.receiptsOff : 0);
}

export function dmPolicyIndex(p: DmPolicy): number {
  const i = DM_POLICIES.indexOf(p);
  return i < 0 ? 0 : i;
}

/** HCS topic ids are `shard.realm.num`; the contract stores only `num`. */
export function topicNum(topicId: string): bigint {
  const parts = topicId.split('.');
  return BigInt(parts[parts.length - 1] || '0');
}

export function keyToBytes32(pkBase64: string): Hex {
  const raw = b64.dec(pkBase64);
  const out = new Uint8Array(32);
  out.set(raw.slice(0, 32));
  return hexs.enc(out) as Hex;
}

class RegistryService {
  readonly mode = registryMode();
  // viem's client generics vary by chain; the concrete types are pinned at call sites.
  private publicClient: any = null;
  private walletClient: any = null;
  private account = config.registry.relayerPrivateKey
    ? privateKeyToAccount(config.registry.relayerPrivateKey)
    : null;
  private queue: Promise<unknown> = Promise.resolve();

  get address(): Address | undefined { return config.registry.address as Address | undefined; }

  get relayerAddress(): Address {
    return (this.account?.address ?? '0x0000000000000000000000000000000000000000') as Address;
  }

  private chain() { return config.registry.chainId === base.id ? base : baseSepolia; }

  private clients() {
    if (!this.publicClient) {
      this.publicClient = createPublicClient({ chain: this.chain(), transport: http(config.registry.rpcUrl) });
    }
    if (!this.walletClient && this.account) {
      this.walletClient = createWalletClient({
        account: this.account, chain: this.chain(), transport: http(config.registry.rpcUrl),
      });
    }
    return { publicClient: this.publicClient, walletClient: this.walletClient };
  }

  get onchain(): boolean { return this.mode === 'onchain' && !!this.address && !!this.account; }

  /**
   * Serialize writes through one queue: a single relayer account has one nonce, and
   * parallel writes would otherwise collide under load.
   */
  private async write(fn: string, args: unknown[]): Promise<string | undefined> {
    if (!this.onchain) return undefined;
    const run = this.queue.then(async () => {
      const { publicClient, walletClient } = this.clients();
      const hash = await walletClient!.writeContract({
        address: this.address!, abi: REGISTRY_ABI, functionName: fn, args: args as never,
        chain: this.chain(), account: this.account!,
      });
      await publicClient!.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 });
      return hash as string;
    });
    this.queue = run.catch(() => undefined);
    try {
      return await run;
    } catch (err) {
      const message = (err as Error).message.split('\n')[0];
      console.error(`[registry] ${fn} failed:`, message);
      // Reads still work from the local mirror, so this degrades rather than breaks — but
      // on-chain state is now behind, which the operator must know about.
      raiseAlert({
        severity: 'warning',
        kind: `registry.write_failed.${fn}`,
        title: `Registry write failed: ${fn}`,
        detail: `The on-chain registry did not accept ${fn}. Local state is ahead of the contract until this is resolved. Cause: ${message}`,
        meta: { function: fn, contract: this.address, chainId: config.registry.chainId, relayer: this.relayerAddress },
      });
      return undefined;
    }
  }

  async read<T>(fn: string, args: unknown[]): Promise<T | undefined> {
    if (!this.address) return undefined;
    try {
      const { publicClient } = this.clients();
      return (await publicClient!.readContract({
        address: this.address, abi: REGISTRY_ABI, functionName: fn, args: args as never,
      })) as T;
    } catch (err) {
      console.error(`[registry] read ${fn} failed:`, (err as Error).message.split('\n')[0]);
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- writes */

  async registerAgent(a: AgentRecord): Promise<string | undefined> {
    return this.write('registerAgent', [
      idToBytes32(a.agentId),
      a.owner as Address,
      keyToBytes32(a.ed25519Pk),
      keyToBytes32(a.x25519Pk),
      topicNum(a.inboxTopic),
      topicNum(a.profileTopic),
      dmPolicyIndex(a.dmPolicy),
      encodeFlags(a.flags),
      a.handle ? handleHash(a.handle) : ('0x' + '00'.repeat(32)) as Hex,
    ]);
  }

  async updateAgent(a: AgentRecord): Promise<string | undefined> {
    return this.write('updateAgent', [idToBytes32(a.agentId), dmPolicyIndex(a.dmPolicy), encodeFlags(a.flags)]);
  }

  async claimHandle(agentId: string, handle: string, durationSeconds = 365 * 24 * 3600) {
    return this.write('claimHandle', [idToBytes32(agentId), handleHash(normalizeHandle(handle)), BigInt(durationSeconds)]);
  }

  async publishPrekeys(agentId: string, deviceId: string, bundleId: string, signedPrekeyHash: Hex, remaining: number) {
    return this.write('publishPrekeys', [
      idToBytes32(agentId), idToBytes32(deviceId), idToBytes32(bundleId), signedPrekeyHash, remaining,
    ]);
  }

  async addDevice(agentId: string, deviceId: string) {
    return this.write('addDevice', [idToBytes32(agentId), idToBytes32(deviceId)]);
  }

  async removeDevice(agentId: string, deviceId: string) {
    return this.write('removeDevice', [idToBytes32(agentId), idToBytes32(deviceId)]);
  }

  async tombstone(agentId: string) {
    return this.write('tombstoneAgent', [idToBytes32(agentId)]);
  }

  async openConversation(c: {
    cid: string; a?: string; b?: string; topicId: string; kind: number; mode: 'open' | 'sealed'; tag?: string;
  }) {
    const zero = ('0x' + '00'.repeat(32)) as Hex;
    return this.write('openConversation', [
      idToBytes32(c.cid),
      c.mode === 'open' && c.a ? idToBytes32(c.a) : zero,
      c.mode === 'open' && c.b ? idToBytes32(c.b) : zero,
      topicNum(c.topicId),
      c.kind,
      c.mode === 'open' ? 0 : 1,
      (c.tag ? ('0x' + Buffer.from(b64.dec(c.tag)).toString('hex').slice(0, 32)) : '0x' + '00'.repeat(16)) as Hex,
    ]);
  }

  async createGroup(g: { groupId: string; creator: string; topicId: string; membersRoot: Hex; members: string[]; settings: number }) {
    return this.write('createGroup', [
      idToBytes32(g.groupId), idToBytes32(g.creator), topicNum(g.topicId), g.membersRoot,
      g.members.map(idToBytes32), g.settings,
    ]);
  }

  async commitMembership(g: {
    groupId: string; actor: string; added: string[]; removed: string[]; membersRoot: Hex; memberCount: number;
  }) {
    return this.write('commitMembership', [
      idToBytes32(g.groupId), idToBytes32(g.actor), g.added.map(idToBytes32), g.removed.map(idToBytes32),
      g.membersRoot, g.memberCount,
    ]);
  }

  async createInvite(groupId: string, actor: string, inviteHash: Hex, expiry: number, maxUses: number) {
    return this.write('createInvite', [idToBytes32(groupId), idToBytes32(actor), inviteHash, BigInt(expiry), maxUses]);
  }

  async redeemInvite(inviteHash: Hex, agentId: string, membersRoot: Hex, memberCount: number) {
    return this.write('redeemInvite', [inviteHash, idToBytes32(agentId), membersRoot, memberCount]);
  }

  async createChannel(channelId: string, owner: string, topicId: string, encrypted: boolean) {
    return this.write('createChannel', [idToBytes32(channelId), idToBytes32(owner), topicNum(topicId), encrypted]);
  }

  async setFollowing(channelId: string, agentId: string, following: boolean) {
    return this.write('setFollowing', [idToBytes32(channelId), idToBytes32(agentId), following]);
  }

  /* ---------------------------------------------------------------- reads */

  /** Cross-check a locally mirrored identity key against the chain (defeats key substitution). */
  async verifyIdentityKey(agentId: string, expectedEd25519Pk: string): Promise<'match' | 'mismatch' | 'unavailable'> {
    const onchain = await this.read<{ ed25519IdentityKey: Hex }>('getAgent', [idToBytes32(agentId)]);
    if (!onchain || !onchain.ed25519IdentityKey || /^0x0+$/.test(onchain.ed25519IdentityKey)) return 'unavailable';
    return onchain.ed25519IdentityKey.toLowerCase() === keyToBytes32(expectedEd25519Pk).toLowerCase()
      ? 'match' : 'mismatch';
  }

  info(): Record<string, unknown> {
    return {
      mode: this.mode,
      address: this.address ?? null,
      chainId: config.registry.chainId,
      relayer: this.account ? this.relayerAddress : null,
      note: this.onchain
        ? 'Registry writes are relayed on-chain; the local snapshot mirrors them for fast reads.'
        : 'Local registry mirror (set REGISTRY_ADDRESS + RELAYER_PRIVATE_KEY to write on-chain).',
    };
  }
}

export const registry = new RegistryService();
