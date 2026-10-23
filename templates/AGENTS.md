# AGENTS.md

Instructions for every coding agent in this repository. This project follows the engineering standard <version, e.g. v0.1.1> (<link to the engineering-standard repository>). Keep this file under 200 lines and import nothing large into it (STANDARD 8.1).

## Project

<One paragraph: what this project is, who uses it, and the one outcome that matters most. Don't restate the spec or the current state; link to them below.>

- Stack: <framework, language, database, hosting>
- Package manager: pnpm <version>, pinned in `package.json` `packageManager`
- Node: <version>, pinned in `package.json` `engines.node`

## Commands

| Purpose | Command |
|---|---|
| Setup | `pnpm install --frozen-lockfile` <then one-time steps, e.g. `/opt/homebrew/bin/supabase start`> |
| Gate | `pnpm run gate`: install from the lockfile, typecheck, lint, unit tests, integration tests, build (STANDARD 2.1). Save its output with `/eng-standard:gate <step>` |
| Fast gate | `pnpm run gate:fast`: typecheck, lint, unit tests. Run it with `/eng-standard:gate fast` before finishing a turn that changed code |
| Dev | `pnpm run dev` <URL, e.g. http://localhost:3000> |
| Unit tests | `pnpm run test` |
| Integration tests | `pnpm run test:integration` <needs local Supabase running> |
| Local database | `/opt/homebrew/bin/supabase start`, then `/opt/homebrew/bin/supabase db reset --local` to replay the migrations. Write the Supabase CLI by the absolute path in `.claude/settings.json` `excludedCommands` (on another machine, the path in its `.claude/settings.local.json`) and always write `--local`: only those spellings leave the sandbox to reach Docker, and this machine never links to a remote project. The CLI is installed outside the project, never as a project dependency |
| Typecheck, lint, build | `pnpm run typecheck`, `pnpm run lint`, `pnpm run build` |

## Architecture in brief

<Five to ten lines: the main parts and how they connect, where the boundaries are (server and client, app and database), and the invariants that matter most. Link to the spec section for anything longer.>

## Rules specific to this project

<Only rules that apply in every session and that no hook, permission rule, CI check, or database policy already enforces. One line each. When a written rule is broken twice, enforce it and delete it here (constitution IV).>

- <rule>

## Where things live

- What we're building: `docs/SPEC.md`. Read the sections your brief names, not the whole file.
- Current state: `docs/PROGRESS.md`, the only state file (STANDARD 8.2).
- The project's terms, one word per concept: `docs/GLOSSARY.md`. Use its words; read it when naming things.
- Decisions and rejected alternatives: `docs/DECISIONS.md`. Intentional differences from the spec: `docs/DEVIATIONS.md`.
- Environments, backups, runbooks: `docs/OPERATIONS.md`.
- Critic passes and rulings: `docs/reviews/`. History: `docs/archive/` (don't load it unless asked).
- Path-scoped rules for migrations, row-level security, and tests: `.claude/rules/`.
- Evidence: `.recon/<step>/`, raw command output with exit codes (gitignored, reviewed in place).
- Agent skills policy and allow-list: `docs/SKILLS.md`. Never run `npx skills`, and never install, update, or remove a skill unless the Planner gives the exact command.

## Workflow

Roles, gates, and evidence rules are in the engineering standard (STANDARD §1, §2). Each role runs in its own session, and the Owner starts every session.

- **Owner** (a human) starts every session, approves briefs, and approves anything irreversible or outward-facing: pushes to `main`, deploys, production data or schema, credentials, spending, publishing. The Owner pushes, opens pull requests, and merges; agent sessions have no route to GitHub.
- **Planner** works in plan mode and never edits the repository. It writes one brief at a time (`docs/BRIEF-TEMPLATE.md`), writes rulings in the brief file's "Rulings" section when the Owner says "Rule on brief <N>", and reads only the files a Builder leaves. It never starts, messages, or supervises a Builder.
- **Builder** implements one brief per session, one layer, exactly as the brief says. Check facts about tools and versions against current docs, not memory. Save raw evidence under `.recon/<step>/` and keep `.recon/<step>/INDEX.md` current (`docs/INDEX-TEMPLATE.md`). At the end, run the Critic and security-reviewer agents in parallel and **fix every finding that fits the brief, at any severity**, logging each. Stop only for a change to the spec or a decision, weaker security, or an irreversible action: list it under "Needs a ruling" in INDEX.md, tell the Owner "Rule on brief <N>", and wait. When the fast gate has passed (its result line is in INDEX.md), the reviews are in, and "Needs a ruling" is empty, stage files by name and commit with `git commit -F`. Never push. End with the brief's Owner steps, with the exact commands and links filled in.
- **Critic** reviews cold and only reports: per step with `/eng-standard:critic-pass <step>`, and at each phase gate in a separate session the Owner starts.
- End every session with `/eng-standard:handoff`.

## Working efficiently

Every turn re-sends the whole session (STANDARD §10):
- At about 140k tokens, hand off: write your state file (the brief file or INDEX.md), start your successor with `start_session`, detach it, and stop. About 3 web lookups per session, then a background research subagent. Hooks enforce both.
- Output that may pass about 100 lines goes to its evidence file; read the tail or grep it. Grep before reading, read large files by line range, and reuse fetched docs in `.recon/docs/`.
- When the brief's checks are done, commit and report; don't wait to be asked.
