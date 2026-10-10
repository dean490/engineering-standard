---
paths:
  - "supabase/migrations/**"
  - "supabase/tests/**"
  - "**/*.sql"
---

# Row-level security (constitution V; STANDARD 4.1, 6.5)

Every table is owned and tested:

- A table that holds user data has an owner column (tenant, household, or user) that references its owner.
- Row-level security is enabled in the migration that creates the table, together with its grants and policies. The policy and its test are part of the same change.
- The app queries as the signed-in user, so the policy, not app code, is the last line of defense. The service-role key bypasses row-level security; it never appears in request paths or client code.

Policy pattern (from the Supabase row-level security guide):

```sql
alter table public.items enable row level security;
revoke all on table public.items from anon, authenticated;
grant select, insert, update, delete on table public.items to authenticated;

create policy "Owners can read their items"
  on public.items for select
  to authenticated
  using ((select auth.uid()) = owner_id);

create policy "Owners can insert their items"
  on public.items for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);
```

- One policy per operation the table allows, each scoped `to authenticated` (or the narrowest role that needs it).
- Check ownership against `(select auth.uid())` or a membership table. Never trust an owner or tenant ID that the client sends.
- Grant each role only the privileges it uses.
- Every owned table has an automated test proving another tenant can't read or write its rows: an integration test against local Supabase, or a database test in `supabase/tests/`.
- Create every view in an exposed schema `with (security_invoker = true)`, so it reads with the caller's rights and the tables' policies apply. Don't let `anon` or `authenticated` select from a materialized view or a foreign table there; neither can have row-level security.
- CI fails when a schema the Data API may expose (`public`, `graphql_public`, and any other in `[api] schemas` of `supabase/config.toml`) holds a table without row-level security, a view without `security_invoker = true`, or a materialized view or foreign table that `anon` or `authenticated` can select (`scripts/check-rls.mjs`). As a backstop, it also fails when the client bundle holds the privileged key (`scripts/check-client-bundle.mjs`).
