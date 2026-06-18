"use client";
// Home — recognition (example chips) + recall (one text box), both starting a run that
// opens into the Run View. A small scope picker chooses WHICH folder Errand may touch.
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useRun } from "./lib/useRun.ts";
import { RunView } from "./components/RunView.tsx";
import { MemoryPanel } from "./components/MemoryPanel.tsx";

const container = { hidden: {}, show: { transition: { staggerChildren: 0.06, delayChildren: 0.04 } } };
const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: "spring" as const, stiffness: 120, damping: 18 } },
};

const EXAMPLES = [
  "Organize this folder by file type",
  "Find any duplicate files and round them up",
  "Read my notes and summarize what they say",
];

interface Folder {
  key: string;
  label: string;
  path: string;
  safe: boolean;
}
interface RunSummary {
  runId: string;
  title: string;
  createdAt: number;
  status: "working" | "done" | "stopped";
  changeCount: number;
}

function relativeTime(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

export default function Page() {
  const run = useRun();
  const [input, setInput] = useState("");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [scope, setScope] = useState<Folder | null>(null);
  const [recent, setRecent] = useState<RunSummary[]>([]);
  const [browser, setBrowser] = useState<"unknown" | "connected" | "disconnected" | "connecting">("unknown");
  const [browsers, setBrowsers] = useState<{ key: string; name: string }[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [safariOnly, setSafariOnly] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [extConnected, setExtConnected] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<{ id: string; text: string; prompt: string | null }[]>([]);
  const [attached, setAttached] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const idle = run.state.phase === "idle";

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Permanently remove one or more past conversations from Recently (optimistic).
  const deleteRuns = async (ids: string[]) => {
    if (!ids.length) return;
    setDeleting(true);
    setRecent((rs) => rs.filter((r) => !ids.includes(r.runId)));
    setSelected(new Set());
    await fetch("/api/runs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).catch(() => {});
    setDeleting(false);
  };

  // Attach one or more files for Errand to read: upload into its safe folder, scope there, and
  // prefill a ready prompt so they just get read on submit.
  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploadErr(null);
    setUploading(true);
    const added: string[] = [];
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.name) added.push(d.name);
        else setUploadErr(d.error || "I couldn't add that file.");
      }
      if (added.length) {
        setAttached((cur) => [...cur, ...added]);
        const safe = folders.find((f) => f.key === "workspace");
        if (safe) setScope(safe); // the files live in the safe folder, so read_file can reach them
        setInput((cur) =>
          cur.trim()
            ? cur
            : added.length === 1
              ? `Read ${added[0]} and tell me what's in it.`
              : `Read these files and tell me what's in them: ${added.join(", ")}.`,
        );
      }
    } catch {
      setUploadErr("I couldn't add that file.");
    } finally {
      setUploading(false);
    }
  };

  // Poll the extension's connection status (it connects once the user loads it).
  useEffect(() => {
    if (!idle) return;
    let alive = true;
    const tick = () =>
      fetch("/api/ext/status")
        .then((r) => r.json())
        .then((d) => alive && setExtConnected(!!d.connected))
        .catch(() => {});
    tick();
    const h = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [idle]);

  useEffect(() => {
    fetch("/api/browser")
      .then((r) => r.json())
      .then((d) => {
        setBrowser(d.connected ? "connected" : "disconnected");
        setBrowsers(d.browsers ?? []);
        setSafariOnly(!!d.safariOnly);
        setPicked((cur) => cur ?? d.connectedBrowser ?? d.browsers?.[0]?.key ?? null);
      })
      .catch(() => setBrowser("disconnected"));
  }, []);

  const connectBrowser = async () => {
    setBrowser("connecting");
    setBrowserError(null);
    const r = await fetch("/api/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: picked }),
    })
      .then((x) => x.json())
      .catch(() => ({ connected: false, error: "Something went wrong." }));
    setBrowser(r.connected ? "connected" : "disconnected");
    if (!r.connected && r.error) setBrowserError(r.error);
  };

  const signIn = async () => {
    setBrowserError(null);
    await fetch("/api/browser/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: picked }),
    }).catch(() => {});
  };

  useEffect(() => {
    fetch("/api/folders")
      .then((r) => r.json())
      .then((d) => {
        const fs: Folder[] = d.folders ?? [];
        setFolders(fs);
        setScope((cur) => cur ?? fs[0] ?? null);
      })
      .catch(() => {});
  }, []);

  // Refresh the Recently list + dreaming's suggestions whenever we land back on Home.
  useEffect(() => {
    if (!idle) return;
    setSelectMode(false);
    setSelected(new Set());
    fetch("/api/runs")
      .then((r) => r.json())
      .then((d) => setRecent(d.runs ?? []))
      .catch(() => {});
    fetch("/api/memory")
      .then((r) => r.json())
      .then((d) => setSuggestions(d.suggestions ?? []))
      .catch(() => {});
  }, [idle, memoryOpen]);

  const dismissSuggestion = async (id: string) => {
    setSuggestions((s) => s.filter((x) => x.id !== id));
    await fetch("/api/memory", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, type: "suggestion" }),
    }).catch(() => {});
  };

  if (run.state.phase !== "idle") {
    return (
      <RunView
        state={run.state}
        onApprove={run.approve}
        onApproveAll={run.approveAlways}
        onCancelAuto={run.cancelAuto}
        onDeny={run.deny}
        onCancel={run.cancel}
        onFollowUp={run.followUp}
        onUndo={run.undo}
        onReset={run.reset}
      />
    );
  }

  const submit = (text: string) => {
    const v = text.trim();
    if (!v) return;
    run.start(v, scope ? [scope.path] : undefined);
    setAttached([]); // chips belong to this task only
    setUploadErr(null);
  };

  return (
    <main className="mx-auto min-h-[100dvh] w-full max-w-[680px] px-6 py-7">
      <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <div className="flex h-14 items-center justify-between">
        <span className="text-[17px] font-semibold tracking-tight text-stone-900">Errand</span>
        <button
          aria-label="Memory & settings"
          onClick={() => setMemoryOpen(true)}
          className="text-stone-400 transition hover:text-stone-700 active:scale-95"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <motion.div variants={container} initial="hidden" animate="show" className="mt-20">
        <motion.div variants={item} className="mb-7">
          <h1 className="text-[34px] font-semibold leading-[1.1] tracking-tight text-stone-900">
            What would you like
            <br />
            <span className="text-stone-400">done today?</span>
          </h1>
        </motion.div>

        <motion.form
          variants={item}
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            uploadFiles(Array.from(e.dataTransfer.files ?? []));
          }}
          className={`lift-lg group rounded-[1.75rem] border bg-white p-2.5 transition focus-within:border-accent-600/40 ${
            dragOver ? "border-accent-600/60 bg-accent-50/40" : "border-stone-200/80"
          }`}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(input);
              }
            }}
            rows={2}
            placeholder="Tell me what you'd like done — organize a folder, read a file you drop in, draft an email…"
            className="block w-full resize-none bg-transparent px-3.5 pt-2.5 text-[15px] leading-relaxed text-stone-900 outline-none placeholder:text-stone-400"
          />
          {/* attachment status: uploading / error / the attached-file chips */}
          {(attached.length > 0 || uploading || uploadErr) && (
            <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1 pt-0.5">
              {attached.map((name) => (
                <span
                  key={name}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-accent-600/30 bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
                    <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    onClick={() => setAttached((cur) => cur.filter((n) => n !== name))}
                    aria-label={`Remove ${name}`}
                    className="ml-0.5 shrink-0 text-accent-700/60 transition hover:text-accent-700"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </span>
              ))}
              {uploading && <span className="text-xs text-stone-400">Adding…</span>}
              {uploadErr && <span className="text-xs text-brick-600">{uploadErr}</span>}
            </div>
          )}
          <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  uploadFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach a file"
                className="grid h-9 w-9 place-items-center rounded-full text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 active:scale-95"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="text-xs text-stone-400">Press Enter, or attach a file</span>
            </div>
            <button
              type="submit"
              aria-label="Start"
              className="grid h-10 w-10 place-items-center rounded-full bg-accent-600 text-white transition hover:bg-accent-700 active:scale-95"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </motion.form>

        <motion.div variants={item} className="mt-3.5 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setInput(ex)}
              className="rounded-full border border-stone-200/80 bg-white/70 px-3.5 py-1.5 text-[13px] text-stone-600 transition hover:-translate-y-px hover:border-stone-300 hover:text-stone-900 active:translate-y-0"
            >
              {ex}
            </button>
          ))}
        </motion.div>

        {/* Ideas — proactive suggestions surfaced by dreaming */}
        {suggestions.length > 0 && (
          <motion.div variants={item} className="mt-6 space-y-2">
            <p className="text-[13px] font-medium text-stone-400">Ideas from Errand</p>
            {suggestions.map((s) => (
              <div
                key={s.id}
                className="lift group flex items-center gap-3 rounded-2xl border border-accent-600/20 bg-accent-50/40 px-4 py-3"
              >
                <button
                  onClick={() => (s.prompt ? submit(s.prompt) : setInput(s.text))}
                  className="min-w-0 flex-1 text-left text-sm text-stone-700 transition group-hover:text-stone-900"
                >
                  {s.text}
                </button>
                <button
                  onClick={() => dismissSuggestion(s.id)}
                  aria-label="Dismiss"
                  className="shrink-0 text-stone-300 transition hover:text-stone-600"
                >
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ))}
          </motion.div>
        )}

        {/* scope — which folder Errand may work in (default: its safe folder) */}
        {folders.length > 0 && (
          <motion.div variants={item} className="mt-10 border-t border-stone-200/70 pt-6">
            <p className="text-[13px] font-medium text-stone-400">Working in</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {folders.map((f) => {
                const active = scope?.key === f.key;
                return (
                  <button
                    key={f.key}
                    onClick={() => {
                      setScope(f);
                      // An attached file lives in the safe folder; switching away makes it
                      // unreadable, so drop the now-misleading chip.
                      if (f.key !== "workspace") setAttached([]);
                    }}
                    title={f.path}
                    className={`rounded-xl border px-3.5 py-2 text-[13px] font-medium transition active:scale-[0.98] ${
                      active
                        ? "border-accent-600/40 bg-accent-50 text-accent-700"
                        : "border-stone-200/80 bg-white text-stone-600 hover:border-stone-300"
                    }`}
                  >
                    {f.label}
                  </button>
                );
              })}
            </div>
            {scope && !scope.safe && (
              <p className="mt-2.5 text-xs text-stone-400">
                I'll only touch files in {scope.label}, and I'll ask before changing anything.
              </p>
            )}
          </motion.div>
        )}

        {/* browser connection — lets Errand do web tasks in the user's own browser */}
        <motion.div variants={item} className="mt-6">
          {/* Preferred: the extension drives the user's REAL browser (their logins, no Google block) */}
          {extConnected ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-forest-600/20 bg-forest-50/50 px-4 py-3">
              <span className="relative grid h-2 w-2 place-items-center">
                <span className="absolute inset-0 rounded-full bg-forest-500/60 breathe" />
                <span className="relative h-2 w-2 rounded-full bg-forest-600" />
              </span>
              <span className="text-sm text-stone-600">Your browser is connected through the Errand extension.</span>
            </div>
          ) : (
            <div className="lift rounded-2xl border border-stone-200/80 bg-white p-5">
              <p className="text-sm font-semibold text-stone-900">Let Errand use your browser</p>
              <p className="mt-1 text-sm leading-relaxed text-stone-500">
                For Gmail and sites you're logged into, install the Errand extension — it works in your normal browser, so
                you stay signed in.
              </p>
              <button
                onClick={() => setShowInstall((s) => !s)}
                className="mt-3 text-sm font-medium text-accent-700 underline-offset-2 transition hover:underline"
              >
                {showInstall ? "Hide steps" : "How to install"}
              </button>
              {showInstall && (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-600">
                  <li>
                    Open <span className="font-mono text-xs">chrome://extensions</span> in your browser.
                  </li>
                  <li>Turn on “Developer mode” (top-right).</li>
                  <li>
                    Click “Load unpacked” and choose the folder{" "}
                    <span className="font-mono text-xs">~/agent-harness/extension</span>.
                  </li>
                  <li>It connects automatically — this dot turns green.</li>
                </ol>
              )}
            </div>
          )}

          {/* Fallback: the Playwright-launched browser (separate profile) */}
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-stone-400">Or use a separate Errand browser instead</summary>
            <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  browser === "connected" ? "bg-forest-600" : browser === "connecting" ? "bg-ochre-500" : "bg-stone-300"
                }`}
              />
              <span className="text-sm text-stone-500">
                {browser === "connected"
                  ? `Browser connected${picked && browsers.length ? ` (${browsers.find((b) => b.key === picked)?.name ?? ""})` : ""}`
                  : "Separate browser not connected"}
              </span>
            </div>
            {browser !== "connected" && browsers.length > 0 && (
              <button
                onClick={connectBrowser}
                disabled={browser === "connecting"}
                className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 transition hover:border-stone-300 active:scale-[0.98] disabled:opacity-50"
              >
                {browser === "connecting"
                  ? "Opening…"
                  : `Connect ${browsers.length === 1 ? browsers.find((b) => b.key === picked)?.name ?? "browser" : "browser"}`}
              </button>
            )}
          </div>

          {/* pick which browser when more than one is installed */}
          {browser !== "connected" && browsers.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {browsers.map((b) => (
                <button
                  key={b.key}
                  onClick={() => setPicked(b.key)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition active:scale-[0.98] ${
                    picked === b.key
                      ? "border-accent-600 bg-accent-50 text-accent-700"
                      : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          )}

          {browserError && <p className="mt-2 text-xs text-brick-600">{browserError}</p>}
          {/* Google blocks sign-in on automated browsers — sign in once in a normal window. */}
          {browser !== "connected" && browsers.length > 0 && (
            <p className="mt-3 text-xs text-stone-400">
              Need to sign into Google or another site first?{" "}
              <button onClick={signIn} className="text-accent-700 underline-offset-2 transition hover:underline">
                Open a sign-in window
              </button>
              , log in, close it, then Connect.
            </p>
          )}
          {browsers.length === 0 && safariOnly && (
            <p className="mt-2 text-xs text-stone-400">
              Web tasks need a Chromium browser (Chrome, Brave, Edge, or Arc). Safari can't be driven with your logins.
            </p>
          )}
          </details>
        </motion.div>

        {/* Recently — revisit a past errand (reopens its full record), or clear ones you don't need */}
        {recent.length > 0 && (
          <motion.div variants={item} className="mt-10 border-t border-stone-200/70 pt-6">
            <div className="flex h-5 items-center justify-between">
              <p className="text-[13px] font-medium text-stone-400">Recently</p>
              {selectMode ? (
                <div className="flex items-center gap-3">
                  {selected.size > 0 && (
                    <button
                      onClick={() => deleteRuns([...selected])}
                      disabled={deleting}
                      className="text-[13px] font-medium text-brick-600 transition hover:text-brick-700 disabled:opacity-50"
                    >
                      Delete {selected.size}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setSelectMode(false);
                      setSelected(new Set());
                    }}
                    className="text-[13px] font-medium text-stone-500 transition hover:text-stone-800"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSelectMode(true)}
                  className="text-[13px] font-medium text-stone-400 transition hover:text-stone-700"
                >
                  Select
                </button>
              )}
            </div>
            <ul className="mt-1.5">
              {recent.map((r) => {
                const isSel = selected.has(r.runId);
                return (
                  <li key={r.runId}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => (selectMode ? toggleSelect(r.runId) : run.open(r.runId))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectMode ? toggleSelect(r.runId) : run.open(r.runId);
                        }
                      }}
                      className={`group flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-white active:scale-[0.99] ${
                        isSel ? "bg-white" : ""
                      }`}
                    >
                      {selectMode && (
                        <span
                          className={`grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border transition ${
                            isSel ? "border-accent-600 bg-accent-600 text-white" : "border-stone-300 bg-white"
                          }`}
                        >
                          {isSel && (
                            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                              <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                      )}
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          r.status === "working" ? "bg-accent-600" : r.status === "done" ? "bg-forest-600" : "bg-stone-300"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-stone-700 transition group-hover:text-stone-900">
                        {r.title}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-stone-400">
                        {relativeTime(r.createdAt)}
                      </span>
                      {!selectMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteRuns([r.runId]);
                          }}
                          aria-label="Delete this conversation"
                          className="shrink-0 text-stone-300 opacity-0 transition group-hover:opacity-100 hover:text-brick-600"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                            <path d="M5 7h14M10 4h4M6 7l1 13h10l1-13M10 11v5M14 11v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </motion.div>
    </main>
  );
}
