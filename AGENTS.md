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

- The prune unit is an entry directly under the root. A `claude` or `claude-<uid>` folder is never a unit, its children are, because Claude Code appends that folder beneath its temp override.
- Age is the newest modified time among the files inside a unit, so a folder in use is never judged by its own timestamp. A unit with no files is judged by its own modified time. A link counts as its own entry and is never followed.
- The root itself is never deleted. The script refuses a drive root, the home folder or an ancestor of it, the OS temp folder or an ancestor of it (named from fixed locations, since a harness may point its temp variable at the root), a folder that contains the current temp folder, and on Windows a UNC or extended-length path or a POSIX-style drive path. A root that is a link, or sits behind one, is resolved and every check runs on where it leads. A root equal to the current temp folder is allowed, since a harness may point its temp variable at the root.
- Per-task folders are named `<harness>-<label>-<6 hex>`. The harness prefix says whose folder it is when someone inspects the root, the label says what it was for, and the random suffix keeps parallel tasks from colliding. No timestamp is encoded, since the modified time already carries it.
- Prune runs on use. There is no scheduled task.
- Default root and age limit live in the script's constants. Change them there and in the `SKILL.md` table and prose in the same edit.

## Editing rules

- Keep every frontmatter string quoted.
- Name harnesses in `SKILL.md` only in the placement table and the Claude Code paragraph beneath it, and only ones with a distinct way of getting scratch space.
- Keep the skill generic: no real project names, local paths, or dates.
- No em dashes, and no semicolons joining sentences.
- Bump `metadata.version` and `package.json` together.

## Before finishing

- Run skill-forge's validator (`node <skill-forge-root>/scripts/validate.mjs <skill-root>`) on a copy of the skill whose directory is named `agent-temp`, so the warning about repository checkout names does not apply.
- Run the script against a throwaway root holding an old folder, a fresh folder, a folder with an old directory but a new file, an old link pointing outside the root, and a `claude` folder with old and fresh sessions. Only the old units go, and nothing outside the root is touched.
