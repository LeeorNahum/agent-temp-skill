---
name: "agent-temp"
description: "Use whenever an agent needs scratch space or a scratchpad: downloads, extracted archives, generated test files, build output, evals, isolated builds, clones or worktrees it makes itself, logs, or any file it will not keep, and when a task that made temp is ending or temp holding secrets must go. Keeps all agent temp under one root that sits outside the home folder by default, prunes stale temp before creating more and has each task remove its own temp when it ends, both without deleting Git work that exists nowhere else, and keeps agent temp out of drive roots, the home folder, and the OS temp folder."
compatibility: "Requires Node.js 18 or later. The GitHub route also requires npm and network access when uncached."
metadata:
  author: "Leeor Nahum"
  version: "1.3.0"
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
| Claude Code subagent | A per-task folder from `new`, since it shares its session's scratchpad |
| Codex | A per-task folder from `new` with `--harness codex`. It has no scratchpad |
| Any other | A per-task folder from `new` with the harness's name |

Each parallel session or subagent uses its own per-task folder or scratchpad, never a sibling's.

Claude Code puts its scratchpad under the root once `CLAUDE_CODE_TMPDIR` is set to the root before the session starts. When the `env` block of its user settings (`settings.json` in `~/.claude`, or in `CLAUDE_CONFIG_DIR` when that is set) has no `CLAUDE_CODE_TMPDIR`, add it there with the root as its value and leave the rest of the file as it was. It takes effect from the next session. The prune covers the `claude` (Windows) or `claude-<uid>` (macOS and Linux) folder Claude Code adds beneath it. The scratchpad lasts for the whole session, and its subagents share it, so only the session's own agent runs `clean` on it, once nothing still running in the session needs its files.

## When The Task Ends

Once the task's work is pushed or moved into its project, run `clean` on the task's own folder from `new`, or on its scratchpad when the harness gave it one under the root. Pass the same `--root` that `new` was given, if any, and run it from outside the folder it cleans, since it cannot delete the folder it runs in:

```bash
npx --yes github:LeeorNahum/agent-temp-skill clean "<task folder or scratchpad>"
node scripts/agent-temp.mjs clean "<task folder or scratchpad>"
```

It deletes a task folder directly under the root, and empties a scratchpad while leaving the scratchpad itself in place. It refuses every other path, with exit code 2. When a Git checkout or repository inside it, or a checkout around it, holds work that exists nowhere else, or, on Windows, a file in it is open in another program, it deletes nothing, exits with 3, and names what it found and where. Save that work or close that program and run it again, or tell the user what it found when neither fits. Ignored files, such as a local environment file, do not stop it. Exit code 1 means a delete failed after the checks passed. Tell the user what is left, which the message names. `clean --dry-run` reports what the checks found, without the open-file test, and changes nothing.

Remove a task folder or scratchpad only with `clean`, never with a shell delete, so the Git check always runs. It acts on exactly the path it is given and cannot tell which task a folder belongs to, so give it only this task's own folder or scratchpad.

## Rules

- Anything worth keeping past the task is moved into the project it belongs to, never left in temp. A task ends by running `clean` on its own folder or scratchpad, as described above. The 30-day prune is the backstop for abandoned folders.
- Worktrees and clones an agent makes itself go in its task folder. A harness's own worktrees stay where that harness puts them, since the harness tracks and cleans them.
- Beyond the root above, never create folders at the root of a drive, in the home folder, or directly in the OS temp folder.
- Pass every path in the form the receiving program expects. A POSIX-style drive path such as `/c/...` handed to a Windows program creates a stray folder on the current drive, so convert it first.
- Evals and isolated builds go in a per-task folder too. A folder under the home folder inherits the user's own agent skills and settings from its ancestors.
- Keep no secrets in temp past the end of the task. Delete credentials, tokens, and private data the moment they are no longer needed. When `clean` keeps the folder or fails, any left in it stay too, so settle what it names before the task ends.
- Pruning judges age by the newest file inside a folder, so a running task's folder is safe while it writes files. It keeps a folder holding a Git checkout or repository, at any depth, with uncommitted changes, untracked files that are not ignored, stashes, commits not on any remote-tracking branch, no remote, a linked worktree outside the folder, or a state it cannot inspect. Do not touch another task's folder.
