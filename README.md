# Engineering standard

How projects built with AI agents are run: what must be true, how each rule is carried out, and the code that enforces it. Version 0.1.0 (`VERSION`). foodplan is the first project on it.

## Three layers

1. **Constitution** ([`CONSTITUTION.md`](CONSTITUTION.md)): twelve short principles every project follows, such as "the spec governs", "nobody grades their own work", and "evidence over assertion". A project may add rules but may not weaken these without an amendment.
2. **Standard** ([`STANDARD.md`](STANDARD.md)): how each principle is carried out, rule by rule. Each rule says how it is held: **[enforced]** by a wall (the sandbox, GitHub branch protection and required checks, CI checks, database policies, the Owner's review), **[guarded]** by a hook or permission rule that a determined agent could get around, with the wall behind it named, **[checked]** by a reviewer, or **[practice]**, kept to a minimum.
3. **Enforcement**: the code behind the [enforced] and [guarded] rules.
   - [`templates/`](templates/): files a project copies once, such as `AGENTS.md`, Claude Code settings with deny rules and the sandbox, path-scoped rules, pnpm supply-chain settings, a strict `tsconfig`, a pre-commit secret scan, the CI workflows (the gate, and the guard checks that run from the base branch) and the check scripts they run, Dependabot, and the `docs/` skeleton.
   - [`plugin/`](plugin/): the `eng-standard` Claude Code plugin. Its hooks guard secrets, protected paths, commit hygiene, and the Planner's and Critic's read-only roles, and remind a Builder to run the fast gate before it stops. It also ships the Critic and security-reviewer agents and the `gate`, `handoff`, and `critic-pass` skills.

This repository is also a Claude Code plugin marketplace ([`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)) with one plugin, `eng-standard`.

This repository is public and contains no secrets. Issues and changes go through pull requests, which the Owner pushes and merges; its own CI runs the tests, lints the workflows, checks action pinning, scans for secrets, and validates the plugin (`docs/ADOPTING.md`, "This repository").

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
