import * as fs from "node:fs";
import * as path from "node:path";

const IGNORE_DIRS = new Set([".git", "node_modules"]);

/** Recursively list files under `dir`, returned as POSIX-style paths relative to `dir`. */
function walk(dir) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(dir, rel) : dir;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  return out;
}

/** Translate a glob pattern into an anchored RegExp over POSIX paths. */
function toRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // '**' – cross directory boundaries. Consume an optional trailing '/'.
        i++;
        if (pattern[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

const isGlob = (p) => /[*?]/.test(p);

/**
 * Resolve space/newline-separated patterns to a sorted, de-duplicated list of
 * absolute file paths, relative to `baseDir`. Literal (non-glob) entries are
 * kept even if the file check is left to the caller.
 */
export function resolveFiles(spec, baseDir) {
  const patterns = spec
    .split(/[\s\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const found = new Set();
  let listing = null; // lazily computed only if a glob is present

  for (const pattern of patterns) {
    if (!isGlob(pattern)) {
      found.add(path.resolve(baseDir, pattern));
      continue;
    }
    if (listing === null) listing = walk(baseDir);
    const rx = toRegExp(pattern.replace(/^\.\//, ""));
    for (const rel of listing) {
      if (rx.test(rel)) found.add(path.resolve(baseDir, rel));
    }
  }
  return [...found].sort();
}
