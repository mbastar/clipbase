// Fold a graded review sheet back into a query set.
//
//   npx tsx eval/apply-review.mts eval/review.md eval/reviewed.json > eval/queries.next.jsonl
//   npx tsx eval/apply-review.mts eval/review.md eval/reviewed.json --check   # counts only
//
// Writes to stdout; never edits eval/queries.jsonl in place. Diff the result
// before moving it into position.
//
// The output contains ONLY human-approved gold: existing gold, adjusted by any
// verdict you changed, plus reviewed new items you kept. Judge material that
// never reached the sheet — the grade-1 additions — is deliberately dropped
// rather than imported unreviewed, which is the whole point of the exercise.
//
// The ledger is optional and should always be passed. Without it, the `why` on
// every added item is scraped from the sheet's `JUDGE:` line, so an item a human
// moved off the pre-fill carries the argument for the grade it no longer has —
// a rescued item reads "(graded 0 — not in the judge's proposed set)" while
// sitting in gold at 1. That is session 7's failure at the last hop: the grade
// survives, the reason does not. A grade that moves takes its reason with it,
// so the ledger wins wherever it has one and the run reports the split.
import { readFileSync } from "node:fs";
import { normalizeGold, type QuerySpec, type GoldItem } from "../src/eval.js";
import { parseCollection } from "../src/commands/eval-collection.js";
import { loadDecisions, key } from "./reviewed.mjs";

const argv = process.argv.slice(2);
const [sheetPath, ledgerPath] = argv.filter((a) => !a.startsWith("--"));
if (!sheetPath) {
  console.error("usage: apply-review.mts <review.md> [reviewed.json] [--check]");
  process.exit(1);
}
const checkOnly = argv.includes("--check");
const decisions = ledgerPath ? loadDecisions(ledgerPath) : new Map();
let fromLedger = 0;
let fromJudge = 0;

const human: QuerySpec[] = readFileSync("eval/queries.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// Parse the sheet: query sections, then id/verdict pairs inside them.
const verdicts = new Map<number, Map<number, number>>(); // qi -> id -> grade
const reasons = new Map<string, string>(); // `${qi}:${id}` -> judge reason
let qi = -1;
let id = -1;
let seen = 0;
for (const line of readFileSync(sheetPath, "utf8").split("\n")) {
  const q = /^##\s+Q(\d+)\s/.exec(line);
  if (q) {
    qi = Number(q[1]);
    if (!verdicts.has(qi)) verdicts.set(qi, new Map());
    continue;
  }
  const item = /^###\s+id\s+(\d+)\s/.exec(line);
  if (item) {
    id = Number(item[1]);
    continue;
  }
  const why = /^-\s+JUDGE:\s+\d+\s+·\s+(.*)$/.exec(line);
  if (why && qi >= 0 && id > 0) reasons.set(`${qi}:${id}`, why[1].trim());
  const v = /^VERDICT:\s*([0-3])\s*$/.exec(line);
  if (v) {
    if (qi < 0 || id < 0) throw new Error(`VERDICT before any query/id heading: ${line}`);
    verdicts.get(qi)!.set(id, Number(v[1]));
    seen += 1;
    id = -1; // a verdict consumes its item; a stray second one should not bind
  }
}

const out: QuerySpec[] = [];
let kept = 0;
let dropped = 0;
let added = 0;
let changed = 0;

for (const [i, spec] of human.entries()) {
  const v = verdicts.get(i) ?? new Map<number, number>();
  const existing = new Map(normalizeGold(spec.gold).map((g) => [g.id, g]));
  const gold: GoldItem[] = [];

  for (const [gid, g] of existing) {
    const verdict = v.get(gid);
    if (verdict === undefined) {
      gold.push(g); // never flagged: the judge agreed, so it stands
      kept += 1;
      continue;
    }
    if (verdict === 0) {
      dropped += 1;
      continue;
    }
    // A `why` that survives a regrade argues for the grade the item used to
    // have, so the ledger's reason replaces it — but only when the grade moved.
    // On an unchanged verdict the stored reason is still the right one, and a
    // ledger entry there is a confirmation, not a better argument.
    const moved = verdict !== g.grade ? decisions.get(key(i, gid))?.why : undefined;
    if (verdict !== g.grade) changed += 1;
    // `group` rides along: a verdict regrades a (query, item) pair, it does not
    // decide whether two URLs are one product. Rebuilding the entry without it
    // would strip every label with a diff that looks like grades only.
    gold.push({ id: gid, grade: verdict as 1 | 2 | 3, why: moved ?? g.why, group: g.group });
  }

  for (const [gid, verdict] of v) {
    if (existing.has(gid) || verdict === 0) continue;
    const decided = decisions.get(key(i, gid))?.why;
    if (decided) fromLedger += 1;
    else fromJudge += 1;
    gold.push({
      id: gid,
      grade: verdict as 1 | 2 | 3,
      why: decided ?? reasons.get(`${i}:${gid}`),
    });
    added += 1;
  }

  gold.sort((a, b) => b.grade - a.grade || a.id - b.id);
  out.push({ query: spec.query, gold, note: spec.note });
}

const relevant = out.reduce((n, s) => n + normalizeGold(s.gold).filter((g) => g.grade >= 2).length, 0);
console.error(
  `read ${seen} verdicts · kept ${kept} · changed ${changed} · dropped ${dropped} · added ${added}\n` +
    `resulting gold ${out.reduce((n, s) => n + s.gold.length, 0)} (${relevant} relevant) across ${out.length} queries\n` +
    `added reasons: ${fromLedger} from the ledger · ${fromJudge} from the judge` +
    (ledgerPath ? ` (${ledgerPath})` : ` — no ledger passed, so every reason is the judge's`),
);

// A query with no grade-2+ item is unscoreable and loadQuerySpecs rejects it —
// catch it here, where the offending query can be named.
const empty = out.map((s, i) => [i, s] as const).filter(([, s]) => !normalizeGold(s.gold).some((g) => g.grade >= 2));
if (empty.length) {
  console.error(
    `\nWARNING: ${empty.length} query(ies) have no grade-2+ item and will be rejected on load:`,
  );
  for (const [i, s] of empty) console.error(`  Q${i} ${s.query.slice(0, 60)}`);
}

// The collection pin is read, never written — this script's output goes to
// stdout and the pin sits in a sibling file, so a fold cannot drop it. Gold
// above the ceiling would be judged outside what was pooled, which `eval`
// refuses to run; say so here, where the sheet that added it is still in hand.
const pin = (() => {
  try {
    return parseCollection(
      readFileSync("eval/queries.collection.json", "utf8"),
      "eval/queries.collection.json",
    );
  } catch {
    return undefined;
  }
})();
const above = pin
  ? out.flatMap((s, i) => normalizeGold(s.gold).filter((g) => g.id > pin.maxItemId).map((g) => `Q${i} id ${g.id}`))
  : [];
if (above.length) {
  console.error(
    `\nWARNING: ${above.length} gold item(s) above the collection ceiling ${pin!.maxItemId}: ${above.join(", ")}\n` +
      `  Re-pool and move maxItemId in the same commit, or eval will reject this set.`,
  );
}

if (!checkOnly) for (const spec of out) console.log(JSON.stringify(spec));
