// Print the still-undecided items for one query, with both agent passes'
// arguments beside the passages a grade has to rest on.
//
//   npx tsx eval/work-queue.mts        # what is left, by query
//   npx tsx eval/work-queue.mts 0      # the undecided items for Q0
//
// The evidence and the passages live in different files — needs-human.json
// carries what the two agent passes argued, review.md carries the chunks — and
// a grader needs both in view at once. This joins them; it decides nothing.
//
// Grouped by query for the same reason make-review.mts groups that way: a
// grader holds one query in mind at a time, and re-reading it per item is how
// calibration drifts.
//
// Read-only. needs-human.json is session 7's frozen population of 99;
// reviewed.json is what has been decided since.
import { readFileSync } from "node:fs";
import type { QuerySpec } from "../src/eval.js";
import { key, loadDecisions } from "./reviewed.mjs";

interface Pending {
  query: number;
  id: number;
  category: string;
  judgeGrade: number;
  agentGrade: number;
  runOneGrade: number;
  agreed: boolean;
  confidence: string;
  noteConflict: boolean;
  chromeRisk: boolean;
  agentEvidence: string;
}

/** Titles, judge reasons and passages, keyed `qi:id`, parsed out of the sheet. */
function parseSheet(path = "eval/review.md") {
  const out = new Map<string, { title: string; judgeWhy: string; passages: string[] }>();
  let qi = -1;
  let cur: { title: string; judgeWhy: string; passages: string[] } | null = null;
  let wantTitle = false;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const q = /^##\s+Q(\d+)\s/.exec(line);
    if (q) {
      qi = Number(q[1]);
      cur = null;
      continue;
    }
    const item = /^###\s+id\s+(\d+)\s/.exec(line);
    if (item) {
      cur = { title: "", judgeWhy: "", passages: [] };
      out.set(key(qi, Number(item[1])), cur);
      wantTitle = true;
      continue;
    }
    if (!cur) continue;
    if (wantTitle && line.trim()) {
      cur.title = line.trim();
      wantTitle = false;
      continue;
    }
    const why = /^-\s+JUDGE:\s+\d+\s+·\s+(.*)$/.exec(line);
    if (why) cur.judgeWhy = why[1].trim();
    if (line.startsWith("> ")) cur.passages.push(line.slice(2));
  }
  return out;
}

const specs: QuerySpec[] = readFileSync("eval/queries.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const pending: Pending[] = JSON.parse(readFileSync("eval/needs-human.json", "utf8")).items;
const decided = loadDecisions();
const sheet = parseSheet();

const open = pending.filter((p) => !decided.has(key(p.query, p.id)));
const arg = process.argv[2];

if (arg === undefined) {
  const byQuery = new Map<number, number>();
  for (const p of open) byQuery.set(p.query, (byQuery.get(p.query) ?? 0) + 1);
  console.log(`${open.length} of ${pending.length} still undecided\n`);
  for (const [q, n] of [...byQuery].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    console.log(`  Q${String(q).padEnd(3)} ${String(n).padStart(2)}  ${specs[q].query}`);
  }
  process.exit(0);
}

const qi = Number(arg);
const spec = specs[qi];
if (!spec) throw new Error(`no query Q${arg} in eval/queries.jsonl`);
const rows = open.filter((p) => p.query === qi);

console.log(`## Q${qi} — ${spec.query}`);
if (spec.note) console.log(`\n> Your note: ${spec.note}`);
console.log(`\n${rows.length} undecided.\n`);

for (const r of rows) {
  const s = sheet.get(key(r.query, r.id));
  const flags = [
    r.agreed ? null : "DIVERGED",
    r.chromeRisk ? "chrome-risk" : null,
    r.noteConflict ? "note-conflict" : null,
  ].filter(Boolean);

  console.log("---");
  console.log(`### id ${r.id} · ${r.category}${flags.length ? ` · ${flags.join(" · ")}` : ""}`);
  console.log(s?.title ?? "(not in sheet)");
  console.log(
    `\n- JUDGE ${r.judgeGrade} · ${s?.judgeWhy ?? ""}` +
      `\n- PASS A ${r.agentGrade} · PASS B ${r.runOneGrade} · ${r.confidence}`,
  );
  console.log(`\n${r.agentEvidence}\n`);
  for (const p of s?.passages ?? []) console.log(`> ${p}`);
  console.log();
}
