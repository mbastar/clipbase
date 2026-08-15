import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Client } from "./db.js";
import { nowIso } from "./db.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function applyMigrations(
  client: Client,
  onApply?: (name: string) => void,
): Promise<string[]> {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  );
  const applied = new Set(
    (await client.execute("SELECT version FROM schema_migrations")).rows.map((r) =>
      Number(r.version),
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (applied.has(version)) continue;
    onApply?.(file);
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await client.executeMultiple(sql);
    await client.execute({
      sql: "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      args: [version, file, nowIso()],
    });
    ran.push(file);
  }
  return ran;
}
