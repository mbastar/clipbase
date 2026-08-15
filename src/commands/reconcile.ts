import type { Client } from "../db.js";
import { canonicalizeUrl } from "../canonicalize.js";
import { listAllBookmarks, type RaindropBookmark } from "../raindrop.js";

/**
 * Detection, not repair, for the one gap the sync cursor cannot close.
 *
 * `syncRaindrop` pages `-created` and stops at the stored cursor, so a bookmark
 * only becomes visible to it by being *created* after the last run. Triage moves
 * bookmarks between collections, and a move changes `lastUpdate`, not `created`
 * — so an old bookmark filed into a tracked collection today lands behind the
 * cursor and is never reached. Nothing in the sync log says so: the collection
 * reports "0 new", which is exactly what a healthy quiet night reports too.
 *
 * Cursoring on `lastUpdate` would fix it properly, at the cost of re-pulling and
 * re-extracting every edited bookmark — a v1 tradeoff deliberately left alone.
 * This makes the failure visible instead, so the gap is a line in the log rather
 * than a silence.
 */

export interface AbsentBookmark {
  collectionId: number;
  collectionTitle: string;
  raindropId: number;
  link: string;
  title: string | null;
  created: string;
  /** True when the cursor has already passed this bookmark: no future sync reaches it. */
  behindCursor: boolean;
}

export interface UnreachableCollection {
  collectionId: number;
  collectionTitle: string;
  error: string;
}

export interface ReconcileResult {
  collectionsChecked: number;
  remoteTotal: number;
  storedTotal: number;
  absent: AbsentBookmark[];
  /** Bookmarks whose link is not a URL clipbase can hold — sync skips these too. */
  invalid: number;
  unreachable: UnreachableCollection[];
}

interface TrackedCollection {
  id: number;
  title: string;
  cursor: string | null;
}

async function storedUrls(client: Client): Promise<Set<string>> {
  const rs = await client.execute("SELECT url FROM items");
  return new Set(rs.rows.map((r) => String(r.url)));
}

async function trackedCollections(client: Client): Promise<TrackedCollection[]> {
  const rs = await client.execute(
    `SELECT collection_id, collection_title, last_created_cursor FROM sync_state
      ORDER BY collection_title COLLATE NOCASE, collection_id`,
  );
  return rs.rows.map((r) => ({
    id: Number(r.collection_id),
    title: r.collection_title != null ? String(r.collection_title) : String(r.collection_id),
    cursor: r.last_created_cursor != null ? String(r.last_created_cursor) : null,
  }));
}

/**
 * Present means "this page is in the corpus", not "this bookmark id is".
 *
 * Raindrop holds duplicates — the same page saved twice, or once as
 * `m.youtube.com` and once as `youtube.com` — and `items.url` is the canonical
 * form, so diffing raindrop ids reports a phantom gap for every duplicate. On
 * the corpus this was written against that is four false alarms against one real
 * one, and a check that cries wolf four times in five is one the operator stops
 * reading. Returns null when the link is not canonicalizable at all.
 */
function isPresent(link: string, urls: Set<string>): boolean | null {
  try {
    return urls.has(canonicalizeUrl(link).canonical);
  } catch {
    return null;
  }
}

function scanCollection(
  collection: TrackedCollection,
  bookmarks: RaindropBookmark[],
  urls: Set<string>,
): { absent: AbsentBookmark[]; invalid: number } {
  const absent: AbsentBookmark[] = [];
  let invalid = 0;
  for (const bookmark of bookmarks) {
    const present = isPresent(bookmark.link, urls);
    if (present === null) invalid++;
    if (present !== false) continue;
    absent.push({
      collectionId: collection.id,
      collectionTitle: collection.title,
      raindropId: bookmark._id,
      link: bookmark.link,
      title: bookmark.title?.trim() || null,
      created: bookmark.created,
      behindCursor: collection.cursor != null && bookmark.created <= collection.cursor,
    });
  }
  return { absent, invalid };
}

/**
 * Read-only against both sides: lists Raindrop and reads the corpus, writes
 * neither. Safe to run on every scheduled sync, including the ones that ingest
 * nothing — a night with no new bookmarks is exactly when a stranded one hides.
 */
export async function reconcile(client: Client, token: string): Promise<ReconcileResult> {
  const [urls, collections] = await Promise.all([storedUrls(client), trackedCollections(client)]);
  const result: ReconcileResult = {
    collectionsChecked: collections.length,
    remoteTotal: 0,
    storedTotal: urls.size,
    absent: [],
    invalid: 0,
    unreachable: [],
  };

  // Sequentially, for the same reason syncAll is: Raindrop rate-limits.
  for (const collection of collections) {
    let bookmarks: RaindropBookmark[];
    try {
      bookmarks = await listAllBookmarks(token, collection.id);
    } catch (err) {
      // One unreachable collection is a partial check, not a failed one — the
      // other twelve still get audited and say so.
      result.unreachable.push({
        collectionId: collection.id,
        collectionTitle: collection.title,
        error: (err as Error).message,
      });
      continue;
    }
    result.remoteTotal += bookmarks.length;
    const scan = scanCollection(collection, bookmarks, urls);
    result.absent.push(...scan.absent);
    result.invalid += scan.invalid;
  }
  return result;
}

function absentLine(a: AbsentBookmark): string {
  const mark = a.behindCursor ? "stranded" : "pending ";
  return `  ${mark} ${a.created.slice(0, 10)}  ${a.collectionTitle}  ${a.title ?? a.link}\n           ${a.link}`;
}

export function formatReconcile(r: ReconcileResult): string {
  const stranded = r.absent.filter((a) => a.behindCursor);
  const scope = `${r.remoteTotal} bookmark(s) across ${r.collectionsChecked - r.unreachable.length} collection(s)`;
  const lines: string[] = [];

  if (r.absent.length === 0) {
    lines.push(`reconcile: ${scope} — all present`);
  } else {
    lines.push(`reconcile: ${r.absent.length} of ${scope} absent from clipbase, ${stranded.length} stranded behind the cursor`);
    lines.push(...r.absent.map(absentLine));
  }
  if (stranded.length > 0) {
    // "pending" clears itself on the next run; "stranded" never does, so the
    // only line here that asks for a decision is this one.
    lines.push(`  no future sync will reach the stranded item(s) — ingest by hand:`);
    lines.push(...stranded.map((a) => `    clipbase ingest ${a.link}`));
  }
  if (r.invalid > 0) lines.push(`  ${r.invalid} bookmark(s) have links clipbase cannot hold (sync skips these too)`);
  for (const u of r.unreachable) {
    lines.push(`  not checked: "${u.collectionTitle}" (${u.collectionId}) — ${u.error}`);
  }
  return lines.join("\n");
}
