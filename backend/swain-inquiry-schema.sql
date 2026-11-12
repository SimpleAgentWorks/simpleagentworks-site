-- Swain Photography inquiry capture + notification outbox
-- Target: existing simpleagentworks-ops Supabase project (ymawwdgxegvvlblrzqxp).
-- Apply with the postgres role that owns the project (Agent02's service_role key
-- cannot run DDL). See docs/SCHEMA-APPLY.md for the exact command.
--
-- Design goals (per John's requirements):
--   * Atomic capture: one INSERT, no lookup-then-append.
--   * Capture + notification jobs in ONE transaction (outbox pattern).
--   * Unique submission id => duplicate posts cannot duplicate records.
--   * Same id + different content => rejected (409) by the API via content hash.
--   * Per-recipient notification state, tracking accepted vs delivered.
--   * No IP addresses in inquiry records (rate-limit keys are HMAC-derived and
--     stored only in the rate limit table, with a short TTL).
--
-- All tables are private: RLS enabled, no anon/authenticated grants.

-- ---------- inquiries ----------
-- One row per accepted inquiry. `id` is the client-supplied submission id
-- (UUID v4) and is the PRIMARY KEY, which makes the insert itself the
-- deduplication mechanism: a duplicate post collides on the primary key.
create table if not exists public.swain_inquiries (
  id             uuid primary key,
  content_hash   text not null,
  name           text not null,
  email          text not null,
  message        text not null,
  source         text not null default 'swain-photography-preview',
  created_at     timestamptz not null default now(),
  -- 'captured' => durably stored, notifications not yet completed.
  -- 'notified' => every notification job reached a terminal state.
  notify_state   text not null default 'captured'
    check (notify_state in ('captured','notified','partial','held')),
  constraint swain_inquiries_email_chk check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create index if not exists swain_inquiries_created_at_idx
  on public.swain_inquiries (created_at desc);
create index if not exists swain_inquiries_notify_state_idx
  on public.swain_inquiries (notify_state);

-- ---------- notification_outbox ----------
-- Durable queue. Rows are inserted in the SAME transaction as the inquiry row,
-- so a crash can never leave a saved inquiry with a missing notification job.
-- The worker claims rows with FOR UPDATE SKIP LOCKED and advances each row's
-- state independently.
create table if not exists public.swain_notification_outbox (
  id             uuid primary key default gen_random_uuid(),
  inquiry_id     uuid not null references public.swain_inquiries(id) on delete cascade,
  -- 'email' | 'sms'
  channel        text not null check (channel in ('email','sms')),
  -- stable destination key, e.g. 'jenna_email', 'jenna_sms', 'john_sms'
  destination    text not null,
  recipient      text not null,
  subject        text,
  body           text not null,
  -- 'pending'   => never attempted
  -- 'sending'   => claimed by a worker; ambiguous if the worker dies here
  -- 'accepted'  => provider accepted the message (Twilio SID / Gmail message id)
  -- 'delivered' => provider confirmed delivery
  -- 'failed'    => provider rejected; retryable
  -- 'held'      => ambiguous/uncertain result => DO NOT auto-retry, needs review
  state          text not null default 'pending'
    check (state in ('pending','sending','accepted','delivered','failed','held')),
  attempts       int not null default 0,
  provider_ref   text,
  provider_status text,
  last_error     text,
  -- set when state='sending' so a crashed worker can be detected and held
  lease_until    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  delivered_at   timestamptz,
  -- exactly one job per (inquiry, destination): retries can never double-notify
  unique (inquiry_id, destination)
);

create index if not exists swain_outbox_state_idx
  on public.swain_notification_outbox (state, created_at);
create index if not exists swain_outbox_inquiry_idx
  on public.swain_notification_outbox (inquiry_id);

-- ---------- rate_limits ----------
-- Shared, atomic rate limiting across all serverless instances.
-- key is an HMAC-derived pseudonymous identifier (never a raw IP address).
-- rows expire and are deleted by the worker / a periodic cleanup.
create table if not exists public.swain_rate_limits (
  key          text primary key,
  scope        text not null,
  count        int not null default 0,
  window_start timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '1 hour',
  updated_at   timestamptz not null default now()
);

create index if not exists swain_rate_limits_expires_idx
  on public.swain_rate_limits (expires_at);

-- ---------- private access ----------
-- Supabase has `anon` and `authenticated` roles; a vanilla Postgres does not.
-- The DO blocks are no-ops there, so this script applies cleanly in both places.
alter table public.swain_inquiries enable row level security;
alter table public.swain_notification_outbox enable row level security;
alter table public.swain_rate_limits enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.swain_inquiries from anon;
    revoke all on public.swain_notification_outbox from anon;
    revoke all on public.swain_rate_limits from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.swain_inquiries from authenticated;
    revoke all on public.swain_notification_outbox from authenticated;
    revoke all on public.swain_rate_limits from authenticated;
  end if;
end $$;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select,insert,update,delete on public.swain_inquiries to service_role;
    grant select,insert,update,delete on public.swain_notification_outbox to service_role;
    grant select,insert,update,delete on public.swain_rate_limits to service_role;
  end if;
end $$;

-- ---------- atomicity helper ----------
-- Captures the inquiry AND enqueues all notification jobs in ONE transaction.
-- If the inquiry id already exists:
--   * same content_hash  -> returns the existing inquiry (duplicate, no new jobs)
--   * different hash     -> raises 'content_mismatch' so the API can 409
-- This is what makes "capture + jobs atomically" true: there is no window in
-- which an inquiry exists without its notification jobs.
create or replace function public.swain_capture_inquiry(
  p_id uuid,
  p_content_hash text,
  p_name text,
  p_email text,
  p_message text,
  p_source text default 'swain-photography-preview',
  p_jobs jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing record;
  v_created boolean := false;
  v_job jsonb;
begin
  -- Capture the inquiry. ON CONFLICT DO NOTHING makes this an atomic
  -- insert-or-detect, never a lookup-then-append race.
  insert into public.swain_inquiries (id, content_hash, name, email, message, source)
  values (p_id, p_content_hash, p_name, p_email, p_message, p_source)
  on conflict (id) do nothing;

  get diagnostics v_created = row_count;

  if v_created then
    -- Enqueue every notification job in the SAME transaction.
    for v_job in select * from jsonb_array_elements(p_jobs) loop
      insert into public.swain_notification_outbox
        (inquiry_id, channel, destination, recipient, subject, body, state)
      values (
        p_id,
        v_job->>'channel',
        v_job->>'destination',
        v_job->>'recipient',
        v_job->>'subject',
        v_job->>'body',
        'pending'
      )
      on conflict (inquiry_id, destination) do nothing;
    end loop;
  else
    -- Duplicate id. Same content => idempotent replay, return stored record.
    -- Different content => reject.
    select id, content_hash, created_at into v_existing
      from public.swain_inquiries where id = p_id;

    if v_existing.content_hash <> p_content_hash then
      raise exception 'content_mismatch'
        using errcode = 'P0001',
              detail = 'Submission id already used with different content';
    end if;
  end if;

  return jsonb_build_object(
    'created', v_created,
    'id', p_id,
    'notify_state', (select notify_state from public.swain_inquiries where id = p_id)
  );
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.swain_capture_inquiry from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.swain_capture_inquiry from authenticated;
  end if;
end $$;
revoke all on function public.swain_capture_inquiry from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.swain_capture_inquiry to service_role;
  end if;
end $$;

-- ---------- atomic rate limit ----------
-- Increments a bucket in one statement. Returns whether the request is allowed
-- and the remaining allowance. The key is an HMAC-derived pseudonymous id.
create or replace function public.swain_rate_limit(
  p_key text,
  p_scope text,
  p_limit int,
  p_window_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.swain_rate_limits%rowtype;
  v_now timestamptz := now();
begin
  -- Single statement upsert + increment = atomic across all instances.
  insert into public.swain_rate_limits (key, scope, count, window_start, expires_at, updated_at)
  values (p_key, p_scope, 1, v_now, v_now + make_interval(secs => p_window_seconds), v_now)
  on conflict (key) do update set
    count = case
              when public.swain_rate_limits.expires_at <= v_now then 1
              else public.swain_rate_limits.count + 1
            end,
    window_start = case
              when public.swain_rate_limits.expires_at <= v_now then v_now
              else public.swain_rate_limits.window_start
            end,
    expires_at = case
              when public.swain_rate_limits.expires_at <= v_now then v_now + make_interval(secs => p_window_seconds)
              else public.swain_rate_limits.expires_at
            end,
    updated_at = v_now
  returning * into v_row;

  return jsonb_build_object(
    'allowed', v_row.count <= p_limit,
    'count', v_row.count,
    'limit', p_limit,
    'reset_at', v_row.expires_at
  );
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.swain_rate_limit from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.swain_rate_limit from authenticated;
  end if;
end $$;
revoke all on function public.swain_rate_limit from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.swain_rate_limit to service_role;
  end if;
end $$;
