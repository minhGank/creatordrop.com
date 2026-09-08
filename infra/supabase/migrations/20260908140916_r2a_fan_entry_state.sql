-- Additive authenticated read. No changes to claim commands, lock order, or grants.
set role creatordrop_migrator;

create function app_private.entry_fan_state(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare q jsonb := payload::jsonb; target_box uuid;
begin
  perform app_private.entry_verify_actor(actor, operation, payload, key_version, expires_ms, signature);
  if operation <> 'state.own' or jsonb_typeof(q) is distinct from 'object'
    or not (q ? 'boxId') or q - 'boxId' <> '{}'::jsonb
  then raise exception using errcode = 'P2005'; end if;
  target_box := (q->>'boxId')::uuid;
  if not exists (
    select 1 from app.boxes b join app.creators cr on cr.id = b.creator_id
      join app.box_versions v on v.id = b.current_published_version_id
    where b.id = target_box and b.status = 'active' and cr.status = 'active'
      and v.state = 'published' and v.opening_compatibility_version = 'opening-v2'
  ) then raise exception using errcode = 'P2001'; end if;

  -- STABLE uses one statement snapshot for visibility, current policies, counts and summaries.
  -- Availability is informational: submit still checks under the existing stable-method guard.
  return jsonb_build_object('boxId', target_box, 'methods', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'policy', app_private.entry_policy_dto(p),
      'claimLimit', p.per_user_claim_limit::text,
      'reservedSlots', counts.pending::text,
      'consumedSlots', counts.approved::text,
      'remainingSlots', greatest(0::bigint, p.per_user_claim_limit - counts.pending - counts.approved)::text,
      'canSubmit', counts.pending + counts.approved < p.per_user_claim_limit,
      'claimCount', counts.total::text,
      'claims', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id, 'policyId', c.policy_id, 'status', c.status,
          'createdAt', c.created_at, 'reviewedAt', c.reviewed_at,
          'openingsGranted', case when c.status = 'approved' then historical.openings_granted::text else '0' end
        ) order by c.created_at desc, c.id desc), '[]'::jsonb)
        from (
          select id, policy_id, status, created_at, reviewed_at from app.entry_claims
          where user_id = actor and method_id = m.id and box_id = target_box and creator_id = m.creator_id
          order by created_at desc, id desc limit 100
        ) c join app.entry_policy_versions historical on historical.id = c.policy_id
      )
    ) order by m.created_at, m.id), '[]'::jsonb)
    from app.entry_methods m join app.entry_policy_versions p on p.id = m.current_policy_id
      and p.method_id = m.id and p.creator_id = m.creator_id and p.box_id = m.box_id
    join app.boxes b on b.id = m.box_id and b.creator_id = m.creator_id
    cross join lateral (
      select count(*) as total,
        count(*) filter (where status = 'pending') as pending,
        count(*) filter (where status = 'approved') as approved
      from app.entry_claims
      where user_id = actor and method_id = m.id and box_id = target_box and creator_id = m.creator_id
    ) counts
    where m.box_id = target_box and m.enabled and p.box_version_id = b.current_published_version_id
  ));
end;
$f$;

create function app.entry_fan_state(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns jsonb
language sql stable security definer set search_path = '' as $f$
  select app_private.entry_fan_state(actor, operation, payload, key_version, expires_ms, signature);
$f$;

revoke all on function app_private.entry_fan_state(uuid,text,text,text,bigint,bytea),
  app.entry_fan_state(uuid,text,text,text,bigint,bytea) from public, anon, authenticated, creatordrop_app;
grant execute on function app.entry_fan_state(uuid,text,text,text,bigint,bytea) to creatordrop_app;

reset role;
