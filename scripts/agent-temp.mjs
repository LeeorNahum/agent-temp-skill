#!/usr/bin/env node
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

const DEFAULT_ROOT = process.platform === "win32" ? "C:\\AgentTemp" : "/tmp/agent-temp";
const DEFAULT_MAX_AGE_DAYS = 14;
const DAY_MS = 86_400_000;

const HELP = `agent-temp: one root for agent temp files, pruned on use.

Usage:
  agent-temp new <label> [--harness <name>] [--no-prune] [options]
      Prune the root, create a fresh per-task folder in it, print its path.
  agent-temp prune [options]
      Delete what has gone untouched for the age limit.
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
folder) is deleted only when its newest file is older than the age limit.
A folder with no files is judged by its own modified time. Links are never
followed. The root itself is never deleted.
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

function listEntries(dir) {
  try {
    return readdirSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function prune(root, maxAgeDays, dryRun) {
  const now = Date.now();
  const result = { root, maxAgeDays, dryRun, deleted: [], kept: 0, failed: [] };
  const visit = (dir, descend) => {
    for (const name of listEntries(dir)) {
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (descend && isHarnessHolder(name) && stat.isDirectory() && !stat.isSymbolicLink()) {
        visit(path, false);
        continue;
      }
      const ageDays = (now - newestMtime(path, stat)) / DAY_MS;
      if (ageDays <= maxAgeDays) {
        result.kept++;
        continue;
      }
      const record = { path, ageDays: Math.floor(ageDays) };
      if (dryRun) {
        result.deleted.push(record);
        continue;
      }
      try {
        remove(path, stat);
        result.deleted.push(record);
      } catch (error) {
        result.failed.push({ ...record, error: error.code ?? error.message });
      }
    }
  };
  visit(root, true);
  return result;
}

function report(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const verb = result.dryRun ? "would delete" : "deleted";
  for (const item of result.deleted) console.log(`${verb} ${item.path} (${item.ageDays} days)`);
  for (const item of result.failed) console.log(`could not delete ${item.path} (${item.error})`);
  console.log(
    `${result.dryRun ? "dry run: " : ""}${verb} ${result.deleted.length}, kept ${result.kept}, failed ${result.failed.length}, root ${result.root}`,
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
