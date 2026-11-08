// Swain Photography inquiry - shared server library.
//
// Everything in this file is server-only. It is imported by the Vercel serverless
// functions under /api and by the local notification worker. Never expose any of
// these values to browser JavaScript.
//
// Storage model: Supabase (existing simpleagentworks-ops project).
//   * public.swain_inquiries          - one row per accepted inquiry
//   * public.swain_notification_outbox - durable notification queue
//   * public.swain_rate_limits         - shared atomic rate-limit buckets
// Capture + notification-job enqueue happen in ONE transaction via the
// swain_capture_inquiry() SQL function, so a crash can never leave a saved
// inquiry without its notification jobs.
//
// Environment variables (all optional; every feature has a safe default):
//   SUPABASE_URL                       - required for capture
//   SUPABASE_SERVICE_ROLE_KEY          - required for capture
//   SWAIN_ALLOWED_ORIGINS              - comma-separated same-origin allowlist
//                                       (exact origins only; no wildcards).
//                                       In addition to this, the Vercel
//                                       platform vars VERCEL_BRANCH_URL,
//                                       VERCEL_URL and
//                                       VERCEL_PROJECT_PRODUCTION_URL are
//                                       honoured automatically, so the
//                                       allowlist follows the deployment
//                                       without being rewritten each deploy.
//                                       Vercel supplies those as BARE
//                                       HOSTNAMES (no scheme); they are
//                                       normalised to https://host.
//   SWAIN_HMAC_SECRET                  - secret for deriving rate-limit keys
//   SWAIN_RATE_PER_IP                  - per-key request cap (default 5)
//   SWAIN_RATE_WINDOW_SECONDS          - rate-limit window (default 3600)
//   SWAIN_RATE_GLOBAL                  - global request cap (default 50)
//   SWAIN_RATE_GLOBAL_WINDOW_SECONDS   - global window (default 3600)
//   SWAIN_NOTIFY_ENABLED               - 'true' to actually deliver notifications
//   SWAIN_MAX_ATTEMPTS                 - delivery attempts before a failed job
//                                       is parked in 'held' for review (default 3)
//   SWAIN_RETRY_BASE_SECONDS           - retry backoff base (default 60)
//   SWAIN_RETRY_MAX_SECONDS            - retry backoff cap (default 3600)
//   SWAIN_EMAIL_TO                     - full-inquiry email recipient
//   SWAIN_EMAIL_FROM                   - sender address
//   TWILIO_ACCOUNT_SID                 - Twilio account sid
//   TWILIO_AUTH_TOKEN                  - Twilio auth token
//   SWAIN_SMS_FROM                     - E.164 sender number
//   SWAIN_SMS_TO_JENNA                 - Jenna's alert number (E.164)
//   SWAIN_SMS_TO_JOHN                  - John's alert number (E.164)
//   SWAIN_EMAIL_MAX_LEN / SWAIN_MSG_MAX_LEN / SWAIN_NAME_MAX_LEN
//   SWAIN_BODY_MAX_BYTES               - request body cap (default 12000)

import crypto from 'node:crypto';

export const SOURCE = 'swain-photography-preview';

// ---------------------------------------------------------------- config

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Normalize a value to an exact origin.
 *
 * Accepts EITHER:
 *   - a full origin        'https://host'  -> returned as-is
 *   - a bare host/hostname 'host'          -> becomes 'https://host'
 *
 * Vercel's platform env vars (VERCEL_URL, VERCEL_BRANCH_URL,
 * VERCEL_PROJECT_PRODUCTION_URL) are BARE HOSTNAMES with no scheme, so they
 * must be accepted and given one.
 *
 * Rejects (returns null): wildcards, paths, queries, fragments, embedded
 * credentials, non-http(s) schemes and anything unparseable. A rejected value
 * is dropped rather than widening the allowlist.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s || s.includes('*') || s.includes(' ')) return null;
  if (s.includes('@')) return null;                    // embedded credentials
  if (s.includes('?') || s.includes('#')) return null;  // query / fragment

  // A bare hostname gets the default https scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(s)) return null;
    s = 'https://' + s;
  }

  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // Only the root path is allowed (a trailing slash is the same origin).
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.search || u.hash) return null;
  if (!u.hostname || u.hostname.includes('*')) return null;
  return u.origin;
}

/**
 * Backoff delay for a failed job, in seconds, given how many attempts have
 * already been made. Exponential with a cap. Attempt 1 fails immediately-ish
 * (base), attempt 2 waits base*2, attempt 3 waits base*4, capped.
 */
export function retryDelaySeconds(attempts, base = 60, max = 3600) {
  const n = Math.max(1, Number(attempts) || 1);
  const d = base * Math.pow(2, n - 1);
  return Math.min(max, Math.round(d));
}

export const config = {
  get supabaseUrl() { return (process.env.SUPABASE_URL || '').replace(/\/+$/, ''); },
  get supabaseKey() { return process.env.SUPABASE_SERVICE_ROLE_KEY || ''; },

  /**
   * Allowed request origins.
   *
   * Priority:
   *   1. Vercel platform-provided values (VERCEL_BRANCH_URL / VERCEL_URL /
   *      VERCEL_PROJECT_PRODUCTION_URL). These are set automatically by Vercel
   *      for every deployment, so the allowlist follows the deployment instead
   *      of needing to be rewritten (and redeployed) every time a preview host
   *      changes. No wildcards: each entry is an exact origin string.
   *   2. SWAIN_ALLOWED_ORIGINS (comma-separated, exact origins) for anything
   *      the platform does not provide.
   *
   * Every candidate must be an exact `scheme://host[:port]` origin. A bare
   * hostname, a path, a wildcard, or a non-http(s) scheme is rejected, so a
   * misconfigured value can never widen the allowlist.
   */
  get allowedOrigins() {
    const raw = [
      process.env.SWAIN_ALLOWED_ORIGINS || '',
      process.env.VERCEL_BRANCH_URL || '',
      process.env.VERCEL_URL || '',
      process.env.VERCEL_PROJECT_PRODUCTION_URL || '',
    ].join(',');
    const out = [];
    for (const s of raw.split(',')) {
      const norm = normalizeOrigin(s.trim());
      if (norm && !out.includes(norm)) out.push(norm);
    }
    return out;
  },
  get hmacSecret() { return process.env.SWAIN_HMAC_SECRET || ''; },
  get ratePerIp() { return intEnv('SWAIN_RATE_PER_IP', 5); },
  get rateWindowSeconds() { return intEnv('SWAIN_RATE_WINDOW_SECONDS', 3600); },
  get rateGlobal() { return intEnv('SWAIN_RATE_GLOBAL', 50); },
  get rateGlobalWindowSeconds() { return intEnv('SWAIN_RATE_GLOBAL_WINDOW_SECONDS', 3600); },
  get notifyEnabled() { return process.env.SWAIN_NOTIFY_ENABLED === 'true'; },

  /**
   * Retry policy for FAILED (definitively rejected) jobs.
   *
   * A failed job is a definitive provider rejection (bad address, not
   * configured, etc.) - it is NOT ambiguous, so it is safe to retry. Before
   * this existed, `failed` was never claimed by anything, so failed jobs were
   * permanent dead letters even though the state machine documents them as
   * retryable.
   */
  get maxAttempts() { return intEnv('SWAIN_MAX_ATTEMPTS', 3); },
  get retryBaseSeconds() { return intEnv('SWAIN_RETRY_BASE_SECONDS', 60); },
  get retryMaxSeconds() { return intEnv('SWAIN_RETRY_MAX_SECONDS', 3600); },
  get emailTo() { return process.env.SWAIN_EMAIL_TO || ''; },
  get emailFrom() { return process.env.SWAIN_EMAIL_FROM || 'info@simpleagentworks.com'; },
  get twilioSid() { return process.env.TWILIO_ACCOUNT_SID || ''; },
  get twilioToken() { return process.env.TWILIO_AUTH_TOKEN || ''; },
  get smsFrom() { return process.env.SWAIN_SMS_FROM || ''; },
  get smsToJenna() { return process.env.SWAIN_SMS_TO_JENNA || ''; },
  get smsToJohn() { return process.env.SWAIN_SMS_TO_JOHN || ''; },
  get nameMax() { return intEnv('SWAIN_NAME_MAX_LEN', 120); },
  get emailMax() { return intEnv('SWAIN_EMAIL_MAX_LEN', 254); },
  get msgMax() { return intEnv('SWAIN_MSG_MAX_LEN', 4000); },
  get bodyMaxBytes() { return intEnv('SWAIN_BODY_MAX_BYTES', 12000); },
};

// ---------------------------------------------------------------- helpers

export function respond(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Extract a searchable error string from a storage failure.
 * PostgREST can return the useful text as a plain string, as
 * {message: ...}, or as {message: ..., detail: ...}. Check all of them.
 */
export function storageErrorText(err) {
  if (!err) return '';
  const parts = [];
  if (err.message) parts.push(String(err.message));
  const body = err.body;
  if (typeof body === 'string') {
    parts.push(body);
  } else if (body && typeof body === 'object') {
    for (const k of ['message', 'detail', 'error', 'hint', 'code']) {
      if (body[k]) parts.push(String(body[k]));
    }
  }
  if (err.status) parts.push('status=' + err.status);
  return parts.join(' | ');
}

/** Stable stringify so content comparison is order-independent. */
export function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

export function contentHash(payload) {
  return crypto.createHash('sha256').update(stable(payload)).digest('hex');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Constant-time string compare. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Derive a short-lived, pseudonymous rate-limit key from an IP address.
 * The raw IP is NEVER stored. Without a secret we fall back to a plain hash so
 * the key is still not the literal IP, but it is less privacy-preserving.
 */
export function rateKeyForIp(ip, scope, windowSeconds) {
  const secret = config.hmacSecret;
  const material = secret
    ? `${scope}|${ip}|${windowSeconds}|${new Date().toISOString().slice(0, 10)}`
    : `${scope}|${ip}|${windowSeconds}`;
  const digest = secret
    ? crypto.createHmac('sha256', secret).update(material).digest('hex')
    : crypto.createHash('sha256').update(material).digest('hex');
  // Bucket by window so keys naturally expire and stay short-lived.
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  return { key: digest.slice(0, 32) + ':' + bucket, bucket };
}

export function ipFromHeaders(headers) {
  const xff = headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const xri = headers['x-real-ip'];
  if (xri) return String(xri).trim();
  return 'unknown';
}

// ---------------------------------------------------------------- storage

async function sb(path, init = {}) {
  const url = config.supabaseUrl + '/rest/v1/' + path;
  const headers = {
    apikey: config.supabaseKey,
    Authorization: 'Bearer ' + config.supabaseKey,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error('storage: ' + res.status + ' ' + (typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)));
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function storageConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseKey);
}

/**
 * Shared, atomic rate limit. Uses the swain_rate_limit() SQL function so all
 * serverless instances share one counter. Falls back to an in-memory counter if
 * the database is unreachable (fail-open on storage outage, fail-closed only
 * for a definitive "not allowed" answer).
 */
const memBuckets = new Map();

export async function rateLimit(scope, ip) {
  const now = Date.now();
  const perKey = rateKeyForIp(ip, scope, config.rateWindowSeconds);
  const globalKey = rateKeyForIp('global', scope, config.rateGlobalWindowSeconds);

  if (!storageConfigured()) {
    // No database: in-memory fallback so local dev still works.
    const bump = (k, limit, window) => {
      const b = memBuckets.get(k);
      if (!b || b.resetAt <= now) {
        memBuckets.set(k, { count: 1, resetAt: now + window });
        return { allowed: true, remaining: limit - 1, resetMs: now + window };
      }
      if (b.count >= limit) return { allowed: false, remaining: 0, resetMs: b.resetAt };
      b.count += 1;
      return { allowed: true, remaining: limit - b.count, resetMs: b.resetAt };
    };
    const a = bump('ip:' + perKey.key, config.ratePerIp, config.rateWindowSeconds * 1000);
    const g = bump('g:' + globalKey.key, config.rateGlobal, config.rateGlobalWindowSeconds * 1000);
    if (!a.allowed) return { allowed: false, limit: config.ratePerIp, remaining: 0, resetMs: a.resetMs, scope: 'per-key' };
    if (!g.allowed) return { allowed: false, limit: config.rateGlobal, remaining: 0, resetMs: g.resetMs, scope: 'global' };
    return { allowed: true, limit: config.ratePerIp, remaining: Math.min(a.remaining, g.remaining), resetMs: Math.max(a.resetMs, g.resetMs) };
  }

  const call = async (key, scopeName, limit, windowSeconds) => {
    const res = await sb('rpc/swain_rate_limit', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        p_key: key,
        p_scope: scopeName,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      }),
    });
    const row = Array.isArray(res) ? res[0] : res;
    return {
      allowed: Boolean(row && row.allowed),
      limit,
      remaining: Math.max(0, limit - ((row && row.count) || 0)),
      resetMs: Math.max(0, (new Date((row && row.reset_at) || Date.now()).getTime()) - Date.now()),
    };
  };

  try {
    const a = await call(perKey.key, scope + ':ip', config.ratePerIp, config.rateWindowSeconds);
    if (!a.allowed) return { ...a, scope: 'per-key' };
    const g = await call(globalKey.key, scope + ':global', config.rateGlobal, config.rateGlobalWindowSeconds);
    if (!g.allowed) return { ...g, scope: 'global' };
    return { allowed: true, limit: a.limit, remaining: Math.min(a.remaining, g.remaining), resetMs: Math.max(a.resetMs, g.resetMs) };
  } catch (err) {
    // Storage outage: do not lock out real inquiries. Fail open, but record it.
    console.error('[swain] rate limit storage unavailable:', err.message);
    return { allowed: true, limit: config.ratePerIp, remaining: config.ratePerIp, resetMs: config.rateWindowSeconds * 1000, degraded: true };
  }
}

export function attachRateHeaders(res, r) {
  try {
    res.setHeader('X-RateLimit-Limit', String(r.limit));
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((r.resetMs || 0) / 1000)));
    if (!r.allowed) res.setHeader('Retry-After', String(Math.max(1, Math.ceil((r.resetMs || 0) / 1000))));
  } catch { /* headers already sent */ }
}

// ---------------------------------------------------------------- validation

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate and normalize an incoming inquiry.
 * Throws an Error with a .status and .publicMessage on rejection.
 */
export function validateInquiry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('Please check your details and try again.');
  }
  if (!UUID_V4.test(String(raw.submissionId || ''))) {
    throw badRequest('Please reload the page and try again.');
  }
  if (raw.clientId !== 'swain-photography') {
    throw badRequest('This form is not configured for this site.');
  }

  const clean = (key, max, required, label) => {
    const value = raw[key];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw badRequest('Please check the ' + label + ' field.');
    }
    // Strip control characters (keeps CR/LF out of email headers and SMS).
    const s = String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
    if (s.length > max) throw badRequest('Please shorten the ' + label + ' field.');
    if (required && !s) throw badRequest('Please complete the ' + label + ' field.');
    return s;
  };

  const name = clean('name', config.nameMax, true, 'name');
  const email = clean('email', config.emailMax, true, 'email');
  const message = clean('message', config.msgMax, true, 'message');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest('Please check the email address.');
  }
  if (/[\r\n]/.test(email)) {
    throw badRequest('Please check the email address.');
  }

  return {
    submissionId: String(raw.submissionId),
    clientId: 'swain-photography',
    name,
    email,
    message,
    source: SOURCE,
  };
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  e.publicMessage = message;
  return e;
}

// ---------------------------------------------------------------- outbox

/** Build the notification jobs for an inquiry. */
export function buildJobs(inquiry) {
  const ref = inquiry.submissionId.slice(0, 8);
  const jobs = [];

  const emailTo = config.emailTo;
  if (emailTo) {
    const subject = `New Swain Photography inquiry | ${inquiry.name}`;
    const body = [
      'A new inquiry was submitted on the Swain Photography preview.',
      '',
      'CONTACT',
      'Name: ' + inquiry.name,
      'Email: ' + inquiry.email,
      '',
      'DETAILS',
      inquiry.message,
      '',
      'Reference: ' + inquiry.submissionId,
      '',
      'Reply to this email to reply directly to the sender.',
    ].join('\n');
    jobs.push({
      channel: 'email',
      destination: 'jenna_email',
      recipient: emailTo,
      subject,
      body,
    });
  }

  const smsBody = [
    'New Swain Photography inquiry',
    inquiry.name,
    inquiry.email,
    inquiry.message.slice(0, 180),
    'Ref ' + ref,
  ].join('\n');

  if (config.smsToJenna) {
    jobs.push({ channel: 'sms', destination: 'jenna_sms', recipient: config.smsToJenna, subject: null, body: smsBody });
  }
  if (config.smsToJohn) {
    jobs.push({ channel: 'sms', destination: 'john_sms', recipient: config.smsToJohn, subject: null, body: smsBody });
  }
  return jobs;
}

/**
 * Capture the inquiry and enqueue notification jobs atomically.
 * Returns { created: bool, id, notifyState }.
 * Throws on content_mismatch (same id, different content).
 */
export async function captureInquiry(inquiry, jobs) {
  if (!storageConfigured()) {
    const e = new Error('storage not configured');
    e.status = 503;
    e.publicMessage = 'The inquiry form is temporarily unavailable. Please try again shortly.';
    throw e;
  }
  const payload = {
    p_id: inquiry.submissionId,
    p_content_hash: contentHash({ name: inquiry.name, email: inquiry.email, message: inquiry.message }),
    p_name: inquiry.name,
    p_email: inquiry.email,
    p_message: inquiry.message,
    p_source: inquiry.source,
    p_jobs: jobs,
  };
  const res = await sb('rpc/swain_capture_inquiry', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  const row = Array.isArray(res) ? res[0] : res;
  if (!row) {
    const e = new Error('capture returned no row');
    e.status = 503;
    e.publicMessage = 'We could not confirm your inquiry was saved. Please try again.';
    throw e;
  }
  return { created: Boolean(row.created), id: row.id, notifyState: row.notify_state };
}

/** Read the per-recipient notification states for an inquiry. */
export async function notificationStates(inquiryId) {
  const rows = await sb('swain_notification_outbox?inquiry_id=eq.' + encodeURIComponent(inquiryId) +
    '&select=destination,recipient,channel,state,attempts,provider_ref,provider_status,last_error,updated_at' +
    '&order=destination.asc');
  return rows || [];
}
