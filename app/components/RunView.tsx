// The Run View — the most important screen. Shows one task progressing in plain
// language, the agent visibly pausing for permission (amber, fixed slot), and a calm
// close. Predictable placement (VARIANCE 3), one breathing animation (MOTION 4), airy
// (DENSITY 3). No emojis — small inline SVG primitives only.
import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RunState, Step } from "../lib/useRun.ts";
import { AgentOrb } from "./AgentOrb.tsx";

// Render the model's markdown (bold, lists, links) cleanly — calm, matches the design.
function Reply({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-stone-800">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-stone-900">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-accent-700 underline underline-offset-2">
              {children}
            </a>
          ),
          code: ({ children }) => <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-sm">{children}</code>,
          h1: ({ children }) => <p className="text-base font-semibold text-stone-900">{children}</p>,
          h2: ({ children }) => <p className="text-base font-semibold text-stone-900">{children}</p>,
          h3: ({ children }) => <p className="font-semibold text-stone-900">{children}</p>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Cross() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Count-accurate, honest undo copy — never claims total success on a partial undo.
function undoSentence(r: RunState["undoResult"]): string {
  if (!r) return "I tried to undo, but couldn't confirm the result — please check your files.";
  if (r.failed === 0 && r.skipped === 0) {
    return `Undone — ${r.undone} change${r.undone === 1 ? "" : "s"} put back the way ${r.undone === 1 ? "it was" : "they were"}.`;
  }
  const parts = [`Put back ${r.undone} of ${r.undone + r.failed + r.skipped}.`];
  if (r.failed) parts.push(`${r.failed} couldn't be restored.`);
  if (r.skipped) parts.push(`${r.skipped} couldn't be undone.`);
  return parts.join(" ");
}

function dotClass(state: Step["state"]): string {
  switch (state) {
    case "done":
      return "bg-forest-600 text-white";
    case "failed":
      return "bg-brick-600 text-white";
    case "waiting":
      return "bg-ochre-500 text-white";
    default:
      return "bg-accent-600 text-white";
  }
}

function StepRow({ step }: { step: Step }) {
  const running = step.state === "running" || step.state === "waiting";
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: "spring", stiffness: 220, damping: 26 }}
      className="flex items-start gap-3 py-2.5"
    >
      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full ${dotClass(step.state)}`}>
        {step.state === "done" ? (
          <Check />
        ) : step.state === "failed" ? (
          <Cross />
        ) : running ? (
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/90" />
        ) : null}
      </span>
      <div className="min-w-0 pt-px">
        <p className={`text-[13px] ${running ? "font-medium text-stone-900" : "text-stone-600"}`}>{step.action}</p>
        {step.summary && <p className="mt-0.5 text-[13px] text-stone-400">{step.summary}</p>}
      </div>
    </motion.div>
  );
}

export function RunView(props: {
  state: RunState;
  onApprove: () => void;
  onApproveAll: () => void;
  onCancelAuto: () => void;
  onDeny: () => void;
  onCancel: () => void;
  onFollowUp: (m: string) => void;
  onUndo: () => void;
  onReset: () => void;
}) {
  const { state } = props;
  const running = state.phase === "running";
  const waiting = state.phase === "waiting";
  const done = state.phase === "done";
  const busy = running || waiting;
  const reversibleCount = state.changes.filter((c) => c.undoable).length;
  const needsBrowser = state.turns.some((t) =>
    t.steps.some((st) => st.state === "failed" && /browser isn't connected/i.test(st.summary ?? "")),
  );
  const [followUp, setFollowUp] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [attached, setAttached] = useState<{ name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Attach a file mid-conversation: upload into THIS run's working folder (so read_file can
  // reach it) and prefill a read prompt; the user hits send.
  const uploadFile = async (file: File) => {
    if (!state.runId) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("runId", state.runId);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.name) {
        setAttached({ name: d.name });
        setFollowUp((cur) => (cur.trim() ? cur : `Read ${d.name} and tell me what's in it.`));
      }
    } catch {
      /* ignore — the user can retry */
    } finally {
      setUploading(false);
    }
  };

  const connectBrowser = async () => {
    setConnecting(true);
    await fetch("/api/browser", { method: "POST" }).catch(() => {});
    setConnecting(false);
  };

  return (
    <div className="mx-auto min-h-[100dvh] w-full max-w-[760px] px-6 py-8">
      {/* top bar — predictable placement */}
      <div className="mb-6 flex h-10 items-center justify-between">
        <button onClick={props.onReset} className="text-sm text-stone-500 transition hover:text-stone-900 active:scale-[0.98]">
          ‹ Home
        </button>
      </div>

      {/* auto-approve banner — always visible + revocable while on (safe actions only) */}
      {state.autoApprove && busy && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-accent-600/30 bg-accent-50 px-4 py-3">
          <p className="text-sm text-accent-700">Approving safe changes automatically in this errand.</p>
          <button
            onClick={props.onCancelAuto}
            className="text-sm font-medium text-accent-700 underline-offset-2 transition hover:underline active:scale-[0.98]"
          >
            Turn off
          </button>
        </div>
      )}

      {/* CONVERSATION TRANSCRIPT — every exchange, in order */}
      <div className="space-y-7">
        {state.turns.map((turn, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 140, damping: 20 }}
            className="space-y-3.5"
          >
            {/* what you asked */}
            <div className="flex justify-end">
              <div className="lift max-w-[85%] whitespace-pre-wrap rounded-[1.25rem] rounded-br-md bg-stone-900 px-4 py-2.5 text-[14px] leading-relaxed text-stone-50">
                {turn.user}
              </div>
            </div>
            {/* the steps the agent took */}
            {turn.steps.length > 0 && (
              <div className="ml-1 border-l border-stone-200/80 pl-4">
                {turn.steps.map((st) => (
                  <StepRow key={st.callId} step={st} />
                ))}
              </div>
            )}
            {/* the agent's reply */}
            {turn.reply && (
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-forest-600 text-white">
                  <Check />
                </span>
                <div className="min-w-0 flex-1 pt-px">
                  <Reply text={turn.reply} />
                </div>
              </div>
            )}
            {/* a snag in this turn */}
            {turn.problem && (
              <div className="lift rounded-2xl border border-brick-200/70 bg-brick-50/70 p-5">
                <p className="text-sm font-semibold text-brick-700">A small snag</p>
                <p className="mt-1.5 text-sm text-stone-700">{turn.problem}</p>
              </div>
            )}
          </motion.div>
        ))}
      </div>

      {/* live status — what's happening right now */}
      {busy && (
        <motion.div
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="lift mt-5 rounded-3xl border border-stone-200/80 bg-white p-6"
        >
          <div className="flex items-center gap-3">
            <AgentOrb size={18} state={waiting ? "idle" : "working"} />
            <div className="min-w-0 flex-1">
              <AnimatePresence mode="wait">
                <motion.p
                  key={state.statusLine}
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -5 }}
                  transition={{ duration: 0.22 }}
                  className="text-[17px] font-semibold leading-snug text-stone-900"
                >
                  {state.statusLine || "Working on it…"}
                </motion.p>
              </AnimatePresence>
            </div>
          </div>
          <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-stone-100">
            <div className={`h-full rounded-full ${waiting ? "w-1/3 bg-ochre-400" : "w-full shimmer"}`} />
          </div>
        </motion.div>
      )}

      {/* live browser view — the user watches the agent work in their own Chrome */}
      {state.screenshot && busy && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="lift mt-4 overflow-hidden rounded-2xl border border-stone-200/80 bg-white"
        >
          <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
            <span className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
              <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
              <span className="h-2.5 w-2.5 rounded-full bg-stone-200" />
            </span>
            <span className="text-xs font-medium text-stone-400">Your browser — live</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.screenshot}
            alt="Live view of the browser"
            className="block max-h-[400px] w-full bg-stone-50 object-contain object-top"
          />
        </motion.div>
      )}

      {/* connect-browser prompt — appears if a browser action needs the user's Chrome */}
      {needsBrowser && !state.screenshot && (
        <div className="mt-4 rounded-xl border border-stone-200 bg-white p-6">
          <p className="text-stone-900">I need your browser connected to do that.</p>
          <p className="mt-1 text-sm text-stone-500">
            This opens a Chrome window you can watch. Connect, then ask me again.
          </p>
          <button
            onClick={connectBrowser}
            disabled={connecting}
            className="mt-4 rounded-xl bg-accent-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-accent-700 active:scale-[0.98] disabled:opacity-50"
          >
            {connecting ? "Opening Chrome…" : "Connect my browser"}
          </button>
        </div>
      )}

      {/* run-level snag (e.g. failed to start, before any turn) */}
      {state.problem && state.turns.length === 0 && (
        <div className="mt-4 rounded-xl border border-brick-200 bg-brick-50 p-6">
          <p className="text-sm font-semibold text-brick-700">A small snag</p>
          <p className="mt-2 text-stone-900">{state.problem}</p>
        </div>
      )}

      {/* permission — rises in the same fixed slot, amber, batched per operation */}
      {state.approval && (
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 200, damping: 22 }}
          className="lift mt-5 rounded-3xl border border-ochre-300/60 bg-ochre-50 p-6"
        >
          <div className="flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-ochre-500 text-white">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M8 4v5M8 11.5v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <p className="text-sm font-semibold text-ochre-700">I need your okay first</p>
          </div>
          <p className="mt-2.5 text-[15px] text-stone-900">{state.approval.action}</p>
          {state.approval.items.length > 0 && (
            <p className="mt-1.5 font-mono text-[13px] text-stone-500">
              {state.approval.items.join(", ")}
              {state.approval.overflowCount ? ` …and ${state.approval.overflowCount} more` : ""}
            </p>
          )}
          {state.approval.reversibility !== "reversible" && (
            <p className="mt-2 text-sm font-medium text-stone-700">
              {state.approval.reversibility === "permanent" ? "This can't be undone." : "I can't undo this automatically."}
            </p>
          )}
          {state.approval.consequences && <p className="mt-2 text-sm text-stone-500">{state.approval.consequences}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={props.onApprove}
              className="rounded-xl bg-accent-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-accent-700 active:scale-[0.98]"
            >
              Yes, go ahead
            </button>
            <button
              onClick={props.onDeny}
              className="rounded-xl border border-stone-300 bg-white px-5 py-3 text-sm font-medium text-stone-700 transition hover:border-stone-400 active:scale-[0.98]"
            >
              Not yet
            </button>
            {/* Auto-approve is offered ONLY for reversible actions — never permanent/unknown. */}
            {state.approval.reversibility === "reversible" && (
              <button
                onClick={props.onApproveAll}
                className="rounded-xl px-3 py-3 text-sm font-medium text-stone-500 transition hover:text-stone-900 active:scale-[0.98]"
              >
                Yes to all in this errand
              </button>
            )}
          </div>
          <p className="mt-3 text-xs text-stone-400">Nothing happens until you choose.</p>
        </motion.div>
      )}

      {/* what changed — recap + honest, count-labelled Undo-all */}
      {done && state.changes.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="lift mt-6 rounded-2xl border border-stone-200/80 bg-white p-6"
        >
          <p className="text-[13px] font-medium text-stone-400">What changed</p>
          <ul className="mt-3 space-y-1.5">
            {state.changes.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-sm text-stone-700">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    c.undoable ? "bg-forest-600" : c.reversibility === "permanent" ? "bg-stone-500" : "bg-ochre-500"
                  }`}
                />
                {c.summary}
                {!c.undoable && <span className="text-xs text-stone-400">· can't be undone</span>}
              </li>
            ))}
          </ul>
          {reversibleCount > 0 &&
            (state.undo === "done" ? (
              <p className="mt-4 text-sm text-stone-500">{undoSentence(state.undoResult)}</p>
            ) : (
              <button
                onClick={props.onUndo}
                disabled={state.undo === "undoing"}
                className="mt-4 rounded-xl border border-stone-300 bg-white px-5 py-3 text-sm font-medium text-stone-700 transition hover:border-stone-400 active:scale-[0.98] disabled:opacity-50"
              >
                {state.undo === "undoing"
                  ? "Undoing…"
                  : `Undo ${reversibleCount === state.changes.length ? "all " : ""}${reversibleCount} change${reversibleCount === 1 ? "" : "s"}`}
              </button>
            ))}
        </motion.div>
      )}

      {/* composer — ALWAYS available. Sending while the agent works interrupts and
          redirects it; a Stop button sits alongside to halt without a new instruction. */}
      <div className="sticky bottom-0 mt-8 bg-gradient-to-t from-[#F4EFE6] via-[#F4EFE6] to-transparent pb-3 pt-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = followUp.trim();
            if (v) {
              props.onFollowUp(v);
              setFollowUp("");
              setAttached(null);
            }
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
            const f = e.dataTransfer.files?.[0];
            if (f) uploadFile(f);
          }}
          className={`lift rounded-2xl border bg-white p-1.5 transition ${
            dragOver ? "border-accent-600/60 bg-accent-50/40" : "border-stone-200/80"
          }`}
        >
          {(attached || uploading) && (
            <div className="px-2 pb-1 pt-1">
              {uploading ? (
                <span className="text-xs text-stone-400">Adding your file…</span>
              ) : (
                attached && (
                  <span className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-accent-600/30 bg-accent-50 px-2.5 py-1 text-xs font-medium text-accent-700">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
                      <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="truncate">{attached.name}</span>
                    <button
                      type="button"
                      onClick={() => setAttached(null)}
                      aria-label="Remove file"
                      className="ml-0.5 shrink-0 text-accent-700/60 transition hover:text-accent-700"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </button>
                  </span>
                )
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            {busy && (
              <button
                type="button"
                onClick={props.onCancel}
                title="Stop"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-stone-500 transition hover:bg-brick-50 hover:text-brick-600 active:scale-[0.96]"
              >
                <span className="block h-3 w-3 rounded-[3px] bg-current" />
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label="Attach a file"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 active:scale-[0.96]"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <input
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              placeholder={busy ? "Interrupt — tell me to change course…" : "Ask for one more thing…"}
              className="flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-stone-400"
            />
            <button
              type="submit"
              aria-label="Send"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-stone-900 text-white transition hover:bg-stone-800 active:scale-[0.96]"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </form>
        {done && (
          <button onClick={props.onReset} className="mt-3 px-1 text-sm text-stone-500 transition hover:text-stone-900">
            Start something else
          </button>
        )}
      </div>
    </div>
  );
}
