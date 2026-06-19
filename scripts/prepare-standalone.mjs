// Post-`next build` step for output:'standalone'. Next does NOT copy the static assets (or the
// public/ dir) into .next/standalone — so the standalone server can't serve CSS/JS without them.
// This copies them in, making .next/standalone a self-contained, runnable server: the exact thing
// the Electron main process forks as a utility process. Run via `npm run build:web`.
import { existsSync, cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error("[prepare-standalone] .next/standalone/server.js missing — run `next build` first.");
  process.exit(1);
}

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
