// Build the human review sheet for the re-pool: the items above the judged
// collection ceiling, with the passages a grade has to rest on.
//
//   npx tsx eval/make-repool-review.mts > eval/repool-review.md
//   npx tsx eval/make-repool-review.mts eval/proposed-anchored.json   # another run
//
// Sibling of make-review.mts, which compares a judge run against existing human
// gold. Nothing above the ceiling HAS existing human gold — that is the whole
// point of the exercise — so there is no DEMOTION/PROMOTION axis here. Every row
// is new material, and the only question is which grade it earns.
//
// Read-only. Edit the VERDICT lines in the output; apply-review.mts folds them
// back into a query set.
import { readFileSync } from "node:fs";
import { getReplicaClient } from "../src/db.js";
import { buildPool, poolEvidence, type PoolCandidate } from "../src/commands/pool.js";
import { normalizeGold, type QuerySpec } from "../src/eval.js";

/** The ceiling the current gold was judged to. Rows below it are already decided. */
const CEILING: number = JSON.parse(
  readFileSync("eval/queries.collection.json", "utf8"),
).maxItemId;

/**
 * A grade-0 candidate is not shown — 316 new pairs is already a session's work,
 * and most of them are genuinely irrelevant items that a depth-50 pool sweeps
 * up. But a false 0 is the one error this sheet cannot catch by construction: it
 * never reaches a person. So grade-0 candidates that a ranker put near the top
 * are surfaced anyway. An item that is truly irrelevant rarely ranks this high.
 */
const RESCUE_RANK = 10;

const human: QuerySpec[] = readFileSync("eval/queries.jsonl", "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// The reference class must be hand-decided gold, never a sheet's pre-fills.
// apply-review output folds unreviewed judge grades into `gold`, so building
// from it would show items as already-graded when they are exactly the ones
// awaiting judgement. A hand gold file cannot contain an id above the ceiling —
// if it does, this is the wrong file.
for (const [qi, q] of human.entries()) {
  for (const g of normalizeGold(q.gold)) {
    if (g.id > CEILING) {
      throw new Error(
        `eval/queries.jsonl Q${qi} carries gold id ${g.id}, above the ceiling ${CEILING}. ` +
          `That file must be hand-decided gold; this looks like apply-review output.`,
      );
    }
  }
}

const judgePath = process.argv[2] ?? "eval/proposed-repool.json";
const judged: QuerySpec[] = JSON.parse(readFileSync(judgePath, "utf8")).proposed;
if (judged.length !== human.length) {
  throw new Error(`judge run has ${judged.length} queries, query set has ${human.length}`);
}

type Cat = "NEW-3" | "NEW-2" | "NEW-1" | "RESCUE-0";
interface Row {
  id: number;
  cat: Cat;
  judgeGrade: number;
  judgeWhy: string;
  fts?: number;
  semantic?: number;
}

const client = await getReplicaClient();
const pool = await buildPool(client, human);

const out: string[] = [];
let rescued = 0;

out.push("# Re-pool review sheet");
out.push("");
const COUNT_SLOT = " count ";
out.push(
  COUNT_SLOT,
  "",
  `Every item here is above the judged ceiling (id > ${CEILING}) — none of it has ever`,
  "been graded. Edit the `VERDICT:` numbers. They are pre-filled with the judge's",
  "grade — a starting point, not a default to accept.",
  "",
  "This run re-graded 279 already-decided pairs blind, so the pre-fill's error is",
  "measured rather than guessed: 68% agreement on answer/not, and the error runs",
  "one way — 98 grades too high against 21 too low. It inflates. 66 of 138 items a",
  "human called grade 1 came back as 2, so a NEW-2 is the pre-fill to distrust",
  "first; only 62% of the judge's 2-and-above survived human review. It is far",
  "better at the top: it reproduced 66 of 76 human 3s, and graded 0 to *none* of",
  "the 141 items a human called an answer.",
  "",
  "Scale: **3** answers the query, **2** substantially relevant, **1** touches the",
  "subject, **0** not relevant (drops it). Only **2** and above count as answers for",
  "Success/MRR/Recall; **1** contributes to nDCG alone. The 1/2 line is the one that",
  "decides what this eval measures.",
  "",
  "Passages are the chunks nearest the query, which is what the grade should rest",
  "on — not the title.",
  "",
);

for (const [qi, hq] of human.entries()) {
  const jg = new Map(
    (judged[qi].gold as { id: number; grade: number; why?: string }[]).map((g) => [g.id, g]),
  );
  const cand = new Map<number, PoolCandidate>(pool.queries[qi].candidates.map((c) => [c.id, c]));

  const rows: Row[] = [];
  for (const [id, c] of cand) {
    if (id <= CEILING) continue; // already decided by hand
    const j = jg.get(id);
    // Absent from the proposed set means grade 0 — or ungraded, which the judge
    // command counts and reports separately. Treated as 0 here; the rescue rule
    // below is what stops that conflation from being silent.
    const grade = j?.grade ?? 0;
    const best = Math.min(c.ftsRank ?? Infinity, c.semanticRank ?? Infinity);
    let cat: Cat | null = null;
    if (grade === 3) cat = "NEW-3";
    else if (grade === 2) cat = "NEW-2";
    else if (grade === 1) cat = "NEW-1";
    else if (best <= RESCUE_RANK) {
      cat = "RESCUE-0";
      rescued += 1;
    }
    if (!cat) continue;
    rows.push({
      id,
      cat,
      judgeGrade: grade,
      judgeWhy: j?.why ?? "(graded 0 — not in the judge's proposed set)",
      fts: c.ftsRank,
      semantic: c.semanticRank,
    });
  }
  if (!rows.length) continue;

  // By stakes: the grades that claim an answer first, then the ones that decide
  // the 1/2 line, then the rescues that only exist to be checked.
  const order: Cat[] = ["NEW-3", "NEW-2", "NEW-1", "RESCUE-0"];
  rows.sort((a, b) => order.indexOf(a.cat) - order.indexOf(b.cat) || a.id - b.id);

  const evidence = await poolEvidence(
    client,
    hq.query,
    rows.map((r) => r.id),
    { perItem: 2, chars: 340 },
  );
  const ev = new Map(evidence.map((e) => [e.id, e]));

  const meta = await client.execute({
    sql: `SELECT id, title, domain FROM items WHERE id IN (${rows.map(() => "?").join(",")})`,
    args: rows.map((r) => r.id),
  });
  const titles = new Map(
    meta.rows.map((r) => [Number(r.id), `${r.domain ?? "-"} · ${r.title ?? "(untitled)"}`]),
  );

  out.push("---", "", `## Q${qi} — ${hq.query}`, "");
  if (hq.note) out.push(`> Your note: ${hq.note}`, "");
  out.push(`${rows.length} to review.`, "");

  for (const r of rows) {
    const e = ev.get(r.id);
    const rank = `f${r.fts ?? "-"} s${r.semantic ?? "-"}`;
    out.push(`### id ${r.id} · ${r.cat} · ${rank}`);
    out.push(`${titles.get(r.id) ?? "(unknown item)"}${e ? ` · ${e.wordCount}w` : ""}`);
    out.push("");
    out.push(`- HUMAN: — (never judged)`);
    out.push(`- JUDGE: ${r.judgeGrade} · ${r.judgeWhy}`);
    out.push("");
    out.push(`VERDICT: ${r.judgeGrade}`);
    out.push("");
    for (const m of e?.matches ?? []) out.push(`> \`${m.similarity}\` ${m.text}`, "");
    if (!e?.matches.length) out.push("> (no embedded passages)", "");
  }
}

const counts = out.filter((l) => l.startsWith("### id ")).length;
const above = pool.queries.reduce(
  (n, q) => n + q.candidates.filter((c) => c.id > CEILING).length,
  0,
);
console.log(
  out
    .join("\n")
    .replace(
      COUNT_SLOT,
      `**${counts} items to review**, drawn from ${above} pooled pairs above id ${CEILING}. ` +
        `${rescued} of them are grade-0 rescues, included because a ranker put them in the ` +
        `top ${RESCUE_RANK} and a false 0 reaches nobody otherwise.`,
    ),
);
