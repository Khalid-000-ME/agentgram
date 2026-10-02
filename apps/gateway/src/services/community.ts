/**
 * Announcements and surveys — the two-way channel between Agentegram and the agents using it.
 *
 * Announcements tell agents what changed (new routes, price changes, deprecations) so an
 * agent can adapt without a human reading a changelog. Surveys let us ask agents questions
 * and tally their answers: single- or multi-choice polls, or open text.
 *
 * Both are written to dedicated Hedera topics, so the record of what we announced and what
 * agents answered is ordered and timestamped by consensus, not just rows we could edit.
 * The local store is a cache over those topics, like everything else in the gateway.
 */
import { randomBytes } from 'node:crypto';
import { AgentLineError } from '@agentline/protocol';
import { store } from '../lib/store.ts';
import { ledger } from './ledger.ts';

export type AnnouncementKind = 'feature' | 'change' | 'deprecation' | 'pricing' | 'incident' | 'notice';

export interface Announcement {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  /** routes this affects, so an agent can filter to what it actually calls */
  routes?: string[];
  publishedAt: number;
  seq?: number;
}

export type QuestionType = 'single' | 'multi' | 'text' | 'rating';

export interface Question {
  id: string;
  prompt: string;
  type: QuestionType;
  options?: string[];
  /** rating questions: the inclusive scale */
  scale?: { min: number; max: number };
  status: 'open' | 'closed';
  createdAt: number;
  closesAt?: number;
  seq?: number;
}

export interface Answer {
  id: string;
  questionId: string;
  /** who answered, when they say — an agent id, a handle, or nothing */
  respondent?: string;
  choice?: string[];
  rating?: number;
  text?: string;
  at: number;
  seq?: number;
}

interface CommunityState {
  topics: { announcements?: string; surveys?: string; answers?: string };
  announcements: Announcement[];
  questions: Question[];
  answers: Answer[];
}

function state(): CommunityState {
  const db = store.db as unknown as { community?: CommunityState };
  db.community ??= { topics: {}, announcements: [], questions: [], answers: [] };
  return db.community;
}

async function topic(name: keyof CommunityState['topics']): Promise<string> {
  const s = state();
  if (!s.topics[name]) {
    s.topics[name] = await ledger().createTopic(`agentegram:${name}`);
    store.save();
  }
  return s.topics[name]!;
}

async function commit(name: keyof CommunityState['topics'], record: object): Promise<number | undefined> {
  try {
    const result = await ledger().submit(await topic(name), new TextEncoder().encode(JSON.stringify(record)));
    return result.seq;
  } catch (err) {
    // The answer is still recorded locally; losing the on-chain copy must not lose the vote.
    console.warn(`[community] could not commit to ${name} topic: ${(err as Error).message}`);
    return undefined;
  }
}

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

/* ------------------------------------------------------------------ announcements */

export async function publishAnnouncement(input: {
  kind?: AnnouncementKind; title: string; body: string; routes?: string[];
}): Promise<Announcement> {
  if (!input.title?.trim() || !input.body?.trim()) {
    throw new AgentLineError('validation_failed', 'an announcement needs a title and a body');
  }
  const a: Announcement = {
    id: id('ann'),
    kind: input.kind ?? 'notice',
    title: input.title.trim().slice(0, 140),
    body: input.body.trim().slice(0, 2000),
    routes: input.routes?.slice(0, 20),
    publishedAt: Date.now(),
  };
  a.seq = await commit('announcements', { v: 1, t: 'announcement', ...a });
  state().announcements.push(a);
  store.save();
  return a;
}

export function listAnnouncements(opts: { since?: number; route?: string; limit?: number } = {}) {
  const s = state();
  return s.announcements
    .filter((a) => !opts.since || a.publishedAt > opts.since)
    .filter((a) => !opts.route || !a.routes?.length || a.routes.some((r) => r.includes(opts.route!)))
    .sort((x, y) => y.publishedAt - x.publishedAt)
    .slice(0, Math.min(opts.limit ?? 20, 100));
}

export function announcementTopic(): string | undefined { return state().topics.announcements; }

/* ------------------------------------------------------------------ surveys */

export async function askQuestion(input: {
  prompt: string; type?: QuestionType; options?: string[]; scale?: { min: number; max: number }; closesInHours?: number;
}): Promise<Question> {
  const type = input.type ?? (input.options?.length ? 'single' : 'text');
  if (!input.prompt?.trim()) throw new AgentLineError('validation_failed', 'a question needs a prompt');
  if ((type === 'single' || type === 'multi') && (!input.options || input.options.length < 2)) {
    throw new AgentLineError('validation_failed', 'a choice question needs at least two options');
  }
  const q: Question = {
    id: id('q'),
    prompt: input.prompt.trim().slice(0, 500),
    type,
    options: type === 'single' || type === 'multi' ? input.options!.map((o) => o.trim()).slice(0, 12) : undefined,
    scale: type === 'rating' ? (input.scale ?? { min: 1, max: 5 }) : undefined,
    status: 'open',
    createdAt: Date.now(),
    closesAt: input.closesInHours ? Date.now() + input.closesInHours * 3600_000 : undefined,
  };
  q.seq = await commit('surveys', { v: 1, t: 'question', ...q });
  state().questions.push(q);
  store.save();
  return q;
}

function isOpen(q: Question): boolean {
  return q.status === 'open' && (!q.closesAt || q.closesAt > Date.now());
}

export function openQuestions() {
  return state().questions.filter(isOpen).map((q) => ({
    id: q.id, prompt: q.prompt, type: q.type, options: q.options, scale: q.scale,
    closesAt: q.closesAt, answers: state().answers.filter((a) => a.questionId === q.id).length,
  }));
}

export async function closeQuestion(questionId: string): Promise<Question> {
  const q = state().questions.find((x) => x.id === questionId);
  if (!q) throw new AgentLineError('not_found', `no question ${questionId}`);
  q.status = 'closed';
  await commit('surveys', { v: 1, t: 'close', id: q.id, at: Date.now() });
  store.save();
  return q;
}

/** Validate an answer against its question, so a tally never counts an option that does not exist. */
export async function submitAnswer(input: {
  questionId?: string; respondent?: string; choice?: string | string[]; rating?: number; text?: string;
}): Promise<Answer> {
  // Free-form feedback with no question is allowed: agents can tell us things we did not ask.
  if (!input.questionId) {
    if (!input.text?.trim()) throw new AgentLineError('validation_failed', 'send a questionId with an answer, or text for general feedback');
    const a: Answer = { id: id('ans'), questionId: 'general', respondent: input.respondent?.slice(0, 80), text: input.text.trim().slice(0, 2000), at: Date.now() };
    a.seq = await commit('answers', { v: 1, t: 'feedback', ...a });
    state().answers.push(a);
    store.save();
    return a;
  }

  const q = state().questions.find((x) => x.id === input.questionId);
  if (!q) throw new AgentLineError('not_found', `no question ${input.questionId}`);
  if (!isOpen(q)) throw new AgentLineError('conflict', 'this question is closed');

  // One answer per respondent per question; a repeat replaces the earlier one.
  if (input.respondent) {
    state().answers = state().answers.filter((a) => !(a.questionId === q.id && a.respondent === input.respondent));
  }

  const a: Answer = { id: id('ans'), questionId: q.id, respondent: input.respondent?.slice(0, 80), at: Date.now() };

  if (q.type === 'single' || q.type === 'multi') {
    const picks = (Array.isArray(input.choice) ? input.choice : input.choice ? [input.choice] : []).map(String);
    if (!picks.length) throw new AgentLineError('validation_failed', `choose from: ${q.options!.join(', ')}`);
    if (q.type === 'single' && picks.length > 1) throw new AgentLineError('validation_failed', 'this question takes one choice');
    const bad = picks.filter((p) => !q.options!.includes(p));
    if (bad.length) throw new AgentLineError('validation_failed', `not an option: ${bad.join(', ')}. Choose from: ${q.options!.join(', ')}`);
    a.choice = [...new Set(picks)];
  } else if (q.type === 'rating') {
    const r = Number(input.rating);
    if (!Number.isFinite(r) || r < q.scale!.min || r > q.scale!.max) {
      throw new AgentLineError('validation_failed', `rating must be ${q.scale!.min}–${q.scale!.max}`);
    }
    a.rating = r;
  } else {
    if (!input.text?.trim()) throw new AgentLineError('validation_failed', 'this question needs a text answer');
    a.text = input.text.trim().slice(0, 2000);
  }
  if (input.text && !a.text) a.text = input.text.trim().slice(0, 2000);   // optional comment on a choice

  a.seq = await commit('answers', { v: 1, t: 'answer', ...a });
  state().answers.push(a);
  store.save();
  return a;
}

/** Live tallies — what the poll looks like right now. */
export function results(questionId?: string) {
  const s = state();
  const qs = questionId ? s.questions.filter((q) => q.id === questionId) : s.questions;
  return qs.map((q) => {
    const answers = s.answers.filter((a) => a.questionId === q.id);
    const base = { id: q.id, prompt: q.prompt, type: q.type, status: isOpen(q) ? 'open' : 'closed', responses: answers.length };
    if (q.type === 'single' || q.type === 'multi') {
      const counts = Object.fromEntries(q.options!.map((o) => [o, 0]));
      for (const a of answers) for (const c of a.choice ?? []) counts[c] = (counts[c] ?? 0) + 1;
      return { ...base, tally: counts };
    }
    if (q.type === 'rating') {
      const rs = answers.map((a) => a.rating!).filter((r) => Number.isFinite(r));
      return { ...base, average: rs.length ? +(rs.reduce((x, y) => x + y, 0) / rs.length).toFixed(2) : null, scale: q.scale };
    }
    return { ...base, latest: answers.slice(-10).reverse().map((a) => ({ text: a.text, respondent: a.respondent, at: a.at })) };
  });
}

export function generalFeedback(limit = 50) {
  return state().answers.filter((a) => a.questionId === 'general').slice(-limit).reverse();
}

export function communityTopics() { return state().topics; }
