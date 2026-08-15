// Fold the human decisions in eval/reviewed.json into the review sheet.
//
//   npx tsx eval/record-verdicts.mts --check   # what would change, no write
//   npx tsx eval/record-verdicts.mts           # rewrite eval/review.md in place
//   npx tsx eval/record-verdicts.mts eval/repool-review.md eval/repool-reviewed.json
//
// A pass gets its own sheet and its own ledger. Sharing one ledger across passes
// would make every decision from an earlier pass unmatched against this pass's
// sheet, and the unmatched check below is a hard error on purpose — it is what
// catches a decision aimed at an item that is not in the sheet at all.
//
// review.md is what apply-review.mts reads, but its VERDICT lines cannot carry
// a reason — the parser is `^VERDICT: [0-3]$` and anything trailing breaks it.
// So the reasons live in reviewed.json and this writes only the number across.
//
// That split is deliberate. Session 7 applied 50 HIGH calls whose per-item
// evidence lived in task output under /private/tmp and is now gone; the grades
// survived, the arguments did not. reviewed.json is where this pass keeps them.
import { readFileSync, writeFileSync } from "node:fs";
import { loadDecisions } from "./reviewed.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const [sheetPath = "eval/review.md", ledgerPath = "eval/reviewed.json"] = args.filter(
  (a) => !a.startsWith("--"),
);
const decisions = loadDecisions(ledgerPath);
const lines = readFileSync(sheetPath, "utf8").split("\n");

let qi = -1;
let id = -1;
const changes: string[] = [];
const applied = new Set<string>();

for (const [i, line] of lines.entries()) {
  const q = /^##\s+Q(\d+)\s/.exec(line);
  if (q) {
    qi = Number(q[1]);
    continue;
  }
  const item = /^###\s+id\s+(\d+)\s/.exec(line);
  if (item) {
    id = Number(item[1]);
    continue;
  }
  const v = /^VERDICT:\s*([0-3])\s*$/.exec(line);
  if (!v || qi < 0 || id < 0) continue;

  const key = `${qi}:${id}`;
  const d = decisions.get(key);
  id = -1; // a verdict consumes its item, as in apply-review.mts
  if (!d) continue;

  applied.add(key);
  const before = Number(v[1]);
  if (before === d.grade) continue;
  lines[i] = `VERDICT: ${d.grade}`;
  changes.push(`  Q${qi} id ${d.id}: ${before} → ${d.grade}  ${d.why}`);
}

const inGold = [...decisions.values()].filter((d) => d.target === "gold");
if (inGold.length) {
  console.error(`${inGold.length} decision(s) target queries.jsonl directly, not the sheet:`);
  for (const d of inGold) console.error(`  Q${d.query} id ${d.id} → ${d.grade}`);
}

const missing = [...decisions.entries()]
  .filter(([k, d]) => d.target !== "gold" && !applied.has(k))
  .map(([k]) => k);
if (missing.length) {
  console.error(`ERROR: ${missing.length} decision(s) match no VERDICT line in the sheet:`);
  for (const k of missing) console.error(`  ${k}`);
  process.exit(1);
}

console.error(
  `${decisions.size} decision(s) recorded · ${changes.length} verdict(s) moved off the judge pre-fill`,
);
for (const c of changes) console.error(c);

if (check) {
  console.error(`\n--check: ${sheetPath} not written`);
} else {
  writeFileSync(sheetPath, lines.join("\n"));
  console.error(`\n${sheetPath} updated`);
}
