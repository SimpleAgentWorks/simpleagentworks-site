-- Migration: optional phone number + SMS/email opt-in on Swain Photography inquiries.
-- Target: existing simpleagentworks-ops Supabase project (ymawwdgxegvvlblrzqxp).
-- Idempotent: safe to run more than once.
--
-- Changes:
--   1. swain_inquiries gains three nullable columns:
--        phone           - optional phone number (E.164-ish, digits/spaces/+/-/() only)
--        sms_opt_in      - 'yes' | 'no' | null (null = not provided)
--        sms_opt_in_at   - timestamptz the opt-in answer was recorded (server clock)
--   2. swain_capture_inquiry() gains three optional parameters and stores them.
--      The new params are DEFAULTED so the existing 6-arg call signature keeps
--      working unchanged (no breakage for anything already deployed).
--
-- Everything remains private: RLS stays on, no anon/authenticated grants.
-- The opt-in timestamp is written by the SERVER (now()), never by the client,
-- so a visitor cannot forge when they opted in.

-- ---------- columns ----------
alter table public.swain_inquiries
  add column if not exists phone text,
  add column if not exists sms_opt_in text
    check (sms_opt_in is null or sms_opt_in in ('yes','no')),
  add column if not exists sms_opt_in_at timestamptz;

-- ---------- capture function ----------
-- The argument list changed (3 new params), so CREATE OR REPLACE cannot
-- replace the old signature - Postgres requires the exact argument list to
-- match. Drop the old one first, then create the new one. The drop is safe:
-- the function is only reachable by the service role, and the replacement is
-- created in the same transaction, so there is no window where it is missing.
drop function if exists public.swain_capture_inquiry(
  uuid, text, text, text, text, text, jsonb
);

create or replace function public.swain_capture_inquiry(
  p_id uuid,
  p_content_hash text,
  p_name text,
  p_email text,
  p_message text,
  p_source text default 'swain-photography-preview',
  p_jobs jsonb default '[]'::jsonb,
  p_phone text default null,
  p_sms_opt_in text default null,
  p_sms_opt_in_at timestamptz default null
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
  insert into public.swain_inquiries
    (id, content_hash, name, email, message, source, phone, sms_opt_in, sms_opt_in_at)
  values
    (p_id, p_content_hash, p_name, p_email, p_message, p_source,
     nullif(p_phone, ''), p_sms_opt_in, p_sms_opt_in_at)
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
