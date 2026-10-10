# Reviews

One file per Critic pass, named `<YYYY-MM-DD>-<scope>.md`, such as `2026-10-07-step-03.md` or `2026-11-02-phase-1.md` (STANDARD 1.4, 1.5, 8.3). Create one with `/eng-standard:critic-pass <scope>`.

**Format.** Each file has a header (scope, date, kind of pass, brief, spec sections, diff range) and a findings table. Every finding has an ID, a severity, and a Planner ruling: fix, defer (with the reason and where it's tracked), or reject (with the reason). A phase isn't complete until every finding in its phase-gate pass has a ruling and every "fix" is done.
