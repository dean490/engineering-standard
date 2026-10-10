---
name: critic-pass
description: Start a Critic pass on a named scope. Create docs/reviews/<date>-<scope>.md from the review template, launch the read-only critic agent against the scope, and record its findings in that file for the Planner's rulings.
disable-model-invocation: true
argument-hint: "<scope> [brief path] [spec sections]"
---

Run a Critic pass (STANDARD 1.4, 1.5). The Critic reviews cold: it gets the scope, the brief, and the spec, never your own opinion of the work.

1. Read the arguments: `$ARGUMENTS`. The first word is the scope, such as `step-03` or `phase-1`; then an optional brief path and optional spec sections. If the scope is missing, ask for it.
2. Work out the review file name: run `date +%F` for today's date and turn the scope into a slug of lowercase letters, digits, and hyphens. The file is `docs/reviews/<date>-<slug>.md`. If it exists, add `-2`, `-3`, and so on.
3. Create the file from the template at `${CLAUDE_PLUGIN_ROOT}/skills/critic-pass/review-template.md`. Fill in the header: scope, date, brief, spec sections, and the diff range (for a step, the commits since the merge base with `main`: run `git merge-base main HEAD`).
4. Launch the critic agent, `eng-standard:critic`, with a prompt that gives only the scope, the diff range, the brief path, and the spec sections. Don't add your own assessment.
5. Copy the Critic's findings table into the file's **Findings** section exactly as returned, then add its notes on what it couldn't review. Leave the **Ruling** column empty: the Planner rules on each finding (fix, defer with a reason, or reject with a reason).
6. Reply with the file path and the number of findings at each severity.
