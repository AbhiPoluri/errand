"use client";
// Production error boundary for the app segment. A jargon-free, calm recovery screen — no stack
// trace, no error code, not even the word "error" on the surface (a jargon leak is a sev-1 here).
// Matches the design system: warm paper, Geist, zinc/stone, the Problem Card tone. The real details
// are logged to the console for diagnostics only; the user just gets a way forward, never a dead end.
import { useEffect } from "react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Diagnostics only — never shown to the user.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[520px] flex-col items-center justify-center px-6 text-center">
      <div className="lift rounded-3xl border border-stone-200/80 bg-white p-8">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-50 text-accent-700">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 8.5v4.5M12 16h.01M12 3l9 16H3l9-16z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h1 className="mt-5 text-lg font-semibold text-stone-900">Something interrupted this</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Nothing you were working on was lost. Let&apos;s pick things back up.
        </p>
        <button
          onClick={() => reset()}
          className="mt-6 rounded-xl bg-accent-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-accent-700 active:scale-[0.98]"
        >
          Start over
        </button>
      </div>
    </div>
  );
}
