// Next runs register() ONCE at server startup, before any route is served — the explicit,
// framework-blessed boot hook, as opposed to a lazy module-eval side effect on first route import.
// We run the agent core's bootstrap() here (reconcile zombie runs from a killed process, warm up MCP
// servers, ensure the safe folder, wire shutdown) so it's done + reconciled before the first request.
// Guarded to the Node server runtime (never edge). Idempotent: runRegistry's module-init still calls
// bootstrap() as a fallback (globalThis-guarded), so a disabled/missing hook can't skip the boot step.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrap } = await import("./src/server/runRegistry.ts");
    bootstrap();
    console.log("[errand] bootstrap ran via instrumentation.register()");
  }
}
