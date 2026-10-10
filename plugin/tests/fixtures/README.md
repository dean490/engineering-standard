# Hook test fixtures

Each JSON file is a hook input payload copied from the example in the Claude Code hooks reference (https://code.claude.com/docs/en/hooks, saved as `.recon/brief-01/docs-cc-hooks.md` in this repository when the plugin was built, 2026-10-07). The tests load a fixture and override only the fields a case needs, such as `tool_input.command`, `cwd`, or `permission_mode`.

| Fixture | Docs section |
|---|---|
| `pretooluse-bash.json` | Common input fields (the PreToolUse Bash example) |
| `pretooluse-read.json` | PreToolUse input, Read |
| `pretooluse-grep.json` | PreToolUse input, Grep |
| `pretooluse-write.json` | PreToolUse input, Write |
| `pretooluse-edit.json` | PreToolUse input, Edit |
| `pretooluse-monitor.json` | Common input fields, with the Monitor tool's input (`command`, `description`, `timeout_ms`) from its schema as loaded in a Claude Code 2.1.293 session (`.recon/brief-03/monitor-tool-schema.txt`); the tools reference says Monitor runs a command with the same permission rules and sandbox as Bash |
| `pretooluse-notebookedit.json` | Common input fields, with the NotebookEdit tool's input (`notebook_path`, `cell_id`, `new_source`, `edit_mode`) from its schema as loaded in the same session; the hooks reference doesn't list it |
| `pretooluse-bash-subagent.json` | Common input fields: `agent_id` and `agent_type` inside a subagent; plugin subagents report the plugin-scoped name (SubagentStart) |
| `userpromptsubmit.json` | UserPromptSubmit input |
| `posttooluse-bash.json` | PostToolUse input, with the Bash output shape from PostToolUse decision control |
| `posttooluse-write.json` | PostToolUse input |
| `stop.json` | Stop input |
| `malformed.txt` | Not JSON: a truncated payload, for the fail-closed and fail-open cases |

Test credentials are assembled at run time from fragments, so no file in this repository holds a string that looks like a real token to a secret scanner.
