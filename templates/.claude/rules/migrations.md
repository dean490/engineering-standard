---
paths:
  - "supabase/migrations/**"
  - "supabase/seed.sql"
  - "supabase/config.toml"
---

# Migrations (constitution VII; STANDARD 6)

- Every schema or seed-data change is a new migration in `supabase/migrations/`. Create it with `/opt/homebrew/bin/supabase migration new <name>` (the CLI's absolute path; `AGENTS.md`). Never change a database by hand or in a dashboard; an emergency fix is captured as a migration afterward.
- Migrations are append-only. Never edit, delete, or rename a migration that exists on the base branch (`main`); a fix is a new migration, with a version newer than every shipped one. A migration committed earlier on the current step's branch hasn't shipped yet and may still be fixed. The protect-paths hook blocks an edit of a shipped migration unless the brief lists the file in `.recon/current-brief-paths.txt`, and the CI check **Migrations are append-only** fails any change to `supabase/migrations/` other than an added migration newer than every one on the base branch.
- One logical change per migration, named for what it does.
- A table that holds user data gets row-level security, its grants, and its policies in the same migration that creates it (see `.claude/rules/rls.md`).
- Migrations replay from empty: run `/opt/homebrew/bin/supabase db reset --local` before reporting a step done. CI replays them on every change and then checks row-level security on every table and view in a schema the Data API may expose.
- Reference and seed data live in migrations or `supabase/seed.sql`, never inserted by hand.
- Production schema changes are an Owner action. Never run `supabase db push`, `supabase link`, or any `supabase` command with `--linked`, `--db-url`, or `--project-ref`.
