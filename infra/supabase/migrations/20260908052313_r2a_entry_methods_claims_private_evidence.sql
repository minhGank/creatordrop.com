-- R2A: private manual-evidence claims. No opening/RNG manifest or ledger changes.
set role creatordrop_migrator;

create table app.entry_methods (
  id uuid primary key,
  creator_id uuid not null references app.creators(id),
  box_id uuid not null,
  draft jsonb not null check (jsonb_typeof(draft) = 'object' and octet_length(draft::text) <= 12000),
  enabled boolean not null default true,
  revision integer not null default 1 check (revision > 0),
  current_policy_id uuid,
  created_by_user_id uuid not null references app.users(id),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (id, creator_id, box_id),
  foreign key (box_id, creator_id) references app.boxes(id, creator_id)
);

create table app.entry_policy_versions (
  id uuid primary key,
  method_id uuid not null,
  creator_id uuid not null,
  box_id uuid not null,
  box_version_id uuid not null references app.box_versions(id),
  version_number integer not null check (version_number > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  openings_granted bigint not null check (openings_granted > 0),
  per_user_claim_limit bigint not null check (per_user_claim_limit > 0),
  published_by_user_id uuid not null references app.users(id),
  published_at timestamptz not null default statement_timestamp(),
  unique (method_id, version_number),
  unique (id, method_id, creator_id, box_id),
  foreign key (method_id, creator_id, box_id) references app.entry_methods(id, creator_id, box_id)
);
alter table app.entry_methods add foreign key (current_policy_id, id, creator_id, box_id)
  references app.entry_policy_versions(id, method_id, creator_id, box_id);

create table app.entry_evidence_objects (
  id uuid primary key,
  user_id uuid not null references app.users(id),
  creator_id uuid not null,
  box_id uuid not null,
  policy_id uuid not null,
  method_id uuid not null,
  media_type text not null check (media_type in ('image/png', 'image/jpeg')),
  byte_length integer not null check (byte_length between 1 and 5242880),
  content_hash bytea check (octet_length(content_hash) = 32),
  created_at timestamptz not null default statement_timestamp(),
  uploaded_at timestamptz,
  foreign key (policy_id, method_id, creator_id, box_id)
    references app.entry_policy_versions(id, method_id, creator_id, box_id),
  check ((content_hash is null) = (uploaded_at is null))
);

create table app.entry_claims (
  id uuid primary key,
  user_id uuid not null references app.users(id),
  creator_id uuid not null,
  box_id uuid not null,
  policy_id uuid not null,
  method_id uuid not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 8000),
  screenshot_id uuid references app.entry_evidence_objects(id),
  order_reference_key text,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default statement_timestamp(),
  reviewed_at timestamptz,
  foreign key (policy_id, method_id, creator_id, box_id)
    references app.entry_policy_versions(id, method_id, creator_id, box_id),
  unique (user_id, idempotency_key),
  check ((status = 'pending') = (reviewed_at is null))
);
create index entry_claims_limit_idx on app.entry_claims(user_id, method_id, status);
create index entry_claims_review_idx on app.entry_claims(creator_id, status, created_at, id);
create unique index entry_claims_reference_idx on app.entry_claims(creator_id, order_reference_key)
  where order_reference_key is not null and status <> 'rejected';

create table app.entry_claim_reviews (
  claim_id uuid primary key references app.entry_claims(id),
  reviewer_user_id uuid not null references app.users(id),
  decision text not null check (decision in ('approved', 'rejected')),
  note text check (length(note) between 1 and 2000),
  grant_id uuid unique references app.opening_entitlement_grants(id),
  created_at timestamptz not null default statement_timestamp(),
  check ((decision = 'approved') = (grant_id is not null))
);

create table app_private.entry_submission_guards (
  user_id uuid primary key references app.users(id)
);
create table app_private.entry_claim_guards (
  user_id uuid not null references app.users(id),
  method_id uuid not null references app.entry_methods(id),
  primary key (user_id, method_id)
);
create table app.entry_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null references app.users(id),
  creator_id uuid not null references app.creators(id),
  resource_id uuid not null,
  action text not null,
  created_at timestamptz not null default statement_timestamp()
);

revoke all on app.entry_methods, app.entry_policy_versions, app.entry_evidence_objects,
  app.entry_claims, app.entry_claim_reviews, app.entry_audit_events from creatordrop_app, public;

create function app_private.entry_immutable_history() returns trigger
language plpgsql set search_path = '' as $f$
begin raise exception using errcode = '23514', constraint = 'entry_history_immutable'; end;
$f$;
create trigger entry_policy_immutable before update or delete on app.entry_policy_versions
  for each row execute function app_private.entry_immutable_history();
create trigger entry_review_immutable before update or delete on app.entry_claim_reviews
  for each row execute function app_private.entry_immutable_history();
create trigger entry_audit_immutable before update or delete on app.entry_audit_events
  for each row execute function app_private.entry_immutable_history();

create function app_private.entry_claim_transition_guard() returns trigger
language plpgsql set search_path = '' as $f$
begin
  if tg_op = 'DELETE' then raise exception using errcode = '23514', constraint = 'entry_claim_immutable'; end if;
  if old.status <> 'pending' or new.status not in ('approved', 'rejected')
    or (to_jsonb(new) - array['status','reviewed_at']) is distinct from (to_jsonb(old) - array['status','reviewed_at'])
  then raise exception using errcode = '23514', constraint = 'entry_claim_terminal'; end if;
  return new;
end;
$f$;
create trigger entry_claim_transition before update or delete on app.entry_claims
  for each row execute function app_private.entry_claim_transition_guard();

create function app_private.entry_evidence_guard() returns trigger
language plpgsql set search_path = '' as $f$
begin
  if tg_op = 'DELETE' then raise exception using errcode = '23514', constraint = 'entry_evidence_immutable'; end if;
  if old.uploaded_at is not null or new.uploaded_at is null
    or (to_jsonb(new) - array['content_hash','uploaded_at']) is distinct from (to_jsonb(old) - array['content_hash','uploaded_at'])
  then raise exception using errcode = '23514', constraint = 'entry_evidence_immutable'; end if;
  return new;
end;
$f$;
create trigger entry_evidence_immutable before update or delete on app.entry_evidence_objects
  for each row execute function app_private.entry_evidence_guard();

create function app_private.entry_review_consistency() returns trigger
language plpgsql security definer set search_path = '' as $f$
declare c app.entry_claims%rowtype; r app.entry_claim_reviews%rowtype; p app.entry_policy_versions%rowtype;
begin
  select * into c from app.entry_claims where id = case when tg_table_name = 'entry_claims' then new.id else new.claim_id end;
  select * into r from app.entry_claim_reviews where claim_id = c.id;
  if (c.status = 'pending' and r.claim_id is not null)
    or (c.status <> 'pending' and (r.claim_id is null or r.decision <> c.status))
  then raise exception using errcode = '23514', constraint = 'entry_review_state_mismatch'; end if;
  if c.status = 'approved' then
    select * into p from app.entry_policy_versions where id = c.policy_id;
    if not exists (select 1 from app.opening_entitlement_grants g where g.id = r.grant_id
      and g.user_id = c.user_id and g.creator_id = c.creator_id and g.box_id = c.box_id
      and g.quantity_granted = p.openings_granted and g.source_type = 'entry_claim'
      and g.source_identity = 'entry_claim:' || c.id::text and g.granted_by_user_id = r.reviewer_user_id)
    then raise exception using errcode = '23514', constraint = 'entry_approval_grant_mismatch'; end if;
  end if;
  return null;
end;
$f$;
create constraint trigger entry_claim_review_consistency after insert or update on app.entry_claims
  deferrable initially deferred for each row execute function app_private.entry_review_consistency();
create constraint trigger entry_review_claim_consistency after insert on app.entry_claim_reviews
  deferrable initially deferred for each row execute function app_private.entry_review_consistency();

create function app_private.entry_require_creator(actor uuid, creator uuid, allowed_roles text[])
returns void language plpgsql security definer set search_path = '' as $f$
declare membership_role text;
begin
  perform 1 from app.creators where id = creator and status = 'active' for share;
  if not found then raise exception using errcode = 'P2001'; end if;
  select role into membership_role from app.creator_memberships where creator_id = creator and user_id = actor;
  if membership_role is null then raise exception using errcode = 'P2001'; end if;
  if not membership_role = any(allowed_roles) then raise exception using errcode = 'P2002'; end if;
end;
$f$;

create function app_private.entry_policy_dto(p app.entry_policy_versions) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', p.id, 'methodId', p.method_id, 'creatorId', p.creator_id,
    'boxId', p.box_id, 'boxVersionId', p.box_version_id, 'versionNumber', p.version_number,
    'publishedAt', p.published_at, 'definition', p.definition);
$f$;
create function app_private.entry_method_dto(m app.entry_methods) returns jsonb
language sql stable security definer set search_path = '' as $f$
  select jsonb_build_object('id', m.id, 'creatorId', m.creator_id, 'boxId', m.box_id,
    'revision', m.revision, 'enabled', m.enabled, 'draft', m.draft,
    'published', (select app_private.entry_policy_dto(p) from app.entry_policy_versions p where id = m.current_policy_id));
$f$;
create function app_private.entry_claim_dto(c app.entry_claims) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', c.id, 'creatorId', c.creator_id, 'boxId', c.box_id,
    'policyId', c.policy_id, 'methodId', c.method_id, 'status', c.status,
    'evidence', c.evidence, 'createdAt', c.created_at, 'reviewedAt', c.reviewed_at);
$f$;

create function app_private.entry_public_policies(target_box uuid) returns jsonb
language sql stable security definer set search_path = '' as $f$
  select coalesce(jsonb_agg(app_private.entry_policy_dto(p) order by m.created_at, m.id), '[]'::jsonb)
    from app.entry_methods m join app.entry_policy_versions p on p.id = m.current_policy_id
    join app.boxes b on b.id = m.box_id join app.creators c on c.id = b.creator_id
    join app.box_versions v on v.id = b.current_published_version_id
    where m.box_id = target_box and m.enabled and b.status = 'active' and c.status = 'active'
      and v.opening_compatibility_version = 'opening-v2' and p.box_version_id = v.id;
$f$;
grant execute on function app_private.entry_public_policies(uuid) to creatordrop_app;

-- A domain-separated capability uses the existing active actor-signing key lifecycle.
-- The restricted database role cannot forge an actor or call the operator grant primitive.
create function app_private.entry_verify_actor(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns void
language plpgsql security definer set search_path = '' as $f$
declare material bytea; now_ms bigint;
begin
  now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  select key_material into material from app_private.fulfillment_actor_binding_keys
    where version = key_version and status = 'active';
  if material is null or expires_ms < now_ms or expires_ms > now_ms + 60000
    or signature is null or signature <> extensions.hmac(convert_to(
      'creatordrop:entry-command:v1|' || key_version || '|' || actor::text || '|' || operation || '|' || payload || '|' || expires_ms::text,
      'utf8'), material, 'sha256')
    or not exists (select 1 from app.users where id = actor and status = 'active')
  then raise exception using errcode = 'P2002'; end if;
end;
$f$;

create function app_private.entry_method_command(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare q jsonb := payload::jsonb; m app.entry_methods%rowtype; p app.entry_policy_versions%rowtype;
  creator uuid := (q->>'creatorId')::uuid; box uuid := (q->>'boxId')::uuid; target_version uuid;
begin
  perform app_private.entry_verify_actor(actor, operation, payload, key_version, expires_ms, signature);
  perform app_private.entry_require_creator(actor, creator,
    case when operation = 'method.list' then array['owner','manager','editor','viewer']
      when operation in ('method.create','method.update') then array['owner','manager','editor']
      else array['owner','manager'] end);
  if not exists (select 1 from app.boxes where id = box and creator_id = creator) then raise exception using errcode = 'P2001'; end if;
  if operation = 'method.list' then
    return (select coalesce(jsonb_agg(app_private.entry_method_dto(e) order by e.created_at, e.id), '[]'::jsonb)
      from app.entry_methods e where e.creator_id = creator and e.box_id = box);
  end if;
  if operation = 'method.create' then
    insert into app.entry_methods(id, creator_id, box_id, draft, created_by_user_id)
      values ((q->>'id')::uuid, creator, box, q->'definition', actor) returning * into m;
  else
    select * into m from app.entry_methods where id = (q->>'methodId')::uuid and creator_id = creator and box_id = box for update;
    if not found then raise exception using errcode = 'P2001'; end if;
    if m.revision <> (q->>'expectedRevision')::integer then raise exception using errcode = 'P2006'; end if;
    if operation = 'method.update' then
      update app.entry_methods set draft = q->'definition', revision = revision + 1, updated_at = statement_timestamp() where id = m.id returning * into m;
    elsif operation = 'method.enable' then
      update app.entry_methods set enabled = (q->>'enabled')::boolean, revision = revision + 1, updated_at = statement_timestamp() where id = m.id returning * into m;
    elsif operation = 'method.publish' then
      select v.id into target_version from app.boxes b join app.box_versions v on v.id = b.current_published_version_id
        where b.id = box and b.status = 'active' and v.state = 'published' and v.opening_compatibility_version = 'opening-v2' for share of b;
      if target_version is null or target_version <> (q->>'boxVersionId')::uuid then raise exception using errcode = 'P2007'; end if;
      insert into app.entry_policy_versions(id, method_id, creator_id, box_id, box_version_id,
        version_number, definition, openings_granted, per_user_claim_limit, published_by_user_id)
      values ((q->>'id')::uuid, m.id, creator, box, target_version,
        (select coalesce(max(version_number), 0) + 1 from app.entry_policy_versions where method_id = m.id),
        m.draft, (m.draft->>'openingsGranted')::bigint, (m.draft->>'perUserClaimLimit')::bigint, actor) returning * into p;
      update app.entry_methods set current_policy_id = p.id, revision = revision + 1, updated_at = statement_timestamp() where id = m.id returning * into m;
    else raise exception using errcode = 'P2005'; end if;
  end if;
  insert into app.entry_audit_events(actor_user_id, creator_id, resource_id, action) values (actor, creator, m.id, operation);
  return app_private.entry_method_dto(m);
end;
$f$;
grant execute on function app_private.entry_method_command(uuid,text,text,text,bigint,bytea) to creatordrop_app;

create function app_private.entry_claim_command(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare q jsonb := payload::jsonb; c app.entry_claims%rowtype; p app.entry_policy_versions%rowtype;
  m app.entry_methods%rowtype; e app.entry_evidence_objects%rowtype; r app.entry_claim_reviews%rowtype;
  requirement record; grant_identity uuid; count_claims bigint;
begin
  perform app_private.entry_verify_actor(actor, operation, payload, key_version, expires_ms, signature);
  if operation = 'claim.pending' then
    perform app_private.entry_require_creator(actor, (q->>'creatorId')::uuid, array['owner','manager']);
    return (select coalesce(jsonb_agg(app_private.entry_claim_dto(x) order by x.created_at, x.id), '[]'::jsonb)
      from (select * from app.entry_claims where creator_id = (q->>'creatorId')::uuid and status = 'pending' order by created_at, id limit 100) x);
  elsif operation = 'claim.submit' then
    -- Per-actor idempotency keys serialize before method/user guard acquisition.
    insert into app_private.entry_submission_guards values (actor) on conflict do nothing;
    perform 1 from app_private.entry_submission_guards where user_id = actor for update;
    select * into c from app.entry_claims where user_id = actor and idempotency_key = q->>'idempotencyKey';
    if found then
      if c.policy_id <> (q->>'policyId')::uuid or c.box_id <> (q->>'boxId')::uuid or c.evidence <> q->'evidence'
        then raise exception using errcode = 'P2003'; end if;
      return app_private.entry_claim_dto(c);
    end if;
    select * into p from app.entry_policy_versions where id = (q->>'policyId')::uuid and box_id = (q->>'boxId')::uuid;
    if not found then raise exception using errcode = 'P2001'; end if;
    select * into m from app.entry_methods where id = p.method_id for share;
    if not m.enabled or m.current_policy_id <> p.id or not exists
      (select 1 from app.boxes b join app.creators cr on cr.id = b.creator_id
       where b.id = p.box_id and b.current_published_version_id = p.box_version_id and b.status = 'active' and cr.status = 'active')
      then raise exception using errcode = 'P2007'; end if;
    for requirement in select key, value from jsonb_each_text(p.definition->'evidenceRequirements') loop
      if (requirement.value = 'required' and not (q->'evidence' ? requirement.key)) or
        (requirement.value = 'not_applicable' and q->'evidence' ? requirement.key)
        then raise exception using errcode = 'P2005'; end if;
    end loop;
    if exists (select 1 from jsonb_object_keys(q->'evidence') k where k not in ('platform_username','profile_url','order_reference','screenshot','note'))
      then raise exception using errcode = 'P2005'; end if;
    if q->'evidence' ? 'screenshot' then
      select * into e from app.entry_evidence_objects where id = (q->'evidence'->>'screenshot')::uuid
        and user_id = actor and policy_id = p.id and creator_id = p.creator_id and uploaded_at is not null;
      if not found then raise exception using errcode = 'P2005'; end if;
    end if;
    insert into app_private.entry_claim_guards values (actor, m.id) on conflict do nothing;
    perform 1 from app_private.entry_claim_guards where user_id = actor and method_id = m.id for update;
    select count(*) into count_claims from app.entry_claims where user_id = actor and method_id = m.id and status <> 'rejected';
    if count_claims >= p.per_user_claim_limit then raise exception using errcode = 'P2004'; end if;
    insert into app.entry_claims(id, user_id, creator_id, box_id, policy_id, method_id, evidence,
      screenshot_id, order_reference_key, idempotency_key)
    values ((q->>'id')::uuid, actor, p.creator_id, p.box_id, p.id, p.method_id, q->'evidence', e.id,
      nullif(upper(btrim(q->'evidence'->>'order_reference')), ''), q->>'idempotencyKey') returning * into c;
    return app_private.entry_claim_dto(c);
  else
    select * into c from app.entry_claims where id = (q->>'claimId')::uuid;
    if not found then raise exception using errcode = 'P2001'; end if;
    if operation = 'claim.own' then
      if c.user_id <> actor then raise exception using errcode = 'P2001'; end if;
      return app_private.entry_claim_dto(c);
    end if;
    if c.creator_id <> (q->>'creatorId')::uuid then raise exception using errcode = 'P2001'; end if;
    perform app_private.entry_require_creator(actor, c.creator_id, array['owner','manager']);
    if operation = 'claim.review_read' then return app_private.entry_claim_dto(c); end if;
    if operation <> 'claim.review' then raise exception using errcode = 'P2005'; end if;
    insert into app_private.entry_claim_guards values (c.user_id, c.method_id) on conflict do nothing;
    perform 1 from app_private.entry_claim_guards where user_id = c.user_id and method_id = c.method_id for update;
    select * into c from app.entry_claims where id = c.id for update;
    if c.status <> 'pending' then
      if c.status <> q->>'decision' then raise exception using errcode = 'P2003'; end if;
      return app_private.entry_claim_dto(c);
    end if;
    if q->>'decision' not in ('approved','rejected') then raise exception using errcode = 'P2005'; end if;
    select * into p from app.entry_policy_versions where id = c.policy_id;
    if q->>'decision' = 'approved' then
      select id into grant_identity from app_private.grant_opening_entitlement((q->>'grantId')::uuid,
        c.user_id, c.creator_id, c.box_id, p.openings_granted, 'entry_claim', 'entry_claim:' || c.id::text, actor, 'Manual evidence approved');
    end if;
    insert into app.entry_claim_reviews(claim_id, reviewer_user_id, decision, note, grant_id)
      values (c.id, actor, q->>'decision', q->>'note', grant_identity) returning * into r;
    update app.entry_claims set status = r.decision, reviewed_at = r.created_at where id = c.id returning * into c;
    insert into app.entry_audit_events(actor_user_id, creator_id, resource_id, action) values (actor, c.creator_id, c.id, 'claim.' || r.decision);
    return app_private.entry_claim_dto(c);
  end if;
end;
$f$;
grant execute on function app_private.entry_claim_command(uuid,text,text,text,bigint,bytea) to creatordrop_app;

create function app_private.entry_evidence_command(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare q jsonb := payload::jsonb; e app.entry_evidence_objects%rowtype; p app.entry_policy_versions%rowtype;
begin
  perform app_private.entry_verify_actor(actor, operation, payload, key_version, expires_ms, signature);
  if operation = 'evidence.create' then
    select p1.* into p from app.entry_policy_versions p1 join app.entry_methods m on m.current_policy_id = p1.id
      join app.boxes b on b.id = m.box_id join app.creators cr on cr.id = b.creator_id
      where p1.id = (q->>'policyId')::uuid and p1.box_id = (q->>'boxId')::uuid and m.enabled
        and b.status = 'active' and cr.status = 'active' and b.current_published_version_id = p1.box_version_id;
    if not found or p.definition->'evidenceRequirements'->>'screenshot' = 'not_applicable'
      then raise exception using errcode = 'P2007'; end if;
    insert into app.entry_evidence_objects(id, user_id, creator_id, box_id, policy_id, method_id, media_type, byte_length)
      values ((q->>'id')::uuid, actor, p.creator_id, p.box_id, p.id, p.method_id, q->>'mediaType', (q->>'byteLength')::integer) returning * into e;
  else
    select * into e from app.entry_evidence_objects where id = (q->>'evidenceId')::uuid;
    if not found then raise exception using errcode = 'P2001'; end if;
    if q->>'creatorId' is not null then
      if e.creator_id <> (q->>'creatorId')::uuid or operation <> 'evidence.read' then raise exception using errcode = 'P2001'; end if;
      perform app_private.entry_require_creator(actor, e.creator_id, array['owner','manager']);
      if not exists (select 1 from app.entry_claims where screenshot_id = e.id and creator_id = e.creator_id)
        then raise exception using errcode = 'P2001'; end if;
    elsif e.user_id <> actor then raise exception using errcode = 'P2001'; end if;
    if operation = 'evidence.complete' then
      select * into e from app.entry_evidence_objects where id = e.id for update;
      if e.uploaded_at is not null then
        if e.content_hash <> decode(q->>'contentHash','hex') then raise exception using errcode = 'P2003'; end if;
      else
        update app.entry_evidence_objects set uploaded_at = statement_timestamp(), content_hash = decode(q->>'contentHash','hex') where id = e.id returning * into e;
      end if;
    elsif operation = 'evidence.read' then
      if e.uploaded_at is null then raise exception using errcode = 'P2007'; end if;
      insert into app.entry_audit_events(actor_user_id, creator_id, resource_id, action) values (actor, e.creator_id, e.id, 'evidence.read');
    elsif operation <> 'evidence.upload' then raise exception using errcode = 'P2005'; end if;
  end if;
  return jsonb_build_object('id', e.id, 'mediaType', e.media_type, 'byteLength', e.byte_length,
    'uploaded', e.uploaded_at is not null, 'contentHash', encode(e.content_hash,'hex'));
end;
$f$;
grant execute on function app_private.entry_evidence_command(uuid,text,text,text,bigint,bytea) to creatordrop_app;

-- Called only from Supabase Storage RLS; no evidence data is returned.
create function app_private.entry_storage_allowed(object_name text, upload boolean) returns boolean
language sql stable security definer set search_path = '' as $f$
  select exists (
    select 1 from app.entry_evidence_objects e join app.users u on u.auth_provider = 'supabase'
      and u.auth_subject = (current_setting('request.jwt.claims', true)::jsonb->>'sub') and u.status = 'active'
    where object_name = e.id::text and (
      (e.user_id = u.id and (not upload or (e.uploaded_at is null and e.created_at > statement_timestamp() - interval '1 hour')))
      or (not upload and e.uploaded_at is not null and exists (
        select 1 from app.creator_memberships cm join app.creators cr on cr.id = cm.creator_id
        where cm.user_id = u.id and cm.creator_id = e.creator_id and cm.role in ('owner','manager') and cr.status = 'active')
        and exists (select 1 from app.entry_claims c where c.screenshot_id = e.id and c.creator_id = e.creator_id))
    )
  );
$f$;
grant usage on schema app_private to authenticated;
grant execute on function app_private.entry_storage_allowed(text,boolean) to authenticated;

reset role;

-- Provider-owned Storage objects are configured by the Supabase migration runner.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
  values ('entry-evidence', 'entry-evidence', false, 5242880, array['image/png','image/jpeg']);
create policy entry_evidence_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'entry-evidence' and app_private.entry_storage_allowed(name, true));
create policy entry_evidence_read on storage.objects for select to authenticated
  using (bucket_id = 'entry-evidence' and app_private.entry_storage_allowed(name, false));
-- No update/delete policies: a submitted screenshot cannot be overwritten or removed by a fan.
