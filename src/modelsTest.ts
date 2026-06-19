// Verifies the model-classification helpers in src/models.ts: the param-size parser and the
// weak-for-browser hint that drives the Settings warning. Pure functions, no DB / network.
// Run: `npm run models:test`.
import { modelParamCountB, modelLikelyWeakForBrowser, modelSupportsVision, MODEL_PRESETS } from "./models.ts";

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
}

// --- modelParamCountB: pull the billions-of-params a model id encodes ---
check("3b parsed from llama-3.2-3b", modelParamCountB("meta-llama/llama-3.2-3b-instruct") === 3);
check("7b parsed from qwen2.5:7b", modelParamCountB("qwen2.5:7b") === 7);
check("72b parsed (not the 2.5)", modelParamCountB("qwen/qwen-2.5-72b-instruct") === 72);
check("1.5b decimal parsed", modelParamCountB("qwen2.5:1.5b") === 1.5);
check("no size in gpt-4.1-mini → null", modelParamCountB("openai/gpt-4.1-mini") === null);
check("no size in gemini-2.5-flash → null", modelParamCountB("google/gemini-2.5-flash") === null);
check("empty id → null", modelParamCountB("") === null);

// --- modelLikelyWeakForBrowser: the soft warning signal ---
check("curated presets are never weak", MODEL_PRESETS.every((p) => !modelLikelyWeakForBrowser(p.id)));
check("OpenRouter :free tier is weak", modelLikelyWeakForBrowser("meta-llama/llama-3.3-70b-instruct:free") === true);
check("sub-8B model is weak (3b)", modelLikelyWeakForBrowser("meta-llama/llama-3.2-3b-instruct") === true);
check("7b is weak (< 8)", modelLikelyWeakForBrowser("mistralai/mistral-7b-instruct") === true);
check("large model (72b) is NOT weak", modelLikelyWeakForBrowser("qwen/qwen-2.5-72b-instruct") === false);
check("strong cloud model (no size) is NOT weak", modelLikelyWeakForBrowser("anthropic/claude-3.5-sonnet") === false);
check("empty id is NOT weak", modelLikelyWeakForBrowser("") === false);
check("a paid 70b is NOT weak (no :free)", modelLikelyWeakForBrowser("meta-llama/llama-3.3-70b-instruct") === false);

// --- modelSupportsVision unchanged by the additions (smoke) ---
check("vision: gemini supported", modelSupportsVision("google/gemini-2.5-flash") === true);
check("vision: a 3b text model not supported", modelSupportsVision("meta-llama/llama-3.2-3b-instruct") === false);

console.log(`\nRESULT: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
if (failures) process.exitCode = 1;
