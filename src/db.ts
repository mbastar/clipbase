import { createClient, type Client } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type { Client };

export function loadEnv(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch {
    // no .env file; rely on the process environment
  }
}

export function getClient(): Client {
  loadEnv();
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set (see .env.example)");
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

/**
 * Read path for vector search, backed by a local embedded replica.
 *
 * Scanning 6125 embeddings takes ~15s against remote Turso and ~10ms against a
 * local libSQL file holding the same rows — the arithmetic is free and the
 * round trips are everything. An ANN index does not close that gap (it merely
 * halved it, while making writes unusable and answers approximate), so reads
 * run locally and stay exact instead.
 *
 * Writes still go to the remote through `getClient`; the replica is a cache,
 * and deleting it costs only the next sync.
 */
export async function getReplicaClient(): Promise<Client> {
  loadEnv();
  const syncUrl = process.env.TURSO_DATABASE_URL;
  if (!syncUrl) throw new Error("TURSO_DATABASE_URL is not set (see .env.example)");

  const path = process.env.CLIPBASE_REPLICA_PATH ?? join(homedir(), ".cache", "clipbase", "replica.db");
  await mkdir(dirname(path), { recursive: true });

  const client = createClient({
    url: `file:${path}`,
    syncUrl,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  // First call pulls the whole database (~8s); later ones ship only new frames
  // (~200ms), which is cheap enough to do on every search rather than leaving
  // the caller to guess whether their replica is stale.
  await client.sync();
  return client;
}

export function nowIso(): string {
  return new Date().toISOString();
}
