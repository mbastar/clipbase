# clipbase data model

One design rule drives everything here: **an immutable raw source layer with a
derived, regenerable synthesis layer on top.** Ingestion writes the raw layer
once; everything a future organizing agent produces lives in separate tables it
owns outright. The two never share a table, so "what is source truth" vs "what
is derived opinion" is answerable by table name alone.

Scale target is hundreds to low thousands of items: the schema optimizes for
correctness and queryability, not throughput.

## Table-by-table

### `items` — one row per ingested thing, regardless of origin

The spine of the database. Every web page, PDF, and Raindrop bookmark becomes
exactly one row; all other tables hang off `items.id` (INTEGER PRIMARY KEY —
short, human-typable ids for `clipbase show <id>`).

| column | meaning |
|---|---|
| `source_type` | `'web'` \| `'pdf'` \| `'raindrop'` — see *Enum policy* below |
| `url` | **canonical** URL, `UNIQUE` — the dedupe key. PDFs store a `file://` URL so one index dedupes everything |
| `original_url` | the URL exactly as saved, before canonicalization (provenance) |
| `title`, `domain`, `author`, `published_at` | descriptive metadata, best-effort, refreshable |
| `status` | `'ok'` \| `'extraction_failed'` |
| `failure_reason` | why extraction failed: `'thin_content'` \| `'fetch_error'` \| `'blocked_content'`; `NULL` when `status='ok'` — see *Failure reasons* below |
| `fetch_method` | which extractor won: `'defuddle'` \| `'firecrawl'` \| `'yt-dlp'` \| `'pdf'` (provenance) |
| `fetched_at` | when content was fetched (provenance) |
| `raindrop_id` | Raindrop bookmark `_id`, `UNIQUE` when present (provenance) |
| `created_at`, `updated_at` | row lifecycle |

**Canonicalization** (in `src/canonicalize.ts`): strip `utm_*` and known
tracking params (`gclid`, `fbclid`, `mc_*`, …), drop the fragment, normalize
trailing slashes and default ports, lowercase scheme/host, and strip a leading
`www.` from the host. Re-ingesting a known URL is a *metadata refresh*
(title/author/provenance + `updated_at`), never a duplicate row — and never a
mutation of stored content.

Three host-specific rules exist because the generic ones were demonstrably not
enough — the live corpus had duplicate rows for the same page:

- **Host aliases.** `m.youtube.com` → `youtube.com` (likewise mobile Facebook
  and Twitter). Saving a link from a phone otherwise creates a second row.
- **Identity params.** For hosts in `IDENTITY_PARAMS` only one query param
  carries page identity and the rest is playback/referrer noise: YouTube keeps
  `v` and drops `app`, `pp`, `ra`, `si`, `t`. Allowlisting beats blocklisting
  here because YouTube keeps inventing these. `youtu.be/<id>` is rewritten to
  the `watch?v=` form first so the same rule covers it.
- **GitHub default-branch roots.** `github.com/o/r/tree/main` (or `/master`) is
  the repo root, so the suffix is stripped — but only when bare:
  `/tree/main/src` is a real subpath and stays distinct.

Changing any of these makes stored URLs stale, so the rules ship with a
maintenance pass: `clipbase recanonicalize` re-derives every canonical from
`original_url` (the pristine saved form, which keeps the pass idempotent),
rewrites what moved, and merges rows that collapse onto one canonical. It is a
dry run by default because merging deletes rows. Survivor precedence is
content > word count > Raindrop provenance > lowest id; a dropped row's
`raindrop_id` transfers to a survivor that lacks one. Deletes run before
rewrites (a dropped row may squat on the canonical the survivor is taking), and
rewrites are two-phase via a placeholder url, since one row's new URL can be
another row's current one and `items.url` is `UNIQUE`.

**Failure reasons.** `status='extraction_failed'` collapsed every cause into one
bucket, which made a permanently walled URL indistinguishable from a transient
error. `failure_reason` splits them:

| value | meaning | worth retrying? |
|---|---|---|
| `thin_content` | a fetcher returned a page, but it was under `THIN_WORD_THRESHOLD` (100 words) — a paywall stub, login gate, JS shell, or a PDF with no text layer | **No.** The wall is the content; re-fetching returns the same stub |
| `fetch_error` | neither defuddle nor firecrawl produced anything at all — non-zero exit, timeout, unparseable output | Maybe. This can be transient |
| `blocked_content` | a full-length page arrived and it was the **wrong document** — a bot wall or error page wearing the URL's clothes. Caught by marker, not by length | **Yes**, more than the others: this is a property of the request (rate limit, datacentre IP, missing cookies), not of the page |

**The validity gate — why length was not enough.** `isThin` asks whether
*enough* text came back, and cannot ask whether it is the *right* text. Item 5
held a YouTube 403 page for three sessions: 1,972 words, comfortably above the
threshold, and not the talk it claimed to be. `isBlocked` (`src/extract/web.ts`)
scans the **first 2,500 characters** for markers of a block page — `error 403`,
`sign in to confirm`, `unusual traffic`, `access denied`, and ten more.

Two design choices carry the weight:

- **Head-only, not whole-document.** A block page announces itself in its first
  lines; an article that *discusses* bot walls mentions them in the body. This
  corpus is largely about agents and scraping, so whole-document matching would
  eat the library.
- **Every marker is verified against the real corpus.** Applied to all 398
  content-bearing items, the marker set matches **zero**. Bare `captcha` was a
  candidate and was dropped: it hit items #36 and #82, both legitimate pages
  advertising captcha *solving* as a product feature. A false positive here
  silently discards a good document, so any new marker must be re-checked the
  same way before it lands — and so must the existing set whenever the corpus
  grows, since a marker earns its place against the documents that exist. It was
  re-run on 2026-07-27 over the 107 documents added that day: still zero.

Measured live (2026-07-25): re-fetching item 5's YouTube URL returned a
**111-word** player shell containing `Error 403 (Forbidden)!!1`. Being over the
100-word threshold, it would have passed `isThin` and replaced a 12,175-word
transcript. The gate caught it and the transcript survived.

**The transcript path — detecting a block is only half of it.** The gate above
made item 5's failure visible; it could not make it succeed. On youtube.com
both page fetchers are asking for a document that is not in the HTML: defuddle
returns the 1-word JS shell, and firecrawl returned the block page on five of
six real attempts. `src/extract/youtube.ts` asks the caption endpoint instead,
via `yt-dlp`, and records `fetch_method='yt-dlp'`.

- **It runs first for a video, not as a fallback.** Reaching the page fetchers
  on this host spends up to three minutes to be told nothing — or worse, to be
  handed a plausible wrong document. Ordering is the fix; the gate is the net.
- **It is not exempt from the gate.** A transcript that comes back thin or
  carrying block markers is discarded like any other candidate, and the chain
  falls through to defuddle and firecrawl.
- **A miss is not an error.** No yt-dlp on PATH, no English captions, or a
  non-video URL all return null and fall through, because a video page can
  still carry a real description worth keeping. Known gap: a video with no
  English captions discards the title and uploader yt-dlp *did* retrieve, and
  takes whatever the page fetchers can find instead. Not built, because no such
  item exists in this corpus to build it against — every video here is an
  English-language talk.
- **Captions are read as `json3`, not `vtt`.** In vtt a rolling caption
  re-emits each displayed row every time a line scrolls in, so the transcript
  arrives three or four times over and has to be de-duplicated by guesswork.
  json3 encodes the same roll as an append event carrying a newline, so
  concatenating every segment in order *is* the transcript.
- **ASR text is stored as it arrives** — unpunctuated, no headings. The raw
  layer holds what the extractor returned; inventing structure here would be
  authoring content. The consequence is real and worth knowing: with no blank
  lines to split on, `chunkMarkdown` falls to its word-aligned size split, so a
  transcript yields more and smaller chunks than prose of the same length
  (item 5: 54 chunks at ~225 words, against ~390 for the hand-made version it
  replaced).

Measured live (2026-07-26), against a copy of the real database: forcing item 5
returned 12,151 words via `yt-dlp` (against the 12,175 stored by hand last
session), and corrected its `fetch_method`, which had said `firecrawl` and was
wrong. Three further corpus videos were fetched read-only — 5,948, 6,117 and
6,566 words, each with title, uploader and upload date. Four of four.

The column is cleared on success, so a reason never outlives the failure that
caused it: a site that comes back gets `status='ok'` and `failure_reason=NULL`
in the same UPDATE. This is not hypothetical — the backfill that populated this
column recovered item #215 (a Reddit URL carrying a `js_challenge` token) from
`extraction_failed` to 505 words of content, and its reason cleared correctly.

**Backfill result (2026-07-20).** Re-attempting all 10 known failures produced
9 × `thin_content` and 0 × `fetch_error`, with 1 recovery. Every remaining
failure is a wall — Reddit, Google Docs, Notion, Linear, Manus, Browser Use,
GoHighLevel — not an outage. That distribution is the argument against a retry
policy: there is nothing here retrying would fix.

**And it held as the corpus grew.** The 109 items ingested on 2026-07-27 added
exactly 2 failures, both `thin_content`, both walls of the same kind already
catalogued above (a Reddit thread, a Substack post). 11 of 409 items now have
no content. Notably **zero** arrived as `blocked_content` — the reason exists
for a request that was refused, and no request in that batch was.

**Retry behaviour today — measured, not assumed.** A failed item is *not*
re-fetched on every sync. `syncCollection` stops paging at
`bookmark.created <= cursor`, so bookmarks older than the collection's cursor
are never re-scanned. This was verified on the live corpus before this column
existed: all 10 `extraction_failed` rows still had `fetched_at == created_at`,
i.e. not one had ever been re-fetched despite many syncs across six days. (They
have since been re-fetched *once*, deliberately, to backfill this column — so
that check no longer reproduces; re-run it against failures recorded from here
on.) Re-extraction happens only via a direct `clipbase ingest`
(intentional), a lost/reset cursor (bounded — a full rescan re-fetches only the
failures, since `ok` rows with content short-circuit), or a new bookmark
canonicalizing onto an existing failed row. **There is no retry cap because
there is no runaway retry**; `failure_reason` exists so that a policy *can* be
written if that ever changes, not because one is needed now.

**Enum policy.** `source_type`, `status`, `failure_reason`, `fetch_method`, and
`link_type` are plain `TEXT` with **no CHECK constraints**, validated in app code. In SQLite a
CHECK change means a full table rebuild; adding `'youtube'` or
`'podcast_transcript'` later must be a code-only change, so the database
deliberately does not enforce the enum. That trade (weaker DB-level integrity
for zero-migration extensibility) is intentional and matches the spec.

### `item_content` — the immutable raw layer

Cleaned markdown, exactly as extracted, 1:0..1 with `items`
(`extraction_failed` items have **no** row here — junk is never stored as if
it were content).

Why a separate table rather than a column on `items`:

1. **Immutability is enforced by the database**, not convention: a
   `BEFORE UPDATE` trigger raises `ABORT`, so nothing — including a buggy
   future agent — can mutate raw content. Write-once means INSERT is still
   allowed, which is exactly what a successful retry of a previously failed
   extraction does.
2. `items` rows stay small, so `list`-style scans never drag megabytes of
   markdown along.
3. The raw/derived boundary is physical, not a column-level convention.

`word_count` is stored here because it describes the raw content itself.

**Replacing raw content — `clipbase ingest <url> --force`.** Write-once made a
bad extraction permanent: repairing item 5 meant hand-deleting a row, and the
other 34 video items had no supported path at all. `--force` is that path, and
it is deliberately narrow.

What it does *not* change: the trigger still stands, and an ordinary re-ingest
still cannot touch content. A replacement is a DELETE followed by an INSERT in
**one batch** (one transaction), so an item is never left with no content row;
the trigger is untouched because nothing is UPDATEd. Raindrop sync never passes
`force`, so bulk sync can never reach this path.

The contract shifts from *raw content can never be replaced* to **raw content
is never replaced except by an explicit operator action, one item at a time**.
The organizing agent still owns nothing here.

Three properties make that safe enough to be worth having:

- **A failed re-fetch keeps the old content.** If extraction returns blocked,
  thin, or nothing, the previous content stays and the result reports
  `action='kept'` with the reason. This is not theoretical: of six real fetches
  of item 5's URL, one returned the transcript and five returned a bot shell.
  Trading a good document for a bad one is the failure this exists to prevent —
  and the CLI exits non-zero, so a bulk repair loop cannot mistake it for
  success.
- **Losing half the words is reported.** A replacement is the only operation
  here that destroys data, and shrinkage is the shape a bad swap takes. It is
  not *blocked* — a real repair can legitimately shrink an item (stripped
  boilerplate, a purged data URI) — but it is never silent.
- **Derived state is rebuilt, and its staleness is announced.** Chunks are
  re-derived from the new text and the FTS row follows. Embeddings live on
  chunks, so a replacement **drops them**; the command says so and
  `clipbase embed --apply` backfills. An item is briefly unreachable by
  semantic search between the two.

### `chunks` — derived passages, the future embedding target

Items split into ~1200-char heading/paragraph-aware passages at ingest
(`src/chunk.ts`), and **no chunk exceeds 2400 chars** — that ceiling is the
property embedding depends on, since every model has a context limit. Chunks
are **derived and regenerable** from `item_content` — if the chunking strategy
changes when an embedding provider is chosen, bump `chunking_version` and run
`clipbase rechunk`; nothing else depends on chunk identity.

Two rules keep the ceiling true, both learned from real pages rather than
anticipated:

- **Whitespace is not a reliable split point.** v1 split oversized blocks on
  `/\s+/`, so a run containing no whitespace stayed one piece. One saved page
  produced a single 973KB chunk — larger than any embedding model's context
  window. Long runs are now hard-sliced at the target, so the bound holds for
  any input. Five further items had chunks of 2.8–8.5KB from the same cause.
- **Inlined data URIs are dropped before chunking.** They are payloads, not
  prose: the 973KB run above was a percent-encoded SVG. Hard-slicing alone
  would have turned it into ~800 vectors of encoded bytes, so chunking strips
  URIs over 200 chars. Only the derived chunks lose them — `item_content`
  keeps the original text, immutability intact.

One rule keeps the passages *retrievable*, learned the same way:

- **A bare heading belongs to the block it introduces** (v3). The split
  promotes every heading line to a block of its own, and v2 let the accumulator
  flush between the heading and its body. Item 463 emitted `## MCP Tools` as a
  whole chunk — three words — which then outranked every real passage for an
  MCP debugging query. Five chunks were a heading and nothing else; **985 more
  (11.6%, across 368 of 472 items) *ended* on a heading whose body went to the
  next chunk**, the same defect on the other side of the flush, against only 316
  chunks that led with their heading. v3 binds a heading to the first *piece* of
  the following block — after the oversized slice, not before it, or a heading
  standing in front of a long block is stranded a second time. A run of headings
  collapses onto one block and a document ending on a heading keeps it, attached
  to the passage above: a heading carries the block's retrieval signal and is
  never dropped. Binding stops at `MAX_CHARS`, because re-splitting a bound pair
  to fit would run it back through the word-packer and flatten the block's
  whitespace — losing a table's line structure to save a heading is the worse
  trade. Known limit: the split reads `# comment` lines inside fenced code as
  headings (item 13's `.env` sample), so a run of them chains past the ceiling
  and stands alone — seven chunks on one item, and fencing-aware splitting is
  the real cure.

There is **no vector column yet** — the embedding provider (and therefore the
dimension) is deliberately undecided. Prior notes assumed OpenAI 1536-dim;
that assumption is *not* baked in anywhere. See *Future migration: vectors*.

### The organization layer — agent-owned

These tables exist so the contract is fixed; ingestion never writes them. The
organize pass populates them through `src/organize.ts`, which is the only
write path (name normalization and idempotent upserts live there, not at call
sites).

**Form vs subject.** Organization splits in two, because the two halves have
different costs and failure modes:

- **Form** — what kind of thing an item is (`repo`, `video`, `article`,
  `product`, `reference`, `discussion`, `paper`). Derived by `clipbase
  classify` from host and URL shape alone: no model call, no cost, identical
  output every run, and re-runnable as a correction pass when rules improve.
  Stored as `form:*` tags, one per item — the prefix namespaces them away from
  subject tags and makes a bad run revertible by prefix match.
- **Subject** — what an item is *about*. This corpus is ~95% AI tooling, so a
  generic subject taxonomy carries no information; the useful cuts need
  judgement and therefore a model. Those go in `topics` (with `description`, so
  meaning stays stable across runs) and flat `tags`.

A bare root path classifying as `product` rather than `article` is the one
non-obvious form rule: 78 of 409 live items are tool landing pages, and calling
them articles would be wrong. The genuinely fuzzy cases (`/app`,
`/products/sandboxes`) are deliberately left to the subject pass rather than
chased with ever-finer path heuristics.

- `topics` + `item_topics` — broad subject clusters, described (`description`)
  so the agent can keep topic meaning stable across runs.
- `tags` + `item_tags` — flat, cheap labels.
- `item_links` — typed item-to-item edges: `link_type` is free text by the
  enum policy above; the working vocabulary is `'related'`, `'contradicts'`,
  `'expands_on'`. `note` lets the agent say *why* it drew the edge.
  PK `(from_item_id, to_item_id, link_type)` makes links idempotent to
  re-derive.
- `item_annotations` — per-item agent output, currently a nullable `summary`.
  This is a separate table (not a column on `items`) so agent-written prose
  never lives in an ingestion-owned row; new agent outputs later (key points,
  quality scores) are `ALTER TABLE ADD COLUMN` here, touching nothing raw.

### The ownership contract

**The organizing agent owns, and may freely INSERT/UPDATE/DELETE:**
`topics`, `item_topics`, `tags`, `item_tags`, `item_links`,
`item_annotations`. All of it is regenerable opinion; dropping all six tables'
contents must always be recoverable by re-running organization.

**The agent must never write:** `items`, `item_content`, `chunks`,
`sync_state`, `schema_migrations`, `items_fts` (trigger-maintained).
`item_content` is additionally trigger-protected. The agent reads these
freely — that's the corpus it is organizing — via the same CLI (`--json`).

### `sync_state` — Raindrop cursor

One row per synced collection: `last_created_cursor` is the max bookmark
`created` timestamp already ingested. Listing is requested sorted `-created`,
so sync stops paging at the first bookmark at/behind the cursor — re-runs
fetch only new bookmarks. Idempotency does **not** depend on the cursor:
`items.raindrop_id` and `items.url` are both UNIQUE, so a lost cursor can only
cause refreshes, never duplicates. Known limitation (v1): edits to
already-synced bookmarks are not re-pulled.

**It is also the registry of what gets synced.** `clipbase sync-all` takes no
collection list and reads no config: it iterates the rows of this table,
because a row exists here precisely because someone ran `sync-raindrop
--collection <name>` once and meant it. That keeps widening the corpus a
separate, deliberate act from keeping it current — which matters, because the
Raindrop account holds 36 collections and only 13 are tracked; the other 23
(archives, non-work subjects, …) are 767 bookmarks that a
discover-everything sync would have swept in.

An unreachable collection is isolated, not fatal: the rest still sync, cursors
commit per collection as each finishes, and the command exits non-zero so a
partial sync cannot read as a clean one.

**Titles survive an id-based sync.** `resolveCollection` returns `null` rather
than the id when handed a number, and `syncRaindrop` then falls back to the
title already in this table. Before that, syncing by id wrote the id *as* the
title — latent while every sync was by name, and a rename of all 13 rows the
first time `sync-all` (which passes ids) ran.

### `items_fts` — full-text search

FTS5 over `(title, content)`, `rowid = items.id`, kept in sync by four
triggers (content insert, title update, item delete, content delete). It is a
regular FTS5 table storing its own copy of the text rather than an
external-content table: `snippet()` needs stored text, the corpus is small,
and self-contained storage avoids the rebuild-order pitfalls of
external-content sync. Only items that actually have content are indexed.

Query strings are never passed raw to `MATCH` — every token is wrapped as a
quoted phrase (`src/fts.ts`), so hyphens, quotes, and FTS operators in
user/agent queries are literals, not syntax errors.

**Tokens are joined with `OR`, not adjacency's implicit `AND`.** AND requires
every token — stopwords included — in one document, so a single absent word
empties the result set. The retrieval eval (`clipbase eval`, `eval/queries.jsonl`)
made this measurable: with AND, 8 of 12 natural-language questions returned zero
rows and FTS nDCG@10 was 0.078; switching to OR (bm25 still ranks, so rare terms
dominate and stopwords barely register) raised it to 0.555 with gold in the
top-10 for 10/12. The token list is deduped and capped (`MAX_TERMS`) so a
pathological query can't blow up the `MATCH` expression. Semantic still leads
overall (0.75), but the two miss on *different* queries — FTS on paraphrases,
semantic on exact-term lookups — which is what justified fusing them; see
`docs/retrieval.md` for the hybrid ranker that resulted.

### `schema_migrations`

Ordered, re-runnable migrations (`migrations/NNNN_*.sql`) applied by
`clipbase migrate` via `executeMultiple` (parses trigger bodies correctly).
Remote Turso DDL isn't transactional, so all DDL is `IF NOT EXISTS` —
re-running after a partial failure converges.

### Vectors — shipped in `0003_vectors.sql`

`chunks.embedding` is an `F32_BLOB(768)`; `chunks.embedding_model` records what
produced it. A chunk counts as embedded only when both are set, so a provider
change is detectable rather than silent — the role `chunking_version` plays for
chunk text. There is deliberately **no vector index**; see *Why no ANN index*
below.

**Model: `google/gemini-embedding-2` via OpenRouter.** Three things decided it:

- **768 dims.** Native width is 3072, Matryoshka-truncatable to anything from
  128 up. 768 is Google's recommended production size — near-peak quality at a
  quarter the storage — and is also EmbeddingGemma's native width, so moving to
  a local model later needs no migration. Voyage is the one option 768 rules
  out: it offers 256/512/1024/2048 but not 768.
- **OpenRouter over the Gemini API.** Gemini Embedding 2 removed the
  `task_type` parameter its predecessor had, expressing retrieval intent as an
  instruction inside the input text instead. That was the one parameter a proxy
  could have silently swallowed; without it the routes are equivalent, so the
  proxy buys model-swapping for nothing.
- **Retrieval is asymmetric.** Only the query carries an instruction prefix
  (`src/embed.ts`); stored passages embed as plain text.

Truncation has one trap worth naming: Gemini re-normalizes when *it* truncates
via `output_dimensionality`, but OpenRouter does not document passing that
parameter through. If a full 3072-dim vector comes back, `fitDimensions`
truncates and re-normalizes locally — cosine ranking assumes unit vectors, and
skipping that step skews results silently instead of failing.

The query path (`searchSemantic`) is an exact scan that over-fetches `limit * 4`
and collapses to distinct items afterwards, because several chunks of one item
can all rank highly:

```sql
SELECT c.item_id, c.content, i.title,
       vector_distance_cos(c.embedding, vector32(?1)) AS distance
FROM chunks c
JOIN items i ON i.id = c.item_id
WHERE c.embedding_model = ?2 AND c.embedding IS NOT NULL
ORDER BY distance
LIMIT ?3;
```

### Why no ANN index, and why reads go through a replica

Measured on the real corpus (6125 vectors × 768 dims), not assumed:

| | remote Turso | local libSQL |
| --- | --- | --- |
| exact scan of all 6125 | ~15,000 ms | **~6–10 ms** |
| `vector_top_k` with ANN index | ~7,500 ms | — |
| one `UPDATE` writing a vector, index present | ~91,000 ms | — |
| one `UPDATE` writing a vector, no index | ~256 ms | — |

Three conclusions follow, and only the third is obvious in hindsight:

1. **The ANN index was strictly worse.** It made writes unusable (a backfill
   could not finish — even writes *not* touching the indexed column took 31s),
   halved read latency at best, and being approximate it returned worse
   neighbours than the exact scan (0.67 vs 0.766 for the true nearest on a
   sample query). Dropped in `0004`.
2. **The bottleneck was never arithmetic.** The identical scan over identical
   data is 6ms local and 15s remote, so the cost is round-tripping. No index
   removes that, which is why the index barely helped.
3. **So reads run locally.** `getReplicaClient` opens a libSQL embedded replica
   (`~/.cache/clipbase/replica.db`, override with `CLIPBASE_REPLICA_PATH`) and
   syncs before querying: ~8s to pull the database the first time, ~200ms
   incrementally after. Writes still go to the remote via `getClient`; the
   replica is a cache, and deleting it costs only the next sync.

An exact scan is linear, so this holds until the corpus grows about tenfold —
at ~60k chunks a local scan approaches 100ms and ANN starts to earn its costs.
Turso's own vector guide likewise documents linear scan rather than an index.

Staleness needs no bookkeeping: `rechunk` deletes and reinserts a rewritten
item's chunks, so a changed passage drops its vector along with it.

## Future migrations (pre-planned, mechanical)

### YouTube / podcast transcripts — *partly shipped, and it cost no migration*

The YouTube half landed on 2026-07-26 and is the enum policy's first real test:
adding `fetch_method='yt-dlp'` touched **no schema at all**, exactly as this
section predicted. See *The transcript path* above for how it behaves.

Videos still ingest as ordinary `'web'` / `'raindrop'` items. A distinct
`source_type='youtube'` was not added, because nothing yet reads it — `classify`
already derives `form:video` from the host, so a second host-derived label would
be a second place to keep in sync. Add it when a query needs it, not before.

Still unbuilt: podcast transcripts (same shape, a different fetcher), and
per-segment timestamps — which, if ever needed, are a new derived table
(`transcript_segments`) beside `chunks`, leaving the raw layer untouched.
