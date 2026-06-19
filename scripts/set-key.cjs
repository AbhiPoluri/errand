// Store the OpenRouter API key in the app's encrypted store so the packaged Errand.app has it
// without relying on the shell/launchd environment. Reads OPENROUTER_API_KEY from the environment
// or ./.env, encrypts it with Electron safeStorage (OS-keychain-backed), and writes the blob to
// <userData>/openrouter.key — exactly where electron/main.cjs loadApiKey() reads it. The key is
// never printed (only a masked tail + a round-trip check). Run: `npm run set-key`.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.setName("Errand"); // -> userData = ~/Library/Application Support/Errand (matches the app)

app.whenReady().then(() => {
  try {
    process.loadEnvFile(); // pull OPENROUTER_API_KEY from ./.env if present (not printed)
  } catch {
    /* no .env — rely on the ambient env */
  }
  const key = (process.env.OPENROUTER_API_KEY || "").trim();
  if (!key) {
    console.error("[set-key] No OPENROUTER_API_KEY found in the environment or ./.env — nothing to set.");
    return app.exit(1);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.error("[set-key] safeStorage encryption is unavailable on this system — cannot store the key securely.");
    return app.exit(1);
  }
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "openrouter.key");
  fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
  // Verify the round-trip without ever printing the key itself.
  const back = safeStorage.decryptString(fs.readFileSync(file));
  const ok = back === key;
  const masked = key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "(short key)";
  console.log(`[set-key] wrote ${file}`);
  console.log(`[set-key] round-trip ${ok ? "OK ✓" : "FAILED ✗"}  (key ${masked}, ${key.length} chars)`);
  app.exit(ok ? 0 : 1);
});
