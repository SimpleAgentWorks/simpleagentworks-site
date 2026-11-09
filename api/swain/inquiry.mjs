// POST /api/swain/inquiry
//
// Captures a Swain Photography inquiry durably, then enqueues notification
// jobs atomically. Shows success ONLY after the capture transaction commits.
//
// Same-origin only. No redirect, no external form branding, no third-party form.
//
// Post-submit dispatch: after the capture commits, the notification outbox is
// drained in the BACKGROUND - the response is written FIRST and the drain
// continues via Vercel's waitUntil (or, without it, after the response is
// written). The visitor never waits on a provider. The drain runs on an
// explicit wall-clock budget (SWAIN_DISPATCH_BUDGET_MS, default 5000ms) and a
// small batch (SWAIN_DISPATCH_BATCH, default 2); when the budget is spent it
// stops cleanly and leaves the remaining jobs 'pending' for the next trigger,
// so a slow provider can never leave a job stranded in 'sending'.

import {
  config, respond, validateInquiry, rateLimit, attachRateHeaders,
  ipFromHeaders, captureInquiry, buildJobs, notificationStates, storageConfigured,
  storageErrorText, normalizeOrigin,
} from './_lib.mjs';
import { processBatch } from './notifications.mjs';

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body) > config.bodyMaxBytes) throw Object.assign(new Error('too large'), { status: 413 });
      return JSON.parse(req.body);
    }
    if (Buffer.isBuffer(req.body)) {
      const raw = req.body.toString('utf8');
      if (Buffer.byteLength(raw) > config.bodyMaxBytes) throw Object.assign(new Error('too large'), { status: 413 });
      return JSON.parse(raw);
    }
    if (typeof req.body === 'object') {
      if (Buffer.byteLength(JSON.stringify(req.body)) > config.bodyMaxBytes) throw Object.assign(new Error('too large'), { status: 413 });
      return req.body;
    }
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > config.bodyMaxBytes) throw Object.assign(new Error('too large'), { status: 413 });
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export default async function handler(req, res, context) {
  // Vercel passes a `{ waitUntil }` context to non-Next.js functions. Capture
  // it so the post-submit drain can run AFTER the response has been written.
  HANDLER_CONTEXT = context || null;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return respond(res, 405, { error: 'Use POST.' });
  }

  // Same-origin enforcement. Third-party form posts are rejected outright.
  // Compared against an EXACT allowlist (no wildcards). The allowlist is
  // built from Vercel platform env vars when available, so it follows the
  // deployment automatically.
  const origin = req.headers.origin;
  const normalized = normalizeOrigin(origin);
  if (!normalized || !config.allowedOrigins.includes(normalized)) {
    return respond(res, 403, { error: 'This form origin is not allowed.' });
  }

  // Shared atomic rate limit (HMAC-derived keys; no raw IP is stored).
  const ip = ipFromHeaders(req.headers);
  const rl = await rateLimit('swain-inquiry', ip);
  attachRateHeaders(res, rl);
  if (!rl.allowed) {
    return respond(res, 429, { error: 'Too many inquiries from your connection. Please try again later.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    const tooLarge = err && err.status === 413;
    return respond(res, tooLarge ? 413 : 400, {
      error: tooLarge ? 'Your message is too long to send.' : 'Please check your details and try again.',
    });
  }

  // Honeypot: a filled hidden field means a bot. Return success so the bot does
  // not learn it was filtered, but save NOTHING and send NOTHING.
  const honey = body && typeof body.hp === 'string' ? body.hp.trim() : '';
  if (honey) {
    return respond(res, 200, { ok: true, id: body.submissionId || null, filtered: true });
  }

  let inquiry;
  try {
    inquiry = validateInquiry(body);
  } catch (err) {
    return respond(res, err.status || 400, { error: err.publicMessage || err.message || 'Please check your details.' });
  }

  if (!storageConfigured()) {
    // Never show a false success when we cannot durably store the inquiry.
    return respond(res, 503, {
      error: 'The inquiry form is temporarily unavailable. Please try again shortly.',
    });
  }

  const jobs = buildJobs(inquiry);

  let capture;
  try {
    capture = await captureInquiry(inquiry, jobs);
  } catch (err) {
    const msg = storageErrorText(err);
    if (/content_mismatch/i.test(msg)) {
      // Same submission id, different content => reject. Do not overwrite.
      return respond(res, 409, {
        error: 'This submission reference was already used with different details. Please reload the page and submit again.',
      });
    }
    console.error('[swain] capture failed:', err.message);
    // Capture failure => error state. Never false success.
    return respond(res, 503, {
      error: 'We could not save your inquiry. Please try again — if it keeps failing, email us directly.',
    });
  }

  if (!capture.created) {
    // Duplicate post of the SAME id and content: idempotent replay.
    // No new records, no new notifications.
    const states = await notificationStates(capture.id).catch(() => []);
    return respond(res, 200, { ok: true, id: capture.id, duplicate: true, notifications: states });
  }

  // --- post-submit dispatch -------------------------------------------
  // The capture transaction has COMMITTED, so the notification jobs are
  // durable. Drain them now instead of waiting for a scheduled cron.
  //
  // The drain must NOT hold the visitor's response. We write the response
  // FIRST, then let the drain continue in the background using Vercel's
  // waitUntil (the platform keeps the invocation alive after the response is
  // sent, bounded by the function's max duration). Where waitUntil is not
  // available we fall back to running the drain after the response has been
  // written - still after the visitor has their answer.
  //
  // A dispatch problem can never fail the request: the inquiry is already
  // durably saved, so problems are logged, and the durable outbox means the
  // jobs remain deliverable later.
  const states = await notificationStates(capture.id).catch(() => []);
  respond(res, 200, { ok: true, id: capture.id, notifications: states });

  const drain = drainNotifications();
  const waitUntil = getWaitUntil(req);
  if (waitUntil) {
    // Fire-and-forget: the platform extends the invocation for this promise.
    waitUntil(drain);
  } else {
    // No platform hook on this runtime: still do not block the response - the
    // response has already been written above.
    drain.catch((err) => {
      console.error('[swain] post-submit dispatch failed:', err && err.message);
    });
  }
  return undefined;
}

/**
 * Find Vercel's waitUntil hook, if this runtime provides one.
 *
 * Vercel exposes it either as the second argument of the handler (the
 * `{ waitUntil }` context) or via the `@vercel/functions` package. We prefer
 * the context form so no new dependency is required.
 */
function getWaitUntil(req) {
  // The context is passed as the second argument; we capture it at call time.
  const ctx = getHandlerContext();
  if (ctx && typeof ctx.waitUntil === 'function') {
    return (promise) => ctx.waitUntil(promise);
  }
  return null;
}

// The handler context is stashed here by the exported handler wrapper.
let HANDLER_CONTEXT = null;
function getHandlerContext() { return HANDLER_CONTEXT; }

/**
 * Drain the notification outbox after the response has been written.
 *
 * Never throws - a dispatch failure must not turn a durably-saved inquiry
 * into a user-facing error.
 */
async function drainNotifications() {
  if (!config.notifyEnabled) {
    // Delivery is disabled (SWAIN_NOTIFY_ENABLED != 'true'). processBatch
    // reads the outbox and reports what it would do but sends nothing, and
    // leaves every job in its original state. Safe by design.
    return { attempted: false, reason: 'delivery_disabled' };
  }
  try {
    const summary = await processBatch({
      limit: config.dispatchBatch,
      budgetMs: config.dispatchBudgetMs,
    });
    return {
      attempted: true,
      enabled: Boolean(summary.enabled),
      processed: (summary.processed || []).length,
      held: (summary.held || []).length,
      failed: (summary.failed || []).length,
      budget_exhausted: Boolean(summary.budget_exhausted),
    };
  } catch (err) {
    // The outbox is durable, so this is recoverable: the jobs stay queued for
    // the next dispatch. Log it, but never fail the request.
    console.error('[swain] post-submit dispatch failed:', err && err.message);
    return { attempted: true, error: 'dispatch_failed' };
  }
}
