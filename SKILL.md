---
name: "agent-temp"
description: "Use whenever an agent needs scratch space or a scratchpad: downloads, extracted archives, generated test files, build output, evals, isolated builds, clones or worktrees it makes itself, logs, or any file it will not keep. Keeps all agent temp under one root that sits outside the home folder by default, prunes stale temp before creating more without deleting Git work that exists nowhere else, and keeps agent temp out of drive roots, the home folder, and the OS temp folder."
compatibility: "Requires Node.js 18 or later. The GitHub route also requires npm and network access when uncached."
metadata:
  author: "Leeor Nahum"
  version: "1.2.0"
---

# Agent Temp

All agent temp lives under one root, so it never piles up in scattered folders. A request for a scratchpad or scratch space means this root: the work goes in the task's own folder under it.

| System | Root |
| --- | --- |
| Windows | `C:\AgentTemp` |
| macOS and Linux | `/tmp/agent-temp` |

## Before Creating Temp

Run the [script](scripts/agent-temp.mjs) once per task, before the first temp folder is made. It deletes what has gone untouched for 30 days, unless it holds Git work that exists nowhere else, and `new` then creates the task's folder and prints its path.

Either of these, whichever is available:

```bash
npx --yes github:LeeorNahum/agent-temp-skill new "<short task label>" --harness "<harness name>"
node scripts/agent-temp.mjs new "<short task label>" --harness "<harness name>"
```

The first command runs from the public repository when the skill came without local files. The second runs the installed copy from the directory holding this SKILL.md and works offline. `--harness` is optional and names the product running the agent, in lowercase. Use the printed path for everything temporary in the task.

Run `prune` instead of `new` when the harness already provides the task's folder, as Claude Code does with its scratchpad:

```bash
npx --yes github:LeeorNahum/agent-temp-skill prune
node scripts/agent-temp.mjs prune
```

`prune --dry-run` lists what it would delete. `--root <dir>` and `--max-age-days <n>` change the root and the age limit. `root` prints the root path. `--help` lists everything.

## Where Each Harness Puts Temp

| Harness | Place |
| --- | --- |
| Claude Code | The scratchpad directory the session names, when it is under the root. Otherwise a per-task folder from `new` |
| Codex | A per-task folder from `new` with `--harness codex`. It has no scratchpad |
| Any other | A per-task folder from `new` with the harness's name |

Each parallel session or subagent uses its own per-task folder or scratchpad, never a sibling's.

Claude Code puts its scratchpad under the root once `CLAUDE_CODE_TMPDIR` is set to the root before the session starts. When the `env` block of its user settings (`settings.json` in `~/.claude`, or in `CLAUDE_CONFIG_DIR` when that is set) has no `CLAUDE_CODE_TMPDIR`, add it there with the root as its value and leave the rest of the file as it was. It takes effect from the next session. The prune covers the `claude` (Windows) or `claude-<uid>` (macOS and Linux) folder Claude Code adds beneath it.

## Rules

- Anything worth keeping past the task is moved into the project it belongs to, never left in temp. A task deletes its own folder when it ends, once its work is pushed or moved into its project, and empties a scratchpad the harness gave it instead of deleting it. The 30-day prune is the backstop for abandoned folders.
- Worktrees and clones an agent makes itself go in its task folder. A harness's own worktrees stay where that harness puts them, since the harness tracks and cleans them.
- Beyond the root above, never create folders at the root of a drive, in the home folder, or directly in the OS temp folder.
- Pass every path in the form the receiving program expects. A POSIX-style drive path such as `/c/...` handed to a Windows program creates a stray folder on the current drive, so convert it first.
- Evals and isolated builds go in a per-task folder too. A folder under the home folder inherits the user's own agent skills and settings from its ancestors.
- Keep no secrets in temp past the end of the task. Delete credentials, tokens, and private data the moment they are no longer needed.
- Pruning judges age by the newest file inside a folder, so a running task's folder is safe while it writes files. It keeps a folder holding a Git checkout or repository, at any depth, with uncommitted changes, untracked files that are not ignored, stashes, commits not on any remote-tracking branch, no remote, a linked worktree outside the folder, or a state it cannot inspect. Do not touch another task's folder.
