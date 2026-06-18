# Errand

A calm, from-scratch AI agent harness with a consumer UI for **non-technical users**. It does real
daily-life work on your files — organize a folder (with Undo), read & explain documents, research the
web, and drive your real Chrome — and asks for a plain-language okay before anything changes your stuff.

Built to **own every line**: no LangChain, no agent-SDK, no reused code. The OpenAI SDK is used for
transport only (pointed at OpenRouter); the agent loop, tools, session, memory, and streaming are all
hand-written.

## Quick start

```bash
npm install
cp .env.example .env      # add your OPENROUTER_API_KEY
npm run web               # → http://localhost:3200
```

For browser tasks, load the unpacked extension: `chrome://extensions` → Load unpacked → `extension/`.

## What it does

- **Files** — organize, read, rename, move, copy, delete; every change is reversible and gated behind approval
- **Documents** — reads PDF, Word (`.docx`), Excel (`.xlsx`), CSV, and pulls text from images/photos via OCR
- **Web** — search the web and read pages
- **Browser** — drives your real Chrome through the extension (your logins, no focus-stealing)
- **Memory** — remembers durable facts about you (embedding-retrieved into the prompt), with an optional
  "dreaming" reflection that learns habits and suggests ideas
- **Streaming** — the agent's reply appears token-by-token
- **Model switcher** — pick any tool-capable OpenRouter model in-app (Settings → Model)

## Stack

Next.js 14 (App Router) · TypeScript · Tailwind · SQLite via Node's built-in `node:sqlite` · OpenRouter

## How it's built

The harness runs server-side inside Next route handlers (`runtime = "nodejs"`; the API key never reaches
the browser). The loop emits a single discriminated-union `AgentEvent` stream through an injected sink — a
headless CLI sink and a web/SSE sink prove it's UI-agnostic. Tools are a typed registry of self-describing,
gated, reversible operations, assembled into **capability packs** (`src/capabilities/`); a new domain is one
pack file. Every destructive action is reversible-by-construction (delete → move to a Review folder; overwrite
→ snapshot prior bytes) and gated behind a plain-language approval.

- **[PLAN.md](PLAN.md)** — the full living spec + dated changelog
- **[HANDOFF.md](HANDOFF.md)** — current state + where to pick up

## Tests

```bash
npm run v1:test       # agent loop: tool selection, multi-turn
npm run v2:test       # approval / denial / cancel + message integrity
npm run v3:test       # file tools + Undo + scope safety
npm run mem:test      # embedding-based memory retrieval
npm run doc:test      # PDF / docx / xlsx / csv extraction
npm run ocr:test      # image OCR (tesseract.js)
npm run cap:test      # capability-pack assembly
npm run restart:test  # interrupted-run reconciliation
```
