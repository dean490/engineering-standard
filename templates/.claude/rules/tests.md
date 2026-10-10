---
paths:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "tests/**"
  - "supabase/tests/**"
  - "vitest.config.*"
  - "vitest.*.config.*"
  - "playwright.config.*"
---

# Tests (constitution VIII; STANDARD 2.4, 2.5)

- Never delete, skip, or weaken a test to make a change pass: no `.skip`, `.only`, or `.todo` added, no loosened assertions, no lowered thresholds, no tests moved out of the run. A test that is wrong is fixed in its own reviewed change, and the brief names it. The CI check **Test integrity** fails a pull request that deletes a test file or adds `.only(`, `.skip(`, `.todo(`, `xit(`, or `xdescribe(`.
- Don't update snapshots (`-u`, `--update`) unless the brief says the snapshot change is intended.
- Core logic, rules, and anything involving money, safety, or permissions has unit tests.
- Anything that changes permanent state has integration tests against the real local database (local Supabase), not mocks.
- Every row-level-security policy has a test proving another tenant can't read or write the rows (see `.claude/rules/rls.md`).
- Report the test-count delta (before and after) at the end of the session.
