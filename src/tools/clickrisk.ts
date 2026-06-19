// Decide whether a browser click is RISKY (pauses for the user's approval on their real, logged-in
// Chrome) vs. benign (runs autonomously). This boolean is the single highest-stakes autonomy gate
// in the app, so it lives here — pure and dependency-free — to be unit-testable offline.

// Clicks that DO something consequential on a real site. Kept to verbs/phrases that map to a real
// commit (orders, sending, accepting terms, mailbox actions, advancing a flow), not generic words
// that would gate benign navigation.
export const RISKY =
  /(^|\b)(send|delete|remove|unsubscribe|buy|purchase|pay|checkout|place order|place your order|order now|confirm|submit|publish|post|trash|deactivate|sign out|log out|report spam|discard|move to trash|continue|proceed|accept|agree|add to cart|subscribe|reply|forward|archive|block|mute|withdraw|transfer|wire)(\b|$)/i;

// Element kinds that are inherently navigation/disclosure — safe to click even without a label.
const BENIGN_KINDS = new Set(["a", "summary", "details"]);

// `label` is the element's visible text/aria-label; `kind` is its tag ("a", "button", an input
// type, "div", …). A LABELLED element is risky iff its label matches a consequential verb. An
// UNLABELLED element (an icon-only button, a clickable div — common in modern UIs) has unknown
// intent, so it defaults to RISKY (pause) unless it's a bare navigation/disclosure kind.
export function classifyClickRisk(label: string | undefined, kind?: string): boolean {
  const l = label?.trim();
  if (l) return RISKY.test(l);
  return !(kind && BENIGN_KINDS.has(kind.toLowerCase()));
}
