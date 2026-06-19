// electron-builder strips node_modules and the .next subdir when copying via extraResources (it
// manages node_modules itself), which leaves the Next standalone server unable to require `next`
// and with no static assets. So we copy the FULL, self-contained .next/standalone tree into the
// packaged app ourselves, AFTER electron-builder's filtered pack runs — verbatim, dereferencing
// symlinks. macOS-only (the first build's target); guarded on the platform name.
const { cpSync, existsSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const projectDir = context.packager.projectDir;
  const appName = context.packager.appInfo.productFilename; // "Errand"
  const src = join(projectDir, ".next", "standalone");
  if (!existsSync(join(src, "server.js"))) {
    throw new Error("[after-pack] .next/standalone/server.js missing — run `npm run build:web` first");
  }
  const dest = join(context.appOutDir, `${appName}.app`, "Contents", "Resources", "app", ".next", "standalone");
  cpSync(src, dest, { recursive: true, dereference: true });
  // Defense in depth: never ship a .env* inside the bundle (it can carry OPENROUTER_API_KEY).
  // prepare-standalone already strips them at the source; this guarantees the packaged tree is clean
  // even if the standalone was built without that step.
  for (const f of readdirSync(dest)) {
    if (f === ".env" || f.startsWith(".env.")) rmSync(join(dest, f), { force: true });
  }
  console.log(`[after-pack] copied the standalone server (node_modules + .next + static, no .env) -> ${dest}`);
};
