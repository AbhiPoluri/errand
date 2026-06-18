// Tool registry + the Tool contract. Each tool co-locates: its model-facing schema,
// runtime Zod validation, a describe() that produces HUMAN wording (the narration
// contract), and a summarize() for the result. Gating/reversibility land in v2/v3.
import type { z } from "zod";
import type OpenAI from "openai";
import type { Journal } from "../journal.ts";

const MAX_TOOL_RESULT_BYTES = 8_000; // output byte cap lives at the tool boundary

export interface ToolContext {
  signal: AbortSignal;
  journal: Journal; // mutating tools record their inverse here (v2+)
  runId: string; // for per-run paths like .errand-review/<runId>/ (v3)
  workspaceRoot: string; // sandbox root all destructive ops are confined to
  roots: string[]; // allowed read/write roots (two-root scope; defaults to [workspaceRoot])
  onScreenshot?: (dataUrl: string) => void; // browser tools stream the live view here
}

// Three-state honesty (NOT a boolean — a boolean conflates a deliberate one-way action
// with a merely-unmodelable one, the exact dishonesty the design forbids):
//   reversible — a clean inverse exists (file ops, read-only); Undo offered.
//   permanent  — one-way and KNOWN at describe() time (send email, permanent delete).
//   unknown    — effects we can't model (raw shell, browser clicks); treated AS permanent.
export type Reversibility = "reversible" | "permanent" | "unknown";

// Outcome of a run. `uncertain` = may-or-may-not have committed (network blip / abort
// mid-irreversible-action). The loop must NEVER auto-retry an uncertain permanent call.
export type Outcome = "done" | "failed" | "uncertain";

export interface ToolResult<D = unknown> {
  ok: boolean;
  outcome?: Outcome; // defaults: ok→"done", !ok→"failed"; set "uncertain" explicitly
  summary?: string; // optional raw; the user-facing line comes from tool.summarize()
  data?: D; // structured payload for the model (typed per tool; defaults to unknown)
  bytes?: number;
  error?: string; // machine code for trace + model recovery — never shown raw to a user
}

export interface ToolDescription {
  action: string; // human verb phrase, e.g. "Checking the current date"
  detail?: string;
  items?: string[];
  consequences?: string;
  reversibility: Reversibility;
}

// Post-approval, pre-run async re-check (state can drift during the human pause).
// ok:false re-proposes with fresh data instead of running. Optional; most tools skip it.
export type PreflightResult = { ok: true } | { ok: false; userSummary: string; refreshed?: ToolDescription };

export interface Tool<A = unknown, D = unknown> {
  name: string;
  modelDescription: string; // description sent to the model
  jsonSchema: Record<string, unknown>; // JSON Schema for the API `parameters`
  argsSchema: z.ZodType<A>; // runtime validation (defense, not just parsing)
  gated: boolean; // requires human approval before running
  describe(args: A): ToolDescription;
  summarize(result: ToolResult<D>): string; // D types result.data for the narration line
  run(args: A, ctx: ToolContext): Promise<ToolResult<D>>;
  preflight?(args: A, ctx: ToolContext): Promise<PreflightResult>; // optional commit-time re-check
}

export type Prepared =
  | { ok: true; tool: Tool<any>; args: any; description: ToolDescription }
  | { ok: false; reason: string; userSummary: string };

export class Registry {
  private tools = new Map<string, Tool<any>>();

  register(tool: Tool<any>): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  schemas(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.modelDescription,
        parameters: t.jsonSchema,
      },
    }));
  }

  // Validate a model tool-call BEFORE running. Never throws — returns a structured
  // result so the loop can feed failures back to the model instead of crashing.
  prepare(name: string, rawArgs: string): Prepared {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, reason: "unknown_tool", userSummary: "That action isn't available." };
    }
    let parsed: unknown;
    try {
      parsed = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { ok: false, reason: "invalid_json", userSummary: "I couldn't quite work out that step." };
    }
    const v = tool.argsSchema.safeParse(parsed);
    if (!v.success) {
      return {
        ok: false,
        reason: "invalid_args:" + v.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; "),
        userSummary: "That step was missing some details, so I skipped it.",
      };
    }
    return { ok: true, tool, args: v.data, description: tool.describe(v.data) };
  }
}

// Serialize a ToolResult into the string content fed back to the model (capped).
export function toToolMessage(result: ToolResult): string {
  const payload = JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    data: result.data,
    error: result.error,
  });
  if (payload.length <= MAX_TOOL_RESULT_BYTES) return payload;
  return (
    payload.slice(0, MAX_TOOL_RESULT_BYTES) +
    `…[truncated ${payload.length - MAX_TOOL_RESULT_BYTES} chars]`
  );
}
