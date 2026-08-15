import type { Client } from "../db.js";

/**
 * How far behind the last sync the corpus may fall before a read command says
 * so unprompted.
 *
 * The failure this exists to stop is not a stale corpus — it is a *silently*
 * stale one. An agent asked "is there a tool for X" answers confidently from
 * whatever is stored, and a miss caused by an un-synced week is indistinguishable
 * from a subject the corpus genuinely does not cover. Fourteen days is one
 * missed weekly sync plus slack, so a routine that ran on time never nags.
 */
export const STALE_AFTER_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export interface CorpusAge {
  lastSyncedAt: string | null;
  ageDays: number | null;
  isStale: boolean;
}

export interface CollectionSync {
  collectionId: number;
  title: string | null;
  lastSyncedAt: string | null;
  ageDays: number | null;
}

export interface CorpusStatus {
  items: { total: number; ok: number; extractionFailed: number; withContent: number };
  chunks: { total: number; embedded: number; pendingEmbed: number };
  annotations: { withSummary: number; withTopics: number; missingTopics: number };
  sync: {
    collectionsTracked: number;
    age: CorpusAge;
    stalest: CollectionSync | null;
    collections: CollectionSync[];
  };
  newestItemAt: string | null;
}

function ageDaysFrom(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / MS_PER_DAY));
}

function num(value: unknown): number {
  return value == null ? 0 : Number(value);
}

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

/**
 * The cheap half of `status`, for read commands that only need to know whether
 * to warn. One aggregate over a table with one row per tracked collection, so
 * it is affordable on every search.
 *
 * Uses max(): "when did any catch-up last run". A collection that was
 * unreachable on the last pass shows up as an outlier in `stalest` rather than
 * dragging the headline number down, because one unreachable collection does
 * not make the whole corpus stale.
 */
export async function getCorpusAge(client: Client, now = new Date()): Promise<CorpusAge> {
  const rs = await client.execute("SELECT max(last_synced_at) AS last FROM sync_state");
  const lastSyncedAt = str(rs.rows[0]?.last);
  const ageDays = ageDaysFrom(lastSyncedAt, now);
  return { lastSyncedAt, ageDays, isStale: ageDays != null && ageDays >= STALE_AFTER_DAYS };
}

/**
 * The line a read command prints when the corpus is stale, or null when it is
 * not. Returned rather than printed so the threshold logic is testable without
 * capturing stderr.
 */
export function formatStaleBanner(age: CorpusAge): string | null {
  if (!age.isStale) return null;
  return (
    `warning: clipbase corpus is ${age.ageDays} days stale ` +
    `(last sync ${age.lastSyncedAt}). Run clipbase-sync. ` +
    `Anything saved since is missing, so a miss here is not evidence of absence.`
  );
}

async function readItems(client: Client): Promise<CorpusStatus["items"]> {
  const rs = await client.execute(`
    SELECT count(*) AS total,
           sum(status = 'ok') AS ok,
           sum(status = 'extraction_failed') AS failed,
           (SELECT count(*) FROM item_content) AS with_content
      FROM items`);
  const r = rs.rows[0];
  return {
    total: num(r?.total),
    ok: num(r?.ok),
    extractionFailed: num(r?.failed),
    withContent: num(r?.with_content),
  };
}

async function readChunks(client: Client): Promise<CorpusStatus["chunks"]> {
  // "Embedded" means both columns are set — embedding_model records what
  // produced the vector, so a model swap reads as pending rather than silently
  // mixing two vector spaces in one ranking.
  const rs = await client.execute(`
    SELECT count(*) AS total,
           sum(embedding IS NOT NULL AND embedding_model IS NOT NULL) AS embedded
      FROM chunks`);
  const total = num(rs.rows[0]?.total);
  const embedded = num(rs.rows[0]?.embedded);
  return { total, embedded, pendingEmbed: total - embedded };
}

async function readAnnotations(client: Client): Promise<CorpusStatus["annotations"]> {
  const rs = await client.execute(`
    SELECT (SELECT count(*) FROM item_annotations WHERE summary IS NOT NULL) AS with_summary,
           (SELECT count(DISTINCT item_id) FROM item_topics) AS with_topics,
           (SELECT count(*) FROM items) AS total`);
  const r = rs.rows[0];
  const withTopics = num(r?.with_topics);
  return {
    withSummary: num(r?.with_summary),
    withTopics,
    missingTopics: num(r?.total) - withTopics,
  };
}

async function readCollections(client: Client, now: Date): Promise<CollectionSync[]> {
  const rs = await client.execute(`
    SELECT collection_id, collection_title, last_synced_at
      FROM sync_state
     ORDER BY last_synced_at IS NULL DESC, last_synced_at ASC`);
  return rs.rows.map((r) => ({
    collectionId: num(r.collection_id),
    title: str(r.collection_title),
    lastSyncedAt: str(r.last_synced_at),
    ageDays: ageDaysFrom(str(r.last_synced_at), now),
  }));
}

export async function getStatus(client: Client, now = new Date()): Promise<CorpusStatus> {
  const [items, chunks, annotations, collections, age] = await Promise.all([
    readItems(client),
    readChunks(client),
    readAnnotations(client),
    readCollections(client, now),
    getCorpusAge(client, now),
  ]);
  const newest = await client.execute("SELECT max(created_at) AS newest FROM items");
  return {
    items,
    chunks,
    annotations,
    sync: {
      collectionsTracked: collections.length,
      age,
      stalest: collections[0] ?? null,
      collections,
    },
    newestItemAt: str(newest.rows[0]?.newest),
  };
}

function ago(ageDays: number | null): string {
  if (ageDays == null) return "never";
  return ageDays === 0 ? "today" : `${ageDays}d ago`;
}

export function formatStatus(s: CorpusStatus): string {
  const lines = [
    `items         ${s.items.total} total — ${s.items.ok} ok, ${s.items.extractionFailed} failed extraction, ${s.items.withContent} with text`,
    `chunks        ${s.chunks.total} total — ${s.chunks.embedded} embedded, ${s.chunks.pendingEmbed} pending embed`,
    `annotations   ${s.annotations.withSummary} summaries, ${s.annotations.withTopics} items with topics (${s.annotations.missingTopics} without)`,
    `sync          ${s.sync.collectionsTracked} collections tracked, last ${ago(s.sync.age.ageDays)}${
      s.sync.age.lastSyncedAt ? ` (${s.sync.age.lastSyncedAt})` : ""
    }`,
  ];
  const stalest = s.sync.stalest;
  if (stalest && stalest.ageDays !== s.sync.age.ageDays) {
    lines.push(`stalest       ${stalest.title ?? stalest.collectionId} — ${ago(stalest.ageDays)}`);
  }
  if (s.newestItemAt) lines.push(`newest item   ${s.newestItemAt}`);
  const banner = formatStaleBanner(s.sync.age);
  if (banner) lines.push("", banner);
  return lines.join("\n");
}
