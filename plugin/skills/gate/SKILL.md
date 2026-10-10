---
name: gate
description: Run the project's gate and save its raw output as evidence: "fast" runs gate:fast (typecheck, lint, unit tests), a step name runs the full gate into .recon/<step>/gate.txt. Prints only the evidence path and the exit code.
argument-hint: "fast | <step>"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/run-gate.cjs *)
---

Run the project's gate (STANDARD 2.1) and keep its raw output as evidence (STANDARD 2.2).

1. The argument is `$ARGUMENTS`.
   - `fast` runs the `gate:fast` script (typecheck, lint, unit tests) and writes its output to `.recon/gate/gate-fast.txt`. Run this when the stop gate asks for it.
   - Any other value is a step name and runs the full `gate` script into `.recon/<step>/gate.txt`. A step name uses only letters, digits, `.`, `_`, and `-`, such as `step-03`.
   - If the argument is empty, use the step the current brief names, or ask the user for one.
2. Run this command, with the argument in place of `<arg>`, and nothing else:

   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/run-gate.cjs <arg>
   ```

   The script runs the script from `package.json` with the project's package manager, writes everything it prints to the evidence file, records the result in `.recon/gate/last.json` for the stop gate, starts that file with one `# result:` line (STANDARD 10.3), and prints two lines: the evidence path and the exit code.
3. Reply with those two lines exactly as printed. Don't summarize or interpret the gate output; the file is the evidence. If the exit code isn't `0`, say that the gate failed and point to the file, then find the failure with `tail` or `grep` on it (don't read it whole) and fix it or report it.
