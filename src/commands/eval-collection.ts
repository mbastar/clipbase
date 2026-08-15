// The collection a gold set was judged over, and the checks that keep the two
// from drifting apart. Gold is only true to the depth actually judged: an item
// the pool never reached is graded 0 by omission, and it does not merely score
// zero — it takes a rank slot from a real answer, so a run over a larger corpus
// than the pool reports a floor, understated most for the method best at
// surfacing recent items. Pinning the run to the judged ids is what makes a
// number quotable.
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Client } from "../db.js";
import { normalizeGold, type QuerySpec } from "../eval.js";

export interface Collection {
  maxItemId: number; // the pool's high-water mark; ids above it were never judged
  /**
   * When the pool was built, used only to verify `maxItemId` — never to filter
   * on. Absent when a human named the ceiling on the command line, which is a
   * claim about the corpus rather than a record of a pool, so the id-reuse check
   * has nothing to check against and is skipped.
   */
  pooledAt?: string;
  source: string; // the file or flag it came from, for the report line and errors
}

/**
 * The pin lives beside its query set under a derived name, so a set and the
 * collection it was judged over travel together. Deliberately not a header line
 * in the JSONL: five `.mts` scripts hand-parse that file and index queries by
 * array position, so a header would shift every Q<n> by one.
 */
export function collectionPathFor(queriesPath: string): string {
  const stem = basename(queriesPath, extname(queriesPath));
  return join(dirname(queriesPath), `${stem}.collection.json`);
}

export function parseCollection(text: string, source: string): Collection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${source}: not valid JSON`);
  }
  const c = parsed as Partial<Collection>;
  if (!Number.isInteger(c.maxItemId) || (c.maxItemId as number) <= 0) {
    throw new Error(`${source}: "maxItemId" must be a positive integer — the pool's highest item id`);
  }
  if (typeof c.pooledAt !== "string" || !c.pooledAt.trim()) {
    throw new Error(`${source}: "pooledAt" must be an ISO timestamp saying when the pool was built`);
  }
  // The id-reuse check compares `pooledAt` against `created_at` as TEXT in
  // SQLite, so a non-ISO date is not a loose format — it is silently always
  // false. "2026-08-04T00:13:28Z" > "29 July 2026" is 0, and the run then
  // reports a pinned collection whose only integrity check is off. Parse it
  // here, and store the normalized form so the comparison is lexicographic.
  const pooledAtMs = Date.parse(c.pooledAt);
  if (!Number.isFinite(pooledAtMs)) {
    throw new Error(
      `${source}: "pooledAt" is ${JSON.stringify(c.pooledAt)}, which is not a date. It is compared ` +
        `against created_at as text, so a non-ISO value disables the id-reuse check instead of ` +
        `loosening it. Use an ISO 8601 timestamp.`,
    );
  }
  return { maxItemId: c.maxItemId as number, pooledAt: new Date(pooledAtMs).toISOString(), source };
}

/**
 * A missing pin is a hard failure rather than "no ceiling". Defaulting to the
 * whole corpus reproduces the understated numbers with nothing on screen to say
 * so, and those are the numbers that get quoted; a scratch query set costs one
 * flag instead.
 */
export async function loadCollection(queriesPath: string): Promise<Collection> {
  const path = collectionPathFor(queriesPath);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `${path} is missing: a query set has to say which collection its gold was judged over. ` +
        `Write it, or pass --collection all to score the whole corpus and read the result as a floor.`,
    );
  }
  return parseCollection(text, path);
}

export async function resolveCollection(
  queriesPath: string,
  override?: string,
): Promise<Collection | undefined> {
  if (override === undefined) return loadCollection(queriesPath);
  if (override === "all") return undefined;
  const maxItemId = Number(override);
  if (!Number.isInteger(maxItemId) || maxItemId <= 0) {
    throw new Error(`--collection expects a positive item id or "all", got ${JSON.stringify(override)}`);
  }
  return { maxItemId, source: `--collection ${maxItemId}` };
}

/**
 * Gold above the ceiling means the file and its pin contradict each other. The
 * unreachable ids would sit in the recall denominator and nothing could ever
 * return them, deflating recall with no symptom to trace.
 */
export function assertGoldWithinCollection(specs: QuerySpec[], collection: Collection): void {
  specs.forEach((spec, i) => {
    for (const g of normalizeGold(spec.gold)) {
      if (g.id > collection.maxItemId) {
        throw new Error(
          `Q${i}: gold id ${g.id} is above the collection ceiling ${collection.maxItemId} ` +
            `(${collection.source}), so no run over that collection can return it`,
        );
      }
    }
  });
}

/**
 * `items.id` is a rowid alias with no AUTOINCREMENT, so SQLite reuses the
 * highest id after that row is deleted — and `recanonicalize --apply` deletes
 * item rows. A never-pooled item can therefore slip under the ceiling wearing a
 * judged item's number, be graded 0 by omission, and have the pin claim it was
 * judged. `created_at` is set once at INSERT and re-ingest does not move it, so
 * a row under the ceiling that postdates pooling has no legitimate cause.
 */
export async function assertCollectionIntact(client: Client, collection: Collection): Promise<void> {
  if (!collection.pooledAt) return;
  const rs = await client.execute({
    sql: `SELECT id FROM items WHERE id <= ?1 AND created_at > ?2 ORDER BY id`,
    args: [collection.maxItemId, collection.pooledAt],
  });
  if (!rs.rows.length) return;
  const ids = rs.rows.map((r) => Number(r.id));
  throw new Error(
    `${collection.source}: item(s) ${ids.slice(0, 10).join(", ")} sit under the ceiling ` +
      `${collection.maxItemId} but were created after ${collection.pooledAt}. An id was reused ` +
      `after a delete, so the pin no longer describes what was judged — re-pool instead.`,
  );
}

/**
 * Printed under the report header so a number cannot be copied out without the
 * collection it was measured over. That coupling is the point: the unpinned line
 * says the numbers are a floor, in the same place the numbers are.
 */
export function formatCollection(collection?: Collection): string {
  if (!collection) {
    return "  collection · whole corpus — UNPINNED: unjudged hits score 0, every number below is a floor";
  }
  const pooled = collection.pooledAt ? ` (pooled ${collection.pooledAt.slice(0, 10)})` : "";
  return `  collection · items 1–${collection.maxItemId} · ${collection.source}${pooled}`;
}
