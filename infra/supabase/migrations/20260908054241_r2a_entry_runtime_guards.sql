-- Add explicit application entry points without exposing the private schema to the runtime role.
set role creatordrop_migrator;

create function app.entry_method_command(actor uuid, operation text, payload text, key_version text, expires_ms bigint, signature bytea)
returns jsonb language sql security definer set search_path = '' as $f$
  select app_private.entry_method_command(actor,operation,payload,key_version,expires_ms,signature);
$f$;
create function app.entry_claim_command(actor uuid, operation text, payload text, key_version text, expires_ms bigint, signature bytea)
returns jsonb language sql security definer set search_path = '' as $f$
  select app_private.entry_claim_command(actor,operation,payload,key_version,expires_ms,signature);
$f$;
create function app.entry_evidence_command(actor uuid, operation text, payload text, key_version text, expires_ms bigint, signature bytea)
returns jsonb language sql security definer set search_path = '' as $f$
  select app_private.entry_evidence_command(actor,operation,payload,key_version,expires_ms,signature);
$f$;
create function app.entry_public_policies(target_box uuid)
returns jsonb language sql stable security definer set search_path = '' as $f$
  select app_private.entry_public_policies(target_box);
$f$;
grant execute on function app.entry_method_command(uuid,text,text,text,bigint,bytea),
  app.entry_claim_command(uuid,text,text,text,bigint,bytea),
  app.entry_evidence_command(uuid,text,text,text,bigint,bytea), app.entry_public_policies(uuid) to creatordrop_app;
revoke all on function app_private.entry_method_command(uuid,text,text,text,bigint,bytea),
  app_private.entry_claim_command(uuid,text,text,text,bigint,bytea),
  app_private.entry_evidence_command(uuid,text,text,text,bigint,bytea), app_private.entry_public_policies(uuid) from creatordrop_app;

create or replace function app_private.entry_verify_actor(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns void
language plpgsql security definer set search_path = '' as $f$
declare material bytea; now_ms bigint;
begin
  now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  select key_material into material from app_private.fulfillment_actor_binding_keys
    where version = key_version and status = 'active';
  if actor is null or operation is null or payload is null or expires_ms is null
    or material is null or expires_ms < now_ms or expires_ms > now_ms + 60000
    or signature is distinct from extensions.hmac(convert_to(
      'creatordrop:entry-command:v1|' || key_version || '|' || actor::text || '|' || operation || '|' || payload || '|' || expires_ms::text,
      'utf8'), material, 'sha256')
    or not exists (select 1 from app.users where id = actor and status = 'active')
  then raise exception using errcode = 'P2002'; end if;
end;
$f$;

create or replace function app_private.entry_review_consistency() returns trigger
language plpgsql security definer set search_path = '' as $f$
declare target uuid; c app.entry_claims%rowtype; r app.entry_claim_reviews%rowtype; p app.entry_policy_versions%rowtype;
begin
  if tg_table_name = 'entry_claims' then target := new.id; else target := new.claim_id; end if;
  select * into c from app.entry_claims where id = target;
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
create function app_private.entry_grant_consistency() returns trigger
language plpgsql security definer set search_path = '' as $f$
begin
  if new.source_type = 'entry_claim' and not exists (
    select 1 from app.entry_claim_reviews r join app.entry_claims c on c.id = r.claim_id
      join app.entry_policy_versions p on p.id = c.policy_id
    where r.grant_id = new.id and r.decision = 'approved' and c.status = 'approved'
      and new.source_identity = 'entry_claim:' || c.id::text
      and new.user_id = c.user_id and new.creator_id = c.creator_id and new.box_id = c.box_id
      and new.quantity_granted = p.openings_granted and new.granted_by_user_id = r.reviewer_user_id
  ) then raise exception using errcode = '23514', constraint = 'entry_grant_without_approval'; end if;
  return null;
end;
$f$;
create constraint trigger entry_grant_requires_approval after insert on app.opening_entitlement_grants
  deferrable initially deferred for each row execute function app_private.entry_grant_consistency();

create or replace function app_private.entry_claim_dto(c app.entry_claims) returns jsonb
language sql stable set search_path = '' as $f$
  select jsonb_build_object('id', c.id, 'creatorId', c.creator_id, 'boxId', c.box_id,
    'policyId', c.policy_id, 'methodId', c.method_id, 'status', c.status,
    'evidence', c.evidence, 'createdAt', c.created_at, 'reviewedAt', c.reviewed_at,
    'policy', (select app_private.entry_policy_dto(p) from app.entry_policy_versions p where p.id = c.policy_id));
$f$;

create function app_private.entry_method_identity_guard() returns trigger
language plpgsql set search_path = '' as $f$
begin
  if (to_jsonb(new) - array['draft','revision','current_policy_id','enabled','updated_at'])
    is distinct from (to_jsonb(old) - array['draft','revision','current_policy_id','enabled','updated_at'])
    or new.revision <> old.revision + 1
  then raise exception using errcode = '23514', constraint = 'entry_method_identity_immutable'; end if;
  return new;
end;
$f$;
create trigger entry_method_identity before update on app.entry_methods
  for each row execute function app_private.entry_method_identity_guard();

reset role;
