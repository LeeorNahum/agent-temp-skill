# agent-temp-skill

An Agent Skill that keeps every coding agent's temp files under one root, outside the home folder by default, and prunes stale temp each time an agent needs more.

- `SKILL.md` holds the trigger, the root, the commands, and the rules.
- `scripts/agent-temp.mjs` prunes the root and creates per-task folders. Node.js 18 or later, no dependencies.
- `package.json` makes the script runnable from the public repository.
- `AGENTS.md` is the maintenance contract.

## Install

```bash
git submodule add https://github.com/LeeorNahum/agent-temp-skill.git .agents/skills/agent-temp
```

To place Claude Code's own temp under the root, set `CLAUDE_CODE_TMPDIR` to the root in user settings.
