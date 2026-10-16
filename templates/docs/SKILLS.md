# Skills

Which agent skills this project may install, at which pinned commit, and which it has (STANDARD 5.6). The standard carries the policy and the pins, not the skills' text.

## Policy

1. **Allow-list only.** Only skills in the allow-list below are installed. "Allowed" means permitted, not installed; the register at the end says what is installed.
2. **Pin a full commit.** Every entry pins a full 40-character commit. The tag is a label and is never what is fetched.
3. **Copy, read, review.** A skill is copied into the project (`.claude/skills/<name>/`) at the pinned commit, read in full, and reviewed as a diff before it is committed.
4. **Keep the licence.** The source's licence file is kept beside the copies (`.claude/skills/<name>/LICENSE`), with its copyright line.
5. **New pin, new diff.** A new pin is a change to this file, reviewed as a diff of the source between the old and the new commit. Nothing auto-updates. The marketplace route is not used for agent-skills: its plugin entry has no `ref` or `sha`, so it cannot be pinned from outside.

## Allow-list

Source: `https://github.com/addyosmani/agent-skills`, path `skills/<name>/SKILL.md`, licence MIT ("Copyright (c) 2025 Addy Osmani", `LICENSE`, 1,068 B at the pin).

| name | pinned commit | tag label | size at pin | obligation it serves |
|---|---|---|---|---|
| `test-driven-development` | `a06bc63b3f8b829c14b0bbf53d99fefc39d58092` | `0.6.12` | 16,517 B | tests first, red then green |
| `debugging-and-error-recovery` | `a06bc63b3f8b829c14b0bbf53d99fefc39d58092` | `0.6.12` | 10,913 B | a debugging method |
| `shipping-and-launch` | `a06bc63b3f8b829c14b0bbf53d99fefc39d58092` | `0.6.12` | 11,409 B | release, rollback, go-live |

Source: `https://github.com/mattpocock/skills`, path `skills/productivity/<name>/SKILL.md`, licence MIT ("Copyright (c) 2026 Matt Pocock", `LICENSE`, 1,068 B at the pin). The repository has no release tags, so the pin is a commit only. Copy each skill's `SKILL.md` only; the `agents/openai.yaml` beside it is for another tool.

| name | pinned commit | tag label | size at pin | obligation it serves |
|---|---|---|---|---|
| `grill-me` | `49dd158d1076134a641b33efb035946536778336` | none | 157 B | the Owner and Planner settle every open decision before a brief is written (STANDARD 1.8); user-invoked only |
| `grilling` | `49dd158d1076134a641b33efb035946536778336` | none | 2,049 B | the interview method `grill-me` hands off to; `grill-me` does nothing without it |

## Excluded

| skill | why not |
|---|---|
| `/build auto` | runs a whole plan in one session, with no stop points |
| `/ship` as a Critic substitute | its personas are prompts, not separation (STANDARD 1.4) |
| `/constraints` | installs tools and edits `package.json` and `CLAUDE.md` |
| `doubt-driven-development` | pipes repository content to other model CLIs |
| `interview-me` | superseded by `grill-me` (DECISIONS 18): one interview skill, not two that overlap |

## Register of installed skills

Filled in by the project. Empty until a skill is installed.

| name | source | commit | date copied | reviewed by | diff path |
|---|---|---|---|---|---|
| | | | | | |
