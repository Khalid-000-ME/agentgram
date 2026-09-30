/**
 * Alerting tests: credential normalisation, config validation, throttling and the
 * honesty guarantees (never throws, never claims undelivered alerts were sent).
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { rmSync } from 'node:fs';

const DATA_DIR = `.data/test-alerts-${process.pid}`;
process.env.DATA_DIR = DATA_DIR;
process.env.ALERT_THROTTLE_MINUTES = '15';
process.env.ALERT_MIN_SEVERITY = 'warning';

const alerts = await import('../apps/gateway/src/services/alerts.ts');
const { store } = await import('../apps/gateway/src/lib/store.ts');

function clearMailEnv() {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'RESEND_API_KEY']) delete process.env[k];
}

beforeEach(() => {
  clearMailEnv();
  (store.db as unknown as { alerts?: unknown[] }).alerts = [];
});

test('a Google app password is accepted however it was pasted', () => {
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_USER = 'ops@gmail.com';
  for (const raw of [
    'abcd efgh ijkl mnop',       // exactly how Google displays it
    'abcdefghijklmnop',
    '  abcd efgh ijkl mnop \n',
    '"abcd efgh ijkl mnop"',
    "'abcdefghijklmnop'",
    'abcd\tefgh\tijkl\tmnop',
  ]) {
    process.env.SMTP_PASS = raw;
    assert.equal(alerts.smtpPassword(), 'abcdefghijklmnop', `failed for: ${JSON.stringify(raw)}`);
    assert.equal(alerts.transportKind(), 'smtp');
    assert.equal(alerts.mailConfigIssue(), null);
  }
});

test('a non-app-password is flagged before an incident needs it', () => {
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_USER = 'ops@gmail.com';
  process.env.SMTP_PASS = 'MyRealPassword123!';
  const issue = alerts.mailConfigIssue();
  assert.ok(issue && /exactly 16/.test(issue), issue ?? 'expected an issue');

  process.env.SMTP_PASS = 'abcd efgh';
  assert.ok(alerts.mailConfigIssue());
});

test('no transport is reported honestly rather than silently swallowed', () => {
  assert.equal(alerts.transportKind(), 'none');
  assert.match(alerts.transportDescription(), /NOT emailed/);
  const alert = alerts.raiseAlert({ severity: 'critical', kind: 'test.no_transport', title: 'x', detail: 'y' });
  assert.equal(alert.delivery, 'no_transport');
});

test('disabling alerting stops delivery but still records the alert', () => {
  alerts.setAlertsEnabled(false);
  const alert = alerts.raiseAlert({ severity: 'critical', kind: 'test.disabled', title: 'x', detail: 'y' });
  assert.equal(alert.delivery, 'disabled');
  assert.equal(alerts.alertHistory(10)[0].kind, 'test.disabled');
  alerts.setAlertsEnabled(true);
});

test('the toggle flips state in one call', () => {
  const before = alerts.alertConfig().enabled;
  assert.equal(alerts.setAlertsEnabled(!before).enabled, !before);
  assert.equal(alerts.setAlertsEnabled(before).enabled, before);
});

test('repeat alerts are throttled and counted, not re-sent', () => {
  process.env.SMTP_HOST = 'smtp.example.invalid';
  process.env.SMTP_USER = 'ops@example.invalid';
  process.env.SMTP_PASS = 'abcdefghijklmnop';
  alerts.setAlertsEnabled(true);

  const first = alerts.raiseAlert({ severity: 'critical', kind: 'test.flapping', title: 'first', detail: 'd' });
  assert.equal(first.delivery, 'sent');

  for (let i = 0; i < 5; i++) {
    const repeat = alerts.raiseAlert({ severity: 'critical', kind: 'test.flapping', title: `repeat ${i}`, detail: 'd' });
    assert.equal(repeat.delivery, 'throttled');
  }
  const original = alerts.alertHistory(50).find((a) => a.id === first.id);
  assert.equal(original?.suppressed, 5, 'suppressed occurrences are attributed to the sent alert');
});

test('severity below the configured floor is not emailed', () => {
  process.env.SMTP_HOST = 'smtp.example.invalid';
  process.env.SMTP_USER = 'ops@example.invalid';
  process.env.SMTP_PASS = 'abcdefghijklmnop';
  const info = alerts.raiseAlert({ severity: 'info', kind: 'test.info', title: 'fyi', detail: 'd' });
  assert.equal(info.delivery, 'disabled');
});

test('raising an alert never throws, even with a broken transport', () => {
  process.env.SMTP_HOST = 'smtp.does-not-resolve.invalid';
  process.env.SMTP_USER = 'ops@example.invalid';
  process.env.SMTP_PASS = 'abcdefghijklmnop';
  assert.doesNotThrow(() => alerts.raiseAlert({
    severity: 'critical', kind: `test.broken.${Date.now()}`, title: 'x', detail: 'y',
  }));
});

test('history is newest-first and bounded', () => {
  for (let i = 0; i < 30; i++) {
    alerts.raiseAlert({ severity: 'warning', kind: `test.bulk.${i}`, title: `alert ${i}`, detail: 'd' });
  }
  const recent = alerts.alertHistory(5);
  assert.equal(recent.length, 5);
  assert.equal(recent[0].title, 'alert 29');
});

process.on('exit', () => { try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ } });
