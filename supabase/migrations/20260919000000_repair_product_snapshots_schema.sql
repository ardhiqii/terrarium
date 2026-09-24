-- Repair the live product snapshot contract without rebuilding the table.
--
-- Older hosted databases may have product_snapshots rows from before the
-- immutable GitHub identity and version columns were introduced. Keep every
-- existing snapshot and only fill the missing derived version value before
-- enforcing the constraints used by the Supabase product store.

create extension if not exists pgcrypto;

alter table public.product_snapshots
  add column if not exists github_id bigint;

alter table public.product_snapshots
  add column if not exists row_version text;

alter table public.product_snapshots
  alter column row_version set default gen_random_uuid()::text;

update public.product_snapshots
set row_version = gen_random_uuid()::text
where row_version is null;

alter table public.product_snapshots
  alter column row_version set not null;

-- The old handle primary key would reject two GitHub identities that happen
-- to reuse a mutable login. Dropping the constraint preserves its rows while
-- allowing the immutable-ID index below to be the identity key.
alter table public.product_snapshots
  drop constraint if exists product_snapshots_pkey;

-- Fail before creating unique indexes if a legacy deployment contains
-- ambiguous ownership. The operator must resolve those rows explicitly; this
-- migration must never choose a mutable handle or silently discard a snapshot.
do $$
begin
  if exists (
    select 1
    from public.product_snapshots
    where github_id is not null
    group by github_id
    having count(*) > 1
  ) then
    raise exception 'product_snapshots contains duplicate github_id values; resolve ownership before applying the repair';
  end if;
  if exists (
    select 1
    from public.product_snapshots
    group by row_version
    having count(*) > 1
  ) then
    raise exception 'product_snapshots contains duplicate row_version values; resolve the duplicate versions before applying the repair';
  end if;
end
$$;

create unique index if not exists product_snapshots_github_id_idx
  on public.product_snapshots (github_id);

create unique index if not exists product_snapshots_row_version_idx
  on public.product_snapshots (row_version);

create index if not exists product_snapshots_handle_idx
  on public.product_snapshots (handle);

-- The account adapter reads and writes this marker on reconnect and
-- disconnect. Keep this repair in the same forward-only migration so a live
-- database cannot land between the two server-side contracts.
alter table public.github_accounts
  add column if not exists disconnected_at timestamptz;
