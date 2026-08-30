-- Phase 10 durable transactional-outbox delivery state and least-privilege worker API.

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'creatordrop_worker') then
    create role creatordrop_worker
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit;
  end if;
end
$roles$;

grant creatordrop_worker to postgres;

do $database_privileges$
begin
  execute format(
    'grant connect on database %I to creatordrop_worker',
    current_database()
  );
end
$database_privileges$;

set role creatordrop_migrator;

alter table app.event_outbox
  add column status text not null default 'pending',
  add column attempt_count integer not null default 0,
  add column available_at timestamptz,
  add column claimed_at timestamptz,
  add column lease_expires_at timestamptz,
  add column claimed_by text,
  add column claim_token uuid,
  add column processed_at timestamptz,
  add column last_error_code text;

update app.event_outbox
set available_at = created_at
where available_at is null;

alter table app.event_outbox
  alter column available_at set default statement_timestamp(),
  alter column available_at set not null,
  add constraint event_outbox_status_check check (
    status in ('pending', 'processing', 'delivered', 'dead')
  ),
  add constraint event_outbox_attempt_count_check check (attempt_count >= 0),
  add constraint event_outbox_available_order_check check (available_at >= created_at),
  add constraint event_outbox_claimed_by_check check (
    claimed_by is null or claimed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  add constraint event_outbox_last_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  add constraint event_outbox_delivery_shape_check check (
    (
      status = 'pending'
      and claimed_at is null
      and lease_expires_at is null
      and claimed_by is null
      and claim_token is null
      and processed_at is null
    )
    or (
      status = 'processing'
      and attempt_count > 0
      and claimed_at is not null
      and lease_expires_at > claimed_at
      and claimed_by is not null
      and claim_token is not null
      and processed_at is null
    )
    or (
      status = 'delivered'
      and attempt_count > 0
      and claimed_at is null
      and lease_expires_at is null
      and claimed_by is null
      and claim_token is null
      and processed_at is not null
    )
    or (
      status = 'dead'
      and attempt_count > 0
      and claimed_at is null
      and lease_expires_at is null
      and claimed_by is null
      and claim_token is null
      and processed_at is null
      and last_error_code is not null
    )
  );

create index event_outbox_delivery_idx
  on app.event_outbox (status, available_at, lease_expires_at, created_at, id);

drop trigger event_outbox_update_guard on app.event_outbox;

create function app_private.protect_event_outbox_history()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '23514',
      constraint = 'event_outbox_history_immutable',
      message = 'Outbox event history cannot be deleted.';
  end if;

  if tg_op = 'INSERT' then
    new.available_at := new.created_at;
    if new.status <> 'pending'
      or new.attempt_count <> 0
      or new.claimed_at is not null
      or new.lease_expires_at is not null
      or new.claimed_by is not null
      or new.claim_token is not null
      or new.processed_at is not null
      or new.last_error_code is not null then
      raise exception using
        errcode = '23514',
        constraint = 'event_outbox_initial_delivery_state_invalid',
        message = 'New outbox events must begin in the pending delivery state.';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.aggregate_type is distinct from old.aggregate_type
    or new.aggregate_id is distinct from old.aggregate_id
    or new.event_type is distinct from old.event_type
    or new.audience is distinct from old.audience
    or new.payload is distinct from old.payload
    or new.occurred_at is distinct from old.occurred_at
    or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      constraint = 'event_outbox_history_immutable',
      message = 'Outbox event identity and content are immutable.';
  end if;

  return new;
end
$function$;

create trigger event_outbox_000_history_guard
before insert or update or delete on app.event_outbox
for each row execute function app_private.protect_event_outbox_history();

create function app.claim_outbox_events(
  claiming_worker_id text,
  batch_size integer,
  lease_duration_ms integer,
  maximum_attempts integer
)
returns table (
  id uuid,
  aggregate_id uuid,
  event_type text,
  audience text,
  payload jsonb,
  occurred_at timestamptz,
  attempt_count integer,
  claim_token uuid,
  opening_public_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if claiming_worker_id is null
    or claiming_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using errcode = '22023', message = 'Invalid outbox worker identifier.';
  end if;
  if batch_size is null or batch_size < 1 or batch_size > 100 then
    raise exception using errcode = '22023', message = 'Invalid outbox batch size.';
  end if;
  if lease_duration_ms is null or lease_duration_ms < 1000 or lease_duration_ms > 300000 then
    raise exception using errcode = '22023', message = 'Invalid outbox lease duration.';
  end if;
  if maximum_attempts is null or maximum_attempts < 1 or maximum_attempts > 100 then
    raise exception using errcode = '22023', message = 'Invalid maximum outbox attempts.';
  end if;

  update app.event_outbox as event
  set status = 'dead',
      claimed_at = null,
      lease_expires_at = null,
      claimed_by = null,
      claim_token = null,
      processed_at = null,
      last_error_code = 'MAX_ATTEMPTS_EXCEEDED'
  where event.attempt_count >= maximum_attempts
    and (
      event.status = 'pending'
      or (
        event.status = 'processing'
        and event.lease_expires_at <= clock_timestamp()
      )
    );

  return query
  with candidates as (
    select event.id
    from app.event_outbox as event
    where (
      event.status = 'pending'
      and event.available_at <= clock_timestamp()
      and event.attempt_count < maximum_attempts
    ) or (
      event.status = 'processing'
      and event.lease_expires_at <= clock_timestamp()
      and event.attempt_count < maximum_attempts
    )
    order by event.available_at, event.created_at, event.id
    for update skip locked
    limit batch_size
  ), claimed as (
    update app.event_outbox as event
    set status = 'processing',
        attempt_count = event.attempt_count + 1,
        claimed_at = clock_timestamp(),
        lease_expires_at = clock_timestamp() + make_interval(secs => lease_duration_ms / 1000.0),
        claimed_by = claiming_worker_id,
        claim_token = extensions.gen_random_uuid(),
        processed_at = null
    from candidates
    where event.id = candidates.id
    returning event.*
  )
  select
    claimed.id,
    claimed.aggregate_id,
    claimed.event_type,
    claimed.audience,
    claimed.payload,
    claimed.occurred_at,
    claimed.attempt_count,
    claimed.claim_token,
    opening.public_id as opening_public_id
  from claimed
  join app.box_opens as opening on opening.id = claimed.aggregate_id
  order by claimed.available_at, claimed.created_at, claimed.id;
end
$function$;

create function app.complete_outbox_event(event_id uuid, event_claim_token uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  update app.event_outbox
  set status = 'delivered',
      claimed_at = null,
      lease_expires_at = null,
      claimed_by = null,
      claim_token = null,
      processed_at = clock_timestamp(),
      last_error_code = null
  where id = event_id
    and status = 'processing'
    and claim_token = event_claim_token;

  if not found then
    raise exception using
      errcode = '40001',
      constraint = 'event_outbox_claim_not_owned',
      message = 'The outbox claim is no longer owned by this delivery attempt.';
  end if;
end
$function$;

create function app.fail_outbox_event(
  event_id uuid,
  event_claim_token uuid,
  failure_code text,
  retry_at timestamptz,
  terminal boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if failure_code is null or failure_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'Invalid outbox failure code.';
  end if;
  if terminal is null or (not terminal and (retry_at is null or retry_at <= clock_timestamp())) then
    raise exception using errcode = '22023', message = 'Invalid outbox retry policy.';
  end if;

  update app.event_outbox
  set status = case when terminal then 'dead' else 'pending' end,
      available_at = case when terminal then available_at else retry_at end,
      claimed_at = null,
      lease_expires_at = null,
      claimed_by = null,
      claim_token = null,
      processed_at = null,
      last_error_code = failure_code
  where id = event_id
    and status = 'processing'
    and claim_token = event_claim_token;

  if not found then
    raise exception using
      errcode = '40001',
      constraint = 'event_outbox_claim_not_owned',
      message = 'The outbox claim is no longer owned by this delivery attempt.';
  end if;
end
$function$;

create function app.read_outbox_lag()
returns table (
  pending_count bigint,
  processing_count bigint,
  dead_count bigint,
  oldest_ready_age_ms bigint
)
language sql
security definer
set search_path = ''
as $function$
  select
    count(*) filter (where status = 'pending') as pending_count,
    count(*) filter (where status = 'processing') as processing_count,
    count(*) filter (where status = 'dead') as dead_count,
    coalesce(
      greatest(
        0,
        floor(
          extract(epoch from (clock_timestamp() - min(created_at) filter (
            where (status = 'pending' and available_at <= clock_timestamp())
              or (status = 'processing' and lease_expires_at <= clock_timestamp())
          ))) * 1000
        )::bigint
      ),
      0
    ) as oldest_ready_age_ms
  from app.event_outbox
$function$;

revoke all on table app.event_outbox from creatordrop_worker;
revoke all on function app.claim_outbox_events(text, integer, integer, integer)
  from public, creatordrop_app;
revoke all on function app.complete_outbox_event(uuid, uuid) from public, creatordrop_app;
revoke all on function app.fail_outbox_event(uuid, uuid, text, timestamptz, boolean)
  from public, creatordrop_app;
revoke all on function app.read_outbox_lag() from public, creatordrop_app;

grant usage on schema app to creatordrop_worker;
grant execute on function app.claim_outbox_events(text, integer, integer, integer)
  to creatordrop_worker;
grant execute on function app.complete_outbox_event(uuid, uuid) to creatordrop_worker;
grant execute on function app.fail_outbox_event(uuid, uuid, text, timestamptz, boolean)
  to creatordrop_worker;
grant execute on function app.read_outbox_lag() to creatordrop_worker;

comment on table app.event_outbox is
  'Immutable committed opening events with mutable, lease-protected Phase 10 delivery metadata.';
comment on function app.claim_outbox_events(text, integer, integer, integer) is
  'Claims committed ready outbox events with SKIP LOCKED and a crash-recoverable lease.';

reset role;
