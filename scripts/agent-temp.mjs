#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

const DEFAULT_ROOT = process.platform === "win32" ? "C:\\AgentTemp" : "/tmp/agent-temp";
const DEFAULT_MAX_AGE_DAYS = 30;
const GIT_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

const HELP = `agent-temp: one root for agent temp files, pruned on use.

Usage:
  agent-temp new <label> [--harness <name>] [--no-prune] [options]
      Prune the root, create a fresh per-task folder in it, print its path.
  agent-temp prune [options]
      Delete what has gone untouched for the age limit, except Git work
      that exists nowhere else.
  agent-temp root [options]
      Print the root path.

Options:
  --root <dir>            Root to use. Default: ${DEFAULT_ROOT}
  --max-age-days <n>      Age limit in days, greater than 0. Default: ${DEFAULT_MAX_AGE_DAYS}
  --dry-run               Report what prune would delete and delete nothing.
  --json                  Print prune results as JSON.
  --harness <name>        Prefix for the per-task folder name. Default: agent
  --no-prune              With new, skip the prune.
  -h, --help              Show this help.

An entry directly under the root (or under the root's claude or claude-<uid>
folder, or under that folder's bundled-skills) is deleted only when its newest
file is older than the age limit. A folder with no files is judged by its own
modified time. Links are never followed. The root itself is never deleted.

An old entry is kept when a Git checkout or repository anywhere inside it has
uncommitted changes, untracked files that are not ignored, stashes, commits not
on any remote-tracking branch, no remote, a linked worktree outside the entry,
or anything that cannot be inspected. Entries under bundled-skills are judged
by age alone.
`;

function fail(message) {
  console.error(`agent-temp: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const valued = new Set(["root", "max-age-days", "harness"]);
  const boolean = new Set(["dry-run", "json", "no-prune", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h") out.flags.help = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (valued.has(key)) {
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) fail(`--${key} needs a value`);
        out.flags[key] = value;
      } else if (boolean.has(key)) out.flags[key] = true;
      else fail(`unknown option ${arg}`);
    } else out._.push(arg);
  }
  return out;
}

const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const isSameOrInside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

function realOrSelf(path) {
  let existing = path;
  const tail = [];
  while (true) {
    try {
      return join(realpathSync.native(existing), ...tail.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) return path;
      tail.push(basename(existing));
      existing = parent;
    }
  }
}

// The same checks apply to the path as written and to where it really leads, so
// a link in the root or in any folder above it cannot hide a protected place.
function checkedRoot(rootArg) {
  if (process.platform === "win32") {
    if (/^\/[a-zA-Z](\/|$)/.test(rootArg ?? "")) {
      fail(`${rootArg} is a POSIX-style drive path that this program would read as a folder on the current drive, pass a Windows path`);
    }
    if (/^[\\/]{2}/.test(rootArg ?? "")) fail(`refusing a UNC or extended-length path, pass a plain drive path: ${rootArg}`);
  }
  const written = resolve(rootArg ?? DEFAULT_ROOT);
  const real = realOrSelf(written);
  // The OS temp folder is named from fixed locations, not only tmpdir(), because
  // a harness may point TMP or TMPDIR at the root, which is a legitimate setup.
  const osTemp = process.platform === "win32"
    ? [join(process.env.LOCALAPPDATA ?? "", "Temp"), join(process.env.SystemRoot ?? "C:\\Windows", "Temp")]
    : ["/tmp", "/var/tmp"];
  const protectedPaths = [homedir(), ...osTemp].filter(Boolean).map((p) => resolve(p));
  protectedPaths.push(...protectedPaths.map(realOrSelf));
  const current = resolve(tmpdir());
  for (const root of new Set([written, real])) {
    if (parse(root).root === root) fail(`refusing to use a drive root as the temp root: ${root}`);
    for (const protectedPath of protectedPaths) {
      if (isSameOrInside(protectedPath, root)) fail(`refusing a root that is, or contains, ${protectedPath}: ${root}`);
    }
    if (norm(current) !== norm(root) && isSameOrInside(current, root)) {
      fail(`refusing a root that contains the current temp folder ${current}: ${root}`);
    }
  }
  try {
    if (!lstatSync(real).isDirectory()) fail(`the root is not a folder: ${real}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return real;
}

function parseAge(value) {
  if (value === undefined) return DEFAULT_MAX_AGE_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) fail("--max-age-days must be a number greater than 0");
  return days;
}

// Newest modified time among the files under a path, never following links.
// A link counts as an entry of its own. A tree with no files falls back to the
// top folder's own modified time.
function newestMtime(path, stat) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.mtimeMs;
  let newest = -Infinity;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return Date.now(); // An unreadable tree cannot be judged old, so it is kept.
    }
    for (const name of entries) {
      const full = join(dir, name);
      let s;
      try {
        s = lstatSync(full);
      } catch {
        return Date.now();
      }
      if (s.isDirectory() && !s.isSymbolicLink()) stack.push(full);
      else newest = Math.max(newest, s.mtimeMs);
    }
  }
  return newest === -Infinity ? stat.mtimeMs : newest;
}

function remove(path, stat) {
  if (stat.isSymbolicLink()) {
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
  } else rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

const isHarnessHolder = (name) => name === "claude" || /^claude-\d+$/.test(name);
// Claude Code keeps one folder per version here. Each is a unit judged by age.
const BUNDLED_SKILLS = "bundled-skills";

function listEntries(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Git runs with no inherited GIT_ variables, so nothing from the caller can point
// it at another repository, and discovery stops at the folder it is run in. No
// transport is allowed and lazy fetching is off, so a partial clone cannot reach
// a remote. Fsmonitor and signature display are off and optional index writes
// are skipped, so an inspection runs no repository-supplied command and changes
// nothing.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));

function git(cwd, args) {
  const run = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...gitEnv,
      GIT_ALLOW_PROTOCOL: "none",
      GIT_CEILING_DIRECTORIES: dirname(cwd),
      GIT_NO_LAZY_FETCH: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  return run.error || run.status === null ? { status: null, out: "" } : { status: run.status, out: run.stdout };
}

const lines = (text, separator = /\r?\n/) => text.split(separator).filter(Boolean);

// Git matches its own file names without regard to case where the file system does.
const foldsCase = process.platform === "win32" || process.platform === "darwin";
const hasName = (entries, name) => entries.some((entry) => (foldsCase ? entry.toLowerCase() === name.toLowerCase() : entry === name));

// Every checkout (a folder holding a .git entry) and every Git folder (one
// holding objects and HEAD or refs, such as a .git folder, a bare repository, or
// a submodule's store under .git/modules) at any depth, never following links.
// Returns null when part of the tree cannot be read.
function findGit(unit) {
  const checkouts = [];
  const stores = [];
  const stack = [unit];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    if (hasName(entries, ".git")) checkouts.push(dir);
    // objects with either of the other two is enough, so a damaged Git folder is
    // still inspected and, failing that, kept. A logs folder holds HEAD and refs
    // but no objects.
    if (hasName(entries, "objects") && (hasName(entries, "HEAD") || hasName(entries, "refs"))) stores.push(dir);
    for (const name of entries) {
      const full = join(dir, name);
      let s;
      try {
        s = lstatSync(full);
      } catch {
        return null;
      }
      if (s.isDirectory() && !s.isSymbolicLink()) stack.push(full);
    }
  }
  return { checkouts, stores };
}

const unreadable = "could not be inspected";

// Whether a path exists as an entry of its own, a dangling link included. Any
// doubt counts as present.
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

// Why the working tree of one checkout must be kept, or null when deleting it
// loses nothing. The refs of a repository whose Git folder is inside the unit are
// judged with that Git folder. A linked worktree of a repository outside the unit
// is recorded in worktrees, so its entry can be cleared after the deletion.
function checkoutHold(checkout, unit, used, worktrees) {
  const dirs = git(checkout, ["rev-parse", "--absolute-git-dir", "--git-common-dir"]);
  if (dirs.status !== 0) return unreadable;
  const [gitLine, commonLine] = lines(dirs.out);
  if (!gitLine || !commonLine) return unreadable;
  const gitDir = resolve(gitLine);
  const commonDir = resolve(checkout, commonLine);
  used.add(norm(gitDir));
  used.add(norm(commonDir));
  const linked = norm(gitDir) !== norm(commonDir);

  const status = git(checkout, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
  if (status.status !== 0) return unreadable;
  const changes = lines(status.out);
  if (changes.some((line) => !line.startsWith("??"))) return "has uncommitted changes";
  if (changes.length) return "has untracked files";

  // Status trusts these index flags, so a file carrying one can hold changes it
  // never reports. A skip-worktree file is fine while it is absent, as in a
  // sparse checkout.
  const flags = git(checkout, ["ls-files", "-v", "-z"]);
  if (flags.status !== 0) return unreadable;
  for (const entry of lines(flags.out, "\0")) {
    const tag = entry[0];
    if (tag >= "a" && tag <= "z") return "has files marked assume-unchanged";
    if (tag === "S" && present(join(checkout, entry.slice(2)))) return "has files marked skip-worktree";
  }

  if (linked) {
    // These refs belong to the worktree alone and go with it.
    const own = git(checkout, ["for-each-ref", "--format=%(objectname)", "refs/worktree", "refs/bisect", "refs/rewritten"]);
    if (own.status !== 0) return unreadable;
    const unpushed = git(checkout, ["rev-list", "-n", "1", "HEAD", ...lines(own.out), "--not", "--remotes"]);
    if (unpushed.status !== 0) return unreadable;
    if (unpushed.out.trim()) return "has commits not on any remote-tracking branch";
    if (!isSameOrInside(commonDir, unit)) {
      if (existsSync(join(gitDir, "locked"))) return "is a locked worktree";
      worktrees.push({ repo: commonDir, entry: gitDir });
    }
  }
  return null;
}

// Why one Git folder inside the unit must be kept, or null when deleting it loses
// nothing. used holds the Git folders of the unit's own checkouts.
function storeHold(store, unit, used) {
  const at = (args) => git(store, ["--git-dir", store, ...args]);
  const bare = at(["rev-parse", "--is-bare-repository"]);
  if (bare.status !== 0) return unreadable;
  // A non-bare Git folder belongs to a working tree. Unless it is the Git folder
  // of a checkout found here, that working tree was not inspected. This holds a
  // deinitialized submodule's store too.
  if (bare.out.trim() !== "true" && !used.has(norm(store))) return "is the Git folder of a working tree that was not inspected";

  const stash = at(["for-each-ref", "--count=1", "--format=%(refname)", "refs/stash"]);
  if (stash.status !== 0) return unreadable;
  if (stash.out.trim()) return "has stashes";

  const remotes = at(["remote"]);
  if (remotes.status !== 0) return unreadable;
  if (!remotes.out.trim()) return "has no remote";

  const unpushed = at(["rev-list", "-n", "1", "--all", "--not", "--remotes"]);
  if (unpushed.status !== 0) return unreadable;
  if (unpushed.out.trim()) return "has commits not on any remote-tracking branch";

  const trees = at(["worktree", "list", "--porcelain", "-z"]);
  if (trees.status !== 0) return unreadable;
  for (const field of lines(trees.out, "\0")) {
    if (!field.startsWith("worktree ")) continue;
    const path = resolve(field.slice("worktree ".length));
    if (!isSameOrInside(path, unit) && existsSync(path)) return `has a linked worktree elsewhere, at ${path}`;
  }
  return null;
}

// Decides whether a unit holds Git work that exists nowhere else.
function gitHold(unit) {
  const found = findGit(unit);
  if (found === null) return { at: unit, reason: "has a part that could not be read" };
  const worktrees = [];
  const { checkouts, stores } = found;
  if (!checkouts.length && !stores.length) return { worktrees };
  // A filter in a repository's own config is a command Git would run while
  // inspecting it, so a repository carrying one is kept rather than run.
  const places = [...checkouts.map((dir) => [dir, []]), ...stores.map((dir) => [dir, ["--git-dir", dir]])];
  for (const [dir, select] of places) {
    const filters = git(dir, [...select, "config", "--show-scope", "--get-regexp", "^filter\\..*\\.(clean|process)$"]);
    if (filters.status !== 0 && filters.status !== 1) return { at: dir, reason: unreadable };
    if (/^(local|worktree)\t/m.test(filters.out)) return { at: dir, reason: "sets a Git filter in its own config, so it was not inspected" };
  }
  const used = new Set();
  for (const checkout of checkouts) {
    const reason = checkoutHold(checkout, unit, used, worktrees);
    if (reason) return { at: checkout, reason };
  }
  for (const store of stores) {
    const reason = storeHold(store, unit, used);
    if (reason) return { at: store, reason };
  }
  return { worktrees };
}

function prune(root, maxAgeDays, dryRun) {
  const now = Date.now();
  const result = { root, maxAgeDays, dryRun, deleted: [], kept: 0, keptForGit: [], failed: [], staleWorktreeEntries: [] };
  const visit = (dir, level) => {
    for (const name of listEntries(dir)) {
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      const isFolder = stat.isDirectory() && !stat.isSymbolicLink();
      if (isFolder && level === "root" && isHarnessHolder(name)) {
        visit(path, "holder");
        continue;
      }
      if (isFolder && level === "holder" && name === BUNDLED_SKILLS) {
        visit(path, "bundled");
        continue;
      }
      const ageDays = (now - newestMtime(path, stat)) / DAY_MS;
      if (ageDays <= maxAgeDays) {
        result.kept++;
        continue;
      }
      const record = { path, ageDays: Math.floor(ageDays) };
      let worktrees = [];
      if (isFolder && level !== "bundled") {
        const hold = gitHold(path);
        if (hold.reason) {
          result.kept++;
          result.keptForGit.push({ ...record, at: hold.at, reason: hold.reason });
          continue;
        }
        worktrees = hold.worktrees;
      }
      if (dryRun) {
        result.deleted.push(record);
        continue;
      }
      try {
        remove(path, stat);
        result.deleted.push(record);
      } catch (error) {
        result.failed.push({ ...record, error: error.code ?? error.message });
        continue;
      }
      // Clear the entry a deleted linked worktree leaves in its main repository.
      for (const { repo, entry } of worktrees) {
        if (!existsSync(repo)) continue;
        git(repo, ["--git-dir", repo, "worktree", "prune"]);
        if (existsSync(entry)) result.staleWorktreeEntries.push(repo);
      }
    }
  };
  visit(root, "root");
  return result;
}

function report(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const verb = result.dryRun ? "would delete" : "deleted";
  for (const item of result.deleted) console.log(`${verb} ${item.path} (${item.ageDays} days)`);
  for (const item of result.keptForGit) {
    console.log(`kept ${item.path} (${item.ageDays} days): ${item.at} ${item.reason}`);
  }
  for (const item of result.failed) console.log(`could not delete ${item.path} (${item.error})`);
  for (const repo of result.staleWorktreeEntries) console.log(`could not clear the stale worktree entry in ${repo}`);
  console.log(
    `${result.dryRun ? "dry run: " : ""}${verb} ${result.deleted.length}, kept ${result.kept} (${result.keptForGit.length} for Git work), failed ${result.failed.length}, root ${result.root}`,
  );
}

const slug = (text, fallback) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;

function newTaskFolder(root, label, harness) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const prefix = `${slug(harness, "agent")}-${slug(label, "task")}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const path = join(root, `${prefix}-${randomBytes(3).toString("hex")}`);
    try {
      mkdirSync(path, { mode: 0o700 });
      return path;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return fail("could not pick an unused folder name");
}

const { _: positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;
if (flags.help || !command) {
  console.log(HELP);
  process.exit(flags.help ? 0 : 2);
}
const root = checkedRoot(flags.root);
const maxAgeDays = parseAge(flags["max-age-days"]);

if (command === "root") {
  console.log(root);
} else if (command === "prune") {
  if (rest.length) fail("prune takes no positional arguments");
  const result = prune(root, maxAgeDays, Boolean(flags["dry-run"]));
  report(result, Boolean(flags.json));
  if (result.failed.length) process.exitCode = 1;
} else if (command === "new") {
  if (rest.length !== 1) fail("new takes one label, for example: agent-temp new \"fix login bug\" --harness codex");
  if (flags["dry-run"]) fail("--dry-run applies to prune only");
  if (!flags["no-prune"]) {
    const result = prune(root, maxAgeDays, false);
    if (result.failed.length) console.error(`agent-temp: ${result.failed.length} old entries could not be deleted`);
  }
  console.log(newTaskFolder(root, rest[0], flags.harness ?? "agent"));
} else {
  fail(`unknown command ${command}`);
}
