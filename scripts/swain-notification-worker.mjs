#!/usr/bin/env node
// Local notification worker for Swain Photography.
//
// WHY A LOCAL WORKER EXISTS
//   The SMS leg works from Vercel directly (Twilio API + env vars).
//   The EMAIL leg cannot: the only working Gmail credential for
//   info@simpleagentworks.com is the `gog` OAuth token, which lives in the
//   macOS Keychain and is not portable to a serverless runtime. Rather than
//   introduce a new paid service or a new credential, the local worker uses
//   `gog` to send email while the Mac mini drains the same durable outbox.
//
//   The outbox is the source of truth. Whether a job is sent by the Vercel
//   worker or this local worker, each job is claimed atomically and its
//   per-recipient state is recorded. There is no double-send path.
//
// Usage:
//   node scripts/swain-notification-worker.mjs --once
//   node scripts/swain-notification-worker.mjs --loop --interval 30
//   node scripts/swain-notification-worker.mjs --once --allow-send   (explicit)
//   node scripts/swain-notification-worker.mjs --status            (read-only)
//
// SAFETY: without --allow-send, the worker READS the outbox and reports what
// it would do, but sends nothing. Real sending requires --allow-send.

import { config } from '../api/swain/_lib.mjs';
import { processBatch } from '../api/swain/notifications.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

async function status() {
  const url = config.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/swain_notification_outbox?select=id,inquiry_id,channel,destination,recipient,state,attempts,provider_status,last_error,created_at,updated_at&order=created_at.desc&limit=100';
  const res = await fetch(url, {
    headers: { apikey: config.supabaseKey, Authorization: 'Bearer ' + config.supabaseKey },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('storage ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const rows = await res.json();
  const byState = {};
  for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
  console.log(JSON.stringify({ total: rows.length, byState, rows }, null, 2));
}

async function once(allowSend) {
  const summary = await processBatch({
    limit: 20,
    allowSend,
    gogBin: process.env.GOG_BIN || '/opt/homebrew/bin/gog',
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Load them from the local env file.');
    process.exit(2);
  }
  if (has('--status')) {
    await status();
    return;
  }
  const allowSend = has('--allow-send');
  if (!allowSend) {
    console.log('[swain-worker] dry run (no sends). Pass --allow-send to deliver.');
  }
  if (has('--loop')) {
    const interval = Number.parseInt(arg('--interval', '30'), 10) || 30;
    console.log('[swain-worker] loop every ' + interval + 's; allowSend=' + allowSend);
    for (;;) {
      try { await once(allowSend); } catch (e) { console.error('[swain-worker] cycle error:', e.message); }
      await new Promise((r) => setTimeout(r, interval * 1000));
    }
  }
  await once(allowSend);
}

main().catch((err) => { console.error('[swain-worker] fatal:', err.message); process.exit(1); });
