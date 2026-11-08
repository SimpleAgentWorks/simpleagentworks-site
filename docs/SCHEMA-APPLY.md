# Swain Photography inquiry flow — schema + setup

**Status:** built on `feat/swain-photography-inquiry`, NOT merged, NOT deployed.
**Owner:** John Charles Swain / Agent02
**Created:** 2026-11-07

---

## 1. What this does

The inquiry form on `preview/swain-photography/index.html` POSTs to
`POST /api/swain/inquiry`. That endpoint:

1. Validates and caps all input server-side.
2. Rate-limits with a shared, atomic counter.
3. Captures the inquiry **and** enqueues all notification jobs in **one
   database transaction**.
4. Returns success **only** after that transaction commits.

A background worker then drains the durable outbox, sending one full-inquiry
email and two alert texts, tracking each recipient separately.

```
browser ──POST /api/swain/inquiry──▶ api/swain/inquiry.mjs
                                        │
                                        ├─ swain_capture_inquiry()  ── ONE TX ──┐
                                        │    ├─ insert swain_inquiries          │
                                        │    └─ insert swain_notification_outbox (×3)
                                        └──────────────────────────────────────┘
                                                     │
                                                     ▼
                            swain_notification_outbox (durable queue)
                                       │            │            │
                                  jenna_email   jenna_sms    john_sms
                                       │            │            │
                                  email worker  Twilio API  Twilio API
```

---

## 2. Storage choice

**Supabase (Postgres) — the existing `simpleagentworks-ops` project
(`ymawwdgxegvvlblrzqxp`).** This is the same store already used by
`joshmaxwell-site` (`quote_leads`) and `cotton-candy-kiosk`. No new paid
service, no new project, no new account.

Three new tables (`backend/swain-inquiry-schema.sql`):

| table | purpose |
|---|---|
| `swain_inquiries` | one row per accepted inquiry; `id` (client submission UUID) is the PK |
| `swain_notification_outbox` | durable queue; `unique (inquiry_id, destination)` guarantees one job per recipient |
| `swain_rate_limits` | shared atomic rate-limit buckets, keyed by an HMAC-derived pseudonym |

Two SQL functions:

| function | purpose |
|---|---|
| `swain_capture_inquiry(...)` | inserts the inquiry + all notification jobs in ONE transaction; on PK conflict returns the existing row, or raises `content_mismatch` if the content differs |
| `swain_rate_limit(...)` | single-statement upsert+increment = one shared counter across every serverless instance |

All three tables have **RLS enabled**, no `anon`/`authenticated` grants, and no
public policies. Only `service_role` can read or write them.

---

## 3. Applying the schema  ⚠️ REQUIRES JOHN

Agent02's service-role key can do DML but **not DDL**, and the stored
`SUPABASE_DB_PASSWORD` no longer authenticates (verified: `password
authentication failed`). Two options — either is fine:

### Option A — Supabase Dashboard SQL editor (fastest)
1. Open the ops project → **SQL Editor** → **New query**.
2. Paste the contents of `backend/swain-inquiry-schema.sql`.
3. Run it. It is idempotent (`create table if not exists`, `create or replace
   function`) and safe to run twice.

### Option B — psql from the Mac mini
```bash
# Get the database password from the Supabase dashboard → Project Settings → Database
export PGPASSWORD='<db password>'
psql "postgresql://postgres.<project-ref>:<db-password>@db.<project-ref>.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f backend/swain-inquiry-schema.sql
```
> If the direct host resolves to IPv6 only, use the **Supavisor** connection
> string from the dashboard instead.

### Verify it worked
```bash
psql "$DATABASE_URL" -c "\dt public.swain_*"
psql "$DATABASE_URL" -c "\df public.swain_*"
```

---

## 4. Configuration variable names

Set these as **Vercel environment variables** for the `simpleagentworks-site`
project (Settings → Environment Variables). **Never** put a value in code, in
this repo, in chat, or in any report.

### Required for capture
| variable | value | notes |
|---|---|---|
| `SUPABASE_URL` | existing ops project URL | already used by other services |
| `SUPABASE_SERVICE_ROLE_KEY` | existing ops service-role key | server-only |

### Required for the origin allowlist
| variable | value |
|---|---|
| `SWAIN_ALLOWED_ORIGINS` | `https://www.simpleagentworks.com` (add the preview origin while testing) |

### Required for rate limiting
| variable | value | default |
|---|---|---|
| `SWAIN_HMAC_SECRET` | random 32+ byte secret | none — **must be set** |
| `SWAIN_RATE_PER_IP` | requests per window per key | `5` |
| `SWAIN_RATE_WINDOW_SECONDS` | window length | `3600` |
| `SWAIN_RATE_GLOBAL` | requests per window overall | `50` |
| `SWAIN_RATE_GLOBAL_WINDOW_SECONDS` | window length | `3600` |

### Required for notifications (activation)
| variable | value |
|---|---|
| `SWAIN_NOTIFY_ENABLED` | `false` until John approves activation, then `true` |
| `SWAIN_EMAIL_TO` | `writetojennaswain@gmail.com` |
| `SWAIN_EMAIL_FROM` | `info@simpleagentworks.com` |
| `TWILIO_ACCOUNT_SID` | existing Twilio account SID |
| `TWILIO_AUTH_TOKEN` | existing Twilio auth token |
| `SWAIN_SMS_FROM` | `+16304261230` (E.164 — see §6) |
| `SWAIN_SMS_TO_JENNA` | `+16303443087` |
| `SWAIN_SMS_TO_JOHN` | `+16304560567` |

### Optional
| variable | purpose | default |
|---|---|---|
| `SWAIN_WORKER_TOKEN` | bearer token guarding `POST /api/swain/notifications` | unset (endpoint open — set it) |
| `SWAIN_NAME_MAX_LEN` / `SWAIN_EMAIL_MAX_LEN` / `SWAIN_MSG_MAX_LEN` | input caps | `120` / `254` / `4000` |
| `SWAIN_BODY_MAX_BYTES` | request body cap | `12000` |
| `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | only if the email leg moves to Vercel instead of the local worker (see §6) | unset |

---

## 5. Running the tests

```bash
# local postgres (test database only — never production)
initdb -D /tmp/swain-pgtest/data -U postgres --auth=trust
LC_ALL=C pg_ctl -D /tmp/swain-pgtest/data \
  -o "-p 55432 -k /tmp/swain-pgtest -c listen_addresses=127.0.0.1" -l /tmp/swain-pgtest/pg.log start

psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c "create database swain_test;"
psql -h 127.0.0.1 -p 55432 -U postgres -d swain_test \
  -v ON_ERROR_STOP=1 -f backend/swain-inquiry-schema.sql

# functional suite (80 assertions, no real sends)
node tests/swain-inquiry.test.mjs

# visual/interaction suite (desktop + mobile)
NODE_PATH=/Users/agent01/.openclaw/workspace/node_modules node tests/swain-form-visual.test.mjs
```

The suite needs the `pg` package for the test harness only:
```bash
mkdir -p /tmp/swain-pgdeps && cd /tmp/swain-pgdeps && npm init -y
npm_config_cache=/tmp/swain-npm-cache npm install pg@8
# then: ln -sfn /tmp/swain-pgdeps/node_modules/pg <repo>/node_modules/pg
```
> `~/.npm` on this machine is a **broken symlink** to the retired USB drive
> (`/Volumes/ExtUSB1/openclaw-data/npm-cache`). Use `npm_config_cache=/tmp/...`
> or fix the symlink.

---

## 6. The email leg — why there is a local worker

The SMS leg is straightforward: Twilio's REST API works from anywhere with an
account SID + auth token, so `api/swain/notifications.mjs` can send from
Vercel directly.

The email leg is not. The **only** working Gmail credential for
`info@simpleagentworks.com` is the `gog` CLI's OAuth refresh token, which
lives in the **macOS Keychain** and cannot be moved into a serverless runtime.
The alternatives were checked and rejected:

| option | status |
|---|---|
| Gmail API from Vercel with a refresh token | needs John to re-authorize `gog` for a new refresh token, or to supply one another way |
| Gmail SMTP + app password for `info@simpleagentworks.com` | needs John to create a Google app password (a credential change) |
| Apps Script relay (the `joshmaxwell-site` pattern) | the account's Apps Script scope is **not authorized**; `gog script content` returns `403 insufficientPermissions` |
| Service account + domain-wide delegation | Workspace-only; `simpleagentworks.com` is a personal Gmail account |
| 1Password vault | `op` CLI has **no accounts configured**; MEMORY.md confirms email creds are not in 1Password |
| **Local worker using `gog`** | **chosen** — uses the credential that already works, adds no credential, no paid service |

`scripts/swain-notification-worker.mjs` polls the same durable outbox and sends
email via `gog`. Because the outbox is the single source of truth and jobs are
claimed atomically, the Vercel worker and the local worker can never
double-send.

**Trade-off to be aware of:** if the Mac mini is off or asleep, the **email**
leg waits (the inquiry is still safely captured, and the SMS alerts still go
out). The Mac mini currently never sleeps (`pmset`: `sleep 0`).

### Moving the email leg into Vercel later
Set `GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` in Vercel
and `api/swain/notifications.mjs` will prefer the Gmail API transport over
`gog`. No other code change is needed.

### Running the local worker
```bash
cd simpleagentworks-site
# dry run: reads the outbox, sends nothing
node scripts/swain-notification-worker.mjs --once
# read-only status view
node scripts/swain-notification-worker.mjs --status
# actual sending (only after John approves activation)
node scripts/swain-notification-worker.mjs --once --allow-send
```
It needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in the environment
(currently in `dashboards/.env`).

---

## 7. Notification state model

Each recipient has its own row and its own state:

| state | meaning | auto-retry? |
|---|---|---|
| `pending` | never attempted | yes |
| `sending` | claimed by a worker; lease active | — |
| `accepted` | **provider accepted** (Twilio SID / Gmail message id) | no |
| `delivered` | provider confirmed delivery | no |
| `failed` | provider definitively rejected (4xx) | yes, later |
| `held` | **ambiguous** (timeout, 5xx, unparseable, expired lease) | **NO — human review first** |

`accepted` is deliberately distinct from `delivered`: a saved inquiry is never
reported as "notified" merely because it was stored. Twilio does not return a
delivery receipt on the send response, so `accepted` is the strongest claim the
API can honestly make without a status callback.

A worker that dies mid-send leaves `state='sending'` with an expired lease. The
next worker **holds** it rather than resending, because the provider may
already have delivered it.

---

## 8. Failure behaviour

| situation | result |
|---|---|
| storage unreachable on capture | **503** + error message — never a false success |
| storage unreachable on rate limit | fails **open** (so real inquiries are not locked out) and logs the degradation |
| body over cap | 413 |
| invalid field | 400 + field-specific message |
| foreign or missing `Origin` | 403 |
| over rate limit | 429 + `Retry-After` |
| same submission id, same content | 200, `duplicate: true` — no new row, no new jobs, no new notifications |
| same submission id, different content | **409** — the stored record is not overwritten |
| honeypot filled | 200 success (so the bot learns nothing) — **nothing saved, nothing sent** |

---

## 9. Privacy

- No IP address is stored on an inquiry record — there is no IP column.
- Rate-limit keys are `HMAC-SHA256(scope|ip|window|today)` truncated to 32 hex
  chars plus a window bucket. Not reversible without `SWAIN_HMAC_SECRET`.
- Inquiries are private: RLS enabled, no `anon`/`authenticated` grants, no
  public policies. Only the service-role key (server-side) can read them.
- Inquiry content is never written to public logs. The endpoint logs only
  error messages, not payloads.
- The preview page is `noindex,nofollow` and is not listed in `sitemap.xml`.

---

## 10. Remaining activation gates (nothing is live yet)

1. **John applies the schema** (§3) — required, Agent02 cannot.
2. **John sets `SWAIN_HMAC_SECRET`** and the Vercel env vars (§4).
3. **John decides the email transport**:
   - accept the local-worker dependency on the Mac mini, **or**
   - authorize a Gmail API refresh token / app password for Vercel, **or**
   - authorize the Apps Script scope for the `joshmaxwell-site` relay pattern.
4. **John approves the exact live-test recipients** and the message text.
5. **John approves deployment** (merge to `main` / production deploy).
6. Only then: `SWAIN_NOTIFY_ENABLED=true` and a single controlled live test.

No recharge, registration, or new subscription has been made or proposed.
