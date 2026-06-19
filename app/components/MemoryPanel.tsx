"use client";
// What Errand remembers + dreaming controls. Full transparency: the user sees every
// memory and can forget any of them, and turns dreaming on/off.
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Memory {
  id: string;
  text: string;
  kind: string;
  createdAt: number;
}

export function MemoryPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [dreaming, setDreaming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [presets, setPresets] = useState<{ id: string; label: string; note: string }[]>([]);
  const [customModel, setCustomModel] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const [endpoint, setEndpoint] = useState("openrouter");
  const [endpoints, setEndpoints] = useState<{ key: string; label: string; note: string }[]>([]);
  const [vision, setVision] = useState(true);
  const [modelCanSee, setModelCanSee] = useState(false);
  const [browserTrusted, setBrowserTrusted] = useState(true);
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [savingUrl, setSavingUrl] = useState(false);
  const [urlErr, setUrlErr] = useState<string | null>(null);
  const [urlStatus, setUrlStatus] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [caps, setCaps] = useState<
    { id: string; label: string; description: string; enabled: boolean; available: boolean; required: boolean }[]
  >([]);
  const [mcpServers, setMcpServers] = useState<
    { id: string; label: string; command: string; args: string[]; enabled: boolean; connected: boolean; toolCount: number; error?: string }[]
  >([]);
  const [newMcp, setNewMcp] = useState({ label: "", command: "", args: "" });
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpErr, setMcpErr] = useState<string | null>(null);
  const [skills, setSkills] = useState<{ name: string; description: string; whenToUse: string }[]>([]);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Modal keyboard support: Escape closes it, and focus moves to the close button on open so
  // keyboard users land inside the dialog (not stranded behind it).
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const load = () => {
    fetch("/api/memory")
      .then((r) => r.json())
      .then((d) => setMemories(d.memories ?? []))
      .catch(() => {});
    fetch("/api/dream")
      .then((r) => r.json())
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => {});
    fetch("/api/capabilities")
      .then((r) => r.json())
      .then((d) => setCaps(d.packs ?? []))
      .catch(() => {});
    fetch("/api/mcp")
      .then((r) => r.json())
      .then((d) => setMcpServers(d.servers ?? []))
      .catch(() => {});
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setSkills(d.skills ?? []))
      .catch(() => {});
    fetch("/api/model")
      .then((r) => r.json())
      .then((d) => {
        setModel(d.current ?? "");
        setPresets(d.presets ?? []);
        setCustomModel(d.current ?? "");
        setEndpoint(d.endpoint ?? "openrouter");
        setEndpoints(d.endpoints ?? []);
        setOllamaUrl(d.ollamaBaseUrl ?? "");
        setOllamaModels(d.ollamaModels ?? []);
        setVision(d.vision !== false);
        setModelCanSee(!!d.modelCanSee);
        setBrowserTrusted(d.browserTrusted !== false);
      })
      .catch(() => {});
  };

  // Save where Ollama lives (this machine or another on the network) and confirm Errand can reach it.
  // The POST only validates the URL's shape, so after saving we re-detect models at that server and
  // report the result inline — a successful save with zero models means the box is off or unreachable.
  // `explicit` lets the reset link pass a value without waiting on the async input state.
  const saveOllamaUrl = async (explicit?: string) => {
    const v = (explicit ?? ollamaUrl).trim();
    if (!v) return;
    setSavingUrl(true);
    setUrlErr(null);
    setUrlStatus(null);
    const res = await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ollamaBaseUrl: v }),
    }).catch(() => null);
    if (res && res.ok) {
      const d = await res.json().catch(() => ({}));
      if (d?.ollamaBaseUrl) setOllamaUrl(d.ollamaBaseUrl);
      // Re-detect models from the saved server to confirm reachability.
      const g = await fetch("/api/model")
        .then((r) => r.json())
        .catch(() => null);
      const models: string[] = g?.ollamaModels ?? [];
      setOllamaModels(models);
      if (g?.current) setModel(g.current);
      setUrlStatus(
        models.length
          ? { kind: "ok", text: `Connected — ${models.length} model${models.length === 1 ? "" : "s"} found.` }
          : { kind: "warn", text: "Saved, but no models found there. Is Ollama running on that machine?" },
      );
    } else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setUrlErr(d?.error ?? "That URL isn't valid.");
    }
    setSavingUrl(false);
  };

  // Revert to the bundled localhost default (the empty-field path is blocked, so do it explicitly).
  const resetOllamaUrl = () => {
    setOllamaUrl("http://localhost:11434/v1");
    saveOllamaUrl("http://localhost:11434/v1");
  };

  // "Eyes": let Errand see page screenshots on web tasks (only does anything on a vision model).
  const toggleVision = async (next: boolean) => {
    setVision(next);
    await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vision: next }),
    }).catch(() => {});
  };

  // Trusted browser input: reliable clicks/keys on hard sites (CDP), at the cost of a debugging banner.
  const toggleTrusted = async (next: boolean) => {
    setBrowserTrusted(next);
    await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserTrusted: next }),
    }).catch(() => {});
  };

  // Connected tools (MCP): add / remove / toggle a server. Every change re-reads the live status.
  const mcpAction = async (body: Record<string, unknown>) => {
    setMcpBusy(true);
    setMcpErr(null);
    const res = await fetch("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res && res.ok) {
      const d = await res.json().catch(() => ({}));
      setMcpServers(d.servers ?? []);
    } else {
      const d = res ? await res.json().catch(() => ({})) : {};
      setMcpErr(d?.error ?? "That didn't work.");
    }
    setMcpBusy(false);
  };
  const addMcpServer = async () => {
    const command = newMcp.command.trim();
    if (!command) return;
    // Args entered as a single line; split on whitespace (quote-free — keep it simple for v1).
    const args = newMcp.args.trim() ? newMcp.args.trim().split(/\s+/) : [];
    await mcpAction({ action: "add", label: newMcp.label.trim(), command, args });
    setNewMcp({ label: "", command: "", args: "" });
  };

  // Switch where the agent runs (cloud OpenRouter or local Ollama). Keep the model compatible:
  // OpenRouter ids contain a "/", Ollama tags (e.g. "llama3.2:3b") don't. When moving to Ollama,
  // prefer a model actually detected on the configured server (a remote box may not have llama3.2:3b).
  const chooseEndpoint = async (key: string) => {
    setEndpoint(key);
    const body: { endpoint: string; model?: string } = { endpoint: key };
    if (key === "ollama" && model.includes("/")) body.model = ollamaModels[0] ?? "llama3.2:3b";
    if (key === "openrouter" && !model.includes("/")) body.model = "deepseek/deepseek-v4-flash:nitro";
    if (body.model) {
      setModel(body.model);
      setCustomModel(body.model);
    }
    await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  // Switch the model new tasks use (persisted; takes effect next task).
  const chooseModel = async (id: string) => {
    const v = id.trim();
    if (!v) return;
    setModel(v);
    setSavingModel(true);
    await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: v }),
    }).catch(() => {});
    setSavingModel(false);
  };
  useEffect(() => {
    if (open) {
      load();
      setResult(null);
    }
  }, [open]);

  const toggleCap = async (id: string, next: boolean) => {
    setCaps((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: next } : c)));
    await fetch("/api/capabilities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled: next }),
    }).catch(() => {});
  };

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await fetch("/api/dream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    }).catch(() => {});
  };

  const dreamNow = async () => {
    setDreaming(true);
    setResult(null);
    const r = await fetch("/api/dream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ now: true }),
    })
      .then((x) => x.json())
      .catch(() => ({ added: 0, suggested: 0 }));
    setDreaming(false);
    const added = r.added ?? 0;
    const sug = r.suggested ?? 0;
    const tidied = (r.merged ?? 0) + (r.removed ?? 0);
    const bits = [
      `${added} new ${added === 1 ? "memory" : "memories"}`,
      tidied > 0 ? `tidied ${tidied}` : null,
      `${sug} idea${sug === 1 ? "" : "s"}`,
    ].filter(Boolean);
    setResult(`Reflected — ${bits.join(", ")}.`);
    load();
  };

  const forget = async (id: string) => {
    setMemories((m) => m.filter((x) => x.id !== id));
    await fetch("/api/memory", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-40 grid place-items-center bg-stone-900/30 px-6 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 220, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-heading"
            className="lift-lg flex max-h-[82vh] w-full max-w-[460px] flex-col overflow-hidden rounded-3xl border border-stone-200/80 bg-white"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-6 py-4">
              <p id="settings-heading" className="text-[15px] font-semibold text-stone-900">Settings</p>
              <button ref={closeRef} onClick={onClose} aria-label="Close settings" className="text-stone-400 transition hover:text-stone-700 active:scale-95">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Everything below the pinned header scrolls as one — otherwise the upper sections
                (Model / What Errand can do / Dreaming) clip when they're taller than the modal. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
            {/* model + endpoint switcher */}
            <div className="border-b border-stone-100 px-6 py-4">
              <p className="text-sm font-medium text-stone-900">Model</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500">
                Where the agent runs and which model. Takes effect on your next task.
              </p>
              {endpoints.length > 1 && (
                <select
                  value={endpoint}
                  onChange={(e) => chooseEndpoint(e.target.value)}
                  disabled={savingModel}
                  className="mt-2.5 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-[13px] text-stone-800 outline-none transition focus:border-accent-600/50 disabled:opacity-60"
                >
                  {endpoints.map((e) => (
                    <option key={e.key} value={e.key}>
                      {e.label} — {e.note}
                    </option>
                  ))}
                </select>
              )}
              {endpoint === "ollama" && (
                <div className="mt-2.5">
                  <p className="text-[12px] font-medium text-stone-700">Ollama server</p>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      value={ollamaUrl}
                      onChange={(e) => {
                        setOllamaUrl(e.target.value);
                        setUrlErr(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveOllamaUrl();
                      }}
                      spellCheck={false}
                      placeholder="192.168.86.237:11434"
                      className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-3 py-1.5 font-mono text-[12px] text-stone-700 outline-none transition focus:border-accent-600/50"
                    />
                    <button
                      onClick={() => saveOllamaUrl()}
                      disabled={savingUrl || !ollamaUrl.trim()}
                      className="shrink-0 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 transition hover:border-stone-300 active:scale-[0.98] disabled:opacity-50"
                    >
                      {savingUrl ? "Saving…" : "Save"}
                    </button>
                  </div>
                  {urlErr ? (
                    <p className="mt-1 text-xs text-rose-500">{urlErr}</p>
                  ) : urlStatus ? (
                    <p className={`mt-1 text-xs ${urlStatus.kind === "ok" ? "text-emerald-600" : "text-amber-600"}`}>
                      {urlStatus.text}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-stone-400">
                      Run on Ollama on this Mac or another on your network — enter the address (e.g.{" "}
                      <span className="font-mono text-[11px]">192.168.86.237:11434</span>) and Errand fills in the rest.
                    </p>
                  )}
                  <button
                    onClick={resetOllamaUrl}
                    disabled={savingUrl}
                    className="mt-1.5 text-[11px] text-stone-400 underline-offset-2 transition hover:text-stone-600 hover:underline disabled:opacity-50"
                  >
                    Reset to localhost
                  </button>
                </div>
              )}
              <div className="mt-2 space-y-2">
                {endpoint === "openrouter" && (
                  <select
                    value={presets.some((p) => p.id === model) ? model : "__custom"}
                    onChange={(e) => {
                      if (e.target.value !== "__custom") chooseModel(e.target.value);
                    }}
                    disabled={savingModel}
                    className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-[13px] text-stone-800 outline-none transition focus:border-accent-600/50 disabled:opacity-60"
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} — {p.note}
                      </option>
                    ))}
                    {!presets.some((p) => p.id === model) && model && <option value="__custom">Custom: {model}</option>}
                  </select>
                )}
                {endpoint === "ollama" && ollamaModels.length > 0 && (
                  <select
                    value={ollamaModels.includes(model) ? model : "__custom"}
                    onChange={(e) => {
                      if (e.target.value !== "__custom") chooseModel(e.target.value);
                    }}
                    disabled={savingModel}
                    aria-label="Model detected on the Ollama server"
                    className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-[12px] text-stone-800 outline-none transition focus:border-accent-600/50 disabled:opacity-60"
                  >
                    {ollamaModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {!ollamaModels.includes(model) && model && <option value="__custom">Custom: {model}</option>}
                  </select>
                )}
                <div className="flex items-center gap-2">
                  <input
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") chooseModel(customModel);
                    }}
                    spellCheck={false}
                    placeholder={endpoint === "ollama" ? "or type a model tag, e.g. llama3.2:3b" : "or any OpenRouter model id"}
                    className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-3 py-1.5 font-mono text-[12px] text-stone-700 outline-none transition focus:border-accent-600/50"
                  />
                  <button
                    onClick={() => chooseModel(customModel)}
                    disabled={savingModel || !customModel.trim() || customModel.trim() === model}
                    className="shrink-0 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 transition hover:border-stone-300 active:scale-[0.98] disabled:opacity-50"
                  >
                    Use
                  </button>
                </div>
                <p className="text-xs text-stone-400">
                  Now using <span className="font-mono text-[11px] text-stone-600">{model || "…"}</span>
                </p>
              </div>

              {/* "Eyes" — feed page screenshots to the model on web tasks (needs a vision model) */}
              <div className="mt-4 flex items-center justify-between gap-4 border-t border-stone-100 pt-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-stone-800">Let Errand see the screen</p>
                  <p className="text-[12px] leading-snug text-stone-500">
                    Show the page to the model as a picture on web tasks, so it can navigate by sight.{" "}
                    {vision &&
                      (modelCanSee ? (
                        <span className="text-emerald-600">This model can see.</span>
                      ) : (
                        <span className="text-amber-600">This model is text-only — pick a vision model above (e.g. Gemini 2.5 Flash).</span>
                      ))}
                  </p>
                </div>
                <button
                  onClick={() => toggleVision(!vision)}
                  role="switch"
                  aria-checked={vision}
                  aria-label="Let Errand see the screen"
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${vision ? "bg-accent-600" : "bg-stone-200"}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${vision ? "left-[1.375rem]" : "left-0.5"}`} />
                </button>
              </div>

              {/* Trusted browser input — reliable clicks/keys on hard sites, at the cost of a banner */}
              <div className="mt-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-stone-800">Reliable clicks &amp; keys</p>
                  <p className="text-[12px] leading-snug text-stone-500">
                    Drive the page as real input so tough sites (Gmail, Google) respond. Chrome shows a small “debugging this
                    browser” banner while it works.
                  </p>
                </div>
                <button
                  onClick={() => toggleTrusted(!browserTrusted)}
                  role="switch"
                  aria-checked={browserTrusted}
                  aria-label="Reliable clicks and keys"
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${browserTrusted ? "bg-accent-600" : "bg-stone-200"}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${browserTrusted ? "left-[1.375rem]" : "left-0.5"}`} />
                </button>
              </div>
            </div>

            {/* capability toggles — transparency: turn off what you don't want the agent to use */}
            {caps.length > 0 && (
              <div className="border-b border-stone-100 px-6 py-4">
                <p className="text-sm font-medium text-stone-900">What Errand can do</p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500">
                  Turn off anything you'd rather Errand not use. Files stays on.
                </p>
                <ul className="mt-3 space-y-3">
                  {caps.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-stone-800">
                          {c.label}
                          {!c.available && <span className="ml-1.5 text-[11px] font-normal text-stone-400">needs setup</span>}
                        </p>
                        <p className="text-[12px] leading-snug text-stone-500">{c.description}</p>
                      </div>
                      <button
                        onClick={() => !c.required && c.available && toggleCap(c.id, !c.enabled)}
                        role="switch"
                        aria-checked={c.enabled}
                        aria-label={c.label}
                        disabled={c.required || !c.available}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${c.enabled ? "bg-accent-600" : "bg-stone-200"}`}
                      >
                        <span
                          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${c.enabled ? "left-[1.375rem]" : "left-0.5"}`}
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* connected tools (MCP) — add external tool servers; each tool always asks before running */}
            <div className="border-b border-stone-100 px-6 py-4">
              <p className="text-sm font-medium text-stone-900">Connected tools (MCP)</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500">
                Plug in tool servers (MCP) to give Errand new abilities. External tools always ask before they run.
              </p>
              {mcpServers.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {mcpServers.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-stone-800">{s.label}</p>
                        <p className="truncate text-[11px] text-stone-500">
                          {s.error ? (
                            <span className="text-rose-500">{s.error}</span>
                          ) : s.connected ? (
                            <span className="text-emerald-600">connected · {s.toolCount} tool{s.toolCount === 1 ? "" : "s"}</span>
                          ) : s.enabled ? (
                            "connecting…"
                          ) : (
                            "off"
                          )}
                          <span className="ml-1 font-mono text-stone-400">{s.command} {s.args.join(" ")}</span>
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => mcpAction({ action: "toggle", id: s.id, enabled: !s.enabled })}
                          role="switch"
                          aria-checked={s.enabled}
                          aria-label={`${s.label} enabled`}
                          disabled={mcpBusy}
                          className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${s.enabled ? "bg-accent-600" : "bg-stone-200"}`}
                        >
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${s.enabled ? "left-[1.125rem]" : "left-0.5"}`} />
                        </button>
                        <button
                          onClick={() => mcpAction({ action: "remove", id: s.id })}
                          disabled={mcpBusy}
                          aria-label={`Remove ${s.label}`}
                          className="text-stone-400 transition hover:text-rose-500 disabled:opacity-50"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                            <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 space-y-1.5">
                <input
                  value={newMcp.label}
                  onChange={(e) => setNewMcp((m) => ({ ...m, label: e.target.value }))}
                  placeholder="Name (e.g. My Files)"
                  className="w-full rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[12px] text-stone-700 outline-none transition focus:border-accent-600/50"
                />
                <div className="flex items-center gap-2">
                  <input
                    value={newMcp.command}
                    onChange={(e) => setNewMcp((m) => ({ ...m, command: e.target.value }))}
                    spellCheck={false}
                    placeholder="command (e.g. npx)"
                    className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-3 py-1.5 font-mono text-[12px] text-stone-700 outline-none transition focus:border-accent-600/50"
                  />
                  <input
                    value={newMcp.args}
                    onChange={(e) => setNewMcp((m) => ({ ...m, args: e.target.value }))}
                    spellCheck={false}
                    placeholder="args (e.g. -y @modelcontextprotocol/server-filesystem ~/Documents)"
                    className="min-w-0 flex-[2] rounded-lg border border-stone-200 bg-white px-3 py-1.5 font-mono text-[12px] text-stone-700 outline-none transition focus:border-accent-600/50"
                  />
                  <button
                    onClick={addMcpServer}
                    disabled={mcpBusy || !newMcp.command.trim()}
                    className="shrink-0 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 transition hover:border-stone-300 active:scale-[0.98] disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
                {mcpErr && <p className="text-xs text-rose-500">{mcpErr}</p>}
              </div>
            </div>

            {/* skills — saved, reusable procedures the agent can apply */}
            <div className="border-b border-stone-100 px-6 py-4">
              <p className="text-sm font-medium text-stone-900">Skills</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500">
                Saved how-tos Errand can follow for routine tasks. Ask Errand to “save that as a skill” to add one.
              </p>
              {skills.length > 0 ? (
                <ul className="mt-3 space-y-2">
                  {skills.map((s) => (
                    <li key={s.name} className="rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2">
                      <p className="text-[13px] font-medium text-stone-800">{s.name}</p>
                      {s.description && <p className="text-[12px] leading-snug text-stone-500">{s.description}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-stone-400">No skills yet.</p>
              )}
            </div>

            {/* dreaming controls */}
            <div className="border-b border-stone-100 px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0 pr-4">
                  <p className="text-sm font-medium text-stone-900">Dreaming</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500">
                    When on, Errand reflects after tasks — learning your habits and suggesting ideas.
                  </p>
                </div>
                <button
                  onClick={toggle}
                  role="switch"
                  aria-checked={enabled}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${enabled ? "bg-accent-600" : "bg-stone-200"}`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled ? "left-[1.375rem]" : "left-0.5"}`}
                  />
                </button>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={dreamNow}
                  disabled={dreaming}
                  className="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 transition hover:border-stone-300 active:scale-[0.98] disabled:opacity-50"
                >
                  {dreaming ? "Reflecting…" : "Dream now"}
                </button>
                {result && <span className="text-[13px] text-stone-500">{result}</span>}
              </div>
            </div>

            {/* memories */}
            <div className="px-6 py-4">
              {memories.length === 0 ? (
                <p className="py-6 text-center text-sm text-stone-400">
                  Nothing remembered yet. As you use Errand, it'll learn your preferences and habits.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {memories.map((m) => (
                    <li
                      key={m.id}
                      className="group flex items-start gap-2.5 rounded-xl px-2.5 py-2 transition hover:bg-stone-50"
                    >
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-600/70" />
                      <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-stone-700">{m.text}</span>
                      <button
                        onClick={() => forget(m.id)}
                        aria-label="Forget this"
                        className="shrink-0 text-stone-300 opacity-0 transition group-hover:opacity-100 hover:text-brick-600"
                      >
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
