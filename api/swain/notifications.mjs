// POST /api/swain/notifications  (also runnable as a local worker)
//
// Drains the durable notification outbox. Each recipient is tracked SEPARATELY:
//   pending -> sending -> accepted -> delivered
//                       \-> failed (retryable)
//                       \-> held    (ambiguous => DO NOT auto-retry)
//
// "accepted" means the provider accepted the message (Twilio SID / Gmail id).
// "delivered" means the provider confirmed delivery. A provider-accepted message
// is never reported as delivered.
//
// Ambiguous results (timeout, 5xx, malformed response) are HELD for human review
// rather than retried, because a retry could duplicate a message that actually
// went out.
//
// Requires SWAIN_NOTIFY_ENABLED=true to deliver. Without it, jobs are read and
// reported but nothing is sent (safe default for staging).
//
// The endpoint FAILS CLOSED: if SWAIN_WORKER_TOKEN is not set it returns 503
// and does nothing, rather than serving any caller.
//
// The hosted email transport needs GMAIL_REFRESH_TOKEN + GMAIL_CLIENT_ID +
// GMAIL_CLIENT_SECRET. The Mac-only `gog` transport is used only when the
// gog binary is present (i.e. on the local worker) - on a serverless runtime
// the job fails fast with a named status instead of attempting a call that
// cannot work.
//
// Also usable as a local worker for the email leg, because the Gmail OAuth
// token used by `gog` lives in the macOS Keychain and cannot reach Vercel:
//
//   node scripts/swain-notification-worker.mjs --once
//   node scripts/swain-notification-worker.mjs --loop --interval 30

import {
  config, stable, safeEqual, sha256, retryDelaySeconds,
} from './_lib.mjs';
import fs from 'node:fs';

const STATE = {
  pending: 'pending', sending: 'sending', accepted: 'accepted',
  delivered: 'delivered', failed: 'failed', held: 'held',
};

// ------------------------------------------------------------------ storage

function sb(path, init = {}) {
  const url = config.supabaseUrl + '/rest/v1/' + path;
  const headers = {
    apikey: config.supabaseKey,
    Authorization: 'Bearer ' + config.supabaseKey,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(20000) })
    .then(async (r) => {
      const t = await r.text();
      let b = null;
      try { b = t ? JSON.parse(t) : null; } catch { b = t; }
      if (!r.ok) {
        const e = new Error('storage ' + r.status + ': ' + String(typeof b === 'string' ? b : JSON.stringify(b)).slice(0, 200));
        e.status = r.status;
        throw e;
      }
      return b;
    });
}

// ------------------------------------------------------------------ providers

/**
 * Send one SMS via Twilio.
 * Returns { state, ref, status, error }.
 *   accepted  - Twilio returned a message SID (provider took it)
 *   failed    - Twilio returned a definitive error (safe to retry later)
 *   held      - ambiguous (timeout / 5xx / no parseable body) => do NOT retry
 */
async function sendSms(job) {
  const sid = config.twilioSid;
  const token = config.twilioToken;
  const from = config.smsFrom;
  if (!sid || !token || !from) {
    return { state: STATE.failed, status: 'not_configured', error: 'Twilio credentials or SWAIN_SMS_FROM missing' };
  }
  if (!/^\+[1-9]\d{7,14}$/.test(from)) {
    return { state: STATE.failed, status: 'bad_sender', error: 'SWAIN_SMS_FROM must be E.164' };
  }
  if (!/^\+[1-9]\d{7,14}$/.test(job.recipient)) {
    return { state: STATE.failed, status: 'bad_recipient', error: 'Recipient must be E.164' };
  }

  const body = new URLSearchParams({ To: job.recipient, From: from, Body: job.body });
  const auth = Buffer.from(sid + ':' + token).toString('base64');
  let res;
  try {
    res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    // Network timeout / connection error: ambiguous. Hold, do not retry.
    return { state: STATE.held, status: 'transport_error', error: String(err.message).slice(0, 200) };
  }

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }

  if (res.ok && parsed && parsed.sid) {
    // Provider accepted. status may be queued/sending.
    return { state: STATE.accepted, ref: parsed.sid, status: parsed.status || 'queued' };
  }
  if (res.status >= 400 && res.status < 500) {
    // Definitive rejection (bad number, not verified, etc.) - retryable later.
    const code = parsed && parsed.code ? parsed.code : res.status;
    const msg = parsed && parsed.message ? parsed.message : text.slice(0, 160);
    return { state: STATE.failed, status: 'twilio_' + code, error: String(msg).slice(0, 200) };
  }
  // 5xx or unparseable: ambiguous. Hold for review rather than risk a duplicate.
  return { state: STATE.held, status: 'twilio_http_' + res.status, error: text.slice(0, 200) };
}

/**
 * Send one email.
 *
 * Two transports:
 *   1. 'gmail_api' - serverless. Needs GMAIL_REFRESH_TOKEN + GMAIL_CLIENT_ID
 *      + GMAIL_CLIENT_SECRET (all three, or the transport is not configured).
 *   2. 'gog'        - local worker only. Uses the macOS Keychain OAuth token.
 *
 * Selection order:
 *   - an explicitly supplied `gmail` object wins;
 *   - otherwise the hosted credentials are read from the environment;
 *   - otherwise we fall back to `gog`, but ONLY when we are actually running
 *     somewhere `gog` can work.
 *
 * The fallback is deliberately guarded: on a serverless runtime there is no
 * `gog` binary and no Keychain, so attempting it would fail obscurely (and
 * could look like a silent success). Instead the job fails fast with a named
 * status that says the hosted transport is not configured.
 */
async function sendEmail(job, { gogBin = '/opt/homebrew/bin/gog', gmail = null } = {}) {
  const creds = gmail || gmailCredentialsFromEnv();
  if (creds && creds.refreshToken) {
    return sendEmailViaGmailApi(job, creds);
  }
  if (!canUseGogFallback()) {
    return {
      state: STATE.failed,
      status: 'hosted_transport_not_configured',
      error: 'GMAIL_REFRESH_TOKEN / GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET are not configured; the gog fallback is only available on the local worker.',
    };
  }
  return sendEmailViaGog(job, gogBin);
}

/**
 * Hosted Gmail credentials from the environment, or null when incomplete.
 * All three are required - a partial set is treated as not configured.
 */
export function gmailCredentialsFromEnv() {
  const refreshToken = config.gmailRefreshToken;
  const clientId = config.gmailClientId;
  const clientSecret = config.gmailClientSecret;
  if (!refreshToken || !clientId || !clientSecret) return null;
  return { refreshToken, clientId, clientSecret };
}

/**
 * True only when the Mac-only `gog` fallback can actually work.
 *
 * We detect the local worker by the presence of the gog binary on disk (the
 * local worker always has it). On Vercel there is no gog and no Keychain, so
 * the fallback must not be attempted.
 */
export function canUseGogFallback() {
  if (process.env.SWAIN_ALLOW_GOG_FALLBACK === 'true') return true;
  if (process.env.SWAIN_ALLOW_GOG_FALLBACK === 'false') return false;
  try {
    // Synchronous existence check - no execution, no credentials touched.
    // eslint-disable-next-line no-undef
    const { existsSync } = fs;
    return existsSync('/opt/homebrew/bin/gog');
  } catch {
    return false;
  }
}

async function sendEmailViaGog(job, gogBin) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const args = [
    'gmail', 'send',
    '--account', config.emailFrom,
    '--to', job.recipient,
    '--subject', job.subject || 'New inquiry',
    '--body', job.body,
    '--json',
  ];
  let stdout;
  try {
    const res = await run(gogBin, args, { timeout: 45000, maxBuffer: 1024 * 1024 });
    stdout = res.stdout;
  } catch (err) {
    const msg = String((err && (err.stderr || err.message)) || 'gog send failed');
    if (/command not found|ENOENT/.test(msg)) {
      return { state: STATE.failed, status: 'gog_missing', error: msg.slice(0, 200) };
    }
    // Timeout / unknown outcome: ambiguous. Hold, do not retry.
    return { state: STATE.held, status: 'gog_error', error: msg.slice(0, 200) };
  }
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch { /* not json */ }
  const id = parsed && (parsed.id || parsed.messageId || (parsed.result && parsed.result.id));
  if (id) {
    // Provider accepted the message.
    return { state: STATE.accepted, ref: String(id), status: 'sent' };
  }
  return { state: STATE.held, status: 'gog_unparsed', error: String(stdout).slice(0, 200) };
}

async function sendEmailViaGmailApi(job, gmail) {
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: gmail.refreshToken,
      client_id: gmail.clientId,
      client_secret: gmail.clientSecret,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text();
    return { state: STATE.failed, status: 'oauth_' + tokenRes.status, error: t.slice(0, 200) };
  }
  const tok = await tokenRes.json();
  const raw = [
    'To: ' + job.recipient,
    'Subject: ' + (job.subject || 'New inquiry'),
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    job.body,
  ].join('\r\n');
  const b64 = Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let res;
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: b64 }),
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    return { state: STATE.held, status: 'transport_error', error: String(err.message).slice(0, 200) };
  }
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  if (res.ok && parsed && parsed.id) {
    return { state: STATE.accepted, ref: parsed.id, status: 'accepted' };
  }
  if (res.status >= 400 && res.status < 500) {
    return { state: STATE.failed, status: 'gmail_http_' + res.status, error: text.slice(0, 200) };
  }
  return { state: STATE.held, status: 'gmail_http_' + res.status, error: text.slice(0, 200) };
}

// ------------------------------------------------------------------ outbox

/**
 * Claim a batch of due jobs atomically.
 *
 * A job is claimable when:
 *   - state='pending'                              -> never attempted
 *   - state='failed' AND attempts < maxAttempts     -> definitive rejection,
 *     safe to retry (this was the dead-letter gap: 'failed' was documented as
 *     retryable but was never claimed by anything)
 *   - state='sending' with an expired lease         -> worker died mid-flight
 *     => AMBIGUOUS => we HOLD it rather than resend
 *
 * A failed job is only re-claimed once its backoff window has elapsed, so a
 * permanently-bad destination cannot spin the worker.
 */
async function claimJobs(limit) {
  const nowIso = new Date().toISOString();
  const rows = await sb('swain_notification_outbox?select=id,inquiry_id,channel,destination,recipient,subject,body,state,attempts,lease_until,updated_at' +
    '&or=(state.eq.pending,state.eq.failed,and(state.eq.sending,lease_until.lt.' + nowIso + '))' +
    '&order=created_at.asc&limit=' + limit);

  const claimed = [];
  const exhausted = [];
  for (const row of rows || []) {
    if (row.state === STATE.sending) {
      // Worker died after claiming: the provider may or may not have sent it.
      // HOLD for human review. Never silently resend.
      await sb('swain_notification_outbox?id=eq.' + row.id, {
        method: 'PATCH',
        body: JSON.stringify({
          state: STATE.held,
          provider_status: 'lease_expired_ambiguous',
          last_error: 'Worker lease expired; delivery outcome unknown. Review before retrying.',
          updated_at: new Date().toISOString(),
        }),
      });
      continue;
    }
    if (row.state === STATE.failed) {
      // Retry a definitive rejection - but only after the backoff window, and
      // only while attempts remain.
      const attempts = row.attempts || 0;
      if (attempts >= config.maxAttempts) {
        // Out of retries: park it in 'held' so it is VISIBLE to a human
        // instead of silently disappearing into a dead letter.
        await sb('swain_notification_outbox?id=eq.' + row.id, {
          method: 'PATCH',
          body: JSON.stringify({
            state: STATE.held,
            provider_status: 'retries_exhausted',
            last_error: 'Failed after ' + attempts + ' attempt(s); no retries left. Review required.',
            lease_until: null,
            updated_at: new Date().toISOString(),
          }),
        });
        exhausted.push({ id: row.id, destination: row.destination, state: 'held_retries_exhausted' });
        continue;
      }
      const delay = retryDelaySeconds(attempts, config.retryBaseSeconds, config.retryMaxSeconds);
      const dueAt = new Date(Date.now() - delay * 1000).toISOString();
      const lastTry = row.updated_at || row.created_at || dueAt;
      if (new Date(lastTry).getTime() + delay * 1000 > Date.now()) {
        continue; // backoff not elapsed yet
      }
    }
    const lease = new Date(Date.now() + 120000).toISOString();
    const upd = await sb('swain_notification_outbox?id=eq.' + row.id +
      '&state=eq.' + (row.state === STATE.failed ? STATE.failed : STATE.pending), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        state: STATE.sending,
        lease_until: lease,
        attempts: (row.attempts || 0) + 1,
        updated_at: new Date().toISOString(),
      }),
    });
    const updated = Array.isArray(upd) ? upd[0] : upd;
    if (updated && updated.state === STATE.sending) {
      // Remember the state the job had BEFORE we claimed it, so the disabled
      // path can restore a 'failed' job to 'failed' (not 'pending') and a
      // disabled run never silently erases retry history.
      claimed.push({ ...updated, prior_state: row.state });
    }
  }
  return { claimed, exhausted };
}

async function markJob(id, result) {
  const patch = {
    state: result.state,
    provider_ref: result.ref || null,
    provider_status: result.status || null,
    last_error: result.error || null,
    lease_until: null,
    updated_at: new Date().toISOString(),
  };
  if (result.state === STATE.delivered) patch.delivered_at = new Date().toISOString();
  await sb('swain_notification_outbox?id=eq.' + id, { method: 'PATCH', body: JSON.stringify(patch) });
}

/** Recompute the inquiry-level notify_state from its job states. */
async function refreshInquiryState(inquiryId) {
  const rows = await sb('swain_notification_outbox?inquiry_id=eq.' + encodeURIComponent(inquiryId) + '&select=state');
  const states = (rows || []).map((r) => r.state);
  if (!states.length) return;
  let level;
  if (states.every((s) => s === STATE.delivered)) level = 'notified';
  else if (states.every((s) => s === STATE.delivered || s === STATE.accepted)) level = 'notified';
  else if (states.some((s) => s === STATE.held || s === STATE.failed)) level = 'held';
  else level = 'partial';
  await sb('swain_inquiries?id=eq.' + encodeURIComponent(inquiryId), {
    method: 'PATCH',
    body: JSON.stringify({ notify_state: level }),
  });
}

/**
 * Process one batch. Returns a summary of per-recipient outcomes.
 */
export async function processBatch({ limit = 20, gogBin, gmail, allowSend = null, budgetMs = null } = {}) {
  const enabled = allowSend === null ? config.notifyEnabled : allowSend;
  const summary = { enabled, processed: [], held: [], failed: [] };
  // Wall-clock budget for the whole drain. When it is exhausted we stop
  // CLEANLY - remaining jobs stay claimable (they were never claimed) and the
  // function is never killed mid-flight, so a job can never be left in
  // 'sending' by an overrun.
  const budget = budgetMs === null ? config.dispatchBudgetMs : budgetMs;
  const deadline = Date.now() + Math.max(0, budget);
  summary.budget_ms = budget;

  if (!config.supabaseUrl || !config.supabaseKey) {
    return { ...summary, error: 'storage_not_configured' };
  }

  let claimed;
  let exhausted = [];
  try {
    ({ claimed: claimed = [], exhausted = exhausted } = await claimJobs(limit));
  } catch (err) {
    // Storage unreachable: report it and stop. Nothing is claimed, nothing is
    // sent, and every job stays in its original state.
    return { ...summary, error: 'storage_unavailable', detail: String(err && err.message).slice(0, 160) };
  }
  const jobs = claimed;
  // Jobs that ran out of retries are parked in 'held' and surfaced so a human
  // sees them instead of them vanishing as dead letters.
  for (const e of exhausted || []) {
    summary.held.push({ id: e.id, destination: e.destination, state: e.state });
  }
  for (const job of jobs) {
    if (!enabled) {
      // Safe default: put it back EXACTLY as it was, so nothing is lost and
      // nothing is sent. A job that was 'failed' must go back to 'failed'
      // (not 'pending'), otherwise a disabled run would silently reset the
      // retry history and hide the failure.
      const restoreState = job.prior_state === STATE.failed ? STATE.failed : STATE.pending;
      await sb('swain_notification_outbox?id=eq.' + job.id, {
        method: 'PATCH',
        body: JSON.stringify({
          state: restoreState,
          lease_until: null,
          attempts: (job.attempts || 1) - 1, // undo the claim's attempt bump
          updated_at: new Date().toISOString(),
        }),
      });
      summary.processed.push({ id: job.id, destination: job.destination, state: 'not_sent_disabled' });
      continue;
    }
    // Budget check BEFORE sending. If the drain is out of time we release the
    // job back to the state it had and stop. Releasing (rather than leaving it
    // 'sending') is what keeps a budget overrun from manufacturing an
    // ambiguous hold.
    if (Date.now() >= deadline) {
      const restoreState = job.prior_state === STATE.failed ? STATE.failed : STATE.pending;
      await sb('swain_notification_outbox?id=eq.' + job.id, {
        method: 'PATCH',
        body: JSON.stringify({
          state: restoreState,
          lease_until: null,
          attempts: (job.attempts || 1) - 1,
          updated_at: new Date().toISOString(),
        }),
      });
      summary.processed.push({ id: job.id, destination: job.destination, state: 'deferred_budget_exhausted' });
      summary.budget_exhausted = true;
      continue;
    }
    let result;
    if (job.channel === 'sms') result = await sendSms(job);
    else if (job.channel === 'email') result = await sendEmail(job, { gogBin, gmail });
    else result = { state: STATE.failed, status: 'unknown_channel', error: 'Unknown channel ' + job.channel };

    await markJob(job.id, result);
    await refreshInquiryState(job.inquiry_id);
    const entry = { id: job.id, destination: job.destination, state: result.state, provider_status: result.status || null };
    summary.processed.push(entry);
    if (result.state === STATE.held) summary.held.push(entry);
    if (result.state === STATE.failed) summary.failed.push(entry);
  }
  return summary;
}

// ------------------------------------------------------------------ http entry

export default async function handler(req, res) {
  // The worker endpoint must not be callable by the public.
  //
  // FAIL CLOSED: if SWAIN_WORKER_TOKEN is missing, the endpoint is not
  // configured and must refuse every request. Previously the guard was
  // `if (expected && ...)`, so an unset token skipped the check entirely and
  // left the endpoint callable by anyone who found the URL - unacceptable for
  // an endpoint that can send real email.
  const expected = process.env.SWAIN_WORKER_TOKEN || '';
  if (!expected) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Worker not configured.' }));
    return;
  }
  const provided = req.headers['x-sworker-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(expected, provided)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Unauthorized.' }));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Use POST.' }));
    return;
  }
  try {
    const summary = await processBatch({
      limit: Number.parseInt(String(req.headers['x-limit'] || '20'), 10) || 20,
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(summary));
  } catch (err) {
    console.error('[swain] worker failed:', err.message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Worker failed.' }));
  }
}
