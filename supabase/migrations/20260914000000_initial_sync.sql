-- Terrarium's durable server-side sync state.
--
-- Note content, note titles, paths, graph edges, and repository contents are
-- intentionally absent. The application writes only derived companion state
-- and encrypted GitHub credentials here.

create extension if not exists pgcrypto;

create table if not exists public.synced_users (
  handle text primary key,
  github_id bigint not null,
  avatar_url text,
  snapshot_json jsonb not null,
  updated_at timestamptz not null,
  constraint synced_users_handle_lowercase check (handle = lower(handle) and btrim(handle) <> '')
);

create table if not exists public.github_accounts (
  github_id bigint primary key,
  handle text not null,
  token_iv text not null,
  token_tag text not null,
  token_ciphertext text not null,
  scopes_json jsonb not null default '[]'::jsonb,
  tracked_repository_ids_json jsonb not null default '[]'::jsonb,
  excluded_repository_ids_json jsonb not null default '[]'::jsonb,
  auto_include_personal boolean not null default false,
  auto_include_organizations_json jsonb not null default '[]'::jsonb,
  baseline_by_repository_id_json jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  constraint github_accounts_handle_lowercase check (handle = lower(handle) and btrim(handle) <> '')
);

create table if not exists public.product_snapshots (
  github_id bigint unique,
  handle text not null,
  snapshot_json jsonb not null,
  updated_at timestamptz not null,
  row_version text not null default gen_random_uuid()::text,
  constraint product_snapshots_handle_lowercase check (handle = lower(handle) and btrim(handle) <> '')
);

-- The application uses the server-only Supabase key. RLS remains enabled so
-- an accidental browser-side client cannot read these tables anonymously.
alter table public.synced_users enable row level security;
alter table public.github_accounts enable row level security;
alter table public.product_snapshots enable row level security;

grant usage on schema public to service_role;
grant select, insert, update, delete on table
  public.synced_users,
  public.github_accounts,
  public.product_snapshots
  to service_role;

create index if not exists synced_users_github_id_idx
  on public.synced_users (github_id);

create index if not exists synced_users_updated_at_idx
  on public.synced_users (updated_at desc);
