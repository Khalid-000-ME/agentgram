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
import { RegistryWriter, type WriteResult, type WriterStats } from './registry-writer.ts';
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
  private writer: RegistryWriter | null = null;

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

  private pipeline(): RegistryWriter {
    if (!this.writer) {
      this.writer = new RegistryWriter(REGISTRY_ABI, this.address);
    }
    return this.writer;
  }

  /**
   * Submit a write through the lane pipeline.
   *
   * `partition` keeps dependent writes for one entity in order (an agent must exist before
   * its prekeys can be published), while unrelated entities go down separate lanes
   * concurrently. A write that cannot land right now is buffered and retried rather than
   * dropped — the caller has already paid for it.
   */
  private async write(fn: string, args: unknown[], partition: string): Promise<string | undefined> {
    if (!this.onchain) return undefined;
    const result: WriteResult = await this.pipeline().submit(fn, args, partition);

    if (result.ok) return result.txHash;

    const message = result.error ?? 'unknown error';
    if (result.queued) {
      // Not a failure the caller can act on: reads still work from the local mirror and the
      // write will land once the chain is reachable again.
      console.warn(`[registry] ${fn} buffered for retry: ${message}`);
      raiseAlert({
        severity: 'warning',
        kind: `registry.buffered.${fn}`,
        title: `Registry write buffered: ${fn}`,
        detail: `The write could not land immediately and is queued for retry. On-chain state is temporarily behind. Cause: ${message}`,
        meta: { function: fn, partition, contract: this.address, queued: this.pipeline().statistics().queued },
      });
      return undefined;
    }

    console.error(`[registry] ${fn} failed:`, message);
    raiseAlert({
      severity: 'critical',
      kind: `registry.write_failed.${fn}`,
      title: `Registry write failed: ${fn}`,
      detail: `The on-chain registry did not accept ${fn} and the write was not recoverable. Local state is ahead of the contract. Cause: ${message}`,
      meta: { function: fn, partition, contract: this.address, chainId: config.registry.chainId },
    });
    return undefined;
  }

  /** Queue depth and lane health, surfaced in the operator console. */
  writerStats(): WriterStats | null {
    return this.onchain ? this.pipeline().statistics() : null;
  }

  async drainWrites(): Promise<number> {
    return this.onchain ? this.pipeline().drain() : 0;
  }

  shutdown(): void { this.writer?.shutdown(); }

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
    ], a.agentId);
  }

  async updateAgent(a: AgentRecord): Promise<string | undefined> {
    return this.write('updateAgent', [idToBytes32(a.agentId), dmPolicyIndex(a.dmPolicy), encodeFlags(a.flags)], a.agentId);
  }

  async claimHandle(agentId: string, handle: string, durationSeconds = 365 * 24 * 3600) {
    return this.write('claimHandle', [idToBytes32(agentId), handleHash(normalizeHandle(handle)), BigInt(durationSeconds)], agentId);
  }

  async publishPrekeys(agentId: string, deviceId: string, bundleId: string, signedPrekeyHash: Hex, remaining: number) {
    return this.write('publishPrekeys', [
      idToBytes32(agentId), idToBytes32(deviceId), idToBytes32(bundleId), signedPrekeyHash, remaining,
    ], agentId);
  }

  async addDevice(agentId: string, deviceId: string) {
    return this.write('addDevice', [idToBytes32(agentId), idToBytes32(deviceId)], agentId);
  }

  async removeDevice(agentId: string, deviceId: string) {
    return this.write('removeDevice', [idToBytes32(agentId), idToBytes32(deviceId)], agentId);
  }

  async tombstone(agentId: string) {
    return this.write('tombstoneAgent', [idToBytes32(agentId)], agentId);
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
    ], c.a ?? c.cid);
  }

  async createGroup(g: { groupId: string; creator: string; topicId: string; membersRoot: Hex; members: string[]; settings: number }) {
    return this.write('createGroup', [
      idToBytes32(g.groupId), idToBytes32(g.creator), topicNum(g.topicId), g.membersRoot,
      g.members.map(idToBytes32), g.settings,
    ], g.groupId);
  }

  async commitMembership(g: {
    groupId: string; actor: string; added: string[]; removed: string[]; membersRoot: Hex; memberCount: number;
  }) {
    return this.write('commitMembership', [
      idToBytes32(g.groupId), idToBytes32(g.actor), g.added.map(idToBytes32), g.removed.map(idToBytes32),
      g.membersRoot, g.memberCount,
    ], g.groupId);
  }

  async createInvite(groupId: string, actor: string, inviteHash: Hex, expiry: number, maxUses: number) {
    return this.write('createInvite', [idToBytes32(groupId), idToBytes32(actor), inviteHash, BigInt(expiry), maxUses], groupId);
  }

  async redeemInvite(inviteHash: Hex, agentId: string, membersRoot: Hex, memberCount: number) {
    return this.write('redeemInvite', [inviteHash, idToBytes32(agentId), membersRoot, memberCount], agentId);
  }

  async createChannel(channelId: string, owner: string, topicId: string, encrypted: boolean) {
    return this.write('createChannel', [idToBytes32(channelId), idToBytes32(owner), topicNum(topicId), encrypted], channelId);
  }

  async setFollowing(channelId: string, agentId: string, following: boolean) {
    return this.write('setFollowing', [idToBytes32(channelId), idToBytes32(agentId), following], agentId);
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
