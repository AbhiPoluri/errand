// Browser click-risk classifier (r4 rank 2) — offline, pure. Verifies which clicks pause for the
// user's approval on their real Chrome vs. run autonomously. The unlabeled-button default is the
// load-bearing safety case: an icon-only button must pause, not auto-fire.
import { classifyClickRisk } from "./tools/clickrisk.ts";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

console.log("\n== consequential labels are RISKY (pause) ==");
for (const l of ["Continue", "Place your order", "Accept", "I agree", "Add to cart", "Archive", "Delete", "Send", "Subscribe", "Reply"]) {
  check(`"${l}" is risky`, classifyClickRisk(l, "button") === true);
}

console.log("\n== money-movement commits are RISKY (never auto-fire on a logged-in bank) ==");
for (const l of ["Withdraw", "Transfer", "Wire transfer", "Transfer funds", "Withdraw all"]) {
  check(`"${l}" is risky`, classifyClickRisk(l, "button") === true);
}
// Guard against over-broadening: a benign word that merely CONTAINS "wire" must stay benign.
check('"Wired" (no word boundary) stays benign', classifyClickRisk("Wired", "a") === false);

console.log("\n== unlabeled non-navigation elements default RISKY ==");
check("unlabeled button is risky", classifyClickRisk(undefined, "button") === true);
check("empty-label button is risky", classifyClickRisk("", "button") === true);
check("unlabeled clickable div is risky", classifyClickRisk(undefined, "div") === true);
check("unlabeled input(submit) is risky", classifyClickRisk(undefined, "submit") === true);

console.log("\n== fail-closed: ambiguous/unknown LABELLED buttons now pause (the core inversion) ==");
// These used to classify BENIGN (no consequential verb matched) and auto-fire ungated on the user's
// real Chrome. A "Save"/"Apply"/"OK"/"Update" is often a commit; a non-English or icon-only label is
// unknowable. All must pause now.
for (const l of ["Save", "Apply", "OK", "Update", "Done", "Confirm changes", "Enviar", "确定", "はい", "Aceptar", "Weiter"]) {
  check(`"${l}" is risky (unknown intent → pause)`, classifyClickRisk(l, "button") === true);
}
check("labelled clickable div with an unknown label is risky", classifyClickRisk("Save", "div") === true);
check("labelled span with an unknown label is risky", classifyClickRisk("Apply", "span") === true);
check("role=button treated like button (unknown label → risky)", classifyClickRisk("OK", "button") === true);
// A RISKY verb rendered as a link still pauses (verb list is an ADDITIONAL signal, not the only path).
check('"Delete" as a link still pauses', classifyClickRisk("Delete", "a") === true);

console.log("\n== benign navigation stays clickable ==");
for (const l of ["Home", "Show more", "Open menu", "Next page", "Back"]) {
  check(`"${l}" is benign`, classifyClickRisk(l, "a") === false);
}
check("unlabeled link is benign", classifyClickRisk(undefined, "a") === false);
check("unlabeled summary (disclosure) is benign", classifyClickRisk(undefined, "summary") === false);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
