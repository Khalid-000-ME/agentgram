/**
 * Production alerting.
 *
 * Raises an alert when something is actually wrong — a chain write failing, payments not
 * settling, an operator wallet running dry, the consensus transport degrading — and emails
 * it to the operator. Three properties matter more than the plumbing:
 *
 *  1. **Throttled.** A failing dependency produces one email and a suppression count, not
 *     a thousand emails. Alert fatigue is how real incidents get missed.
 *  2. **Honest about delivery.** If no mail transport is configured, alerts are still
 *     recorded and the UI says plainly that nothing is being delivered. A monitoring
 *     system that silently fails to notify is worse than none.
 *  3. **Never breaks the request path.** Alerting is best-effort and fully detached: a
 *     broken SMTP server must not turn into a failed message send.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.ts';
import { store } from '../lib/store.ts';

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  at: number;
  severity: Severity;
  /** stable key used for throttling, e.g. "hcs.submit_failed" */
  kind: string;
  title: string;
  detail: string;
  meta?: Record<string, unknown>;
  /** how many further occurrences were suppressed while throttled */
  suppressed: number;
  delivery: 'sent' | 'disabled' | 'no_transport' | 'failed' | 'throttled';
  deliveryError?: string;
}

export interface AlertConfig {
  enabled: boolean;
  to: string;
  throttleMinutes: number;
  minSeverity: Severity;
}

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const MAX_STORED = 200;

export function alertConfig(): AlertConfig {
  const db = store.db as unknown as { alertConfig?: AlertConfig };
  if (!db.alertConfig) {
    db.alertConfig = {
      // On by default: the operator asked to be told about problems, and an alerting
      // system that ships switched off is decoration.
      enabled: process.env.ALERTS_ENABLED !== 'false',
      to: process.env.ALERT_EMAIL_TO ?? '1.dev.dude.global@gmail.com',
      throttleMinutes: Number(process.env.ALERT_THROTTLE_MINUTES ?? 15),
      minSeverity: (process.env.ALERT_MIN_SEVERITY as Severity) ?? 'warning',
    };
    store.save();
  }
  return db.alertConfig;
}

export function setAlertsEnabled(enabled: boolean): AlertConfig {
  const cfg = alertConfig();
  cfg.enabled = enabled;
  store.save();
  console.log(`[alerts] ${enabled ? 'enabled' : 'disabled'} by operator`);
  return cfg;
}

export function alertHistory(limit = 50): Alert[] {
  const db = store.db as unknown as { alerts?: Alert[] };
  return (db.alerts ?? []).slice(-limit).reverse();
}

function record(alert: Alert): void {
  const db = store.db as unknown as { alerts?: Alert[] };
  db.alerts ??= [];
  db.alerts.push(alert);
  if (db.alerts.length > MAX_STORED) db.alerts.splice(0, db.alerts.length - MAX_STORED);
  store.save();
}

const lastSent = new Map<string, { at: number; alertId: string }>();

/* ------------------------------------------------------------------ transport */

export type TransportKind = 'smtp' | 'resend' | 'none';

/**
 * Google displays an app password as four space-separated groups ("abcd efgh ijkl mnop").
 * The spaces are presentation only — SMTP AUTH rejects them — so strip all whitespace.
 * Also tolerate a value the operator wrapped in quotes.
 */
export function smtpPassword(): string {
  const raw = process.env.SMTP_PASS ?? '';
  return raw.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
}

export function transportKind(): TransportKind {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && smtpPassword()) return 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  return 'none';
}

/**
 * Catch the credential mistakes that otherwise only show up as an SMTP auth failure at
 * the moment you most need the alert to go out.
 */
export function mailConfigIssue(): string | null {
  if (transportKind() !== 'smtp') return null;
  const host = (process.env.SMTP_HOST ?? '').trim();
  const pass = smtpPassword();
  const user = (process.env.SMTP_USER ?? '').trim();

  if (/gmail\.com$/i.test(host) || /@gmail\.com$/i.test(user)) {
    if (pass.length !== 16) {
      return `SMTP_PASS is ${pass.length} characters after removing spaces; a Google App Password is exactly 16. `
        + 'A normal account password will be rejected by Gmail — generate one under '
        + 'Google Account > Security > 2-Step Verification > App passwords.';
    }
    if (!/^[a-z]{16}$/i.test(pass)) {
      return 'SMTP_PASS does not look like a Google App Password (16 letters). Double-check what you pasted.';
    }
  }
  if (!/^\d+$/.test((process.env.SMTP_PORT ?? '587').trim())) return 'SMTP_PORT must be a number (587 for STARTTLS, 465 for TLS).';
  return null;
}

export function transportDescription(): string {
  switch (transportKind()) {
    case 'smtp': {
      const issue = mailConfigIssue();
      return `SMTP ${process.env.SMTP_HOST} as ${process.env.SMTP_USER}${issue ? ` — WARNING: ${issue}` : ''}`;
    }
    case 'resend': return 'Resend HTTP API';
    default: return 'none configured — alerts are recorded but NOT emailed';
  }
}

let smtp: Transporter | null = null;

function smtpTransport(): Transporter {
  if (!smtp) {
    const port = Number((process.env.SMTP_PORT ?? '587').trim());
    smtp = nodemailer.createTransport({
      host: (process.env.SMTP_HOST ?? '').trim(),
      port,
      secure: port === 465,
      auth: { user: (process.env.SMTP_USER ?? '').trim(), pass: smtpPassword() },
    });
  }
  return smtp;
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const kind = transportKind();
  const from = process.env.ALERT_EMAIL_FROM ?? process.env.SMTP_USER ?? 'alerts@agentline.local';

  if (kind === 'smtp') {
    try {
      await smtpTransport().sendMail({ from, to, subject, text });
    } catch (err) {
      const message = (err as Error).message;
      if (/invalid login|username and password not accepted|535|534/i.test(message)) {
        throw new Error(
          `${message} — Gmail rejected the credentials. Use a 16-character App Password, not the account password, `
          + 'and make sure 2-Step Verification is on for that account.',
        );
      }
      throw err;
    }
    return;
  }
  if (kind === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error('no mail transport configured');
}

function body(alert: Alert): string {
  return [
    `${alert.severity.toUpperCase()}: ${alert.title}`,
    '',
    alert.detail,
    '',
    `kind      ${alert.kind}`,
    `time      ${new Date(alert.at).toISOString()}`,
    `service   AgentLine gateway ${config.publicUrl}`,
    `env       ${config.env}`,
    alert.meta ? `\ncontext\n${JSON.stringify(alert.meta, null, 2)}` : '',
    '',
    `Console:  ${config.publicUrl}/ui`,
    `Status:   ${config.publicUrl}/v1/status`,
    '',
    'You are receiving this because alerting is enabled for this AgentLine gateway.',
    'Turn it off with one click in the console.',
  ].filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ raise */

/**
 * Report a problem. Safe to call from anywhere, including error handlers: it never throws
 * and never blocks the caller on network I/O.
 */
export function raiseAlert(input: {
  severity: Severity;
  kind: string;
  title: string;
  detail: string;
  meta?: Record<string, unknown>;
}): Alert {
  const cfg = alertConfig();
  const alert: Alert = {
    id: `alr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    severity: input.severity,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    meta: input.meta,
    suppressed: 0,
    delivery: 'disabled',
  };

  const tag = `[alert:${input.severity}] ${input.kind} — ${input.title}`;
  input.severity === 'critical' ? console.error(tag, input.detail) : console.warn(tag, input.detail);

  if (!cfg.enabled) { alert.delivery = 'disabled'; record(alert); return alert; }
  if (SEVERITY_ORDER[input.severity] < SEVERITY_ORDER[cfg.minSeverity]) {
    alert.delivery = 'disabled';
    record(alert);
    return alert;
  }

  // Throttle per kind: attribute the suppression to the alert that was actually sent, so
  // the console shows "this fired 47 more times" instead of 47 identical rows.
  const previous = lastSent.get(input.kind);
  const windowMs = cfg.throttleMinutes * 60_000;
  if (previous && Date.now() - previous.at < windowMs) {
    alert.delivery = 'throttled';
    record(alert);
    const db = store.db as unknown as { alerts?: Alert[] };
    const original = db.alerts?.find((a) => a.id === previous.alertId);
    if (original) { original.suppressed += 1; store.save(); }
    return alert;
  }

  if (transportKind() === 'none') { alert.delivery = 'no_transport'; record(alert); return alert; }

  lastSent.set(input.kind, { at: Date.now(), alertId: alert.id });
  alert.delivery = 'sent';
  record(alert);

  // Detached: delivery outcome is written back, but the caller is never delayed by it.
  void sendEmail(cfg.to, `[AgentLine ${input.severity}] ${input.title}`, body(alert))
    .catch((err) => {
      alert.delivery = 'failed';
      alert.deliveryError = (err as Error).message.slice(0, 300);
      console.error(`[alerts] delivery failed: ${alert.deliveryError}`);
      lastSent.delete(input.kind);   // allow a retry on the next occurrence
      store.save();
    });

  return alert;
}

/** Operator-triggered test so delivery can be proven before an incident. */
export async function sendTestAlert(): Promise<{ ok: boolean; transport: TransportKind; to: string; error?: string }> {
  const cfg = alertConfig();
  const alert: Alert = {
    id: `alr_test_${Date.now().toString(36)}`,
    at: Date.now(),
    severity: 'info',
    kind: 'alerts.test',
    title: 'Test alert from AgentLine',
    detail: 'This is a manual test of the alerting path. If you received this email, production alerts will reach you.',
    meta: {
      consensus: config.hedera.enabled ? config.hedera.network : 'local',
      registry: config.registry.address ?? null,
      payments: config.x402.network,
    },
    suppressed: 0,
    delivery: 'sent',
  };
  if (transportKind() === 'none') {
    alert.delivery = 'no_transport';
    record(alert);
    return { ok: false, transport: 'none', to: cfg.to, error: 'no mail transport configured (set SMTP_* or RESEND_API_KEY)' };
  }
  try {
    await sendEmail(cfg.to, '[AgentLine test] alerting is working', body(alert));
    record(alert);
    return { ok: true, transport: transportKind(), to: cfg.to };
  } catch (err) {
    alert.delivery = 'failed';
    alert.deliveryError = (err as Error).message.slice(0, 300);
    record(alert);
    return { ok: false, transport: transportKind(), to: cfg.to, error: alert.deliveryError };
  }
}
