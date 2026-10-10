---
name: handoff
description: End-of-session handoff. Update docs/PROGRESS.md (state, last step, deployed where, next step, open items) and nothing else, then show the diff.
disable-model-invocation: true
allowed-tools: Read Edit(docs/PROGRESS.md) Bash(git diff *)
disallowed-tools: Write NotebookEdit
---

Update the project's single state file, `docs/PROGRESS.md` (STANDARD 8.2), at the end of this session.

Rules:

- Change `docs/PROGRESS.md` and no other file.
- Keep the file's sections and fill each one: **State** (phase and status), **Last step**, **Deployed where**, **Next step**, **Open items**.
- Record only what this session verified or what a file you read shows. Write `unknown` where you don't know; never guess (constitution XII).
- Point to evidence and documents by path, such as `.recon/step-03/gate.txt` or `docs/reviews/2026-10-07-step-03.md`, instead of restating them.
- Replace stale state, and keep the file short (STANDARD 10): state, next step, and open items, under about 60 lines. History belongs in git and `docs/archive/`, not in this file. This skill edits only `docs/PROGRESS.md`, so if history worth keeping has to leave the file, name it in your reply for the Planner to move to `docs/archive/`.

Steps:

1. Read `docs/PROGRESS.md`, the current brief, and the evidence files this session produced.
2. Edit `docs/PROGRESS.md`.
3. Run `git diff -- docs/PROGRESS.md` and show its output.
