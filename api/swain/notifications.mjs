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
// Also usable as a local worker for the email leg, because the Gmail OAuth
// token used by `gog` lives in the macOS Keychain and cannot reach Vercel:
//
//   node scripts/swain-notification-worker.mjs --once
//   node scripts/swain-notification-worker.mjs --loop --interval 30

import {
  config, stable, safeEqual, sha256,
} from './_lib.mjs';

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
 * Two transports are supported:
 *   1. 'gog'  - local worker, uses the macOS Keychain OAuth token (no new creds)
 *   2. 'gmail_api' - serverless, needs GMAIL_REFRESH_TOKEN + GMAIL_CLIENT_ID/SECRET
 * Returns { state, ref, status, error } with the same semantics as sendSms.
 */
async function sendEmail(job, { gogBin = '/opt/homebrew/bin/gog', gmail = null } = {}) {
  if (gmail && gmail.refreshToken) {
    return sendEmailViaGmailApi(job, gmail);
  }
  return sendEmailViaGog(job, gogBin);
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
 * A job is claimable when: state='pending', or state='sending' with an expired
 * lease (worker died mid-flight => ambiguous => we HOLD it rather than resend).
 */
async function claimJobs(limit) {
  const nowIso = new Date().toISOString();
  const rows = await sb('swain_notification_outbox?select=id,inquiry_id,channel,destination,recipient,subject,body,state,attempts,lease_until' +
    '&or=(state.eq.pending,and(state.eq.sending,lease_until.lt.' + nowIso + '))' +
    '&order=created_at.asc&limit=' + limit);

  const claimed = [];
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
    const lease = new Date(Date.now() + 120000).toISOString();
    const upd = await sb('swain_notification_outbox?id=eq.' + row.id + '&state=eq.pending', {
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
    if (updated && updated.state === STATE.sending) claimed.push(updated);
  }
  return claimed;
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
export async function processBatch({ limit = 20, gogBin, gmail, allowSend = null } = {}) {
  const enabled = allowSend === null ? config.notifyEnabled : allowSend;
  const summary = { enabled, processed: [], held: [], failed: [] };

  if (!config.supabaseUrl || !config.supabaseKey) {
    return { ...summary, error: 'storage_not_configured' };
  }

  const jobs = await claimJobs(limit);
  for (const job of jobs) {
    if (!enabled) {
      // Safe default: put it back so nothing is lost and nothing is sent.
      await sb('swain_notification_outbox?id=eq.' + job.id, {
        method: 'PATCH',
        body: JSON.stringify({
          state: STATE.pending,
          lease_until: null,
          updated_at: new Date().toISOString(),
        }),
      });
      summary.processed.push({ id: job.id, destination: job.destination, state: 'not_sent_disabled' });
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
  const expected = process.env.SWAIN_WORKER_TOKEN || '';
  const provided = req.headers['x-sworker-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (expected && !safeEqual(expected, provided)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
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
