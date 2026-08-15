import type { Client } from "../db.js";
import { embed as defaultEmbed, EMBEDDING_MODEL, type Embedder } from "../embed.js";
import { searchItems, searchSemantic } from "./search.js";
import { normalizeGold, type QuerySpec } from "../eval.js";

/**
 * Depth each ranker is drawn to when building the candidate universe. Matches
 * CANDIDATE_DEPTH in search.ts on purpose: hybrid fuses the two lists with RRF
 * and never invents a candidate, so FTS@50 ∪ semantic@50 is exactly what hybrid
 * is able to rank. Judging deeper than the rankers can reach buys nothing.
 */
export const POOL_DEPTH = 50;

export type PoolSource = "fts" | "semantic" | "gold";

export interface PoolCandidate {
  id: number;
  title: string | null;
  domain: string | null;
  /** 1-based rank in each list, absent when that ranker did not return it. */
  ftsRank?: number;
  semanticRank?: number;
  /** Existing judgement, if this id is already in the query's gold. */
  grade?: 1 | 2 | 3;
  /**
   * True when the item is only here because it was already judged — neither
   * ranker reached it at POOL_DEPTH, so no method can retrieve it. These are
   * the corpus's recall ceiling, and they are the reason the pool unions gold
   * rather than trusting the rankers to re-surface what was already paid for.
   */
  unreachable: boolean;
}

export interface PoolQuery {
  query: string;
  candidates: PoolCandidate[];
  ftsCount: number;
  semanticCount: number;
  /** Already-judged ids, and how many of them the rankers failed to reach. */
  goldCount: number;
  unreachableCount: number;
}

export interface PoolReport {
  depth: number;
  queries: PoolQuery[];
}

/**
 * Build the judging pool for one query: the union of both rankers at `depth`,
 * plus every id already judged for it.
 *
 * Unioning the existing gold is not redundancy. Gold was pooled against a
 * smaller corpus, and items added since push older ones past the depth cut — a
 * re-pool that trusted the rankers alone would silently drop judgements that
 * are still correct, and quietly shrink the recall denominator with them.
 */
async function poolQuery(
  client: Client,
  spec: QuerySpec,
  depth: number,
  embed: Embedder,
): Promise<PoolQuery> {
  const [fts, semantic] = await Promise.all([
    searchItems(client, spec.query, depth),
    searchSemantic(client, spec.query, depth, { embed }),
  ]);

  const byId = new Map<number, PoolCandidate>();
  const upsert = (id: number, title: string | null, domain: string | null) => {
    let c = byId.get(id);
    if (!c) {
      c = { id, title, domain, unreachable: false };
      byId.set(id, c);
    }
    return c;
  };

  fts.forEach((h, i) => {
    upsert(h.id, h.title, h.domain).ftsRank = i + 1;
  });
  semantic.forEach((h, i) => {
    upsert(h.id, h.title, h.domain).semanticRank = i + 1;
  });

  const graded = normalizeGold(spec.gold);
  for (const g of graded) {
    const c = byId.get(g.id);
    if (c) {
      c.grade = g.grade;
    } else {
      // Judged but unreachable. Title is filled in by the caller's metadata
      // pass — the rankers never returned a row for it.
      byId.set(g.id, { id: g.id, title: null, domain: null, grade: g.grade, unreachable: true });
    }
  }

  // Best rank first, so triage starts where the rankers are most confident.
  // Unreachable gold sorts last: it has no rank to be confident about.
  const best = (c: PoolCandidate) =>
    Math.min(c.ftsRank ?? Number.MAX_SAFE_INTEGER, c.semanticRank ?? Number.MAX_SAFE_INTEGER);
  const candidates = [...byId.values()].sort((a, b) => best(a) - best(b) || a.id - b.id);

  return {
    query: spec.query,
    candidates,
    ftsCount: fts.length,
    semanticCount: semantic.length,
    goldCount: graded.length,
    unreachableCount: candidates.filter((c) => c.unreachable).length,
  };
}

/** Fill in title/domain for unreachable gold, which arrived without a search row. */
async function hydrate(client: Client, report: PoolReport): Promise<void> {
  const missing = new Set<number>();
  for (const q of report.queries) {
    for (const c of q.candidates) if (c.title === null && c.domain === null) missing.add(c.id);
  }
  if (!missing.size) return;
  const ids = [...missing];
  const rs = await client.execute({
    sql: `SELECT id, title, domain FROM items WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  });
  const meta = new Map(
    rs.rows.map((r) => [
      Number(r.id),
      {
        title: r.title != null ? String(r.title) : null,
        domain: r.domain != null ? String(r.domain) : null,
      },
    ]),
  );
  for (const q of report.queries) {
    for (const c of q.candidates) {
      const m = meta.get(c.id);
      if (m && c.title === null && c.domain === null) {
        c.title = m.title;
        c.domain = m.domain;
      }
    }
  }
}

/**
 * Build the pool for every query in the set. Read-only: this produces the
 * candidate list a judge works through, and writes nothing back.
 */
export async function buildPool(
  client: Client,
  specs: QuerySpec[],
  depth = POOL_DEPTH,
  opts: { embed?: Embedder } = {},
): Promise<PoolReport> {
  const embed = opts.embed ?? defaultEmbed;
  const queries: PoolQuery[] = [];
  for (const spec of specs) {
    queries.push(await poolQuery(client, spec, depth, embed));
  }
  const report: PoolReport = { depth, queries };
  await hydrate(client, report);
  return report;
}

export interface PoolEvidence {
  id: number;
  wordCount: number;
  /** Chunks nearest the query — what the judgement actually rests on. */
  matches: { similarity: number; text: string }[];
}

/**
 * The passages a query actually matches, for the ids a judge is ruling on.
 *
 * Judging from titles is the failure this repo already corrected once: a title
 * says what a page is called, not whether it answers the question. The head of
 * a document is barely better — a GitHub README opens with badges. So evidence
 * is the nearest chunks, not the opening ones.
 */
export async function poolEvidence(
  client: Client,
  query: string,
  ids: number[],
  opts: { embed?: Embedder; perItem?: number; chars?: number } = {},
): Promise<PoolEvidence[]> {
  if (!ids.length) return [];
  const embed = opts.embed ?? defaultEmbed;
  const perItem = opts.perItem ?? 2;
  const chars = opts.chars ?? 420;
  const { vectors } = await embed([query], "query");
  const vector = JSON.stringify(vectors[0]);

  const out: PoolEvidence[] = [];
  for (const id of ids) {
    const meta = await client.execute({
      sql: `SELECT coalesce(c.word_count, 0) AS wc
            FROM items i LEFT JOIN item_content c ON c.item_id = i.id
            WHERE i.id = ?`,
      args: [id],
    });
    if (!meta.rows.length) continue;
    const chunks = await client.execute({
      sql: `SELECT substr(content, 1, ?4) AS c,
                   round(1 - vector_distance_cos(embedding, vector32(?1)), 3) AS sim
            FROM chunks
            WHERE item_id = ?2 AND embedding_model = ?3 AND embedding IS NOT NULL
            ORDER BY vector_distance_cos(embedding, vector32(?1))
            LIMIT ?5`,
      args: [vector, id, EMBEDDING_MODEL, chars, perItem],
    });
    out.push({
      id,
      wordCount: Number(meta.rows[0].wc),
      matches: chunks.rows.map((r) => ({
        similarity: Number(r.sim),
        text: String(r.c).replace(/\s+/g, " ").trim(),
      })),
    });
  }
  return out;
}

// --- human-readable rendering -------------------------------------------------

const rank = (n?: number) => (n ?? "-").toString().padStart(2);

export function formatPool(report: PoolReport): string {
  const lines: string[] = [];
  const total = report.queries.reduce((n, q) => n + q.candidates.length, 0);
  const unreachable = report.queries.reduce((n, q) => n + q.unreachableCount, 0);
  const judged = report.queries.reduce(
    (n, q) => n + q.candidates.filter((c) => c.grade !== undefined).length,
    0,
  );
  lines.push(
    `judging pool · ${report.queries.length} queries · depth=${report.depth} · ` +
      `${total} candidates, ${judged} already judged, ${total - judged} to judge`,
  );
  if (unreachable) {
    lines.push(
      `  ${unreachable} judged item(s) sit outside both rankers at this depth — no method can retrieve them`,
    );
  }

  report.queries.forEach((q, i) => {
    lines.push("");
    lines.push(`### Q${i} ${q.query}`);
    lines.push(
      `# pooled ${q.candidates.length} (fts ${q.ftsCount} + semantic ${q.semanticCount}` +
        `, gold ${q.goldCount}, unreachable ${q.unreachableCount})`,
    );
    for (const c of q.candidates) {
      // A judged candidate shows its grade; an unjudged one shows a dot, so the
      // work remaining is scannable down one column.
      const mark = c.unreachable ? "!" : c.grade !== undefined ? String(c.grade) : "·";
      lines.push(
        `${String(c.id).padStart(4)} ${mark} f${rank(c.ftsRank)} s${rank(c.semanticRank)} ` +
          `${(c.domain ?? "-").slice(0, 22).padEnd(22)} ${(c.title ?? "-").slice(0, 100)}`,
      );
    }
  });
  return lines.join("\n");
}

export function formatEvidence(query: string, evidence: PoolEvidence[]): string {
  const lines: string[] = [`### ${query}`];
  for (const e of evidence) {
    lines.push("");
    lines.push(`--- ${e.id} [${e.wordCount}w]`);
    if (!e.matches.length) lines.push("(no embedded chunks)");
    for (const m of e.matches) lines.push(`MATCH(${m.similarity}) ${m.text}`);
  }
  return lines.join("\n");
}
