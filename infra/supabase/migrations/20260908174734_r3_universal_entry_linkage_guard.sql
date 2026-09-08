-- Bind Universal Entry consumption to the exact new opening it authorizes.
-- Additive scope backfill preserves existing opening/grant identities and history.
set role creatordrop_migrator;

alter table app_private.universal_entry_consumptions
  add column creator_id uuid,
  add column box_id uuid,
  add column box_version_id uuid,
  add column configuration_hash bytea;
-- ALTER TABLE retains its exclusive lock until this migration transaction commits.
alter table app_private.universal_entry_consumptions disable trigger universal_entry_consumptions_immutable;
update app_private.universal_entry_consumptions as consumption
set creator_id = opening.creator_id, box_id = opening.box_id,
    box_version_id = opening.box_version_id, configuration_hash = opening.configuration_hash
from app.box_opens as opening where opening.id = consumption.opening_id;
alter table app_private.universal_entry_consumptions enable trigger universal_entry_consumptions_immutable;
alter table app_private.universal_entry_consumptions
  alter column creator_id set not null,
  alter column box_id set not null,
  alter column box_version_id set not null,
  alter column configuration_hash set not null,
  add constraint universal_entry_configuration_hash_shape check (octet_length(configuration_hash) = 32);

create function app_private.validate_entitlement_consumption_linkage() returns trigger
language plpgsql security definer set search_path = '' as $function$
declare linked bigint;
begin
  select (select count(*) from app.opening_entitlement_consumptions where opening_id = new.opening_id)
       + (select count(*) from app_private.universal_entry_consumptions where opening_id = new.opening_id)
    into linked;
  if linked <> 1 or exists (
    select 1 from app_private.universal_entry_consumptions as consumption
    where consumption.opening_id = new.opening_id and not exists (
      select 1 from app.box_opens as opening
      where opening.id = consumption.opening_id and opening.user_id = consumption.user_id
        and opening.creator_id = consumption.creator_id and opening.box_id = consumption.box_id
        and opening.box_version_id = consumption.box_version_id
        and opening.configuration_hash = consumption.configuration_hash
        and opening.opening_compatibility_version = 'opening-v2'
    )
  ) then
    raise exception using errcode = '23514', constraint = 'opening_entitlement_consumption_link_invalid';
  end if;
  return new;
end
$function$;
create constraint trigger universal_entry_consumptions_link_guard
after insert on app_private.universal_entry_consumptions deferrable initially deferred
for each row execute function app_private.validate_entitlement_consumption_linkage();
create constraint trigger creator_entry_consumptions_link_guard
after insert on app.opening_entitlement_consumptions deferrable initially deferred
for each row execute function app_private.validate_entitlement_consumption_linkage();

-- Fail closed if a previously installed R3 database already contains invalid linkage.
do $validation$
begin
  if exists (
    select 1 from app_private.universal_entry_consumptions as consumption
    join app.box_opens as opening on opening.id = consumption.opening_id
    where opening.opening_compatibility_version <> 'opening-v2'
      or exists (select 1 from app.opening_entitlement_consumptions as creator_consumption
                 where creator_consumption.opening_id = consumption.opening_id)
  ) then
    raise exception using errcode = '23514', constraint = 'opening_entitlement_consumption_link_invalid';
  end if;
end
$validation$;

create or replace function app.consume_opening_v2_entitlement(
  target_consumption_id uuid,target_opening_id uuid,target_user_id uuid,target_creator_id uuid,
  target_box_id uuid,target_box_version_id uuid,target_configuration_hash bytea
) returns table(outcome text,max_openings_per_user text,successful_openings text,remaining_entitlements text,
  source text, universal_entries_remaining text)
language plpgsql security definer set search_path = '' as $function$
declare result record; selected_id uuid; remaining_count bigint;
begin
  perform app_private.lock_progression(target_user_id);
  if exists(select 1 from app.box_opens where id = target_opening_id) then
    raise exception using errcode = '23514', constraint = 'opening_entitlement_requires_new_opening';
  end if;
  if not exists(select 1 from app.creators where id=target_creator_id and status='active') then
    raise exception using errcode='23514',constraint='opening_v2_catalog_snapshot_invalid';
  end if;
  select * into strict result from app_private.consume_creator_entitlement(target_consumption_id,
    target_opening_id,target_user_id,target_creator_id,target_box_id,target_box_version_id,target_configuration_hash);
  if result.outcome = 'entitlement_required' then
    select g.id into selected_id from app_private.universal_entry_grants g
      where g.user_id = target_user_id and not exists
        (select 1 from app_private.universal_entry_consumptions c where c.grant_id = g.id)
      order by g.source_level,g.id for update of g limit 1;
    if selected_id is not null then
      insert into app_private.universal_entry_consumptions(
        opening_id,grant_id,user_id,creator_id,box_id,box_version_id,configuration_hash
      ) values(target_opening_id,selected_id,target_user_id,target_creator_id,target_box_id,
        target_box_version_id,target_configuration_hash);
    end if;
  end if;
  select count(*) into remaining_count from app_private.universal_entry_grants g
    where g.user_id = target_user_id and not exists
      (select 1 from app_private.universal_entry_consumptions c where c.grant_id = g.id);
  return query select case when selected_id is not null then 'consumed' else result.outcome end,
    result.max_openings_per_user,
    case when selected_id is not null then (result.successful_openings::numeric+1)::text else result.successful_openings end,
    result.remaining_entitlements,
    case when selected_id is not null then 'universal' when result.outcome='consumed' then 'creator' else null end,
    remaining_count::text;
end
$function$;
revoke all on function app_private.validate_entitlement_consumption_linkage()
  from public,anon,authenticated,creatordrop_app,creatordrop_worker;
reset role;
