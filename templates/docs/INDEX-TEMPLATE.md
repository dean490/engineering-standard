# <step>: <name>

Copy this to `.recon/<step>/INDEX.md` and keep it current as the step goes. The commit gate (STANDARD 1.6) reads the "Checks" and "Needs a ruling" sections.

## What changed

- <Files and behaviour, one line each.>

## Checks

- <Paste the first line of `.recon/gate/gate-fast.txt` here after `/eng-standard:gate fast` passes. The commit gate refuses a commit until a line of that form recording exit 0 is in this file. Do not type it by hand.>
- <Other checks: command, evidence file, exit code.>

## Findings and fixes

- <Critic or security-reviewer finding, severity, and what was changed to fix it. Every finding that fits the brief is fixed, at any severity.>

## Needs a ruling

none

## Test counts

- Before: <count>. After: <count>. Delta: <count>.
