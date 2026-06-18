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

console.log("\n== unlabeled non-navigation elements default RISKY ==");
check("unlabeled button is risky", classifyClickRisk(undefined, "button") === true);
check("empty-label button is risky", classifyClickRisk("", "button") === true);
check("unlabeled clickable div is risky", classifyClickRisk(undefined, "div") === true);
check("unlabeled input(submit) is risky", classifyClickRisk(undefined, "submit") === true);

console.log("\n== benign navigation stays clickable ==");
for (const l of ["Home", "Show more", "Open menu", "Next page", "Back"]) {
  check(`"${l}" is benign`, classifyClickRisk(l, "a") === false);
}
check("unlabeled link is benign", classifyClickRisk(undefined, "a") === false);
check("unlabeled summary (disclosure) is benign", classifyClickRisk(undefined, "summary") === false);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
