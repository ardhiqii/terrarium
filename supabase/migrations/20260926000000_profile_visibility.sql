-- Public-profile opt-in policy.
--
-- The rule (see apps/web/src/lib/sync/profile-visibility.ts) is that a public
-- profile is OPT-IN and the default is PRIVATE. Storing the choice keyed by
-- the immutable GitHub id (never the mutable, reusable login) is what makes
-- the rule enforceable; without this table /u/<handle> has no policy to read.
--
-- Additive and idempotent: no existing data is touched.

create table if not exists public.profile_visibility (
  github_id bigint primary key,
  handle text not null,
  -- Only 'public' renders a profile. Anything else is the private default.
  visibility text not null default 'private',
  updated_at timestamptz not null default now()
);

-- Lookups are always by immutable id; the handle is stored for display only.
create index if not exists profile_visibility_handle_idx
  on public.profile_visibility (handle);
