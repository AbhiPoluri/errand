"use client";
// Root-level error boundary. This one REPLACES the root layout (html/body) when the failure happens
// above the app segment, so it renders its own document shell and can't rely on globals.css loading —
// the critical calm look is inlined. Same contract as error.tsx: no stack trace, no error code, not
// even the word "error" on the surface (a jargon leak is a sev-1), and a single clear way forward.
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          backgroundColor: "#f4efe6",
          color: "#1c1917",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div
          style={{
            maxWidth: "460px",
            width: "100%",
            textAlign: "center",
            background: "#ffffff",
            border: "1px solid rgba(41,30,22,0.10)",
            borderRadius: "24px",
            padding: "32px",
            boxShadow: "0 1px 2px rgba(41,30,22,0.05), 0 14px 34px -14px rgba(41,30,22,0.14)",
          }}
        >
          <div
            aria-hidden
            style={{
              width: "48px",
              height: "48px",
              margin: "0 auto",
              display: "grid",
              placeItems: "center",
              borderRadius: "9999px",
              background: "rgba(194,85,46,0.10)",
              color: "#b0492b",
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 8.5v4.5M12 16h.01M12 3l9 16H3l9-16z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 style={{ margin: "20px 0 0", fontSize: "18px", fontWeight: 600, color: "#1c1917" }}>
            Something interrupted this
          </h1>
          <p style={{ margin: "8px 0 0", fontSize: "14px", lineHeight: 1.6, color: "#57534e" }}>
            Nothing you were working on was lost. Let&apos;s pick things back up.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "24px",
              border: "none",
              cursor: "pointer",
              borderRadius: "12px",
              background: "#b0492b",
              color: "#ffffff",
              fontSize: "14px",
              fontWeight: 500,
              padding: "12px 20px",
            }}
          >
            Start over
          </button>
        </div>
      </body>
    </html>
  );
}
