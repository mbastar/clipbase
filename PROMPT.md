Build a first working version of clipbase: a personal knowledge-base tool backed by a Turso database. It ingests web links, Raindrop.io clips, and PDFs, retrieves the full content, and stores it in a sound relational data model designed so an agent can later organize the corpus (topics, tags, links, summaries) and vector search can be added without restructuring. This is a knowledge base, not a memory system: the unit of value is source content I keep and query, not conversation history. The data model is the core deliverable; the CLI around it is deliberately thin.

You are running inside the clipbase repo. Boilerplate already exists: git is initialized with an initial commit on main, and package.json (Node 20+, ESM, TypeScript), tsconfig.json, .gitignore, .env.example, and a src/index.ts stub are in place with @libsql/client, typescript, and tsx installed. Build on top of this; add dependencies as needed.

Product specification:
- A TypeScript CLI backed by a Turso (libSQL) cloud database.
- Versioned SQL migration files applied by a script. Copy .env.example to .env (gitignored) for TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, RAINDROP_TOKEN.
- The Turso CLI is installed and already authenticated on this machine. Create the database yourself (turso db create clipbase), then get credentials via turso db show clipbase --url and turso db tokens create clipbase. Remote-only connection is fine for v1; embedded replicas are a future consideration, not in scope.
- Ingestion surfaces (v1):
  1. clipbase ingest <url> — fetch the page, clean to markdown, store.
  2. clipbase ingest --pdf <path> — extract text from a local PDF, store.
  3. clipbase sync-raindrop --collection <id-or-name> — pull bookmarks from the Raindrop.io REST API v1 (api.raindrop.io/rest/v1, Bearer token from RAINDROP_TOKEN), ingest each bookmark URL not already in the database, and persist a sync cursor so re-runs only fetch new bookmarks.
- Content fetching: use the locally installed defuddle CLI first (clean markdown extraction). If output is thin or empty (JS-rendered page), fall back to the locally installed firecrawl CLI. If both come back thin, store the item with status extraction_failed rather than storing junk — never silently save empty content as if it succeeded.
- Retrieval: clipbase search "<query>" using SQLite FTS5 with ranked results and snippets; clipbase list (recent items, filterable by source_type and status); clipbase show <id> (full record). Every read command supports a --json flag that emits clean machine-readable output, because an agent is a first-class consumer of this CLI.
- Data model requirements — design it and justify it in writing; it must include at least:
  - items: one row per ingested thing regardless of origin, with source_type ('web', 'pdf', 'raindrop'; the enum must be extensible to 'youtube' and 'podcast_transcript' later without migration pain), canonical URL, title, domain, author and published date when derivable, ingest status, timestamps.
  - An immutable raw layer: the cleaned extracted content is write-once after ingest. The future organizing agent never mutates it. Keep raw content clearly separated from anything agent-written.
  - An organization layer, created now and left empty, that is explicitly where the future organize pass writes: topics (+ item_topics junction), tags (+ item_tags junction), item_links (typed item-to-item relations, e.g. 'related', 'contradicts', 'expands_on'), and a nullable agent-written summary field per item. Document this contract precisely: which tables/columns the agent owns, which it must never touch.
  - Chunking for future embeddings: either a chunks table now (items split into passages) or a documented plan for one. Do NOT create an F32_BLOB vector column yet — the embedding provider and therefore the dimension is undecided. Instead, document the exact future migration: ALTER TABLE to add the vector column, CREATE INDEX with libsql_vector_idx, and a sample vector_top_k query, so adding vectors later is a mechanical step.
  - Provenance on every item: raindrop bookmark id when applicable, original URL as saved, which fetch method succeeded (defuddle/firecrawl/pdf), fetched_at.
  - An FTS5 virtual table over item title + content, kept in sync with triggers.
- Deliverable doc: docs/data-model.md explaining every table, why it exists, the raw-vs-organization boundary, and the future-migration notes (vectors, transcript source types).

Users: one operator (me, solo, on macOS with zsh) and Claude Code agents acting on my behalf in later sessions. The agent consumes the same CLI with --json. No UI, no auth, no multi-user concerns.

Domain context: Turso is a SQLite-compatible (libSQL) cloud database; treat it as SQLite with a cloud endpoint and native vector search available later. Expected corpus is hundreds to low thousands of items — design for correctness and queryability, not scale heroics. The design philosophy mirrors my existing knowledge vault: an immutable raw source layer with a derived, regenerable synthesis layer on top; the database must preserve that separation. I have prior notes that assumed OpenAI 1536-dim embeddings — that decision is now explicitly deferred, do not bake in a dimension.

Tricky cases:
- Duplicate ingestion: canonicalize URLs (strip utm_* and similar tracking params, normalize trailing slashes) and treat re-ingest of a known URL as a metadata refresh, never a duplicate row.
- Paywalled or JS-heavy pages: defuddle returns thin content; detect "thin" with a sensible heuristic (e.g. word count), fall back to firecrawl, and record which method won.
- Large PDFs: extract without loading everything into one string if the library allows; store full text; never crash on a 300-page document.
- Raindrop sync: handle pagination; re-running sync must be idempotent (track raindrop _id per item and a lastUpdate cursor).
- FTS5 query syntax: user/agent-supplied search strings with quotes, hyphens, or operators must not throw — escape or wrap them.
- YouTube/podcast URLs ingested today should store as ordinary web items; the schema just must not block adding transcript source types later.

Required behavior: idempotent ingest and sync; nonzero exit codes with a clear one-line error on failure; ordered, re-runnable migrations; search returns ranked results with useful snippets; all secrets from env, nothing sensitive committed; --json output is valid JSON with no log noise mixed in.

Acceptable rough edges: no embeddings or vector search yet (schema-ready only); no organize/agent pass yet (tables exist, empty); no YouTube/podcast transcripts; no web UI; no MCP server (the CLI is the agent surface for now); best-effort PDF extraction quality; no retry/backoff sophistication; tests only on the core paths (URL ingest + dedupe, thin-content fallback, Raindrop sync idempotency, FTS search).

Work in explicit stages: (1) brainstorm — surface the key design questions and your answers, especially on the data model; (2) plan — propose the schema, CLI structure, and build order, and present the plan for my approval before writing code; (3) build; (4) review — self-review the diff for correctness bugs and scope creep before testing; (5) test. Keep the implementation to the stated scope. Test it in the environment where it will be used: create the real Turso database, run the real migrations, ingest at least 3 real URLs (include one JS-heavy page to exercise the fallback), 1 real PDF, and one Raindrop collection pull, then demonstrate search returning ranked snippets from that real data. Build on a feature branch off main and prepare a pull request; no remote exists yet, so create a private repo with gh under the mbastar account, or leave the branch ready and tell me which you did.

When you finish, give me:
1. Instructions for trying it
2. The main decisions you made — especially data-model choices and what they enable or foreclose
3. What you left out
4. Test results and other evidence (the real items ingested, actual search output)
5. The areas I should review most carefully
