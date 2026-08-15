import type { Client } from "../db.js";
import { escapeFtsQuery } from "../fts.js";
import { embed as defaultEmbed, EMBEDDING_MODEL, type Embedder } from "../embed.js";
import { rrfFuse } from "../rank.js";

export interface SearchHit {
  id: number;
  title: string | null;
  url: string | null;
  domain: string | null;
  source_type: string;
  summary: string | null;
  topics: string[];
  score: number;
  snippet: string;
}

// Correlated subqueries rather than joins: a join to item_topics is 1:many and
// would need a GROUP BY, which does not sit well with the FTS query's bm25()
// and snippet() aux functions or its ORDER BY rank. These run once per returned
// row instead, which is bounded by `limit`.
const ANNOTATIONS_SQL = `(SELECT summary FROM item_annotations WHERE item_id = i.id) AS summary,
                 (SELECT group_concat(t.name, char(31)) FROM topics t
                    JOIN item_topics it ON it.topic_id = t.id
                   WHERE it.item_id = i.id) AS topics`;

/**
 * group_concat returns one joined string, or NULL when an item has no topics.
 * The separator is US (char 31) rather than a comma because nothing stops a
 * topic name from containing one, and a comma would split it into two topics.
 */
const TOPIC_SEPARATOR = "\u001f";

function toTopics(value: unknown): string[] {
  if (value == null) return [];
  return String(value).split(TOPIC_SEPARATOR).filter(Boolean).sort();
}

/**
 * `maxItemId` searches only the items at or below an id, and exists for the
 * eval: gold was judged over a pool that ends at one item, so anything above it
 * is unjudged and scores 0 by omission while still occupying a rank slot. It is
 * a SQL predicate rather than a filter on the returned hits because filtering
 * afterwards shortens the list below `limit` — and shortens it most for the
 * method best at surfacing recent items, which flips the bias instead of
 * removing it. Inside `WHERE`, `LIMIT` still returns `limit` eligible rows.
 */
export interface SearchOpts {
  embed?: Embedder;
  maxItemId?: number;
}

export async function searchItems(
  client: Client,
  query: string,
  limit: number,
  opts: SearchOpts = {},
): Promise<SearchHit[]> {
  const match = escapeFtsQuery(query);
  if (!match) throw new Error("empty search query");
  const rs = await client.execute({
    sql: `SELECT i.id, i.title, i.url, i.domain, i.source_type,
                 ${ANNOTATIONS_SQL},
                 round(bm25(items_fts), 4) AS score,
                 snippet(items_fts, 1, '>>>', '<<<', ' … ', 14) AS snip
          FROM items_fts
          JOIN items i ON i.id = items_fts.rowid
          WHERE items_fts MATCH ?1 AND (?2 IS NULL OR i.id <= ?2)
          ORDER BY rank
          LIMIT ?3`,
    args: [match, opts.maxItemId ?? null, limit],
  });
  return rs.rows.map((r) => ({
    id: Number(r.id),
    title: r.title != null ? String(r.title) : null,
    url: r.url != null ? String(r.url) : null,
    domain: r.domain != null ? String(r.domain) : null,
    source_type: String(r.source_type),
    summary: r.summary != null ? String(r.summary) : null,
    topics: toTopics(r.topics),
    score: Number(r.score),
    snippet: String(r.snip),
  }));
}

/** One line of the matching passage, so a hit shows why it matched. */
function excerpt(content: string, chars = 240): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars)} …`;
}

export async function searchSemantic(
  client: Client,
  query: string,
  limit: number,
  opts: SearchOpts = {},
): Promise<SearchHit[]> {
  if (!query.trim()) throw new Error("empty search query");
  const embed = opts.embed ?? defaultEmbed;
  const { vectors } = await embed([query], "query");
  const vector = JSON.stringify(vectors[0]);

  // An exact scan, deliberately: it beat the ANN index on this corpus for both
  // speed and recall (see migrations/0004). Reads run against a local embedded
  // replica, where scanning every embedding costs ~10ms.
  //
  // Over-fetch, because several chunks of one item can all rank highly and
  // collapsing to items afterwards would otherwise return fewer than `limit`.
  const rs = await client.execute({
    sql: `SELECT c.item_id, c.content, i.title, i.url, i.domain, i.source_type,
                 ${ANNOTATIONS_SQL},
                 vector_distance_cos(c.embedding, vector32(?1)) AS distance
          FROM chunks c
          JOIN items i ON i.id = c.item_id
          WHERE c.embedding_model = ?2 AND c.embedding IS NOT NULL
            AND (?4 IS NULL OR c.item_id <= ?4)
          ORDER BY distance
          LIMIT ?3`,
    args: [vector, EMBEDDING_MODEL, limit * 4, opts.maxItemId ?? null],
  });

  const seen = new Set<number>();
  const hits: SearchHit[] = [];
  for (const r of rs.rows) {
    const id = Number(r.item_id);
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({
      id,
      title: r.title != null ? String(r.title) : null,
      url: r.url != null ? String(r.url) : null,
      domain: r.domain != null ? String(r.domain) : null,
      source_type: String(r.source_type),
      summary: r.summary != null ? String(r.summary) : null,
      topics: toTopics(r.topics),
      // Similarity reads better than distance, and matches FTS where higher is
      // a better hit rather than the reverse.
      score: Number((1 - Number(r.distance)).toFixed(4)),
      snippet: excerpt(String(r.content)),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

// How deep to read each method before fusing. Fusing only the top `limit` of
// each throws away the reason to fuse at all: an item FTS ranks 14th and
// semantic ranks 3rd should surface, and it cannot if neither list was read past
// 10. The eval measured FTS recall@10 at 0.64 and semantic at 0.83, so the
// misses are real and sit just below the cut. 50 is deep enough to reach them
// and still one local scan — reads run against the embedded replica, where the
// extra rows cost single-digit milliseconds.
const CANDIDATE_DEPTH = 50;

/**
 * Rank by both methods and fuse the two rankings (RRF). Costs the same one
 * query embedding as `searchSemantic`; the FTS side is local and free.
 */
export async function searchHybrid(
  client: Client,
  query: string,
  limit: number,
  opts: SearchOpts = {},
): Promise<SearchHit[]> {
  const depth = Math.max(limit, CANDIDATE_DEPTH);
  // Both legs take the ceiling, and they have to: RRF scores a position in each
  // input list, so an ineligible item above an eligible one shifts that item's
  // rank — by different amounts in the two lists — and changes the fused order.
  // Dropping ineligible items after fusion cannot reproduce that, and it also
  // spends fusion depth on candidates that were never going to count.
  const [fts, semantic] = await Promise.all([
    searchItems(client, query, depth, opts),
    searchSemantic(client, query, depth, opts),
  ]);

  // Both methods return the same item metadata, so either row will do — but
  // prefer the FTS snippet, which marks the matched terms and so says why the
  // item is a hit, over a leading chunk excerpt that only says what it starts
  // with. Semantic first, FTS overwrites.
  const byId = new Map<number, SearchHit>();
  for (const hit of semantic) byId.set(hit.id, hit);
  for (const hit of fts) byId.set(hit.id, hit);

  return rrfFuse([fts.map((h) => h.id), semantic.map((h) => h.id)])
    .slice(0, limit)
    .map((fused) => ({
      ...(byId.get(fused.id) as SearchHit),
      // RRF scores live around 0.016–0.033 — a different scale from bm25 or
      // cosine, and not comparable across methods. 6dp keeps them distinguishable
      // at that magnitude, where the 4dp the other methods use would not.
      score: Number(fused.score.toFixed(6)),
    }));
}
