-- Opt-in for showing dressed companions on the owner's public repositories.
--
-- See apps/web/src/lib/sync/repo-badge-store.ts and
-- docs-plan/PLAN-dressed-repo-creature.md. Separate from profile_visibility
-- because a repo badge and a public profile publish different things.
--
-- Default OFF: a row exists only while the owner has opted in, and opting out
-- deletes it. Keyed by the immutable GitHub id, never the reusable login.
--
-- Additive and idempotent: no existing data is touched.

create table if not exists public.repo_badge_display (
  github_id bigint primary key,
  handle text not null,
  updated_at timestamptz not null default now()
);

-- Only the server (service role) reads or writes this table. With RLS on and
-- no policies, the anon and authenticated roles see nothing.
alter table public.repo_badge_display enable row level security;
grant select, insert, update, delete on table public.repo_badge_display to service_role;
