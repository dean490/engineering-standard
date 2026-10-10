# Engineering standard

How projects built with AI agents are run: what must be true, how each rule is carried out, and the code that enforces it. Version 0.1.0 (`VERSION`). foodplan is the first project on it.

## Three layers

1. **Constitution** ([`CONSTITUTION.md`](CONSTITUTION.md)): twelve short principles every project follows, such as "the spec governs", "nobody grades their own work", and "evidence over assertion". A project may add rules but may not weaken these without an amendment.
2. **Standard** ([`STANDARD.md`](STANDARD.md)): how each principle is carried out, rule by rule. Each rule says how it is held: **[enforced]** by a wall (the sandbox, GitHub branch protection and required checks, CI checks, database policies, the Owner's review), **[guarded]** by a hook or permission rule that a determined agent could get around, with the wall behind it named, **[checked]** by a reviewer, or **[practice]**, kept to a minimum.
3. **Enforcement**: the code behind the [enforced] and [guarded] rules.
   - [`templates/`](templates/): files a project copies once, such as `AGENTS.md`, Claude Code settings with deny rules and the sandbox, path-scoped rules, pnpm supply-chain settings, a strict `tsconfig`, a pre-commit secret scan, the CI workflows (the gate, and the guard checks that run from the base branch) and the check scripts they run, Dependabot, and the `docs/` skeleton.
   - [`plugin/`](plugin/): the `eng-standard` Claude Code plugin. Its hooks guard secrets, protected paths, commit hygiene, and the Planner's and Critic's read-only roles, and remind a Builder to run the fast gate before it stops. It also ships the Critic and security-reviewer agents and the `gate`, `handoff`, and `critic-pass` skills.

This repository is also a Claude Code plugin marketplace ([`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)) with one plugin, `eng-standard`.

## Status

Not published: no remote, one local commit, no tag. No wall in this repository has run on a real remote yet.

- **Live now** (local tests only): the plugin's and the templates' tests, below.
- **Live after publication:** CI, the ruleset on `main`, and the release tag the plugin pin names.
- **Live after adoption** (hooks and sandbox in a real project session): the plugin's hooks and the template's sandbox settings. They are not active in this repository's own sessions.
- **On the Owner's machine:** `strictAllowlist` and `core.hooksPath`.

This repository contains no secrets. Once published, changes go through pull requests, which the Owner pushes and merges, and its CI runs the tests, lints the workflows, checks action pinning, scans for secrets, and validates the plugin (`docs/ADOPTING.md`, "This repository").

## Reading order

[`STANDARD.md`](STANDARD.md) for what must be true, [`DECISIONS.md`](DECISIONS.md) for why, [`docs/ADOPTING.md`](docs/ADOPTING.md) for how.

## What this adds

Other projects cover the process of specifying and planning work with agents. This repository adds what they do not: **walls**, each rule naming what holds it against a determined agent and what only guards it; **role separation**, with Planner, Builder, and Critic never the same session; **evidence**, raw command output saved to disk and reviewed in place; **findings with IDs** and a ruling on each; **hand-off**, one state file updated at the end of every session; **stack rules** for a Supabase, Next.js, and pnpm project (row-level security, append-only migrations, tests); **supply-chain settings** (lockfile installs, release-age delay, install-script allowlist, pinned actions); and **environment findings**, what Claude Code's sandbox, permissions, and hooks were observed to do, recorded as evidence.

## Known gaps nobody covers, including us

A rollback procedure, performance budgets, and a diff-size limit.

## Prior art

- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT): four of its skills are allowed in a project at the pinned `0.6.12` (`templates/docs/SKILLS.md`); nothing is installed from it by default.
- [github/spec-kit](https://github.com/github/spec-kit) (MIT): evaluated at `v1.1.3`, not used (DECISIONS 16).

This repository is MIT-licensed (`LICENSE`), Copyright (c) 2026 Dean Hebert.

## Adopt it in a project

Follow [`docs/ADOPTING.md`](docs/ADOPTING.md): which template files to copy, how to enable the plugin, the GitHub settings the Owner turns on, and what to check afterwards.

## Change it

Changes go through a pull request to this repository, with the reason added to [`DECISIONS.md`](DECISIONS.md) and a new version in `VERSION` and [`CHANGELOG.md`](CHANGELOG.md). Projects pin a version and adopt new ones deliberately, reviewing the diff.

## Repository layout

```text
CONSTITUTION.md   principles
STANDARD.md       rules and how each is enforced
DECISIONS.md      decisions about the standard itself
CHANGELOG.md      what changed in each version
VERSION           current version
LICENSE           MIT
docs/ADOPTING.md  how a project adopts the standard
templates/        files a project copies once
plugin/           the eng-standard Claude Code plugin (hooks, agents, skills, tests)
tests/            tests of the CI check scripts and the template configuration
.claude-plugin/   marketplace manifest
.claude/          this repository's own Claude Code settings (sandbox, deny rules)
.github/          this repository's CI and Dependabot
.githooks/        the pre-commit secret scan (git config core.hooksPath .githooks)
```

Run the tests (Node's built-in test runner; tested on Node 24.21.0): the plugin's, then the CI check scripts' and the template configuration's. The pinning-check tests need yq v4 on `PATH` (`brew install yq`) and are skipped without it.

```bash
node --test plugin/tests/
```

```bash
node --test tests/
```
