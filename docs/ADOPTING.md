# Adopting the engineering standard

How to put a project on the engineering standard, new or existing: the steps, once each. The rules are in `STANDARD.md`; the reasons are in `DECISIONS.md`. It takes about an hour, most of it reviewing settings. The Owner does the steps marked **(Owner)**; anything else can be a Builder step with a brief.

Verified against Claude Code 2.1.293 (and 2.1.286, which this repository's CI pins), pnpm 10.34.6 and 12.8.2, Node 24.21.0, gitleaks 8.30.1, actionlint 1.7.12, yq 4.53.6, git 2.39.2, the Supabase CLI source at v2.120.0, and the GitHub, pnpm, gitleaks, Vercel, Supabase, and Claude Code documentation as of 2026-10-09. The evidence is in this repository's `.recon/brief-01/` to `.recon/brief-05/` on the machine that built it.

## Guardrails and walls

The standard tags each rule by what holds it (`STANDARD.md`, introduction). A **wall** holds against a determined agent (the walls are listed in DECISIONS 11). A **guardrail** catches mistakes and casual improvisation: the plugin's hooks and the permission rules read command text or paths, so a determined agent can find a spelling they miss. The guardrails stop most problems early; the walls below are what the standard relies on. Set up both.

## What you need

- **Claude Code 2.1.285 or later**, on macOS, Linux, or WSL2, in the CLI or the desktop app's Code tab, in **local sessions**. v0.1.0 doesn't support cloud sessions: they don't install the plugins a repository declares, and they reach GitHub with the Owner's authorization through Anthropic's proxy, so neither the guardrails nor the network wall holds there. The template turns on the sandbox with `failIfUnavailable`, so Claude Code refuses to start where the sandbox can't run, including native Windows. On Linux and WSL2, install `bubblewrap` and `socat` first.
- **Node** on `PATH`. The plugin's hooks run `node`.
- **git**, and **pnpm 10.26.0 or later**. The template pins the 10.x line; see [pnpm version](#pnpm-version).
- **The Supabase CLI**, installed outside the project, never as a project dependency: on macOS, `brew install supabase/tap/supabase` (Apple Silicon puts it at `/opt/homebrew/bin/supabase`, the path the template names; Intel Macs at `/usr/local/bin/supabase`); on Linux and WSL2, a release binary from <https://github.com/supabase/cli/releases>, checked against that release's `checksums.txt`. Pick a release at least 7 days old where you can (STANDARD 5.2); CI pins 2.119.0. See [The Supabase CLI](#the-supabase-cli) for a machine where it lives at another path.
- **gitleaks** on `PATH` on every machine that commits to the project. The pre-commit hook runs it on the staged changes and stops the commit when it isn't installed. On macOS, install it with Homebrew: `brew install gitleaks`. On Linux and WSL2, use a release binary from <https://github.com/gitleaks/gitleaks/releases>. The hook needs gitleaks 8.19.0 or later, the release that added `gitleaks git`; CI uses 8.30.1.
- **GitHub**: the project's repository is private and needs GitHub Pro or higher for rulesets: Pro for a repository owned by a personal account, Team or Enterprise for one owned by an organization. Push-blocking secret scanning on a private repository needs GitHub Team or Enterprise, so on Pro the local pre-commit gitleaks hook and the CI secret scan stand in for it, and the project records that in `docs/DEVIATIONS.md`. See [GitHub settings](#github-settings-owner).
- Network access to github.com for Claude Code itself (it clones the plugin marketplace) and for the Owner's pushes. Once this repository is published it is public, so no git credentials are needed to use the plugin. Sandboxed commands never reach GitHub.

## Owner machine setup (Owner, once per machine)

**Required.** Add the network lock and the machine's network allowlist to `~/.claude/settings.json`, merging them into any `sandbox` settings already there:

```json
{
  "sandbox": {
    "network": {
      "strictAllowlist": true,
      "allowedDomains": ["registry.npmjs.org"]
    }
  }
}
```

- `strictAllowlist` makes the sandbox refuse every host outside the allowlist, in every permission mode, instead of prompting or letting auto mode approve it. Claude Code reads it only from user settings, managed settings, and `--settings`; a repository can't turn it on or off. It needs Claude Code 2.1.219 or later.
- With the lock on, Claude Code ignores a repository's `allowedDomains` (and its `WebFetch(domain:...)` allow rules and proxy ports, from 2.1.285). So on this machine the list above is the one that counts, and the template's own `allowedDomains` applies only on machines without the lock. When a project needs another host, such as Google Fonts at build time or Playwright's browser download, the Owner adds it here. Never add GitHub (`github.com`, `api.github.com`, `*.githubusercontent.com`): agent sessions have no route to GitHub (STANDARD 1.6; `DECISIONS.md`, entry 12).
- The lock and the list apply to every project on the machine that has the sandbox on, not only to projects on the standard.
- Code sessions in the Claude desktop app read the same `~/.claude/settings.json` as the CLI.

**Recommended.** Compact earlier, and keep what a project doesn't use out of its sessions (STANDARD §10). Add the compaction window to `~/.claude/settings.json`; the template sets the same value for each project:

```json
{
  "autoCompactWindow": 200000
}
```

- `autoCompactWindow` (100000 to 1000000) makes a session compact at that many tokens of context instead of near the model's limit. What overrides it, and when, is in STANDARD 10.2.
- A session starts with tens of thousands of tokens of tool definitions (about 57k in the Owner's measurement: Claude Code's tools about 31k, connector tools about 17k, skills about 6k), and every turn re-sends them. What you can switch off, by where it lives:
  - **Connectors in the Claude desktop app's Code tab.** The app delivers them to the session itself, so no setting file reaches them. Switch them off in the app: **+ > Connectors**, **Manage connectors**, or Settings > Connectors. The session's connector toggle applies to that session only. On claude.ai, the same list is at claude.ai/customize/connectors.
  - **Connectors in the CLI, VS Code, JetBrains, and Agent SDK sessions.** The template sets `"disableClaudeAiConnectors": true` for each project. Set it in `~/.claude/settings.json` to apply to every project (a `true` in any settings file applies), or set the environment variable `ENABLE_CLAUDEAI_MCP_SERVERS=false`. A project that needs those connectors removes the key from its `.claude/settings.json`, and the Owner sets neither of these.
  - **Skills and plugins synced from your claude.ai account.** `"syncClaudeAiSkills": false` and `"syncClaudeAiPlugins": false` work only in `~/.claude/settings.json`, `.claude/settings.local.json`, or managed settings: a repository can't turn them off. `skillOverrides` and `enabledPlugins` work in any settings file, including the project's.
  - **MCP servers a project defines in `.mcp.json`.** `enabledMcpjsonServers` and `disabledMcpjsonServers` approve or reject them; they don't reach connectors or user-level servers. Tool definitions of MCP servers are already deferred until used (tool search, on by default).

On a machine whose Supabase CLI isn't at `/opt/homebrew/bin/supabase`, also add its path to the project's `.claude/settings.local.json` (see [The Supabase CLI](#the-supabase-cli)).

## Copy the templates

The template's `.claude/settings.json` stops Claude's file tools and sandboxed commands from writing `.github/`, `.githooks/`, and the gitleaks files, so a session can't install them. **(Owner)** First copy the protected files in yourself, from a terminal outside Claude Code (or the desktop app's terminal panel), with the standard checked out at `$STANDARD` and the project as the current directory:

```bash
cp -R "$STANDARD/templates/.github" "$STANDARD/templates/.githooks" "$STANDARD/templates/scripts" .
```

That copies the CI workflows, Dependabot, the pull request template, the pre-commit hook, and the check scripts. The templates hold no `.gitleaks.toml` or `.gitleaksignore`; when a project needs a `.gitleaksignore` entry, the Owner writes it. Then copy the other files from `templates/` to the same path in the project (a Builder step is fine), with `.claude/settings.json` last:

| Template | Purpose | Edit after copying |
|---|---|---|
| `AGENTS.md` | Instructions for every agent; stays under 200 lines | Replace every `<…>` placeholder |
| `CLAUDE.md` | Imports `AGENTS.md` and adds Claude Code notes | Nothing |
| `.claude/settings.json` | Deny, ask, and allow rules; sandbox; plugin marketplace | Pin `ref` to the standard's version tag |
| `.githooks/pre-commit` | Scans the staged changes for secrets with gitleaks before every commit | Nothing; keep it executable (`chmod +x`) |
| `.claude/rules/migrations.md`, `rls.md`, `tests.md` | Path-scoped rules that load when Claude touches matching files | Adjust `paths` if the layout differs |
| `pnpm-workspace.yaml` | Release-age delay, install-script allowlist, trust policy | Add `allowBuilds` entries as installs ask for them |
| `tsconfig.base.json` | Strict TypeScript options | Have the project's `tsconfig.json` extend it |
| `.github/workflows/ci.yml` | The jobs that run the pull request's code: **Gate** (with the row-level security check and the client bundle backstop) and **Dependency audit**; on a push to `main`, the secret scan, pinning check, and migration check again | Nothing, if `package.json` has the scripts below; set `CLIENT_BUNDLE_DIR` on the bundle step for a client build directory other than `.next/static`, or `none` |
| `.github/workflows/guards.yml` | The guard checks, run from the default branch on `pull_request_target`: **Migrations are append-only**, **Test integrity**, **Sensitive change**, **Actions pinned to commit SHAs**, **Secret scan**, **Release age** | Nothing |
| `scripts/check-*.mjs` | The checks the workflows run (copied from `templates/scripts/`); protected paths | Nothing |
| `.github/dependabot.yml` | Weekly npm and GitHub Actions updates with a 7-day cooldown | Nothing |
| `.github/pull_request_template.md` | Pull request sections the standard asks for | Nothing |
| `docs/SPEC.md`, `DECISIONS.md`, `DEVIATIONS.md`, `PROGRESS.md`, `OPERATIONS.md`, `SKILLS.md`, `reviews/README.md`, `archive/README.md` | The standard document set (STANDARD 8.3) | Fill in as the project goes |
| `.gitignore` | Ignores `.env*` (except `.env.example`), `.recon/`, build output, and personal Claude files | Add project-specific entries |

Agents cannot reliably edit permission files inside `templates/`: the Owner applies such edits, and the Builder stops and reports when refused (DECISIONS 17).

### `package.json`

The CI workflow, the gate skill, the stop gate, and the pre-commit hook rely on these in `package.json`:

```json
{
  "packageManager": "pnpm@10.34.6",
  "engines": { "node": "24.x" },
  "scripts": {
    "prepare": "test \"$(git config --get core.hooksPath)\" = .githooks || git config core.hooksPath .githooks",
    "dev": "<dev server>",
    "typecheck": "tsc --noEmit",
    "lint": "<linter, without --fix>",
    "test": "<unit tests, e.g. vitest run>",
    "test:integration": "<integration tests against local Supabase>",
    "build": "<build>",
    "gate:fast": "pnpm run typecheck && pnpm run lint && pnpm run test",
    "gate": "pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run lint && pnpm run test && pnpm run test:integration && pnpm run build"
  }
}
```

- **`prepare`** runs on every `pnpm install` and sets `core.hooksPath` to `.githooks`, so git runs `.githooks/pre-commit`. It writes `.git/config` only when the setting is missing or different, because the Claude Code sandbox denies writes to `.git/config`: run the first `pnpm install` in a new clone yourself, outside Claude Code, and later installs inside the sandbox pass. A plain `git config core.hooksPath .githooks` would make every `pnpm install` Claude runs fail, including the one that starts `gate`.
- **`gate:fast`** is the fast gate: typecheck, lint, and unit tests, with no install, integration tests, or build, so it is quick and needs no local Supabase. `/eng-standard:gate fast` runs it inside the sandbox and records the result. When a Builder session is about to finish with uncommitted source or test changes and no passing record for those changes, the stop gate blocks the stop once and asks it to run `/eng-standard:gate fast`. The stop gate itself runs nothing.
- **`gate`** is the full gate, for `/eng-standard:gate <step>`; CI runs the same steps one by one. Drop `test:integration` from `gate` if the project has no database. Integration tests expect local Supabase to be running (`/opt/homebrew/bin/supabase start`); CI starts it.

`tsconfig.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "<framework options>": "..." }
}
```

`exactOptionalPropertyTypes` is on. Tested against Next.js 16.3.8, React 19.3.0, @supabase/supabase-js 2.117.2, @supabase/ssr 0.12.7, Zod 4.6.5, and Vitest 5.0.3 with TypeScript 7.0.2: it added no errors in those libraries' own types, and idiomatic use of each compiled cleanly. It does reject passing a value that may be `undefined` to an optional field typed without `| undefined`, such as `persistSession: maybeBoolean` in the Supabase client options. Spread the field in only when it's defined.

## Enable the plugin

The template's `.claude/settings.json` registers this repository as a plugin marketplace and turns the plugin on for everyone who works in the project:

```json
"extraKnownMarketplaces": {
  "engineering-standard": {
    "source": { "source": "github", "repo": "dean490/engineering-standard", "ref": "v0.1.0" }
  }
},
"enabledPlugins": { "eng-standard@engineering-standard": true }
```

Once published, the marketplace is a public GitHub repository, [dean490/engineering-standard](https://github.com/dean490/engineering-standard), so no credential setup is needed: Claude Code clones a public repository over HTTPS without credentials.

1. Keep `ref` on a released tag of this repository. `ref` pins the marketplace, and with it the plugin, to that tag; adopting a new version means changing `ref` and reviewing the diff (constitution IX). **(Owner)** A version can be adopted once its tag, such as `v0.1.0`, is pushed to GitHub. That tag does not exist until publication: this repository has no remote and no tag, so until then the `ref` above names nothing that can be fetched.
2. On a machine with no SSH key for github.com, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in the environment Claude Code starts in. For `owner/repo` sources, Claude Code checks whether an SSH key authenticates to github.com and clones over HTTPS if it doesn't; the variable skips that check.
3. Open the project in Claude Code and accept the workspace trust dialog. Claude Code applies a repository's `extraKnownMarketplaces` only in a folder you've trusted; in an untrusted folder, including a `claude -p` run there, it ignores them without a message. Project `permissions.allow` rules also wait for trust; deny and ask rules apply immediately.
4. Check: run `/plugin` and confirm `eng-standard` is installed and enabled, or run `claude plugin list` in the shell. `eng-standard` is listed in the marketplace by a relative path, so it loads from the marketplace's copy as soon as the marketplace registers; no separate `claude plugin install` is needed.

Background auto-update is off by default for marketplaces outside Anthropic's own. Leave it off: versions change only when the project changes `ref`.

### Fallback: a vendored copy

For offline use, or to keep a pinned copy inside the project instead of fetching it from GitHub, vendor this repository. Copy its `.claude-plugin/` and `plugin/` into the project, for example under `vendor/engineering-standard/`, commit them, and point the marketplace at the copy:

```json
"extraKnownMarketplaces": {
  "engineering-standard": {
    "source": { "source": "directory", "path": "./vendor/engineering-standard" }
  }
}
```

A relative `directory` path resolves against the repository's main checkout. Update the copy only by replacing it with a tagged release and reviewing the diff. For a one-off session, `claude --plugin-dir vendor/engineering-standard/plugin` loads the plugin without any marketplace.

## Workflow files the Owner writes

- **`.recon/current-brief-paths.txt`**: when a brief allows the Builder to edit a protected path with Claude's file tools (a shipped migration, the lockfile, a `scripts/check-*` file, or `.claude/settings.json`), the Owner lists those repository-relative paths here, one per line, before handing the brief to the Builder, and clears the file after the step. The deny rule `Edit(.recon/current-brief-paths.txt)` and the protect-paths hook stop a session from writing it, so write it in an editor or shell outside Claude Code. The list lifts only the hook; the CI checks still apply, so a change to a shipped migration fails **Migrations are append-only** and the others fail **Sensitive change** until the Owner merges them deliberately. Files under `.github/` and `.githooks/`, `.gitleaks.toml`, and `.gitleaksignore` can't be listed: the `Edit` deny rules and the sandbox block them for every session, so the Owner edits them outside Claude Code.
- **Planner sessions**: start the Planner in plan mode, with `claude --permission-mode plan` or by switching to plan mode before sending the first prompt. The plugin records each session's role from its first prompt. A session whose first prompt is sent in plan mode is a Planner session for its whole life, including after a plan is approved and after `--resume` or `--continue`, which keep the session: the plugin's hooks deny its Edit, Write, and NotebookEdit calls on files in the repository, and allow its Bash, PowerShell, and Monitor commands only when they are on the read-only allowlist the Critic uses (read-only git commands, read-only file utilities such as `cat`, `grep`, and `find`, and the project's test and typecheck scripts). If its role record can't be read, the session is treated as a Planner. Any other session is a Builder session, which plan mode alone governs: its file edits wait while plan mode is on, so a Builder can explore, plan, have the plan approved, and implement in one session. These hooks are guardrails; the walls are the Owner's review at merge and the protected `main`. `/clear` and `--fork-session` start a new session, whose role comes from its own first prompt. **Never fork a Planner session (`--fork-session`, `/fork`, `/branch`) to build. Start a new session.** Roles live in `~/.claude/plugins/data/<plugin id>/session-roles/`, which no session's file tools may write, and are removed 30 days after a session's last prompt.
- **Phase-gate Critic**: start a separate session with `claude --agent eng-standard:critic`.

## How the Owner pushes and opens a pull request

Agent sessions never push (STANDARD 1.6, DECISIONS 12). After the Owner approves a step's commit, the Planner gives the Owner the commands to push the branch and open the pull request. The Owner runs them in one of these places:

- **`!` commands in the session**, the simplest. A command typed after `!` at the start of the prompt runs in the Owner's own shell: outside the sandbox, and past the deny rules and the plugin's hooks, which apply only to the commands Claude runs (Claude Code 2.1.293: `.recon/brief-04/cc-binary-shell-mode-and-excluded-commands.txt`). The exceptions are a background session, and a Linux session with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, where `!` commands run in the sandbox too; use a terminal there. The adoption check confirms the route works in your setup, CLI or desktop app.
- **The desktop app's terminal panel** (**Terminal** in the session's title bar, or Ctrl+\`), or **any terminal outside Claude Code**: the same commands without the `!`.

Read what the push carries, push the branch, and open the pull request:

```text
! git fetch origin
! git log --oneline --stat origin/main..HEAD
! git push -u origin <branch>
! gh pr create --base main --head <branch> --title "<title>" --body-file <file>
```

Without the GitHub CLI, open `https://github.com/<owner>/<repo>/compare/main...<branch>?expand=1` in a browser instead of the last command. Claude reads the output of `!` commands and replies to it; set `respondToBashCommands` to `false` in `~/.claude/settings.json` if you'd rather it didn't. The Owner merges in the pull request once the required checks pass, or with the override (below).

## Turning things off

- **Stop gate**: add `"env": { "ENG_STANDARD_STOP_GATE": "off" }` to `.claude/settings.json` for the whole project, or to `.claude/settings.local.json` for one machine. A project with no `gate:fast` script has no stop gate either. The stop gate is a reminder, not a wall: CI's required **Gate** check is.
- Nothing else is meant to be turned off. A rule that gets in the way is a change to the standard: propose it in this repository (constitution, Amendments).

## Consequences to know about

What changes for a project and the people in it, and where each is specified. The rule is in `STANDARD.md`, the reason in `DECISIONS.md`, and the exact settings in the templates and the plugin's hooks.

| Consequence | Specified in |
|---|---|
| **No real secret in a project file.** On a machine where agents run, `.env*` and key files hold only local values; never run `vercel env pull` there, and take local Supabase values from `supabase status -o env`. `next dev`, builds, and tests that Claude runs can't read `.env.local`. `.env.example` is covered too, so the Owner maintains it. The read block has a known bypass, which is why the wall is that no real secret is in the working tree; the secret-guard hooks also block the common reads (`cat .env`, `grep KEY .env.local`). | STANDARD 3.1, 4.6; DECISIONS 7; template `.claude/settings.json` |
| **Linux and WSL2 cover less.** A `.env*` file created during a session is covered from the next session, and the wildcard write entries don't stop a rename or a new `.env*` file there. The wall is the same on every platform. | DECISIONS 7 (What is verified) |
| **Credential stores and token variables are unreadable** to sandboxed commands and Claude's Read tool. `pnpm install` still works with `~/.npmrc` unreadable; it prints a warning (pnpm 10.34.6, `.recon/brief-04/npmrc-pnpm-install.txt`). | STANDARD 3.1; template `.claude/settings.json` (`denyRead`, `sandbox.credentials`) |
| **Every commit runs gitleaks** on the staged changes with its built-in rules, and a finding stops the commit with the secret redacted. Remove the secret; for a false positive, add a `gitleaks:allow` comment or the finding's fingerprint to `.gitleaksignore`, which fails the CI **Sensitive change** check so the Owner merges it deliberately. The CI **Secret scan** is the wall that matters. | STANDARD 4.6, 3.5; DECISIONS 11; `.githooks/pre-commit` |
| **The plugin blocks pushes, deploys, and the usual ways to throw away work**, including git commands whose name or arguments come from a variable or a substitution, since it can't tell what would run. Restoring or staging a single named file stays allowed, Next.js route files such as `app/[slug]/page.tsx` included. This is a guardrail; the walls are the sandbox, the ruleset, and no production credentials on the machine. | STANDARD 1.6, 3.2; DECISIONS 11, 12; `plugin/hooks/commit-hygiene.cjs` and its tests |
| **Production credentials stay off development machines.** No production database URL or password, no `supabase login` access token, no `vercel login` token. Production changes run through CI or by the Owner, from a session without agents. | STANDARD 3.8; phase-gate checks in `plugin/skills/critic-pass/review-template.md` |
| **Supabase: development machines use the local stack only.** Never run `supabase link` against staging or production there; the Owner applies production migrations. With no linked project and no access token, the commands the hook blocks have nothing to reach. | STANDARD 3.2, 3.3, 3.8; DECISIONS 14; [The Supabase CLI](#the-supabase-cli) below |
| **Local servers (macOS).** `allowLocalBinding` lets sandboxed commands start a dev server and reach local Supabase on `localhost`. On Linux and WSL2 it has no effect: sandboxed commands can't reach servers on the host, so add the integration-test and dev commands to `sandbox.excludedCommands` in `.claude/settings.local.json` there. | template `.claude/settings.json`; STANDARD 3.3 |
| **Network allowlist.** Sandboxed commands reach only the npm registry, plus any host the Owner adds to the machine's list (see [Owner machine setup](#owner-machine-setup-owner-once-per-machine)); never GitHub. Claude Code itself still clones the plugin marketplace from GitHub, in its own process, not in the sandbox. | STANDARD 3.3, 1.6; DECISIONS 12 |
| **Allow rules are short on purpose.** Everything else prompts, or goes to the classifier in auto mode. | STANDARD 3.4 |
| **A deny rule of your own is also a sandbox block.** A `Read` or `Edit` deny rule is merged into the sandbox configuration, so never deny a path a tool has to write. The symptom is `Operation not permitted` on something like `.git/index.lock`, from a `git add` that worked before the rule (`.recon/brief-06/git-deny-wide.txt`). | STANDARD 3.5; DECISIONS 12 |

### The Supabase CLI

The local-stack commands drive Docker, which can't run in the sandbox, so `sandbox.excludedCommands` takes them out of it, by the CLI's absolute path only: `/opt/homebrew/bin/supabase start`, `stop`, and `status`, and `db reset`, `db diff`, `test db`, and `gen types` written with `--local` straight after the subcommand, as in `/opt/homebrew/bin/supabase db reset --local` (Supabase CLI v2.120.0; `.recon/brief-03/supabase-cli-v2.120.0/`). Claude Code matches these entries against the command's text, so `supabase start`, `pnpm exec supabase start`, `npx supabase start`, and `PATH=… /opt/homebrew/bin/supabase start` all stay in the sandbox, where they can't reach Docker and fail; write the absolute-path form (`AGENTS.md` says so). Deny rules and hooks still apply to excluded commands.

- **Another path**: on a machine whose CLI lives elsewhere, such as `/usr/local/bin/supabase` (Homebrew on an Intel Mac) or a release binary on Linux, add the same entries with that path to `.claude/settings.local.json`; entries from every settings file combine into one list:

  ```json
  {
    "sandbox": {
      "excludedCommands": [
        "/usr/local/bin/supabase start *",
        "/usr/local/bin/supabase stop *",
        "/usr/local/bin/supabase status *",
        "/usr/local/bin/supabase db reset --local *",
        "/usr/local/bin/supabase db diff --local *",
        "/usr/local/bin/supabase test db --local *",
        "/usr/local/bin/supabase gen types --local *"
      ]
    }
  }
  ```

- **Never a project dependency**: don't add `supabase` to `package.json`. `pnpm exec supabase` would run a binary from `node_modules/`, which sandboxed commands can rewrite, outside the sandbox (`DECISIONS.md`, entry 14). CI installs the CLI with `supabase/setup-cli` at the version its `version` input pins.
- **The local stack is outside the sandbox** (STANDARD 3.3, exception). It runs agent-written SQL (migrations, seed) and Edge Functions in Docker, with no sandbox file or network rules. A project without Edge Functions turns the Edge Runtime off in `supabase/config.toml`:

  ```toml
  [edge_runtime]
  enabled = false
  ```

## pnpm version

The template sets `minimumReleaseAge`, `allowBuilds`, `strictDepBuilds`, `trustPolicy`, and `blockExoticSubdeps`. `allowBuilds` needs pnpm 10.26.0 or later (it replaced `onlyBuiltDependencies`, which pnpm 11 removed). The template pins the 10.x line because GitHub's Dependabot documentation lists pnpm support for v7 through v10 only. pnpm 12.8.2 was also tested with the same settings and enforces them the same way; move to it once Dependabot supports it. Pick a pnpm release at least 7 days old.

## GitHub settings (Owner)

1. **Protect `main` with a ruleset** (STANDARD 9.1). In the repository's **Settings**, open **Rulesets** in the left sidebar under "Code, planning, and automation", click **New ruleset**, then **New branch ruleset**. Name it, set **Enforcement status** to **Active**, and under **Target branches** add the default branch. Then:
   - **Bypass list**: click **Add bypass**, add the **Repository admin** role, then click the menu to the right of "Always allow" and choose **For pull requests only**. Never leave it on "Always allow". The Owner can then merge a pull request that fails a check, as a deliberate override, but nobody pushes straight to `main`, the Owner included.
   - **Restrict deletions** and **Block force pushes**: on (both are on by default).
   - **Require a pull request before merging**: on, with **Required approvals** at 0. GitHub doesn't let a pull request's author approve it, so with a solo Owner any required approval would block every merge; the Owner's review is the merge itself.
   - **Require status checks to pass**: on. Add each check below, and set each one's source to **GitHub Actions**, so a status that some other app or token sets can't satisfy it. GitHub offers an app as a check's source only once that app has recently reported the check in the repository, so finish this step after the first pull request has run both workflows (see the bootstrap note below).

   | Required check | Produced on pull requests by |
   |---|---|
   | **Gate** | `.github/workflows/ci.yml` |
   | **Dependency audit** | `.github/workflows/ci.yml` |
   | **Migrations are append-only** | `.github/workflows/guards.yml` |
   | **Test integrity** | `.github/workflows/guards.yml` |
   | **Sensitive change** | `.github/workflows/guards.yml` |
   | **Actions pinned to commit SHAs** | `.github/workflows/guards.yml` |
   | **Secret scan** | `.github/workflows/guards.yml` |
   | **Release age** | `.github/workflows/guards.yml` |

   Each name comes from exactly one workflow on pull requests. The `ci.yml` jobs that run on a push to `main` (**Secret scan on main**, **Migrations are append-only on main**, **Actions pinned on main**) have other names on purpose, since a job skipped by its condition reports success and would otherwise satisfy a required check. They aren't required checks. Keep job names unique when you add workflows.

   **Owner overrides.** Some checks fail on purpose for changes the Owner may still want, and the Owner merges those with the bypass after reading the diff: **Sensitive change** (a pull request that changes `package.json` scripts, test-runner, TypeScript, or lint configuration, `supabase/config.toml`, `.github/`, `.githooks/`, `.claude/settings.json`, `.gitleaks*` or a `gitleaks:allow` line, `pnpm-workspace.yaml`, or a `scripts/check-*` file; the job summary lists what) and **Test integrity** (a pull request that deletes a test file or adds `.only`, `.skip`, `.todo`, `.fails`, `runIf(`, `skipIf(`, `xit(`, `xdescribe(`, or similar; record in the pull request why the Owner accepted it). For **Release age**, list a security fix in `minimumReleaseAgeExclude` instead (the base branch's list is the one that counts, so that change merges first).

   **Bootstrap.** GitHub runs `guards.yml` from the default branch, so the pull request that first adds it isn't judged by it: its guard checks never start. The Owner merges that pull request with the bypass. The same holds for a pull request that changes `guards.yml` or a check script: it's judged by the old copies, and Sensitive change fails it until the Owner merges it.

   **Public repositories.** GitHub blocks `pull_request_target` in public repositories by a default Actions event policy, enforced from 2026-11-02 for repositories that use the default; a public project allows it in an Actions event policy (`.recon/brief-04/docs-gh-securely-using-pull-request-target.md`). Private repositories aren't affected.

   **Known limit.** A pull request can add a job to `ci.yml` named like a guard check (DECISIONS 13). The Owner reads what a push carries before pushing (`git log --stat` above) and checks that each required check appears once in the pull request's checks list.
2. **Require actions pinned to a full-length commit SHA** in the repository's Actions settings, alongside the CI check (STANDARD 5.4).
3. **Secret scanning with push protection** (STANDARD 4.6). A private repository gets push-blocking secret scanning only with GitHub Secret Protection, which GitHub sells for organization-owned repositories on Team and Enterprise; a private repository owned by a personal account, on Free or Pro, can have neither secret scanning nor push protection. Projects on the standard are private on GitHub Pro, so two scans stand in: the local pre-commit gitleaks hook (`.githooks/pre-commit`) stops a commit that contains a secret, and the CI **Secret scan** job scans the pull request's commits from the base branch, and the full history again on every push to `main`, after the push. Record this in the project's `docs/DEVIATIONS.md` with the entry below, numbered with the next free `D` number. (A public repository gets secret scanning by default and can turn on push protection for free under Settings, Advanced Security; it needs no deviation.)

   ```markdown
   ## D<n>: No GitHub push protection; local and CI secret scans stand in

   - **Spec says:** STANDARD 4.6: secret scanning with push protection is on for every repository.
   - **Code does:** The repository is private on GitHub Pro, where GitHub offers neither secret scanning nor push protection. `.githooks/pre-commit` runs gitleaks with its built-in rules on the staged changes and stops a commit that contains a secret, and the CI **Secret scan** job (`.github/workflows/guards.yml`) scans every pull request's commits, and **Secret scan on main** (`.github/workflows/ci.yml`) the full git history on every push to `main`, with the built-in rules, ignoring any `.gitleaks.toml`. The CI scans report a leak after the push; they don't block the push.
   - **Why:** Push protection for a private repository needs GitHub Secret Protection, which GitHub sells only for organization-owned repositories on GitHub Team or Enterprise. Owner decision, 2026-10-08: projects stay private on GitHub Pro (engineering-standard `DECISIONS.md`, entry 8).
   - **Until:** The repository moves to an organization with GitHub Secret Protection, or becomes public.
   ```

4. **Dependabot**: turn on Dependabot alerts and security updates. Version updates come from `.github/dependabot.yml`.

## Existing projects

Do everything above, plus:

- **Instructions**: move the project's instructions into `AGENTS.md`. Keep only what no hook, rule, or check enforces, and stay under 200 lines. Replace `CLAUDE.md` with the template, which imports `AGENTS.md`.
- **Settings**: merge into the existing `.claude/settings.json` rather than overwriting it. Review every existing allow rule against STANDARD 3.4, and move one-off approvals out of `.claude/settings.local.json`.
- **State**: move current state into `docs/PROGRESS.md` and make other documents link to it.
- **Migrations**: every migration already on `main` counts as shipped from now on.
- **pnpm**: the first `pnpm install` under the new settings may stop on packages with install scripts. Set each to `true` or `false` in `allowBuilds` after reading what its script does.
- **Hooks**: remove any project-local copies of hooks the plugin now provides, such as QuaSaR's `.claude/hooks/*.cjs`, so each guard runs once.
- **Secret scan configuration**: the pre-commit hook and the CI **Secret scan** use gitleaks's built-in rules and ignore `.gitleaks.toml`. Move any exception the project needs to `.gitleaksignore` (a finding's fingerprint) or a `gitleaks:allow` comment, and delete `.gitleaks.toml`.
- **Supabase CLI**: remove `supabase` from `devDependencies` and install the CLI outside the project ([What you need](#what-you-need)). Replace `pnpm exec supabase` in scripts and documents with the absolute path.
- **Supabase link**: if the machine was linked to a staging or production project, unlink it (`supabase unlink`) and log out (`supabase logout`) before agents work there.
- **Secrets in the working tree**: move every real secret out of the project's `.env*` and key files into the hosting provider, and keep only local values there (STANDARD 3.1).

## Check the adoption

- `claude doctor` in the project shows no invalid settings.
- `/plugin` lists `eng-standard` as enabled; `/hooks` shows its hooks, with `Monitor` in every matcher that lists `Bash`.
- Ask Claude to run `git add .`: the commit-hygiene hook blocks it.
- **Required: no route to GitHub, checked live.** Ask Claude to run `git ls-remote https://github.com/dean490/engineering-standard` with Bash: it fails, because the sandbox proxy refuses the connection. Ask Claude to run `git push`: it's denied ("The Owner pushes"). Then push the adoption branch yourself with `! git push -u origin <branch>` (or from a terminal): it succeeds, which shows the Owner's route works. Record the output in the adoption evidence.
- **Required: the sandbox read and write blocks, checked live.** Create a dummy `apps/web/.env.local` (any path below the root works; put a made-up value in it), then ask Claude to run each of these with Bash and confirm each fails with "Operation not permitted" or "EPERM": `node -e "require('fs').readFileSync('apps/web/.env.local')"`, `mv apps/web/.env.local x && cat x`, `node -e "require('fs').readFileSync('.env.example')"`, and `chmod -x .githooks/pre-commit`. Then run `/sandbox` and check the Config tab lists the `.env*` read and write entries and the `.github`, `.githooks`, and gitleaks write entries. This repository verified the rules with the macOS sandbox outside a Claude Code session (`.recon/brief-04/sandbox-check.txt`); this is the check inside one. Record the output in the adoption evidence.
- **Required: Claude's file tools can't write `.git/config` or `.git/hooks/`, checked live.** Ask Claude to use its Edit tool on `.git/config` and its Write tool on `.git/hooks/probe`: both are denied by the permission settings. Then ask it to run `git status` and `git add <a named file>`: both still work. The `git add` is the part that matters for the rules themselves, because a deny rule inside `.git` is also a sandbox write block, so it proves the rules didn't take git's own paths (`.git/index.lock`, `.git/index`) with them. The check doesn't apply in a session opened in a git worktree, because there `.git` is a file and the config git reads is outside the project.
- **(Owner) No real secret in the working tree**: no `.env*` or key file in the project holds a real secret, only local values (STANDARD 3.1). Repeat at each phase gate.
- **(Owner) No privileged key in hosting**: the app's hosting environment doesn't hold the privileged database key (STANDARD 4.2). Repeat at each phase gate.
- No staging or production credentials on the machine: `supabase projects list` fails because the CLI isn't logged in, and `vercel whoami` reports no login.
- `pnpm install --frozen-lockfile` passes, `git config --get core.hooksPath` prints `.githooks`, and `gitleaks version` prints a version.
- `pnpm run gate:fast` and `pnpm run gate` pass, and `/eng-standard:gate fast` writes `.recon/gate/last.json`.
- The first pull request runs both workflows' jobs, and `main` refuses a direct push, from the Owner too: `! git push origin HEAD:main` is rejected by the ruleset.

## This repository

The standard's own repository follows the same model once it is published as [dean490/engineering-standard](https://github.com/dean490/engineering-standard).

**Status.** It is not published: no remote and no tag. No wall in this repository has run on a real remote yet.

- **Live now** (local tests only): `node --test plugin/tests/` and `node --test tests/`.
- **Live after publication:** the CI workflow, the ruleset on `main`, and the release tag the plugin pin names.
- **Live after adoption** (hooks and sandbox in a real project session): the plugin's hooks and the template's sandbox settings. They are not active in this repository's own sessions, whose `.claude/settings.json` does not enable the plugin.
- **On the Owner's machine:** `strictAllowlist` and `core.hooksPath`.

- **The Owner pushes.** The repository's `.claude/settings.json` is the template's sandbox and deny rules without the plugin, so agent sessions here have no route to GitHub either (DECISIONS 12). The Owner pushes and opens pull requests as above.
- **Hooks**: after cloning, run `git config core.hooksPath .githooks` once, outside Claude Code (the sandbox denies writes to `.git/config`), so `.githooks/pre-commit`, a copy of the template's, scans every commit with gitleaks.
- **CI**: `.github/workflows/ci.yml` runs on pull requests and on pushes to `main`. `.github/dependabot.yml` updates its actions weekly, with a 7-day cooldown.
- **Ruleset on `main`**, set up as in [GitHub settings](#github-settings-owner), step 1 (rulesets are available for public repositories on every plan), with these required checks, each with **GitHub Actions** as its source:

  | Required check | What it runs |
  |---|---|
  | **Tests** | `node --test plugin/tests/` and `node --test tests/`, on Node 24.21.0 |
  | **Workflow lint** | actionlint 1.7.12, checksum-checked, with shellcheck from the runner image, over this repository's workflow and both template workflows |
  | **Actions pinned to commit SHAs** | `templates/scripts/check-action-pins.mjs` over this repository's `.github/` |
  | **Secret scan** | gitleaks 8.30.1 with its built-in rules over the full history |
  | **Plugin validate** | `claude plugin validate --strict` for `./plugin` and `.`, with Claude Code 2.1.286's Linux build, checked against the npm registry's integrity for that version |

  This repository has no `guards.yml`: its checks run from the pull request, and the Owner reviews every change to them.
- Turn on secret scanning and push protection (free for a public repository), Dependabot alerts, and the setting that requires actions pinned to a full-length commit SHA.
- **Running the tests locally** needs yq v4 on `PATH` (`brew install yq`) for the two pinning-check tests; without it, they are skipped.
