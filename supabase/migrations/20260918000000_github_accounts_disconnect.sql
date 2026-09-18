-- Disconnect keeps the account row and the user's repository choices and only
-- drops the credential, so the row needs a way to say "no live token".
-- `putCredential` clears the marker on reconnect, `getToken` refuses to
-- decrypt a row that carries it, and `clearCredential` sets it. Without this
-- column every PostgREST call that names it fails with 42703, which turns
-- OAuth sign-in into `?signin=failed` and every repository/sync request into a
-- 500. Additive and idempotent: no data is rewritten.

alter table public.github_accounts
  add column if not exists disconnected_at timestamptz;
