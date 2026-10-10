# Critic pass: <scope>

- **Date:** <YYYY-MM-DD>
- **Kind:** <per-step review | phase-gate pass> (STANDARD 1.4)
- **Brief:** <path to the brief>
- **Spec sections:** <sections the scope implements>
- **Diff range:** <base>..<head>
- **Reviewer:** eng-standard:critic and, when run, eng-standard:security-reviewer

## Findings

Copied from the Critic's report as returned. The Planner fills in **Ruling**: fix, defer (with the reason and where it's tracked), or reject (with the reason) (STANDARD 1.5).

| ID | Severity | File:line | Spec / brief reference | Finding | Evidence | Ruling |
|---|---|---|---|---|---|---|

## Phase-gate checks

Phase-gate pass only. Each [checked] rule that a gate holds, with the raw output or the Owner's answer as evidence. Delete this section for a per-step review.

| Rule | Check | Who | Result |
|---|---|---|---|
| 3.4 no standing approvals | `cat .claude/settings.local.json` and the `permissions.allow` list in `~/.claude/settings.json`: every entry is a read-only or routine local command, and none covers anything in 1.6 (push, deploy, production data or schema, credentials, purchases, publication). One-offs that belong in the project move to `.claude/settings.json` through a reviewed change; the rest are deleted | Critic | |
| 4.1 isolation tests | Every owned table has a test proving another tenant can't read or write its rows | Critic | |
| 3.1 no real secrets in the working tree | No `.env*` or key file in the project holds a real secret; only local values (the local Supabase URL and keys, local ports) | Owner | |
| 3.8 no production credentials | `supabase projects list` fails (not logged in), `vercel whoami` reports no login, no production database URL on the machine | Owner | |
| 4.2 privileged key | The privileged database key isn't set in the app's hosting environment | Owner | |

## Not reviewed

What the Critic couldn't review, and the commands it ran.

## Resolution

Filled in when every finding has a ruling and every "fix" is done: the commit or brief that resolved each one.
