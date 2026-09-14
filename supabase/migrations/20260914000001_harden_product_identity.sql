-- Product snapshots belong to an immutable GitHub account ID, not a mutable
-- login handle. Keep handle as display metadata and migrate any legacy rows
-- that can be matched to the account table.

alter table public.product_snapshots
  add column if not exists github_id bigint;

update public.product_snapshots as snapshot
set github_id = account.github_id
from public.github_accounts as account
where snapshot.github_id is null
  and snapshot.handle = account.handle;

alter table public.product_snapshots
  drop constraint if exists product_snapshots_pkey;

create unique index if not exists product_snapshots_github_id_idx
  on public.product_snapshots (github_id);

create index if not exists product_snapshots_handle_idx
  on public.product_snapshots (handle);
