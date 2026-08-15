import type { Client } from "./db.js";
import { nowIso } from "./db.js";
import { ingestUrl, type IngestResult } from "./ingest.js";

const API = "https://api.raindrop.io/rest/v1";
const PER_PAGE = 50;

export interface RaindropBookmark {
  _id: number;
  link: string;
  title?: string;
  created: string;
  lastUpdate: string;
}

async function api<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Raindrop API ${res.status} on ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * A collection reference is either an id or a name. The title comes back
 * `null` for an id, because resolving one costs two API calls and the caller
 * usually has a better name already — `sync_state` remembers it from the run
 * that first used the name. Returning the id as its own title, which is what
 * this used to do, silently overwrote "Learning" with "50403388".
 */
export async function resolveCollection(
  token: string,
  idOrName: string,
): Promise<{ id: number; title: string | null }> {
  if (/^-?\d+$/.test(idOrName)) return { id: Number(idOrName), title: null };
  const [root, children] = await Promise.all([
    api<{ items: { _id: number; title: string }[] }>(token, "/collections"),
    api<{ items: { _id: number; title: string }[] }>(token, "/collections/childrens"),
  ]);
  const all = [...root.items, ...children.items];
  const match = all.find((c) => c.title.toLowerCase() === idOrName.toLowerCase());
  if (!match) {
    const names = all.map((c) => c.title).join(", ");
    throw new Error(`Raindrop collection not found: "${idOrName}" (available: ${names})`);
  }
  return { id: match._id, title: match.title };
}

/**
 * Every bookmark in a collection, cursor ignored.
 *
 * `syncRaindrop` stops paging the moment it reaches the cursor, which is the
 * right call for ingestion and the wrong one for auditing: the bookmarks worth
 * auditing for are precisely the ones sitting behind the cursor where that loop
 * never looks. Reads only — no ingestion, no cursor write.
 */
export async function listAllBookmarks(token: string, id: number): Promise<RaindropBookmark[]> {
  const all: RaindropBookmark[] = [];
  for (let page = 0; ; page++) {
    const res = await api<{ items: RaindropBookmark[] }>(
      token,
      `/raindrops/${id}?sort=-created&perpage=${PER_PAGE}&page=${page}`,
    );
    if (!res.items?.length) break;
    all.push(...res.items);
    if (res.items.length < PER_PAGE) break;
  }
  return all;
}

export interface SyncResult {
  collectionId: number;
  collectionTitle: string;
  scanned: number;
  created: number;
  refreshed: number;
  retried: number;
  extractionFailed: number;
  skippedInvalid: number;
  newCursor: string | null;
}

export interface SyncOptions {
  log?: (msg: string) => void;
  ingest?: typeof ingestUrl;
}

// Sync is new-bookmarks-only: listing is sorted -created and paging stops at
// the stored cursor (max created previously ingested). Idempotency does not
// depend on the cursor — items.raindrop_id and items.url are UNIQUE, so a
// re-run can only refresh, never duplicate.
export async function syncRaindrop(
  client: Client,
  token: string,
  collectionRef: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const { log, ingest = ingestUrl } = opts;
  const { id, title: resolvedTitle } = await resolveCollection(token, collectionRef);

  const stateRow = (
    await client.execute({
      sql: "SELECT last_created_cursor, collection_title FROM sync_state WHERE collection_id = ?",
      args: [id],
    })
  ).rows[0];
  const cursor = stateRow?.last_created_cursor != null ? String(stateRow.last_created_cursor) : null;
  // A name given on the command line is the freshest truth and wins; failing
  // that, the name this collection was first synced under; failing that, the
  // bare id, which is all a never-before-seen numeric ref can offer.
  const storedTitle = stateRow?.collection_title != null ? String(stateRow.collection_title) : null;
  const title = resolvedTitle ?? storedTitle ?? String(id);

  const fresh: RaindropBookmark[] = [];
  for (let page = 0; ; page++) {
    const res = await api<{ items: RaindropBookmark[] }>(
      token,
      `/raindrops/${id}?sort=-created&perpage=${PER_PAGE}&page=${page}`,
    );
    if (!res.items?.length) break;
    let stop = false;
    for (const bookmark of res.items) {
      if (cursor && bookmark.created <= cursor) {
        stop = true;
        break;
      }
      fresh.push(bookmark);
    }
    if (stop || res.items.length < PER_PAGE) break;
  }
  log?.(`collection "${title}" (${id}): ${fresh.length} new bookmark(s) since ${cursor ?? "beginning"}`);

  // Oldest first, so provenance order matches bookmarking order.
  fresh.reverse();

  const counts = { created: 0, refreshed: 0, retried: 0, extractionFailed: 0, skippedInvalid: 0 };
  let maxCreated = cursor;
  for (const bookmark of fresh) {
    let result: IngestResult | null = null;
    try {
      result = await ingest(client, bookmark.link, {
        sourceType: "raindrop",
        raindropId: bookmark._id,
        meta: { title: bookmark.title?.trim() || undefined },
        log,
      });
    } catch (err) {
      counts.skippedInvalid++;
      log?.(`skipping raindrop ${bookmark._id} (${bookmark.link}): ${(err as Error).message}`);
    }
    if (result) {
      // Sync never passes `force`, so it can only ever see these three
      // actions; `replaced` and `kept` belong to operator-driven repair.
      const { action } = result;
      if (action === "created" || action === "refreshed" || action === "retried") {
        counts[action]++;
      }
      if (result.status === "extraction_failed") counts.extractionFailed++;
      log?.(`raindrop ${bookmark._id}: ${result.action} item #${result.id} (${result.status})`);
    }
    if (!maxCreated || bookmark.created > maxCreated) maxCreated = bookmark.created;
  }

  await client.execute({
    sql: `INSERT INTO sync_state (collection_id, collection_title, last_created_cursor, last_synced_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (collection_id) DO UPDATE SET
            collection_title = excluded.collection_title,
            last_created_cursor = excluded.last_created_cursor,
            last_synced_at = excluded.last_synced_at`,
    args: [id, title, maxCreated, nowIso()],
  });

  return {
    collectionId: id,
    collectionTitle: title,
    scanned: fresh.length,
    ...counts,
    newCursor: maxCreated,
  };
}

/** A collection that could not be reached at all — not one that synced badly. */
export interface SyncFailure {
  collectionId: number;
  collectionTitle: string;
  error: string;
}

export interface SyncAllResult {
  synced: SyncResult[];
  failed: SyncFailure[];
  totals: Omit<SyncResult, "collectionId" | "collectionTitle" | "newCursor">;
}

const TOTAL_KEYS = [
  "scanned",
  "created",
  "refreshed",
  "retried",
  "extractionFailed",
  "skippedInvalid",
] as const;

/**
 * Sync every collection already tracked in `sync_state`.
 *
 * `sync_state` *is* the registry, which is why this takes no collection list
 * and reads no config: a row exists there precisely because someone ran
 * `sync-raindrop --collection <name>` once and meant it. Adding a collection
 * stays that one deliberate act, and this command never widens the corpus on
 * its own — it only catches up what was already chosen.
 */
export async function syncAll(
  client: Client,
  token: string,
  opts: SyncOptions = {},
): Promise<SyncAllResult> {
  const rows = (
    await client.execute(
      `SELECT collection_id, collection_title FROM sync_state
       ORDER BY collection_title COLLATE NOCASE, collection_id`,
    )
  ).rows;

  // Silence would look like success on a fresh database, where the honest
  // answer is that nothing has been chosen to sync yet.
  if (rows.length === 0) {
    throw new Error(
      "no collections tracked yet — sync one by name first: " +
        "clipbase sync-raindrop --collection <idOrName>",
    );
  }

  const synced: SyncResult[] = [];
  const failed: SyncFailure[] = [];

  for (const row of rows) {
    const id = Number(row.collection_id);
    const title = row.collection_title != null ? String(row.collection_title) : String(id);
    try {
      // By id, not by name: the stored name may be stale if the collection was
      // renamed in Raindrop, and an id needs no lookup. `syncRaindrop` keeps
      // the stored title when it is handed an id, so this cannot rename a row.
      synced.push(await syncRaindrop(client, token, String(id), opts));
    } catch (err) {
      // One collection's outage must not cost the other twelve their sync.
      // Cursors are per-collection and committed as each finishes, so the ones
      // that ran stay done and a re-run resumes only what failed.
      const message = (err as Error).message;
      failed.push({ collectionId: id, collectionTitle: title, error: message });
      opts.log?.(`collection "${title}" (${id}) failed: ${message}`);
    }
  }

  // Sequentially, deliberately. Raindrop rate-limits, and each bookmark can
  // spawn a defuddle or firecrawl subprocess — thirteen collections in
  // parallel would be a self-inflicted load test on both.
  const totals = Object.fromEntries(
    TOTAL_KEYS.map((key) => [key, synced.reduce((sum, r) => sum + r[key], 0)]),
  ) as SyncAllResult["totals"];

  return { synced, failed, totals };
}
