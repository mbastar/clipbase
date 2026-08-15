import { readFile } from "node:fs/promises";
import type { Client } from "../db.js";
import { embed as defaultEmbed, type Embedder, type EmbedResult } from "../embed.js";
import { searchItems, searchSemantic, searchHybrid, type SearchOpts } from "./search.js";
import {
  assertCollectionIntact,
  assertGoldWithinCollection,
  formatCollection,
  type Collection,
} from "./eval-collection.js";
import {
  aggregate,
  normalizeGold,
  scoreRanking,
  RELEVANT_GRADE,
  type AggregateMetrics,
  type GoldEntry,
  type GoldItem,
  type QueryMetrics,
  type QuerySpec,
} from "../eval.js";

export type Method = "fts" | "semantic" | "hybrid";

export interface QueryResult {
  query: string;
  ranked: number[]; // item ids returned, best-first
  metrics: QueryMetrics;
}

export interface MethodReport {
  method: Method;
  perQuery: QueryResult[];
  aggregate: AggregateMetrics;
}

export interface EvalReport {
  k: number;
  gold: QuerySpec[];
  collection?: Collection; // absent means the run was not pinned, so the numbers are a floor
  methods: MethodReport[];
}

/**
 * Validate one gold entry: either a bare item id (grade 2, "answers the query")
 * or a judged `{id, grade, why?}`. Grades outside 1–3 are rejected not clamped —
 * a stray 5 means the judge was working to a different scale than the metric,
 * and silently flattening it would hide that.
 */
function parseGoldEntry(entry: unknown, where: string): GoldEntry {
  if (Number.isInteger(entry)) {
    if ((entry as number) <= 0) throw new Error(`${where}: "gold" ids must be positive integers`);
    return entry as number;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${where}: "gold" entries must be an item id or {id, grade}`);
  }
  const g = entry as Partial<GoldItem>;
  if (!Number.isInteger(g.id) || (g.id as number) <= 0) {
    throw new Error(`${where}: "gold" ids must be positive integers`);
  }
  if (g.grade !== 1 && g.grade !== 2 && g.grade !== 3) {
    throw new Error(`${where}: gold id ${g.id} has grade ${JSON.stringify(g.grade)}, expected 1, 2 or 3`);
  }
  if (g.group !== undefined && (typeof g.group !== "string" || !g.group.trim())) {
    throw new Error(`${where}: gold id ${g.id} has group ${JSON.stringify(g.group)}, expected a product slug`);
  }
  // Ungrouped items get the synthetic key `#<id>`, so a label starting `#` can
  // absorb another item's solo group and drop it out of both the recall
  // denominator and the ideal — scored as found without ever being returned.
  if (typeof g.group === "string" && g.group.trim().startsWith("#")) {
    throw new Error(
      `${where}: gold id ${g.id} has group ${JSON.stringify(g.group)}; "#" is reserved for ` +
        `the key an ungrouped item gets, so a label cannot start with it`,
    );
  }
  // Normalized on the way in: " openviking" and "openviking" are one product,
  // and storing them apart splits the group with nothing to see in the diff.
  // `group` is attached only when declared. An own key holding `undefined` is
  // not the same object under `assert.deepStrictEqual`, which the tests use.
  const group = typeof g.group === "string" ? g.group.trim() : undefined;
  return { id: g.id as number, grade: g.grade, why: g.why, ...(group ? { group } : {}) };
}

/**
 * A group is a claim about the items, so it holds in every query they appear
 * in. Labelling 93 in one query and forgetting it in the next quietly un-groups
 * the pair there — the same cheap, invisible-afterwards typo the duplicate-id
 * check guards against, one query apart.
 */
function assertGroupsConsistent(specs: QuerySpec[]): void {
  const label = (group?: string) => (group === undefined ? "ungrouped" : JSON.stringify(group));
  const seen = new Map<number, { group?: string; at: number }>();
  specs.forEach((spec, at) => {
    for (const g of normalizeGold(spec.gold)) {
      const prior = seen.get(g.id);
      if (prior === undefined) {
        seen.set(g.id, { group: g.group, at });
      } else if (prior.group !== g.group) {
        throw new Error(
          `gold id ${g.id} is ${label(g.group)} in Q${at} but ${label(prior.group)} in Q${prior.at}`,
        );
      }
    }
  });
}

/**
 * Parse a JSONL query set: one `{query, gold, note?}` object per line. Blank
 * lines are skipped so the file can be spaced for reading. Every spec is
 * validated up front — a typo'd gold id is a silent way to make a method look
 * worse than it is, so a bad line fails loudly with its number.
 */
export function parseQuerySpecs(text: string): QuerySpec[] {
  const specs: QuerySpec[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const where = `line ${i + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const spec = parsed as Partial<QuerySpec>;
    if (typeof spec.query !== "string" || !spec.query.trim()) {
      throw new Error(`${where}: "query" must be a non-empty string`);
    }
    if (!Array.isArray(spec.gold) || spec.gold.length === 0) {
      throw new Error(`${where}: "gold" must be a non-empty array of item ids`);
    }
    const gold = spec.gold.map((entry) => parseGoldEntry(entry, where));

    // A repeated id inflates the recall denominator and the ideal ranking, so
    // the query quietly becomes unwinnable. Cheap to typo, invisible afterwards.
    const ids = gold.map((g) => (typeof g === "number" ? g : g.id));
    const dupe = ids.find((id, at) => ids.indexOf(id) !== at);
    if (dupe !== undefined) throw new Error(`${where}: gold id ${dupe} listed twice`);

    // A query judged entirely at grade 1 has no answer to find, so Success@k,
    // MRR and recall score 0 however well a method ranks — it silently drags the
    // averages down instead of measuring anything.
    if (!normalizeGold(gold).some((g) => g.grade >= RELEVANT_GRADE)) {
      throw new Error(`${where}: every gold item is grade 1, so no result can answer this query`);
    }

    specs.push({ query: spec.query, gold, note: spec.note });
  }
  if (!specs.length) throw new Error("query set is empty");
  assertGroupsConsistent(specs);
  return specs;
}

export async function loadQuerySpecs(path: string): Promise<QuerySpec[]> {
  return parseQuerySpecs(await readFile(path, "utf8"));
}

async function scoreMethod(
  method: Method,
  specs: QuerySpec[],
  k: number,
  rank: (query: string) => Promise<number[]>,
): Promise<MethodReport> {
  const perQuery: QueryResult[] = [];
  for (const spec of specs) {
    const ranked = await rank(spec.query);
    perQuery.push({ query: spec.query, ranked, metrics: scoreRanking(ranked, spec.gold, k) });
  }
  return { method, perQuery, aggregate: aggregate(perQuery.map((r) => r.metrics)) };
}

/**
 * Cache embeddings for the run. Semantic and hybrid embed the same query text,
 * so without this a run costs two identical API calls per query — and, worse,
 * gives the two methods two chances to be measured against different vectors.
 * The promise is cached rather than the result, so concurrent callers share one
 * request instead of racing to make two.
 */
function memoizeEmbedder(embed: Embedder): Embedder {
  const cache = new Map<string, Promise<EmbedResult>>();
  return (texts, kind) => {
    const key = `${kind}\0${JSON.stringify(texts)}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = embed(texts, kind);
      cache.set(key, pending);
    }
    return pending;
  };
}

/**
 * Run every retrieval method over the same query set and the same corpus. All
 * read through the one client and share one query embedding, so the methods are
 * measured against identical rows and identical vectors — the point is a fair
 * comparison, not three different databases.
 */
export async function runEval(
  client: Client,
  specs: QuerySpec[],
  k: number,
  opts: { embed?: Embedder; collection?: Collection } = {},
): Promise<EvalReport> {
  const embed = memoizeEmbedder(opts.embed ?? defaultEmbed);
  const ids = (hits: { id: number }[]) => hits.map((h) => h.id);
  const { collection } = opts;
  if (collection) {
    assertGoldWithinCollection(specs, collection);
    await assertCollectionIntact(client, collection);
  }
  // One options bag for all three, so no method is measured over a different
  // collection than the others.
  const search: SearchOpts = { embed, maxItemId: collection?.maxItemId };

  const fts = await scoreMethod("fts", specs, k, (q) => searchItems(client, q, k, search).then(ids));
  const semantic = await scoreMethod("semantic", specs, k, (q) =>
    searchSemantic(client, q, k, search).then(ids),
  );
  const hybrid = await scoreMethod("hybrid", specs, k, (q) =>
    searchHybrid(client, q, k, search).then(ids),
  );
  return { k, gold: specs, collection, methods: [fts, semantic, hybrid] };
}

// --- human-readable rendering -------------------------------------------------

const pct = (x: number) => x.toFixed(3);

const LABELS: Record<Method, string> = { fts: "FTS", semantic: "semantic", hybrid: "hybrid" };

function metricRow(label: string, pick: (a: AggregateMetrics) => number, reports: MethodReport[]): string {
  const cols = reports.map((r) => pct(pick(r.aggregate)).padStart(9)).join("");
  return `  ${label.padEnd(12)}${cols}`;
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`retrieval eval · ${report.gold.length} queries · k=${report.k}`);
  lines.push(formatCollection(report.collection));
  lines.push(
    `  ${"".padEnd(12)}${report.methods.map((m) => LABELS[m.method].padStart(9)).join("")}`,
  );
  lines.push(metricRow("Success@1", (a) => a.success1, report.methods));
  lines.push(metricRow("Success@5", (a) => a.success5, report.methods));
  lines.push(metricRow("MRR", (a) => a.mrr, report.methods));
  lines.push(metricRow("Recall", (a) => a.recall, report.methods));
  lines.push(metricRow("nDCG", (a) => a.ndcg, report.methods));
  lines.push("");

  // Per-query rank of the first item that *answers* the query (grade 2+), so the
  // queries where the methods disagree — the case fusion has to earn — are
  // visible at a glance. "–" means no answer landed in the top k; a grade-1 hit
  // there still reads as "–", which is the point.
  lines.push(`  first gold rank (${report.methods.map((m) => LABELS[m.method]).join(" / ")}):`);
  const rank = (r: QueryResult) => (r.metrics.firstGoldRank ?? "–").toString().padStart(2);
  report.gold.forEach((spec, i) => {
    const ranks = report.methods.map((m) => rank(m.perQuery[i])).join(" / ");
    const q = spec.query.length > 58 ? `${spec.query.slice(0, 57)}…` : spec.query;
    lines.push(`   ${ranks}   ${q}`);
  });
  return lines.join("\n");
}
