---
name: "agent-temp"
description: "Use whenever an agent needs scratch space or a scratchpad: downloads, extracted archives, generated test files, build output, evals, isolated builds, clones or worktrees it makes itself, logs, or any file it will not keep, and whenever it would delete anything in that temp: a scratch file, a lock or slot folder, or temp holding secrets. Keeps all agent temp under one root that sits outside the home folder by default, prunes stale temp before creating more and removes temp only through its own command rather than a shell delete, both without deleting Git work that exists nowhere else, and keeps agent temp out of drive roots, the home folder, and the OS temp folder."
compatibility: "Requires Node.js 18 or later. The GitHub route also requires npm and network access when uncached."
metadata:
  author: "Leeor Nahum"
  version: "1.4.0"
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

The first command runs from the public repository when the skill came without local files. The second runs the installed copy from the directory holding this SKILL.md and works offline. `--harness` is optional and names the product running the agent, in lowercase. Use the printed path for everything temporary in the task, except a clone or worktree the agent makes, which gets a folder of its own from a second `new`.

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

Claude Code puts its scratchpad under the root once `CLAUDE_CODE_TMPDIR` is set to the root before the session starts. When the `env` block of its user settings (`settings.json` in `~/.claude`, or in `CLAUDE_CONFIG_DIR` when that is set) has no `CLAUDE_CODE_TMPDIR`, add it there with the root as its value and leave the rest of the file as it was. It takes effect from the next session. The prune covers the `claude` (Windows) or `claude-<uid>` (macOS and Linux) folder Claude Code adds beneath it, one session at a time. The scratchpad lasts for the whole session, and its subagents share it, so an agent removes only its own files there, never the scratchpad as a whole. Claude Code asks the user to approve some shell deletes in every permission mode, bypass included, so a shell delete in temp can hold a task until the user answers. Among them are some globs after a change of folder or through `..`, a glob under a variable such as `"$DIR"/*`, a target that is only a command's output such as `"$(pwd)"`, and an `rm` in a command that also runs a `bash -c` or `sh -c` script through a program named by a variable. It denies `Remove-Item` on a target ending in `*` outright.

## Removing Temp

Remove anything under the root only with `clean`, never with a shell delete such as `rm`, `rmdir`, `Remove-Item`, or `find -delete`, so the Git checks run. When the task ends, its folder stays, so its files remain for the user or a later agent to look at, and the 30-day prune removes it once nothing in it has changed for that long. `clean` removes nothing inside a folder that holds a clone, worktree, or other Git repository, which is why clones get a task folder of their own. Change files inside a clone the agent made with Git or the project's own tools.

Remove only what must go before then, such as credentials and tokens once they are used, or a lock the agent made itself. Keep throwaway files that may need clearing during the task in a subfolder of their own, so one `clean` on that subfolder clears them all. A lock or slot that another tool or script hands out goes back through that tool, and when it has no release command, leave it and tell the user.

Pass `clean` the path, and the same `--root` that `new` was given, if any. Run it from outside the folder it removes, since it cannot delete the folder it runs in:

```bash
npx --yes github:LeeorNahum/agent-temp-skill clean "<path>"
node scripts/agent-temp.mjs clean "<path>"
```

It acts on exactly the path it is given:

- A file or folder directly under the root, or inside a folder there, is deleted, except the `claude` or `claude-<uid>` folder and what it holds.
- A file or folder inside a scratchpad is deleted.
- A scratchpad is emptied and left in place.

It refuses every other path, with exit code 2. When a Git checkout or repository inside it holds work that exists nowhere else, or, on Windows, a file in it is open in another program, it deletes nothing, exits with 3, and names what it found and where. Save that work or close that program and run it again, or tell the user what it found when neither fits. It also exits with 3, deleting nothing, for a path inside a task folder or scratchpad that holds any Git repository, and for a path inside a checkout or other Git repository. That path needs no action. It stays until the prune removes the whole folder. Ignored files, such as a local environment file, do not stop it. Exit code 1 means a delete failed after the checks passed. Tell the user what is left, which the message names. `clean --dry-run` reports what the checks found, without the open-file test, and changes nothing.

`clean` cannot tell which task a folder belongs to, so give it only this task's own files and folders.

## Rules

- Anything worth keeping past the task is moved into the project it belongs to, never left in temp. What is left in temp stays for later inspection until the 30-day prune removes it.
- Worktrees and clones an agent makes itself go in a task folder of their own from `new`, apart from scratch files, secrets, and locks, even where the harness gave a scratchpad, since `clean` removes nothing inside a folder that holds Git work. A harness's own worktrees stay where that harness puts them, since the harness tracks and cleans them.
- Beyond the root above, never create folders at the root of a drive, in the home folder, or directly in the OS temp folder.
- Pass every path in the form the receiving program expects. A POSIX-style drive path such as `/c/...` handed to a Windows program creates a stray folder on the current drive, so convert it first.
- Evals and isolated builds go in a per-task folder too. A folder under the home folder inherits the user's own agent skills and settings from its ancestors.
- Keep no secrets in temp once they are no longer needed. Remove credentials, tokens, and private data with `clean` at that moment. When `clean` keeps them or fails, settle what it names before the task ends, or tell the user which secret is left and where.
- Pruning judges age by the newest file inside a folder, so a running task's folder is safe while it writes files. It keeps a folder holding a Git checkout or repository, at any depth, with uncommitted changes, untracked files that are not ignored, stashes, commits not on any remote-tracking branch, no remote, a linked worktree outside the folder, or a state it cannot inspect. Do not touch another task's folder.
