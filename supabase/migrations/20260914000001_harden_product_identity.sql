-- Product snapshots belong to an immutable GitHub account ID, not a mutable
-- login handle. Keep handle as display metadata. Legacy rows without an
-- immutable ID remain unbound until an operator can verify their ownership;
-- never auto-claim them by a reused login handle.

create extension if not exists pgcrypto;

alter table public.product_snapshots
  add column if not exists github_id bigint;

alter table public.product_snapshots
  add column if not exists row_version text;

update public.product_snapshots
set row_version = gen_random_uuid()::text
where row_version is null;

alter table public.product_snapshots
  alter column row_version set not null;

alter table public.product_snapshots
  drop constraint if exists product_snapshots_pkey;

create unique index if not exists product_snapshots_github_id_idx
  on public.product_snapshots (github_id);

create unique index if not exists product_snapshots_row_version_idx
  on public.product_snapshots (row_version);

create index if not exists product_snapshots_handle_idx
  on public.product_snapshots (handle);
