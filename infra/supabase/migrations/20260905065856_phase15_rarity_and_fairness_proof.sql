-- Phase 15 only: immutable per-box-entry rarity-v1 publication snapshots.
-- Existing published entries remain nullable legacy history.

set role creatordrop_migrator;

alter table app.box_version_rewards
  add column rarity text,
  add column rarity_policy_version text,
  add constraint box_version_rewards_rarity_snapshot_shape check (
    (rarity is null and rarity_policy_version is null)
    or (
      rarity in ('common', 'uncommon', 'rare', 'epic', 'legendary')
      and rarity_policy_version = 'rarity-v1'
    )
  );

create function app_private.derive_rarity_v1(reward_weight bigint, total_weight bigint)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $function$
begin
  if reward_weight <= 0 or total_weight <= 0 or reward_weight > total_weight then
    raise exception using
      errcode = '22023',
      message = 'rarity-v1 requires a positive reward weight within the total weight.';
  end if;

  if reward_weight::numeric * 5 >= total_weight::numeric then
    return 'common';
  elsif reward_weight::numeric * 25 >= total_weight::numeric * 2 then
    return 'uncommon';
  elsif reward_weight::numeric * 50 >= total_weight::numeric then
    return 'rare';
  elsif reward_weight::numeric * 200 >= total_weight::numeric then
    return 'epic';
  end if;
  return 'legendary';
end
$function$;

revoke all on function app_private.derive_rarity_v1(bigint, bigint) from public;

create function app_private.validate_published_box_rarity_snapshots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.state = 'published'
    and (tg_op = 'INSERT' or old.state is distinct from 'published')
    and exists (
      select 1
        from app.box_version_rewards as entry
       where entry.box_version_id = new.id
         and (
           entry.rarity_policy_version is distinct from 'rarity-v1'
           or entry.rarity is distinct from app_private.derive_rarity_v1(
             entry.weight,
             new.total_weight
           )
         )
    ) then
    raise exception using
      errcode = '23514',
      constraint = 'published_box_rarity_snapshot_invalid',
      message = 'Newly published box entries require exact rarity-v1 snapshots.';
  end if;
  return new;
end
$function$;

revoke all on function app_private.validate_published_box_rarity_snapshots() from public;

create trigger box_versions_rarity_snapshot_guard
before insert or update on app.box_versions
for each row execute function app_private.validate_published_box_rarity_snapshots();

comment on column app.box_version_rewards.rarity is
  'Immutable server-derived probability tier; null only for pre-Phase-15 published history or drafts.';
comment on column app.box_version_rewards.rarity_policy_version is
  'Immutable rarity threshold policy snapshot; rarity-v1 for every new publication.';

reset role;
