// Shared safety helpers for file tools: confine every path to an allowed root
// (no ../ traversal, no symlink escape), detect binaries, and cap read size.
import { resolve, relative, isAbsolute, sep, basename } from "node:path";
import { realpathSync, statSync } from "node:fs";

export const MAX_READ_BYTES = 200_000;

// Absolute cap on a file we'll pull into memory at all (readFileSync loads the whole file
// before we truncate/extract). Guards every read path — text AND document — against OOM on a
// pathological file. Generous: real essays/homework/PDFs sit far below this.
export const MAX_FILE_BYTES = 50_000_000;

export class PathError extends Error {
  constructor(public userSummary: string) {
    super(userSummary);
  }
}

// Resolve `p` to an absolute path and guarantee it sits inside one of `roots`.
// Relative paths resolve against the first root. Throws PathError if it escapes.
export function resolveWithin(roots: string[], p: string): string {
  if (!roots.length) throw new PathError("I don't have a folder to work in.");
  const abs = isAbsolute(p) ? resolve(p) : resolve(roots[0], p);
  for (const root of roots) {
    const r = resolve(root);
    const rel = relative(r, abs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return abs;
    }
  }
  throw new PathError("That's outside the folder I'm allowed to touch.");
}

// After confirming a path is within scope, also confirm its REAL path (resolving
// symlinks) is still within scope — blocks a symlink that points outside.
export function assertRealWithin(roots: string[], abs: string): void {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return; // path doesn't exist yet (e.g. a write target) — nothing to resolve
  }
  for (const root of roots) {
    let r: string;
    try {
      r = realpathSync(resolve(root));
    } catch {
      r = resolve(root);
    }
    const rel = relative(r, real);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  }
  throw new PathError("That points somewhere outside the folder I'm allowed to touch.");
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

export const name = (p: string) => basename(p);
export const ROOT_SEP = sep;
