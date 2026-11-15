# agent-temp-skill

An Agent Skill that keeps every coding agent's temp files under one root, outside the home folder by default, prunes stale temp each time an agent needs more, and has each agent remove its own temp when done, never deleting Git work that exists nowhere else.

- `SKILL.md` holds the trigger, the root, the commands, and the rules.
- `scripts/agent-temp.mjs` prunes the root, creates per-task folders, and removes the one task folder or scratchpad it is given. Node.js 18 or later, no dependencies.
- `package.json` makes the script runnable from the public repository.
- `AGENTS.md` is the maintenance contract.

## Install

```bash
git submodule add https://github.com/LeeorNahum/agent-temp-skill.git .agents/skills/agent-temp
```

When Claude Code's user settings have no `CLAUDE_CODE_TMPDIR`, the skill has the agent set it to the root there, so Claude Code's own temp goes under the root from the next session.
