-- Read-only status filtering and pagination; existing review/claim commands are unchanged.
set role creatordrop_migrator;

create function app_private.entry_review_list(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns jsonb
language plpgsql security definer set search_path = '' as $f$
declare q jsonb := payload::jsonb; cursor_claim app.entry_claims%rowtype;
begin
  perform app_private.entry_verify_actor(actor, operation, payload, key_version, expires_ms, signature);
  if operation <> 'review.list' or q->>'status' is null or q->>'status' not in ('pending','approved','rejected')
    or q - array['creatorId','status','cursor'] <> '{}'::jsonb
  then raise exception using errcode = 'P2005'; end if;
  perform app_private.entry_require_creator(actor, (q->>'creatorId')::uuid, array['owner','manager']);
  if q->>'cursor' is not null then
    select * into cursor_claim from app.entry_claims where id = (q->>'cursor')::uuid
      and creator_id = (q->>'creatorId')::uuid;
    if not found then raise exception using errcode = 'P2001'; end if;
  end if;
  return (
    with candidates as materialized (
      select * from app.entry_claims where creator_id = (q->>'creatorId')::uuid and status = q->>'status'
        and (cursor_claim.id is null or (created_at,id) > (cursor_claim.created_at,cursor_claim.id))
      order by created_at,id limit 101
    ), page as (select * from candidates order by created_at,id limit 100)
    select jsonb_build_object('claims', coalesce((select jsonb_agg(app_private.entry_claim_dto(p) order by p.created_at,p.id) from page p),'[]'::jsonb),
      'nextCursor', case when (select count(*) from candidates) > 100
        then (select id from page order by created_at desc,id desc limit 1) else null end)
  );
end;
$f$;
create function app.entry_review_list(actor uuid, operation text, payload text,
  key_version text, expires_ms bigint, signature bytea) returns jsonb
language sql security definer set search_path = '' as $f$
  select app_private.entry_review_list(actor,operation,payload,key_version,expires_ms,signature);
$f$;
revoke all on function app_private.entry_review_list(uuid,text,text,text,bigint,bytea),
  app.entry_review_list(uuid,text,text,text,bigint,bytea) from public, anon, authenticated, creatordrop_app;
grant execute on function app.entry_review_list(uuid,text,text,text,bigint,bytea) to creatordrop_app;
reset role;
