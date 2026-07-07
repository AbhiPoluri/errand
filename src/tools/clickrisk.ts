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

// Labels that clearly read as navigation / disclosure / paging — safe even on a button or div.
// Kept deliberately NARROW: movement through content, expand/collapse, menus, paging. NOT a commit
// (no "OK", "Save", "Apply", "Confirm" — those must pause). Anchored (^…$) so a benign word inside a
// consequential phrase can't whitelist it. English-only on purpose: a label we can't read as clearly
// benign is treated as unknown, which fails closed to RISKY below.
const BENIGN_LABEL =
  /^(home|back|go back|next|next page|previous|prev|previous page|newer|older|show more|show less|see more|see all|view more|view all|load more|read more|expand|collapse|open menu|close menu|toggle menu|first|last|top|page \d+|more|»|«|›|‹|→|←)$/i;

// `label` is the element's visible text/aria-label; `kind` is its tag ("a", "button", an input
// type, "div", …). FAIL-CLOSED: a labelled clickable element is treated as RISKY (pause for the
// user's okay) UNLESS it is a bare navigation/disclosure kind (a/summary/details) OR its label
// clearly matches a benign navigation pattern. An UNLABELLED non-navigation element (an icon-only
// button, a clickable div — common in modern UIs) has unknown intent, so it is RISKY. This means
// unknown/ambiguous buttons ("Save", "Apply", "OK", non-English, icon-only) pause rather than
// auto-fire on the user's real, logged-in browser. The RISKY verb list is an ADDITIONAL signal
// (it makes a link labelled "Delete" pause too) but is never the ONLY path to risky.
export function classifyClickRisk(label: string | undefined, kind?: string): boolean {
  const l = label?.trim();
  // A consequential verb ("Delete", "Send", "Pay", "Transfer"…) is risky on ANY element, even a link.
  if (l && RISKY.test(l)) return true;
  // Bare navigation/disclosure kinds are otherwise benign (links, <summary>, <details>).
  if (kind && BENIGN_KINDS.has(kind.toLowerCase())) return false;
  // A non-navigation clickable with NO readable label has unknown intent → pause.
  if (!l) return true;
  // Labelled non-navigation element: benign ONLY if it clearly reads as navigation/disclosure.
  return !BENIGN_LABEL.test(l);
}
