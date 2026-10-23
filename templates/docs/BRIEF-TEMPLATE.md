# Brief <N>: <name>

**Status:** draft <the Planner changes this to "approved" only when the three lines below are filled; the brief check refuses otherwise>
**Layer:** <exactly one of: server, screens, docs, tooling>
**Model:** <Sonnet 5.5 or Opus>, effort <low, medium, high, xhigh, or max>
**Repository:** <path>, branch `<branch>`, at `<base commit>` (diff base for the reviews)
**Blocked by:** <briefs that must finish first, or none>
**Grilled:** <date, and where the questions and answers are kept; assumptions the Planner made for the Owner are listed here> (STANDARD 1.8)

## Why

<The problem, in a few lines.>

## What to build

<Scope, files in scope, and what is out of scope. For a server brief, how it is checked through the API and the agent connector; for a screens brief, what is observed running (STANDARD 1.9, 2.3).>

## Checks

- <Acceptance checks, with the test seams and what each catches and misses (STANDARD 2.6).>
- Raw output and exit codes saved under `.recon/<step>/`; the test-count delta reported.
- At step end the Builder runs the Critic and security-reviewer agents in parallel, fixes every finding that fits this brief, and logs each in `.recon/<step>/INDEX.md`. Only a spec or decision change, weaker security, or an irreversible action goes under "Needs a ruling".
- When the fast gate has passed, the reviews are in, and "Needs a ruling" is empty, the Builder stages files by name and commits with `git commit -F`. It never pushes.

## Owner steps

<The commands and links the Owner runs after the commit, in order, with the folder they run in: the full gate, `git push`, the compare link for the pull request, the steps after the merge (production migrations, deploy), and the phone check. The Builder ends its report with these, filled in.>

## Rulings

(The Planner writes rulings here when the Owner says "Rule on brief <N>".)
