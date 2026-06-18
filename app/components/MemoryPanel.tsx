"use client";
// What Errand remembers + dreaming controls. Full transparency: the user sees every
// memory and can forget any of them, and turns dreaming on/off.
import { useEffect, useState } from "react";
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

  const load = () => {
    fetch("/api/memory")
      .then((r) => r.json())
      .then((d) => setMemories(d.memories ?? []))
      .catch(() => {});
    fetch("/api/dream")
      .then((r) => r.json())
      .then((d) => setEnabled(!!d.enabled))
      .catch(() => {});
    fetch("/api/model")
      .then((r) => r.json())
      .then((d) => {
        setModel(d.current ?? "");
        setPresets(d.presets ?? []);
        setCustomModel(d.current ?? "");
        setEndpoint(d.endpoint ?? "openrouter");
        setEndpoints(d.endpoints ?? []);
      })
      .catch(() => {});
  };

  // Switch where the agent runs (cloud OpenRouter or local Ollama). Keep the model compatible:
  // OpenRouter ids contain a "/", Ollama tags (e.g. "llama3.2:3b") don't.
  const chooseEndpoint = async (key: string) => {
    setEndpoint(key);
    const body: { endpoint: string; model?: string } = { endpoint: key };
    if (key === "ollama" && model.includes("/")) body.model = "llama3.2:3b";
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
            className="lift-lg flex max-h-[82vh] w-full max-w-[460px] flex-col overflow-hidden rounded-3xl border border-stone-200/80 bg-white"
          >
            <div className="flex items-center justify-between border-b border-stone-100 px-6 py-4">
              <p className="text-[15px] font-semibold text-stone-900">Settings</p>
              <button onClick={onClose} className="text-stone-400 transition hover:text-stone-700 active:scale-95">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
              </button>
            </div>

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
                <div className="flex items-center gap-2">
                  <input
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") chooseModel(customModel);
                    }}
                    spellCheck={false}
                    placeholder={endpoint === "ollama" ? "Ollama model, e.g. llama3.2:3b" : "or any OpenRouter model id"}
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
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
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
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
