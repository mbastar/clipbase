// The ledger of human decisions over the 99 items session 7 could not settle.
//
// Session 7 applied 50 agent calls whose per-item evidence lived in task output
// under /private/tmp; the grades survived into review.md, the arguments did not.
// review.md cannot hold them either — apply-review.mts parses `^VERDICT: [0-3]$`
// and anything trailing breaks it. So the reasons live here, beside the grade,
// and record-verdicts.mts writes only the number across.
//
// `grade` follows the sheet's scale: 3 answers the query, 2 substantially
// relevant, 1 touches the subject, 0 not relevant. 0 keeps an item out of gold;
// for these 99 — all candidate additions — 0 and 1 differ only in whether the
// item is recorded as considered-and-rejected or as weakly on-topic.
import { readFileSync, existsSync } from "node:fs";

export interface Decision {
  query: number;
  id: number;
  grade: 0 | 1 | 2 | 3;
  why: string;
  /**
   * Where the grade has to land. Most decisions rewrite a `VERDICT:` line in the
   * review sheet. A few adjust gold that was hand-written in queries.jsonl and
   * never entered the sheet — those carry `target: "gold"` and are edited there,
   * because record-verdicts has no line to rewrite and should still fail loudly
   * on a decision that matches nothing.
   */
  target?: "sheet" | "gold";
}

export const key = (query: number, id: number) => `${query}:${id}`;

export function loadDecisions(path = "eval/reviewed.json"): Map<string, Decision> {
  if (!existsSync(path)) return new Map();
  const items: Decision[] = JSON.parse(readFileSync(path, "utf8")).items;
  return new Map(items.map((d) => [key(d.query, d.id), d]));
}
