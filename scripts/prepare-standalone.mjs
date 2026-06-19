// Post-`next build` step for output:'standalone'. Next does NOT copy the static assets (or the
// public/ dir) into .next/standalone — so the standalone server can't serve CSS/JS without them.
// This copies them in, making .next/standalone a self-contained, runnable server: the exact thing
// the Electron main process forks as a utility process. Run via `npm run build:web`.
import { existsSync, cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error("[prepare-standalone] .next/standalone/server.js missing — run `next build` first.");
  process.exit(1);
}

// SECURITY: `next build` copies .env* into .next/standalone, and those carry OPENROUTER_API_KEY —
// which must NEVER ship inside the packaged .app (a plaintext secret anyone with the bundle could
// read). Strip them here so the standalone server NEVER reads a key from a bundled file; the key is
// injected at runtime by the host (Electron main: launchd env / safeStorage), as it should be.
//
// Walk the WHOLE tree, not just its root: Next writes the copied .env at a path RELATIVE to its
// file-tracing root (the closest lockfile), which can resolve to a PARENT dir — landing the .env in a
// nested subdir (e.g. .next/standalone/<project>/.env) that a flat root-only scan would silently miss
// and ship. A recursive strip can't no-op on that layout. (Skip node_modules: deps never carry the
// app's secret, and the standalone dep tree is huge.)
function stripEnvFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    // A freshly-built standalone tree (same user) shouldn't have unreadable/vanishing dirs, but if one
    // does, warn and skip it rather than crashing the whole build (and the dist with it).
    console.warn(`[prepare-standalone] could not read ${dir} (${e.code || e.message}) — skipping`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      stripEnvFiles(join(dir, entry.name));
    } else if (entry.name === ".env" || entry.name.startsWith(".env.")) {
      const full = join(dir, entry.name);
      rmSync(full, { force: true });
      console.log(`[prepare-standalone] stripped bundled secret file: ${full.slice(standalone.length + 1)}`);
    }
  }
}
stripEnvFiles(standalone);

// .next/static -> .next/standalone/.next/static (hashed chunks + CSS the pages reference)
const staticDest = join(standalone, ".next", "static");
mkdirSync(dirname(staticDest), { recursive: true });
cpSync(join(root, ".next", "static"), staticDest, { recursive: true });
console.log("[prepare-standalone] copied .next/static");

// public/ -> .next/standalone/public (only if the app has a public dir; today it does not)
const publicSrc = join(root, "public");
if (existsSync(publicSrc)) {
  cpSync(publicSrc, join(standalone, "public"), { recursive: true });
  console.log("[prepare-standalone] copied public/");
}

console.log("[prepare-standalone] standalone server is self-contained and ready to fork.");
