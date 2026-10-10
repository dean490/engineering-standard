# Engineering Standard

Version 0.1 (draft) · Oct 2026 · Implements `CONSTITUTION.md` v0.1

How the constitution is carried out on every project. Each rule names how it is held:

- **[enforced]** by a wall, something that holds against a determined agent: the OS sandbox (files and network), GitHub-side controls (a ruleset on `main`, required checks), CI checks on committed content that run from the base branch, database constraints and policies, and the Owner's review at merge.
- **[guarded]** by a guardrail: a hook or permission rule blocks the common forms. It reads command text or paths, so a determined agent can find a spelling it misses (Claude Code's own docs say Bash deny rules aren't a security boundary). A [guarded] rule names the wall behind it in the same rule.
- **[checked]** by a reviewer: the Critic or the Owner checks it at a gate.
- **[practice]** relies on the agent following the instruction. Kept to a minimum; a practice broken twice gets promoted.

Every protection that matters has a wall behind it. Guardrails stay because they stop most real mistakes early and cheaply.

`[enforced]` describes a project once the GitHub settings in `docs/ADOPTING.md` are made.

Exact configuration lives in `templates/` and `plugin/`. This file says what must be true.

---

## 1. Roles and workflow

1.1 **Four roles.** Owner (human), Planner, Builder, Critic, as in constitution II. Each runs in its own session with its own context. Planner and Builder are never the same session. A Planner session is never forked (`--fork-session`, `/fork`, `/branch`) to build; building starts in a new session. [practice]

1.2 **Planner runs in plan mode and cannot edit the repository.** [guarded: plan mode, and the Planner guard on Claude's file tools and shell commands; walls: the Owner's review at merge and the protected `main` (9.1)] It reads the repo directly, reviews raw artifacts, and gives the Owner the exact next Builder prompt.

1.3 **Builder implements one step per session**, against a written step brief that states scope, files in scope, out-of-scope items, and the acceptance checks. [checked] When the brief does not cover something, the Builder stops and reports. [practice]

1.4 **Critic runs in two forms.**
- *Per-step review:* a read-only Critic subagent reviews each step's diff against the brief and spec before the Owner approves the commit. It reports gaps that affect correctness or stated requirements, not style. [checked]
- *Phase-gate pass:* a cold, separate Critic session reviews the whole phase against the spec. A phase is not complete until its gate pass is resolved. [checked]

1.5 **Findings get IDs and a ruling.** Every Critic finding has an ID, a severity, and a Planner ruling (fix, defer with reason, or reject with reason), recorded in that pass's review file. [checked]

1.6 **Owner approves**: every push to `main`, every deploy, every production data or schema change, every credential, every purchase, every publication. The Owner pushes, opens pull requests, and merges; agents commit only with the Owner's approval and never push. [enforced for pushes to `main` and deploys: agent sessions have no route to GitHub (the sandbox's network allowlist, 3.3), and the ruleset on `main` takes changes only through a pull request with the required checks (9.1); checked, by the Owner at adoption and at each phase gate, for production data, schema, and credentials: no production credentials on development machines (3.8); guarded: deny rules and the commit-hygiene hook, which block every `git push`; no standing approvals (3.4)]

1.7 **Model provenance.** Commit trailers and records name the model that actually did the work, or are omitted. Never a default. [practice]

## 2. Verification gates

2.1 **The gate.** One command per project runs, in order: install from lockfile, typecheck, lint, unit tests, integration tests (where a database is involved), build. Output goes to a file. [enforced: CI required check Gate, once the ruleset exists (9.1); guarded: the stop-gate hook asks a Builder session to run the fast gate before it finishes with uncommitted changes. It blocks once per stop and its record is forgeable, so it is a reminder and the wall is the CI Gate check (DECISIONS 10)]

2.2 **Evidence, not summaries.** Builder reports carry raw command output with exit codes, saved under `.recon/<step>/`. The Planner reviews the files. [checked]

2.3 **Observed running.** Any change to what a user or caller sees is incomplete until it has been observed in the running app, with the observation captured to a file (screenshot, HTTP response, log). Exempt: pure refactors, docs, and logic already pinned by tests. [checked]

2.4 **Tests.** Core logic, rules, and anything with money, safety, or permissions has unit tests. Anything that changes permanent state has integration tests against a real local database. Tests are never deleted or loosened to make a change pass. [enforced: CI check Test integrity, run from the base branch, fails a pull request that deletes a test file or adds a skipped, focused, postponed, or inverted test, and Sensitive change fails one that changes the test-runner, TypeScript, or lint configuration; the Owner may override with an admin merge, recorded in the pull request; checked]

2.5 **Test-count delta** is reported at the end of every Builder session. [practice]

## 3. Agent guardrails (Claude Code configuration)

3.1 **No real secrets within agents' reach.** On a machine where agents run, `.env*` and key files in a project hold only local, non-secret values (the local Supabase URL and keys, local ports). Real secrets live only in the hosting provider (4.6), and production credentials stay off the machine (3.8). [checked: the Owner, at adoption and at each phase gate] Reads of `.env*`, key files, and credential stores are also denied, and tool output is scanned for secret patterns and blocked if one appears. [guarded: the sandbox's read block for shell commands (`sandbox.filesystem.denyRead`, the `Read` deny rules it takes in, and `sandbox.credentials`), the `Read` deny rules for Claude's file tools, and the secret-guard hooks. Known gap: the sandbox's read block has a known bypass for shell commands, reported to Anthropic and not known to be fixed (see DECISIONS 7). The wall is the first half of this rule: there is no real secret to read.]

3.2 **Destructive and outward commands are denied by default:** every push, bulk `git add`, branch deletion, `rm -rf` outside the workspace, piping downloads into a shell, production database commands, deploys. [guarded: deny rules and the commit-hygiene hook; walls: the sandbox's network allowlist, which gives agent sessions no route to GitHub or the hosting provider (3.3), the sandbox's file blocks (3.3), and the ruleset on `main` (9.1); checked: no production credentials on development machines (3.8)]

3.3 **Shell commands run in the sandbox**, with network access limited to an allowlist: the package registry and the project's own services, never GitHub (1.6). [enforced: sandbox settings, with `failIfUnavailable` and no unsandboxed retry; checked: `strictAllowlist`, which refuses every host outside the allowlist in every permission mode, is set in the Owner's user settings, not in the repository, and the live check "no route to GitHub" in ADOPTING shows the allowlist refusing GitHub in the Owner's session; nothing reads the key itself. Exception: the local Supabase stack. The Supabase CLI, installed outside the project, leaves the sandbox by its absolute path for the local-stack commands only, and the stack runs agent-written SQL (migrations, seed) and Edge Functions in Docker, outside the sandbox and its network allowlist (DECISIONS 14)]

3.4 **No standing approvals for anything in 1.6.** Allowlists cover read-only and routine local commands only, and live in the committed project settings, not accumulated one-offs. [enforced for the committed settings: the CI check Sensitive change makes the Owner merge any change to `.claude/settings.json` deliberately, and sees committed settings only: user and local settings are the Owner's (3.3); checked for accumulated one-offs: at each phase gate, the Critic reviews `.claude/settings.local.json` and the user settings' `permissions.allow`]

3.5 **Protected paths.** Shipped migrations, the lockfile (except through the package manager), the standard's CI check scripts, and agent settings cannot be edited by the Builder without an explicit brief that names them. Everything under `.github/` (workflows, local actions) and `.githooks/`, and the secret-scan configuration (`.gitleaks.toml`, `.gitleaksignore`), are edited by the Owner only. So are git's own `.git/config` and `.git/hooks/`, which the Owner's terminal git reads and runs with the Owner's credentials (1.6). An `Edit` deny rule is merged into the sandbox's write block, so no deny rule may cover a path a tool or git must write: denying all of `.git` breaks `git add`, which is why the rules name `config`, `config.worktree`, and `hooks/` and nothing wider. [guarded: the protect-paths hook and the `Edit` deny rules on Claude's file tools for `.git/config`, `.git/config.worktree`, and `.git/hooks/`; walls: the sandbox's write block on `.github/`, `.githooks/`, the gitleaks files, `.git/config`, and `.git/hooks/`, the CI checks Migrations are append-only (6.2) and Sensitive change, which run from the base branch, and CI's frozen-lockfile install (5.1). Known limit: the `Edit` rules anchor at the session's primary working directory, so in a linked worktree the shared `.git` is outside them and only Claude Code's protected-path handling applies; `.git` is a protected directory, so in auto mode a write there routes to the permission classifier instead of being denied (`.recon/brief-04/docs-cc-permission-modes.md`, "Protected paths", and `docs-cc-permissions.md:374`)]

3.6 **Instructions are portable.** `AGENTS.md` is the project's instruction file for every agent tool; `CLAUDE.md` imports it and adds only Claude-specific notes. [practice]

3.7 **Hooks are portable and fail safely.** Paths resolve from the project directory, never a user's home path. Security hooks are written to block when unsure (exit 2); convenience hooks to allow. A hook that cannot start (no `node`, a crash) does not block, because Claude Code treats any exit other than 2 as non-blocking. A hook is a guard, never a wall; the adoption live check confirms hooks fire. [checked]

3.8 **Production credentials stay off development machines.** Production credentials (database, hosting) are not stored on development machines. Production changes run through CI or by the Owner. [checked: the Owner, at adoption and at each phase gate]

## 4. Application security

4.1 **Row-level security on every table**, written so the policy, not the app code, is the last line of defense. Every household-, tenant-, or user-owned table has an automated test proving another tenant cannot read or write it. [enforced: CI check that, in `public`, `graphql_public`, and any other schema the project lists for the Data API, every table has row-level security on, every view runs with `security_invoker`, and `anon` and `authenticated` can't select from a materialized view or foreign table; checked: each owned table has its isolation test, by the Critic at each phase gate; CI runs the tests]

4.2 **The app queries as the signed-in user.** The privileged database key is never used in request paths, never in client code, and only in server-side admin scripts that are run deliberately. [checked: the Owner, at adoption and at each phase gate, that the privileged key isn't set in the app's hosting environment; CI backstop: the check of the built client bundle and of browser-exposed variable names, which sees only a key written into the repository]

4.3 **Tokens and sessions.** Tokens are accepted only if issued for this service (audience, expiry, signature checked). Sessions are never used as authentication. Database and API clients are created per request, never shared across requests. [checked]

4.4 **AI features treat model input as untrusted.** Content from users, the web, or imports is passed to models as data. Tools a model can call enforce their own permissions; a model can never loosen a safety setting. Prompts and responses containing private data are not logged. Model versions are pinned. [checked]

4.5 **Security review.** Run the security review on every phase gate and on any change touching auth, permissions, payments, or AI tool access. The Planner runs it through `/eng-standard:critic-pass`, which launches the security reviewer when the Planner passes `gate` (every phase gate) or `security` (a change touching these areas); its findings are ruled like the Critic's (1.5). [checked]

4.6 **Secrets** live in the hosting provider's environment settings or a secrets manager, never in the repo, synced folders, agent settings, or a project file on a machine where agents run (3.1). Secret scanning with push protection is on for every repository where GitHub offers it. A private repository owned by a personal account gets neither (ADOPTING, GitHub settings), so there the stand-ins are the local pre-commit scan [guarded] and the CI secret scan [enforced] once the ruleset exists. [enforced: the CI secret scan with gitleaks's built-in rules, run from the base branch on pull requests, and GitHub push protection where the plan offers it; guarded: the local pre-commit scan, which runs only where `core.hooksPath` has been set outside Claude Code and which `--no-verify` bypasses, so the wall is the CI secret scan]

## 5. Supply chain

5.1 **Lockfile installs only.** CI installs strictly from the lockfile and fails on drift. [enforced]

5.2 **Release-age delay.** New package versions are not installed until they have been public for a minimum age (default 7 days; security fixes may be exempted by name). [enforced: package-manager setting, and the CI check Release age, which reads the registry's publish time of every version a pull request adds to the lockfile and applies the base branch's setting; a change to the setting fails the CI check Sensitive change]

5.3 **Install scripts allowlisted.** Only named packages may run install scripts. [enforced: package-manager setting; a change to it fails the CI check Sensitive change]

5.4 **Pinned CI actions.** Third-party GitHub Actions are pinned to a full commit hash, in workflows and in local composite actions, and `docker://` actions to an image digest. [enforced: CI check, and GitHub's setting requiring full-length SHAs]

5.5 **Dependency updates** arrive as automated pull requests, go through the full gate, and are merged by the Owner. [enforced: Dependabot plus the ruleset on `main`]

5.6 **Agent extensions are dependencies.** Skills, plugins, and MCP servers are read in full before install, committed or pinned, and their updates reviewed as diffs. Official publishers first. [checked; procedure and allow-list in `templates/docs/SKILLS.md`]

## 6. Data and migrations

6.1 **Schema and seed data change only through migrations** in the repo. No manual changes in a database console; an emergency fix is captured as a migration afterward. [checked]

6.2 **Shipped migrations are never edited.** A fix is a new migration, newer than every shipped one. [enforced: CI check Migrations are append-only, which fails any change to `supabase/migrations/` other than an added file, and an added migration that isn't newer than every migration on the base branch; guarded: the protect-paths hook]

6.3 **Migrations replay from empty** in CI on every change. [enforced: CI]

6.4 **Order of environments:** local, then staging, then production. Production schema changes are an Owner approval. [checked: no production credentials on development machines (3.8), so production migrations are applied by the Owner or a CI deploy job]

6.5 **Every table that holds user data** references its owner (tenant, household, or user) and has row-level security from its first migration. [practice for the owner reference, which no check reads; enforced for row-level security by the RLS check in 4.1]

## 7. Operations

7.1 **Environments are written down:** what exists, which keys each uses (names only), and what is deployed where. One file, updated when it changes. [practice; checked at phase gates]

7.2 **Backups and restore.** Before real users depend on the data: automated backups on, recovery window known, and one restore actually performed into a scratch environment and recorded. [checked; a go-live gate]

7.3 **Error monitoring** that never captures private data by default (no PII, no session replay unless decided). [checked]

7.4 **Go-live checklist** per project: staging exists, restore tested, secrets scanned, security review passed, monitoring on. [checked]

## 8. Documents and state

8.1 **Always-loaded instructions stay short.** `AGENTS.md` under about 200 lines; no `@`-imports of large documents. Specs, runbooks, and history are read on demand. [checked: a size read from `wc -l` and `wc -c` at each phase gate; no script ships]

8.2 **One state file.** `docs/PROGRESS.md` holds current state: phase, last step, what is deployed where, next step, open items. Other documents link to it instead of restating state. Updated by the `/eng-standard:handoff` skill at the end of every session, and kept under about 60 lines: history moves to `docs/archive/` (8.3). [practice, made routine by the skill]

8.3 **Standard document set:**
- `docs/SPEC.md`: what is being built (split by area when it grows past one reading).
- `docs/DECISIONS.md`: decisions with date, rationale, and rejected alternatives.
- `docs/DEVIATIONS.md`: intentional differences from the spec.
- `docs/PROGRESS.md`: current state (8.2).
- `docs/OPERATIONS.md`: environments, backups, runbooks.
- `docs/SKILLS.md`: the agent-skills allow-list, pins, and register of what is installed (5.6).
- `docs/reviews/<date>-<scope>.md`: one file per Critic pass with findings and rulings.
- `docs/archive/`: session logs and superseded documents, by quarter.

8.4 **Supersession is explicit.** A changed section says what replaced it; the spec keeps a short index of which section governs each feature. [checked]

## 9. Repository and CI

9.1 **`main` is protected:** pull requests only, required CI checks, no force-push, no deletion. Nobody pushes to `main` directly, the Owner included: the Owner's bypass works only through a pull request. [enforced: a ruleset on `main`]

9.2 **CI runs the full gate** (2.1), the migration replay (6.3), the row-level security check and isolation tests (4.1), the client bundle backstop (4.2), and the dependency audit on the pull request's code. On pull requests, the guard checks run from the base branch, so a pull request can't change or skip them: secret scanning (4.6), action pinning (5.4), the append-only migration check (6.2), Release age (5.2), Test integrity (2.4), and Sensitive change (3.4, 3.5). On a push to `main`, secret scanning, action pinning, and the migration check run again on what was pushed. [enforced]

9.3 **Commits** are staged by name, messages written to a file and committed with `-F`, subjects of 72 characters or less. [guarded: the commit-hygiene hook for bulk staging and `-m`, whose block message states the 72-character subject limit but does not measure it; walls: the Owner's review at merge and the protected `main` (9.1); practice for the subject length and the trailers]

## 10. Context and cost

Every turn re-sends the whole conversation, and each session starts with tens of thousands of tokens of tool definitions, so long sessions cost the most (DECISIONS 15). These rules are about cost, not safety; none is a wall. A rule that a template setting carries says so.

10.1 **Short sessions.** One Builder brief per session, sized so the session finishes under about 150k tokens. A Planner session covers one review cycle and ends with the state file updated (8.2). Work too big for that is split into more briefs. [checked: the Planner, when writing a brief]

10.2 **Early compaction.** A session compacts when its context reaches `autoCompactWindow` tokens instead of the model's limit (about 967k on a model with a 1M window). The template sets `"autoCompactWindow": 200000` in `.claude/settings.json`; the key takes 100000 to 1000000 and is valid in any settings file. A window saved per model with `/autocompact` takes precedence over the key in the same file, `--autocompact` overrides both for one launch, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (a plain integer) overrides everything. The Owner sets the same value in `~/.claude/settings.json` (ADOPTING). [practice, set in the template]

10.3 **Long output goes to a file.** A command that may print more than about 100 lines (tests, builds, installs, logs) writes to its evidence file, and the agent reads the tail or greps it. Evidence files and probe scripts start with one result line (counts, exit code), so a reviewer can check them with `head` or `grep`; the raw output still follows in full (2.2). `/eng-standard:gate` works this way: it prints only the evidence path and the exit code, and its file starts with a `# result:` line. [practice]

10.4 **Read narrowly.** Grep before reading, read large files by line range, and never pull a whole documentation page into context: save it to a file once and grep it. [practice]

10.5 **One docs cache.** Fetched sources live in `.recon/docs/`, one file per source with its fetch date, and are reused across steps. Re-fetch when a source is older than 30 days or its version changed. [practice]

10.6 **Model and effort per brief.** Each brief names its model and effort: the mid-tier model (Sonnet) for routine steps, the top tier (Opus) for the Planner, the Critic, and steps that touch security, permissions, row-level security, or core algorithms. [checked: the Planner, when writing a brief]

10.7 **Load only what the project uses.** Connectors, MCP servers, skills, and plugins that a project doesn't use stay out of its sessions, because each adds to the tokens a session starts with. A project can set only part of this. The template sets `"disableClaudeAiConnectors": true`, which stops Claude Code from fetching claude.ai connectors in terminal, VS Code, JetBrains, and Agent SDK sessions. It does not reach the connectors the Claude desktop app delivers, which the Owner switches off in the app, nor the skills and plugins synced from the Owner's claude.ai account, which only user, local, or managed settings can turn off; ADOPTING lists the Owner's toggles. MCP tool definitions are already deferred until used (tool search, on by default), and `enabledMcpjsonServers` and `disabledMcpjsonServers` approve or reject only servers a project's `.mcp.json` defines. [practice, set in the template for what a project can set]

10.8 **Broad research goes to a subagent** (such as Explore), so only the conclusion enters the main context. Evidence a reviewer needs is still saved raw to files. [practice]

---

## Changing this standard

Proposed changes go through a pull request to the standard's repository with the reason added to its decision log. Projects pin a standard version and adopt new versions deliberately, reviewing the diff.
