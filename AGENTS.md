# Maintenance Contract: agent-temp

This file is for agents editing the skill. Keep maintainer rules here, not in `SKILL.md`.

## File roles

| File | Role |
| --- | --- |
| `SKILL.md` | Trigger, root, commands, per-harness placement, rules |
| `scripts/agent-temp.mjs` | The only executable. Prunes the root and creates per-task folders |
| `package.json` | Exposes the script as the `agent-temp` bin and keeps its version equal to `metadata.version` |
| `README.md` | Human skim layer. Keep it to a few lines |

## Contract of the script

- The prune unit is an entry directly under the root. A `claude` or `claude-<uid>` folder is never a unit, its children are, because Claude Code appends that folder beneath its temp override. Inside it, `bundled-skills` is never a unit either. Claude Code keeps one folder per version there, and each version folder is a unit judged by age alone.
- Every old unit that is a folder, except a `bundled-skills` version folder, is checked for Git work before it goes. The scan walks the whole unit without following links and finds two kinds of thing: checkouts, which are folders holding a `.git` entry, and Git folders, which hold `objects` and either `HEAD` or `refs` (a checkout's `.git`, a bare repository, a submodule's store under `.git/modules`, a separate Git folder). The scan requires only one of `HEAD` and `refs`, so a damaged Git folder is still found. Names are matched without case on Windows and macOS, as Git matches them there.
- A checkout is kept when it has uncommitted changes, untracked files that are not ignored, a file marked assume-unchanged, or a file marked skip-worktree that is present, a dangling link included (a sparse checkout's absent files are fine). A linked worktree is also kept for commits not on any remote-tracking branch reachable from its HEAD or from the refs that belong to it alone (`refs/worktree`, `refs/bisect`, `refs/rewritten`), and, when its repository is outside the unit, for being locked.
- A Git folder is kept when it has a stash, no remote, commits on any ref not on a remote-tracking branch, or a linked worktree outside the unit. A non-bare Git folder is kept unless it is the Git folder of a checkout found in the unit, because its working tree was not inspected. That includes the store of a deinitialized submodule, whose files cannot be told apart from an unrelated repository kept in the same place.
- The unit is also kept when part of it cannot be read or any Git call fails or runs past its timeout. Nothing is deleted on a doubt.
- A checkout or Git folder whose own config (local or worktree scope) sets a `filter.<name>.clean` or `process` command is kept after a `git config` read and nothing else, because inspecting it would run that command. Git runs with no inherited `GIT_` variables, with `GIT_CEILING_DIRECTORIES` at the parent of the folder it inspects, with no transport allowed (`GIT_ALLOW_PROTOCOL`), lazy fetching off (`GIT_NO_LAZY_FETCH`), fsmonitor and signature display off, and optional locks off. Stashes are read as a ref, not through `git stash list`. So an inspection runs no command the repository supplies, reaches no remote, and writes nothing that the age check reads.
- After deleting a linked worktree whose main repository still exists, the script runs `git worktree prune` in that repository and reports the entry as stale if it is still there.
- Age is the newest modified time among the files inside a unit, so a folder in use is never judged by its own timestamp. A unit with no files is judged by its own modified time. A link counts as its own entry and is never followed.
- The root itself is never deleted. The script refuses a drive root, the home folder or an ancestor of it, the OS temp folder or an ancestor of it (named from fixed locations, since a harness may point its temp variable at the root), a folder that contains the current temp folder, and on Windows a UNC or extended-length path or a POSIX-style drive path. A root that is a link, or sits behind one, is resolved and every check runs on where it leads. A root equal to the current temp folder is allowed, since a harness may point its temp variable at the root.
- Per-task folders are named `<harness>-<label>-<6 hex>`. The harness prefix says whose folder it is when someone inspects the root, the label says what it was for, and the random suffix keeps parallel tasks from colliding. No timestamp is encoded, since the modified time already carries it.
- Prune runs on use. There is no scheduled task.
- Default root, age limit, and Git timeout live in the script's constants. Change the root and age limit there and in the `SKILL.md` table and prose in the same edit.

## Editing rules

- Keep every frontmatter string quoted.
- Name harnesses in `SKILL.md` only in the placement table and the Claude Code paragraph beneath it, and only ones with a distinct way of getting scratch space. Beyond the Claude Code folder exception and its `CLAUDE_CODE_TMPDIR` setting, no rule depends on one particular harness.
- The skill says where temp goes and when it is removed. Workflow choices such as whether to clone or push, or where secrets are stored, stay out of it.
- Keep the skill generic: no real project names, local paths, or dates.
- No em dashes, and no semicolons joining sentences.
- Bump `metadata.version` and `package.json` together.

## Before finishing

- Run skill-forge's validator (`node <skill-forge-root>/scripts/validate.mjs <skill-root>`) on a copy of the skill whose directory is named `agent-temp`, so the warning about repository checkout names does not apply.
- Run the script against a throwaway root holding an old folder, a fresh folder, a folder with an old directory but a new file, an old link pointing outside the root, a loose old file, and a `claude` folder holding old and fresh sessions and a `bundled-skills` folder with old and fresh versions. Only the old units go, the `bundled-skills` folder itself stays, and nothing outside the root is touched.
- In the same kind of root, age these to past the limit and run `prune --dry-run`: a dirty clone, a clone with untracked files, a clone with a stash, a clone with an unpushed commit, a repository with no remote, a clean pushed clone, a linked worktree of an outside repository with and without changes, and a checkout whose `.git` points nowhere. Only the clean pushed clone and the clean worktree are listed. A real run then clears the deleted worktree's entry from its main repository. Then add a bare repository, a separate Git folder whose checkout is outside, a deinitialized submodule, files marked assume-unchanged and skip-worktree, a `.GIT` spelled in capitals, a worktree-local ref, a locked worktree, and a partial clone. Each of those is kept. A clean sparse checkout is listed for deletion. A dry run changes no file in the root.
