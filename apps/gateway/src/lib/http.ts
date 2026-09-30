import type { NextFunction, Request, Response } from 'express';
import { AgentLineError } from '@agentline/protocol';
import { store } from './store.ts';

/** Wrap an async handler so rejections reach the error middleware. */
export function handler<T extends Request>(fn: (req: T, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req as T, res).catch(next);
  };
}

/** Idempotency-Key support: a retried request never double-posts or double-charges. */
export function idempotent(req: Request): string | undefined {
  const key = req.headers['idempotency-key'];
  return typeof key === 'string' && key ? `${req.method} ${req.path} ${key}` : undefined;
}

export function replayIfKnown(req: Request, res: Response): boolean {
  const key = idempotent(req);
  if (!key) return false;
  const known = store.idempotent<{ status: number; body: unknown }>(key);
  if (!known) return false;
  res.setHeader('Idempotent-Replay', 'true');
  res.status(known.status).json(known.body);
  return true;
}

export function remember(req: Request, status: number, body: unknown): void {
  const key = idempotent(req);
  if (key) store.rememberIdempotent(key, { status, body });
}

export function ok(req: Request, res: Response, status: number, body: unknown): void {
  remember(req, status, body);
  res.status(status).json(body);
}

export function requireFields<T extends Record<string, unknown>>(body: T | undefined, fields: string[]): T {
  if (!body) throw new AgentLineError('validation_failed', 'request body is required');
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw new AgentLineError('validation_failed', `missing required field(s): ${missing.join(', ')}`, { missing });
  }
  return body;
}
