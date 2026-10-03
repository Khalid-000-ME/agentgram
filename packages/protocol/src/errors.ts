/**
 * RFC 9457 problem+json error model with stable codes.
 */
export const ERROR_CODES = [
  'payment_required', 'payment_invalid', 'signature_invalid', 'nonce_replayed',
  'agent_not_found', 'blocked', 'dm_policy_denied', 'prekeys_exhausted',
  'envelope_too_large', 'rate_limited', 'chain_unavailable', 'conversation_sealed',
  'validation_failed', 'conflict', 'not_found', 'forbidden', 'internal',
  'handle_taken', 'insufficient_credits',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  payment_required: 402, payment_invalid: 402, signature_invalid: 401, nonce_replayed: 401,
  agent_not_found: 404, blocked: 403, dm_policy_denied: 403, prekeys_exhausted: 409,
  envelope_too_large: 413, rate_limited: 429, chain_unavailable: 503, conversation_sealed: 409,
  validation_failed: 422, conflict: 409, not_found: 404, forbidden: 403, internal: 500,
  handle_taken: 409, insufficient_credits: 402,
};

export class AgentLineError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public detail?: Record<string, unknown>,
  ) { super(message); this.name = 'AgentLineError'; }

  get status(): number { return STATUS[this.code] ?? 500; }

  toProblem(instance?: string) {
    return {
      type: `https://agentline.dev/errors/${this.code}`,
      title: this.code.replace(/_/g, ' '),
      status: this.status,
      detail: this.message,
      code: this.code,
      instance,
      ...(this.detail ? { meta: this.detail } : {}),
    };
  }
}

export function fail(code: ErrorCode, message: string, detail?: Record<string, unknown>): never {
  throw new AgentLineError(code, message, detail);
}
