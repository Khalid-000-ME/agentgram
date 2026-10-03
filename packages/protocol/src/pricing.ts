/**
 * x402 price table. Amounts are USDC (6 decimals) as decimal strings.
 * Config-driven so fees can be recalibrated against real chain costs (R2).
 */
export interface PriceRule {
  /** flat price in USDC */
  price: string;
  /** optional per-KB or per-MB adder */
  perKB?: string;
  perMB?: string;
  /** multiplier key, e.g. group fan-out */
  scale?: 'members100';
  description: string;
}

export const PRICES: Record<string, PriceRule> = {
  'POST /v1/agents':                    { price: '0.50',   description: 'Register agent: inbox + profile topic, registry write (~$0.026 infra)' },
  'PATCH /v1/agents':                   { price: '0.01',   description: 'Update profile, capabilities or DM policy (republished to the profile topic)' },
  'POST /v1/handles':                   { price: '1.00',   description: 'Claim or renew an @handle for one year' },
  'PUT /v1/prekeys':                    { price: '0.01',   description: 'Publish a prekey bundle' },
  'POST /v1/conversations':             { price: '0.05',   description: 'Open a conversation (topic creation)' },
  // A send is two HCS submits (conversation topic + recipient inbox notice) at $0.0008
  // each, so $0.0016 of infrastructure; priced above a 2x cost floor.
  'POST /v1/messages':                  { price: '0.005',  perKB: '0.0005', description: 'Send a message to a contact' },
  'POST /v1/messages:first-contact':    { price: '0.01',   perKB: '0.0005', description: 'First message to a non-contact (anti-spam stamp)' },
  'POST /v1/receipts':                  { price: '0.0002', description: 'Batched delivery/read receipts' },
  'POST /v1/groups':                    { price: '0.25',   description: 'Create a group' },
  'POST /v1/groups/messages':           { price: '0.001',  scale: 'members100', description: 'Group message (fan-out notices)' },
  'POST /v1/media/uploads':             { price: '0.000',  perMB: '0.002', description: 'Encrypted media upload' },
  'GET /v1/messages':                   { price: '0.0001', description: 'Indexed read, one page (mirror nodes remain free)' },
  'POST /v1/webhooks':                  { price: '1.00',   description: 'Webhook/SSE delivery, 30 days' },
  'POST /v1/channels':                  { price: '1.00',   description: 'Create a channel' },
  'POST /v1/billing/credits':           { price: '0.00',   description: 'Buy prepaid credits (amount set by the caller)' },
  'GET /v1/directory':                  { price: '0.0001', description: 'Directory search, one page' },
  'GET /v1/proofs':                     { price: '0.0001', description: 'Consensus proof bundle' },
};

const USDC_DECIMALS = 6;

export function toAtomic(decimal: string, decimals = USDC_DECIMALS): bigint {
  const [whole, frac = ''] = decimal.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

export function fromAtomic(atomic: bigint, decimals = USDC_DECIMALS): string {
  const s = atomic.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export interface PriceContext { bytes?: number; members?: number; amount?: string }

/** Resolve the atomic-units price for a route, applying size/fan-out adders. */
export function quote(routeKey: string, ctx: PriceContext = {}): bigint {
  const rule = PRICES[routeKey];
  if (!rule) throw new Error(`no price rule for ${routeKey}`);
  if (ctx.amount) return toAtomic(ctx.amount);
  let total = toAtomic(rule.price);
  if (rule.perKB && ctx.bytes) total += toAtomic(rule.perKB) * BigInt(Math.ceil(ctx.bytes / 1024));
  if (rule.perMB && ctx.bytes) total += toAtomic(rule.perMB) * BigInt(Math.ceil(ctx.bytes / (1024 * 1024)));
  if (rule.scale === 'members100' && ctx.members) total *= BigInt(Math.ceil(ctx.members / 100));
  return total;
}

export function describe(routeKey: string): string {
  return PRICES[routeKey]?.description ?? routeKey;
}
