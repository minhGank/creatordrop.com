-- R4: opening-derived usage, including compatible history. No counters or commercial policy.
set role creatordrop_migrator;

create view app_private.hosted_opening_usage with (security_barrier = true) as
select opening.id as opening_id, opening.creator_id, opening.box_id,
       opening.created_at as occurred_at,
       case when universal.opening_id is null then 'creator_entitlement'
            else 'universal_entry' end as authorization_source
from app.box_opens as opening
left join app_private.universal_entry_consumptions as universal on universal.opening_id = opening.id
where opening.opening_compatibility_version = 'opening-v2' and opening.status = 'completed';

comment on view app_private.hosted_opening_usage is
  'One committed opening-v2 row is one hosted opening. Existing source linkage constraints guarantee exactly one authorization source. Includes compatible history without rewriting openings; excludes legacy v1.';
revoke all on app_private.hosted_opening_usage from public, anon, authenticated, creatordrop_app, creatordrop_worker;

-- STABLE keeps authorization, totals, and page on the calling statement snapshot.
create function app.read_creator_hosted_usage(
  p_actor uuid, p_creator uuid, p_start timestamptz, p_end timestamptz,
  p_as_of timestamptz, p_after uuid, p_limit integer
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  actor_role text;
  month_start timestamptz := date_trunc('month', p_as_of at time zone 'UTC') at time zone 'UTC';
  result jsonb;
begin
  if not exists (select 1 from app.users where id = p_actor and status = 'active') then
    raise exception using errcode = 'P4103', message = 'Account is not active.';
  end if;
  select membership.role into actor_role from app.creator_memberships as membership
    join app.creators as creator on creator.id = membership.creator_id and creator.status = 'active'
    where membership.creator_id = p_creator and membership.user_id = p_actor;
  if actor_role is null then
    raise exception using errcode = 'P4104', message = 'Creator not found.';
  end if;
  if actor_role not in ('owner', 'manager') then
    raise exception using errcode = 'P4105', message = 'Creator permission denied.';
  end if;
  if p_end is null or p_as_of is null or not isfinite(p_end) or not isfinite(p_as_of)
    or (p_start is not null and (not isfinite(p_start) or p_start > p_end))
    or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'Invalid usage range.';
  end if;

  with facts as materialized (
    select * from app_private.hosted_opening_usage
    where creator_id = p_creator and occurred_at < p_as_of
  ), ranges(name, starts, ends) as (
    values ('lifetime', null::timestamptz, p_as_of),
      ('currentMonth', month_start, p_as_of),
      ('previousMonth', (date_trunc('month', p_as_of at time zone 'UTC') - interval '1 month') at time zone 'UTC', month_start),
      ('last30Days', p_as_of - interval '720 hours', p_as_of),
      ('selected', p_start, p_end)
  ), totals as (
    select ranges.name, jsonb_build_object(
      'hostedOpenings', count(facts.opening_id)::text,
      'creatorEntitlementOpenings', count(facts.opening_id) filter (where facts.authorization_source = 'creator_entitlement')::text,
      'universalEntryOpenings', count(facts.opening_id) filter (where facts.authorization_source = 'universal_entry')::text
    ) as counts from ranges left join facts on (ranges.starts is null or facts.occurred_at >= ranges.starts)
      and facts.occurred_at < ranges.ends group by ranges.name
  ), grouped as (
    select box_id,
      count(*)::text as hosted,
      count(*) filter (where authorization_source = 'creator_entitlement')::text as creator,
      count(*) filter (where authorization_source = 'universal_entry')::text as universal
    from facts where (p_start is null or occurred_at >= p_start) and occurred_at < p_end
      and (p_after is null or box_id > p_after)
    group by box_id order by box_id limit p_limit + 1
  ), page as (
    select * from grouped order by box_id limit p_limit
  )
  select jsonb_build_object(
    'totals', (select jsonb_object_agg(name, counts) from totals),
    'drops', coalesce((select jsonb_agg(jsonb_build_object(
      'boxId', page.box_id,
      'name', (select version.name from app.box_versions as version
        where version.box_id = page.box_id and version.published_at is not null
        order by version.version_number desc limit 1),
      'hostedOpenings', page.hosted, 'creatorEntitlementOpenings', page.creator,
      'universalEntryOpenings', page.universal
    ) order by page.box_id) from page), '[]'::jsonb),
    'nextCursor', case when (select count(*) from grouped) > p_limit
      then (select box_id from page order by box_id desc limit 1) else null end
  ) into result;
  return result;
end
$function$;
revoke all on function app.read_creator_hosted_usage(uuid,uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  from public, anon, authenticated, creatordrop_worker;
grant execute on function app.read_creator_hosted_usage(uuid,uuid,timestamptz,timestamptz,timestamptz,uuid,integer)
  to creatordrop_app;
reset role;
