// Re-judging the eval's gold: grade pooled candidates against their content.
//
// Runs through the already-authenticated Claude Code CLI, same as enrich.ts —
// no ANTHROPIC_API_KEY needed. Writes nothing on its own: it emits a proposed
// query set, because gold lives in eval/queries.jsonl under review, not in a
// table something can silently rewrite.

import { execFile } from "node:child_process";
import type { Client } from "../db.js";
import { normalizeGold, type QuerySpec, type GoldItem } from "../eval.js";
import { buildPool, poolEvidence, POOL_DEPTH, type PoolCandidate } from "./pool.js";
import type { Embedder } from "../embed.js";

const CLI_TIMEOUT_MS = 600_000;

/** 0 means "not relevant" — a candidate the judge drops rather than grades. */
export type Grade = 0 | 1 | 2 | 3;

export interface Judgement {
  id: number;
  grade: Grade;
  why: string;
}

/**
 * The rubric is quoted from docs/retrieval.md rather than reworded. The judge
 * and the metric have to mean the same thing by "relevant", or agreement with
 * the existing gold measures nothing.
 */
const RUBRIC = `3 = answers the query: someone with this question would be satisfied by this item
2 = substantially relevant: about the right thing, but not the direct answer
1 = touches the subject but is not what the query asked for
0 = not relevant`;

export interface Anchor {
  query: string;
  id: number;
  grade: 1 | 2 | 3;
  why?: string;
  evidence: string[];
}

/**
 * Pick a fixed set of already-graded items to show as worked examples.
 *
 * Drawn from across the whole query set, not per query, for a blunt reason:
 * gold averages under five items a query and six queries have exactly one, so
 * per-query anchors would eat the very items the agreement number is computed
 * from. A cross-query set teaches the *scale*, which is what drifts — the judge
 * knows what the query is, it just does not know how good a 3 has to be.
 *
 * Deterministic: first `perGrade` of each grade in query then id order, so two
 * runs are comparable.
 */
export function selectAnchors(
  specs: QuerySpec[],
  perGrade: number,
): { query: string; item: GoldItem }[] {
  const out: { query: string; item: GoldItem }[] = [];
  for (const grade of [3, 2, 1] as const) {
    // At most one per query before taking a second from any: anchors drawn from
    // one query teach that query's subject as much as the scale, and they are
    // subtracted from that query's scoring.
    const perQuery = specs.map((spec) =>
      normalizeGold(spec.gold)
        .filter((item) => item.grade === grade)
        // A stated reason makes the better example, so prefer one — but never
        // require it. Every grade-1 item in the current set is a bare id, and
        // grade 1 is exactly the boundary that drifts, so requiring a reason
        // would leave the bottom of the scale undemonstrated.
        .sort((a, b) => Number(Boolean(b.why)) - Number(Boolean(a.why)) || a.id - b.id)
        .map((item) => ({ query: spec.query, item })),
    );
    for (let round = 0; out.filter((o) => o.item.grade === grade).length < perGrade; round += 1) {
      const before = out.length;
      for (const q of perQuery) {
        if (out.filter((o) => o.item.grade === grade).length >= perGrade) break;
        if (q[round]) out.push(q[round]);
      }
      if (out.length === before) break; // nothing left at this grade
    }
  }
  return out;
}

export function buildJudgePrompt(
  query: string,
  items: { id: number; title: string | null; domain: string | null; evidence: string[] }[],
  anchors: Anchor[] = [],
): string {
  const blocks = items
    .map((i) => {
      const head = `id=${i.id} | ${i.domain ?? "-"} | ${i.title ?? "(untitled)"}`;
      const body = i.evidence.length
        ? i.evidence.map((e) => `    ${e}`).join("\n")
        : "    (no extracted content)";
      return `${head}\n${body}`;
    })
    .join("\n\n");

  // Worked examples go before the query on purpose: the scale is what they are
  // there to fix, and a scale stated after the task reads as an afterthought.
  const calibration = anchors.length
    ? `\nWORKED EXAMPLES — these grades are correct. Match this standard; do not grade more generously than these.\n\n${anchors
        .map(
          (a) =>
            `For the query "${a.query}":\n  GRADE ${a.grade}${a.why ? ` — ${a.why}` : ""}\n${a.evidence
              .map((e) => `    ${e}`)
              .join("\n")}`,
        )
        .join("\n\n")}\n`
    : "";

  return `You are judging search results for a retrieval evaluation over a personal knowledge base of AI/agent tooling.

Grade each candidate on how well it answers the query:

${RUBRIC}
${calibration}
QUERY: ${query}

The passages shown are the parts of each document closest in meaning to the query — judge the item on them, not on whether the title sounds related. A document whose passages are navigation links, badges or a comparison table has not shown you its substance; grade what the passages actually demonstrate.

Be strict about grade 3. "About the same topic" is 2, not 3.

Return ONLY a JSON array, no prose, no markdown fence:
[{"id":<int>,"grade":<0-3>,"why":"<max 15 words>"}]

CANDIDATES:
${blocks}`;
}

function runClaude(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", "--model", model, "--output-format", "json"],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const hint =
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? "the `claude` CLI is not on PATH (see docs/topic-taxonomy.md)"
              : err.message;
          reject(new Error(`claude -p failed: ${hint}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(prompt);
  });
}

/**
 * Head *and* tail of a bad reply. A truncated reply and a prose-suffixed one
 * look identical from the front, so a head-only excerpt made one real failure
 * undiagnosable after the fact — the interesting end is the one that broke.
 */
function excerptForError(body: string, span = 180): string {
  if (body.length <= span * 2) return body;
  return `${body.slice(0, span)} …[${body.length - span * 2} chars]… ${body.slice(-span)}`;
}

/**
 * Find the first complete JSON array in `text`, ignoring brackets inside string
 * literals. Used to recover a reply the model wrapped in prose.
 */
function extractArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Every complete top-level `{...}` in `text`, string-aware. Survives truncation. */
function salvageObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          /* a malformed object is skipped, not fatal */
        }
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Recover the judgements from a reply body.
 *
 * Two deviations from "return ONLY a JSON array" showed up across ~180 real
 * batches, each costing a complete and correct reply: one object per line
 * instead of an array, and a prose preamble before the array. Both are parsed
 * rather than discarded — the instruction is worth repeating in the prompt, but
 * not worth throwing 20 judgements away over.
 */
function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    // Prose before (or after) the array — take the array itself.
    const arr = extractArray(body);
    if (arr) {
      try {
        return JSON.parse(arr);
      } catch {
        /* fall through to the line-delimited attempt */
      }
    }
    // An array that never closes — a reply cut off mid-flight. The judgements
    // before the cut are complete and usable, so salvage them; the candidates
    // after it come back ungraded and are counted as such by the caller, which
    // is the honest outcome rather than losing the whole batch.
    const salvaged = salvageObjects(body);
    if (salvaged.length) return salvaged;

    // One object per line, unwrapped.
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    const objects = lines.every((l) => l.startsWith("{") && l.endsWith("}"))
      ? lines.map((l) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            return null;
          }
        })
      : [];
    if (!objects.length || objects.some((o) => o === null)) {
      throw new Error(`model reply was not JSON: ${excerptForError(body)}`);
    }
    return objects;
  }
}

/** Same envelope-then-fence unwrapping as enrich; grades are validated, not clamped. */
export function parseJudgeReply(stdout: string): Judgement[] {
  let envelope: { result?: string; is_error?: boolean };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`claude -p returned non-JSON: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error || typeof envelope.result !== "string") {
    throw new Error(`claude -p reported an error: ${stdout.slice(0, 200)}`);
  }
  const body = envelope.result.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const parsed = parseBody(body);
  if (!Array.isArray(parsed)) throw new Error("model reply was not a JSON array");
  return parsed.flatMap((raw) => {
    const j = raw as Partial<Judgement>;
    // A grade outside 0-3 means the judge worked to a different scale; drop the
    // row rather than flatten it, so the disagreement stays visible in the count.
    if (!Number.isInteger(j.id) || (j.id as number) <= 0) return [];
    if (![0, 1, 2, 3].includes(j.grade as number)) return [];
    return [{ id: j.id as number, grade: j.grade as Grade, why: String(j.why ?? "") }];
  });
}

export interface Agreement {
  compared: number;
  /** Identical grade. */
  exact: number;
  /** Grades within one step — a 2-vs-3 disagreement barely moves nDCG. */
  withinOne: number;
  /**
   * Agreement on relevance (grade >= 2), which is the only cut Success@k, MRR
   * and recall can see. This is the number that decides whether the judge is
   * usable, not exact-grade agreement.
   */
  relevant: number;
  /** Human said relevant, judge did not. */
  judgeStricter: number;
  /** Judge said relevant, human did not. */
  judgeLooser: number;
}

const RELEVANT = 2;

/**
 * Compare a judge's grades against grades a human already assigned, over the
 * ids they both cover.
 */
export function agreement(human: GoldItem[], judged: Judgement[]): Agreement {
  const byId = new Map(judged.map((j) => [j.id, j.grade]));
  const a: Agreement = {
    compared: 0,
    exact: 0,
    withinOne: 0,
    relevant: 0,
    judgeStricter: 0,
    judgeLooser: 0,
  };
  for (const h of human) {
    const g = byId.get(h.id);
    if (g === undefined) continue;
    a.compared += 1;
    if (g === h.grade) a.exact += 1;
    if (Math.abs(g - h.grade) <= 1) a.withinOne += 1;
    const hr = h.grade >= RELEVANT;
    const jr = g >= RELEVANT;
    if (hr === jr) a.relevant += 1;
    else if (hr) a.judgeStricter += 1;
    else a.judgeLooser += 1;
  }
  return a;
}

export interface JudgedQuery {
  query: string;
  judgements: Judgement[];
  /** Candidates put to the judge, whether or not it returned a grade for each. */
  candidates: number;
  /** Present only in validate mode. */
  agreement?: Agreement;
}

export interface JudgeResult {
  queries: JudgedQuery[];
  batches: number;
  failures: { query: number; batch: number; error: string }[];
  /**
   * Candidates that came back with no grade at all — from a failed batch, or a
   * reply that simply skipped them. They are NOT the same as grade 0: an
   * ungraded candidate is one nobody ruled on, and it drops out of the proposed
   * gold looking exactly like one judged irrelevant. Counted so that silence is
   * visible rather than mistaken for a verdict.
   */
  unjudged: number;
  /** Aggregate agreement across every query, in validate mode. */
  agreement?: Agreement;
}

export interface JudgeOptions {
  /**
   * Score the run against the human grades.
   *
   * This does NOT narrow the batches to the graded items. Doing so was the
   * original mistake: a batch of pre-selected gold is uniformly plausible,
   * while a real batch is mostly marginal, and the judge grades relative to
   * what surrounds it — so the narrow batch measured a calibration the judge
   * never uses. Batches stay production-shaped and only the scoring is
   * restricted to the ids a human ruled on.
   */
  validate: boolean;
  /** Worked examples per grade shown ahead of the task, to fix the scale. */
  anchorsPerGrade: number;
  depth: number;
  batchSize: number;
  model: string;
  /** Cap on queries processed, for a cheap first look. */
  limit: number;
  embed?: Embedder;
  runner?: (prompt: string, model: string) => Promise<string>;
  log?: (msg: string) => void;
}

/**
 * Judge pooled candidates, one query at a time.
 *
 * The existing grade never enters the prompt for a candidate — a judge shown
 * the answer agrees with it. Worked examples are the exception and the point:
 * they are drawn from *other* queries and excluded from scoring, so they fix
 * the scale without revealing any answer being measured.
 */
export async function judgePool(
  client: Client,
  specs: QuerySpec[],
  opts: JudgeOptions,
): Promise<JudgeResult> {
  const log = opts.log ?? (() => {});
  const runner = opts.runner ?? runClaude;
  const chosen = specs.slice(0, opts.limit);
  const pool = await buildPool(client, chosen, opts.depth, { embed: opts.embed });

  // Anchors are picked from the whole set, then their ids are held out of
  // scoring everywhere — an item shown with its grade cannot also be evidence
  // that the judge reproduces it.
  const picked = opts.anchorsPerGrade > 0 ? selectAnchors(specs, opts.anchorsPerGrade) : [];
  const anchorIds = new Set(picked.map((p) => p.item.id));
  const anchors: Anchor[] = [];
  for (const p of picked) {
    const [ev] = await poolEvidence(client, p.query, [p.item.id], { embed: opts.embed });
    anchors.push({
      query: p.query,
      id: p.item.id,
      grade: p.item.grade,
      why: p.item.why,
      evidence: ev ? ev.matches.map((m) => m.text) : [],
    });
  }
  if (anchors.length) log(`calibrating with ${anchors.length} worked example(s)`);

  const result: JudgeResult = { queries: [], batches: 0, failures: [], unjudged: 0 };

  for (const [qi, pq] of pool.queries.entries()) {
    const human = normalizeGold(chosen[qi].gold).filter((h) => !anchorIds.has(h.id));
    // Batches stay production-shaped in every mode. Narrowing them to the
    // graded ids is what made the first validation optimistic.
    const candidates: PoolCandidate[] = pq.candidates.filter((c) => !anchorIds.has(c.id));

    const judgements: Judgement[] = [];
    for (let start = 0; start < candidates.length; start += opts.batchSize) {
      const batch = candidates.slice(start, start + opts.batchSize);
      const batchNo = ++result.batches;
      log(`Q${qi} batch ${batchNo}: ${batch.length} candidate(s)`);

      const evidence = await poolEvidence(
        client,
        pq.query,
        batch.map((c) => c.id),
        { embed: opts.embed },
      );
      const byId = new Map(evidence.map((e) => [e.id, e.matches.map((m) => m.text)]));
      const items = batch.map((c) => ({
        id: c.id,
        title: c.title,
        domain: c.domain,
        evidence: byId.get(c.id) ?? [],
      }));

      try {
        const reply = parseJudgeReply(
          await runner(buildJudgePrompt(pq.query, items, anchors), opts.model),
        );
        const inBatch = new Set(batch.map((b) => b.id));
        // Ignore ids the model invented; a hallucinated grade is worse than a gap.
        judgements.push(...reply.filter((j) => inBatch.has(j.id)));
      } catch (err) {
        // One bad batch must not lose the rest of the run.
        result.failures.push({ query: qi, batch: batchNo, error: (err as Error).message });
        log(`Q${qi} batch ${batchNo} failed: ${(err as Error).message}`);
      }
    }

    const graded = new Set(judgements.map((j) => j.id));
    const missed = candidates.filter((c) => !graded.has(c.id)).length;
    if (missed) {
      result.unjudged += missed;
      log(`Q${qi}: ${missed} candidate(s) came back with no grade`);
    }

    result.queries.push({
      query: pq.query,
      judgements,
      candidates: candidates.length,
      agreement: opts.validate ? agreement(human, judgements) : undefined,
    });
  }

  if (opts.validate) {
    const all = result.queries.map((q) => q.agreement!).filter(Boolean);
    result.agreement = all.reduce(
      (acc, a) => ({
        compared: acc.compared + a.compared,
        exact: acc.exact + a.exact,
        withinOne: acc.withinOne + a.withinOne,
        relevant: acc.relevant + a.relevant,
        judgeStricter: acc.judgeStricter + a.judgeStricter,
        judgeLooser: acc.judgeLooser + a.judgeLooser,
      }),
      { compared: 0, exact: 0, withinOne: 0, relevant: 0, judgeStricter: 0, judgeLooser: 0 },
    );
  }
  return result;
}

/**
 * Render judgements as a query set. Grade 0 is dropped: gold lists what is
 * relevant, and an item judged irrelevant simply is not in it.
 *
 * Gold rebuilt here carries no `group`: a judge grades a (query, item) pair and
 * is never asked whether two URLs are one product. Folding this output straight
 * into `eval/queries.jsonl` would therefore strip every equivalence class —
 * merge through `apply-review.mts`, which keeps them.
 */
export function toQuerySpecs(specs: QuerySpec[], result: JudgeResult): QuerySpec[] {
  return result.queries.map((jq, i) => ({
    query: jq.query,
    gold: jq.judgements
      .filter((j) => j.grade > 0)
      .sort((a, b) => b.grade - a.grade || a.id - b.id)
      .map((j) => ({ id: j.id, grade: j.grade as 1 | 2 | 3, why: j.why || undefined })),
    note: specs[i]?.note,
  }));
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}%` : "–");

export function formatAgreement(result: JudgeResult): string {
  const a = result.agreement;
  if (!a) return "";
  const lines = [
    `judge agreement · ${a.compared} items already graded by hand`,
    `  relevant/not (grade >= 2)   ${a.relevant}/${a.compared}  ${pct(a.relevant, a.compared)}   <- the cut the metrics use`,
    `  exact grade                 ${a.exact}/${a.compared}  ${pct(a.exact, a.compared)}`,
    `  within one grade            ${a.withinOne}/${a.compared}  ${pct(a.withinOne, a.compared)}`,
    `  judge stricter than human   ${a.judgeStricter}`,
    `  judge looser than human     ${a.judgeLooser}`,
  ];
  if (result.failures.length) lines.push(`  ${result.failures.length} batch(es) failed`);
  if (result.unjudged) lines.push(`  ${result.unjudged} candidate(s) came back ungraded`);
  return lines.join("\n");
}
