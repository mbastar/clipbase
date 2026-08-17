# clipbase

Personal knowledge-base ingestion tool backed by a Turso (libSQL) database. Web
links, Raindrop.io clips, and PDFs go in; content is fetched, cleaned to
markdown, and stored in a relational model with an immutable raw layer and an
agent-owned organization layer (topics, tags, links, summaries) on top. FTS5,
semantic, and hybrid search out via a thin CLI that agents consume with
`--json`.

## What this is, and what it is not

A single-operator tool, published as a working record rather than a product.
Development happens in a private working repo against the live corpus; this
repo is its public release, and its history starts here. The corpus itself —
a few hundred saved repos, articles, videos and papers — is a private
database (`*.db` is gitignored and stays that way), so cloning this gets the
method and none of the data. Bring your own Turso database and Raindrop
account and the same pipeline runs against them; `Setup` below is everything
it assumes. PR numbers cited in `docs/` refer to the private repo and are
kept as-is — the docs are a record, not a rewrite.

The part worth reading is `docs/`. **`docs/retrieval.md`** is the decision
record kept while retrieval was built and measured: why fusion is rank-based
with nothing to calibrate, what a 30-query labelled gold set is worth and the
three limits that bound it, how an LLM judge's 85% validation agreement failed
to transfer to real runs and what that was traced to — and the chunking defect
(990 of 8522 chunks with a heading on the wrong side of a boundary) whose fix
moved the aggregate numbers slightly *down* and was kept anyway, with the
reasoning recorded rather than the metric obeyed. `docs/data-model.md` is the
schema and the raw-vs-organization boundary; `docs/topic-taxonomy.md` the
classification rules and their fallbacks; `PROMPT.md` the spec v1 was built
from, unedited since.

`eval/` ships alongside: the labelled queries (`eval/queries.jsonl`), their
graded gold, and the review ledger (`eval/reviewed.json`) carrying one
recorded reason per grading decision — so the numbers the docs quote are
checkable against the artifacts that produced them, not just asserted. The
working sheets and judge-run logs behind those ledgers stay in the private
repo — they quote stored page content wholesale; what ships is the decisions.

## Making it yours

The pipeline transfers; the corpus, the taxonomy and the schedule are one
operator's. What that means concretely, in the order you will hit it:

**Works as-is — nothing to edit.**

- **Credentials.** `cp .env.example .env` and fill in what it names: your own
  Turso database (`turso db create <name>`), a Raindrop test token, an
  OpenRouter key for embeddings. `migrate` builds the schema.
- **Tools.** `defuddle` and `firecrawl` (npm globals) for web extraction,
  `yt-dlp` optionally for YouTube transcripts, and an authenticated `claude`
  CLI for `enrich` and `eval-judge`. Setup below says what happens when each
  is missing.
- **The launchers.** `scripts/install-bin.sh` derives the repo path itself and
  writes both `clipbase` and `clipbase-sync` to `~/.local/bin`.
- **The sync script.** `scripts/weekly-sync.sh` finds the repo relative to
  itself and honours `CLIPBASE_BIN`; nothing in it is machine-specific.
- **Which collections sync.** Not a config file: run
  `sync-raindrop --collection <name>` once per collection you mean to track,
  and `sync-all` covers it from then on.

**Templates — edit before use.**

- **`scripts/com.example.clipbase.sync.plist`** — the nightly schedule.
  Replace every `YOUR-USERNAME` path, point its `PATH` entry at your node
  install, rename the label and the file to your own reverse-domain, and pick
  an hour after whatever files bookmarks into your collections. The file's
  own comments walk each field.
- **The topic taxonomy** — `TOPICS` in `src/commands/enrich.ts`, hardcoded on
  purpose and tuned to this corpus (AI agents, no-code automation). Replace
  the topics with your own subjects; `docs/topic-taxonomy.md` records the
  rules that keep a taxonomy assignable.
- **`skills/clipbase/SKILL.md`** — the agent-facing contract. The command
  surface transfers, but the frontmatter `description` names this corpus's
  subjects; rewrite it for what you save, or agents will not reach for it.

**Records — this corpus's, not yours.**

- **`eval/`** — the labelled queries and graded gold reference this corpus's
  item ids, so against your database the numbers would be meaningless. Start
  a fresh `eval/queries.jsonl` — `eval/queries.example.jsonl` shows the
  format — and grow your own gold with `eval-pool` and `eval-judge`
  (*Measuring retrieval*, below).
- **The upstream triage.** Bookmarks reach the tracked collections here via a
  separate cloud routine that files the Raindrop Inbox nightly; it is not in
  this repo. File bookmarks into collections by hand, or schedule your own —
  the one requirement is that filing happens before the sync hour.

## Setup

```bash
npm install
cp .env.example .env   # fill in Turso + Raindrop credentials
npm run --silent cli -- migrate
```

Requires Node 20+, plus the `defuddle` and `firecrawl` CLIs on PATH for web
ingestion. `yt-dlp` is optional and used only for YouTube transcripts; without
it those URLs fall back to the page fetchers, which mostly fail on that host.
The database is yours to create — `turso db create <name>` — and
`.env.example` names each credential and where it comes from.

`npm install` compiles to `dist/` via the `prepare` script. To get a `clipbase`
command that works from any directory:

```bash
sh scripts/install-bin.sh    # writes ~/.local/bin/clipbase
```

**Prefer that over `npm link`.** `npm link` installs the bin inside whichever
Node version was active at the time, on a PATH entry that a version manager
rebuilds per shell session — so the command works in the shell that installed it
and is missing from a terminal that resolves a different Node. The launcher goes
in `~/.local/bin` and pins the interpreter by absolute path, so a Node switch
cannot strand it.

Two things it does not survive: **moving the repo**, and a **stale `dist/`**. The
launcher points at `dist/index.js` by absolute path, so re-run the script after
a move, and `npm run build` after pulling changes to `src/` — otherwise the
command silently runs the old code.

## Usage

```bash
npm run --silent cli -- ingest https://example.com/article     # web page → markdown
npm run --silent cli -- ingest --pdf ~/papers/attention.pdf    # local PDF
npm run --silent cli -- ingest https://example.com/article --force   # re-fetch, replace stored content
npm run --silent cli -- sync-raindrop --collection "Reading"   # pull new bookmarks (id or name)
npm run --silent cli -- sync-all                               # pull new bookmarks for every tracked collection
npm run --silent cli -- search "vector databases" --limit 5    # ranked FTS5 results + snippets
npm run --silent cli -- search "how do agents remember" --semantic   # rank by meaning
npm run --silent cli -- search "how do agents remember" --hybrid     # fuse both rankings
npm run --silent cli -- embed                     # dry run; --apply to embed (spends credits)
npm run --silent cli -- list --source-type web --status ok
npm run --silent cli -- list --status extraction_failed        # rows show status:failure_reason
npm run --silent cli -- show 12
npm run --silent cli -- show 12 --no-content        # record + annotations, without the document
npm run --silent cli -- recanonicalize            # dry run; --apply to write
npm run --silent cli -- rechunk                   # dry run; --apply to write
```

Every read command takes `--json` for clean machine-readable output (agents are a first-class consumer). Progress/log output always goes to stderr. Nonzero exit code with a one-line error on failure.

`--silent` is required when parsing `--json`: without it npm prints a `> clipbase@0.1.0 cli` banner to stdout ahead of the payload, which is not valid JSON. Agents can also skip npm entirely — `npm run build` once, then invoke `dist/index.js` (or the `clipbase` bin) directly.

## Ingestion

The happy path is one command in Usage above. These are the two places it
needed judgement.

### Repairing a bad extraction

Ingest stores a document once and, by default, never touches it again — a
re-ingest of a known-good URL only refreshes metadata. That made a *wrong*
stored document permanent. `--force` re-fetches and replaces the content:

```bash
clipbase ingest https://youtube.com/watch?v=... --force    # repair one item
clipbase list --status ok --json | jq -r '.[].url' | xargs -n1 -I{} clipbase ingest {} --force
```

Two guards make this safe to point at real data:

- **A failed re-fetch keeps what was already there.** If the fetch comes back
  blocked, thin or empty, the old content survives and the command reports
  `kept` and exits non-zero — so a bulk loop can't read it as success. Only a
  successful extraction replaces anything.
- **A page can now fail for being the *wrong* document, not just a short one.**
  `isThin` cuts at 100 words and cannot tell a 403 page from an article. A
  marker check (`Error 403`, `Sign in to confirm`, `unusual traffic`, …) reads
  the first 2,500 characters and records `blocked_content` — worth retrying,
  unlike `thin_content`. Markers are matched at the head only, and the set is
  verified to match zero of the 398 real documents in the corpus, because a
  false positive here throws away a good page.

Replacing content re-derives chunks, which **drops their embeddings** — run
`clipbase embed --apply` afterwards.

### YouTube transcripts

A youtube.com URL is fetched by `yt-dlp` from the caption endpoint, *before*
either page fetcher is tried — on that host defuddle returns a 1-word JS shell
and firecrawl returned a bot wall on five of six real attempts, so the page
chain spends minutes to be handed the wrong document. `fetch_method` records
`yt-dlp`, and title, uploader and upload date come back with the transcript.

```bash
clipbase ingest "https://youtube.com/watch?v=..." --force   # repair a video item
```

The transcript is not exempt from the validity gate: one that comes back thin
or block-marked is discarded and the chain falls through as usual. No yt-dlp on
PATH, or no English captions, is a fall-through too — never a hard failure.

Auto-captions are stored as they arrive, unpunctuated and without headings, so
a transcript chunks into more and smaller passages than prose of the same
length. Rationale in `docs/data-model.md` → *The transcript path*.

## Staying current

Two commands: one that catches the corpus up, one that says whether an answer
can be trusted.

### Keeping the corpus current

`sync-raindrop` pulls one collection. `sync-all` pulls **every collection
already tracked**, which is exactly the rows in `sync_state`:

```bash
clipbase sync-all
clipbase sync-all --json     # per-collection results plus totals
```

Real output from the first run against the live corpus (2026-07-27), which had
gone eight days without a sync:

```
  Add-ons & Components .......... 0 new
  Agentic: Complementary ........ 20 new
  Agentic: Memory & Knowledge ... 13 new
  Learning ...................... 24 new, 2 failed extraction
  Self-hosted ................... 25 new
  Videos ........................ 3 new
  ... 7 more

13 collections: 109 new, 2 failed extraction
```

There is no config file and no `--all-collections` flag, and that is the point.
A collection is tracked because someone ran `sync-raindrop --collection <name>`
once and meant it, so **catching up** what you chose and **widening** what you
collect stay separate acts. The Raindrop account behind this corpus holds 36
collections; 13 are tracked and the other 23 are 767 bookmarks that a
discover-everything sync would have swept in uninvited. To add one, sync it by
name once — it is covered from then on.

An unreachable collection does not stop the others. It is reported on its own
line, the collections that ran keep their advanced cursors, and the command
exits non-zero so a partial sync is never mistaken for a clean one.

### Knowing whether to trust an answer

```bash
clipbase status          # items, pending embeds, annotation coverage, sync age
clipbase status --json
```

Real output from the run that justified the command (2026-08-04), before the
catch-up that answered it:

```
items         416 total — 405 ok, 11 failed extraction, 405 with text
chunks        7779 total — 7715 embedded, 64 pending embed
annotations   398 summaries, 369 items with topics (47 without)
sync          13 collections tracked, last today (2026-08-04T00:13:30.279Z)
stalest       Agentic: Complementary — 7d ago
```

Three things worth reading off it. `stalest` caught what the headline hid — a
sync age of "today" was true of twelve collections and false of the thirteenth,
which was still eight days back. The 64 pending embeds and 47 items without
topics are the window `weekly-sync.sh` exists to close: those items are already
findable by keyword and not yet rankable by `--hybrid` or describable by
`topics`. And the run it prompted pulled **69 new items, not the 7 the stalest
collection implied** — the other twelve were behind too, just not by enough to
flag.

The problem this solves is not a stale corpus, it is a **silently** stale one.
An agent asked "is there a tool for X" answers from whatever is stored, and a
miss caused by an un-synced fortnight is indistinguishable from a subject the
corpus genuinely does not cover — so the wrong answer arrives with the same
confidence as the right one.

Rather than trust a reader to remember to check, `search` and `topics` **print a
warning to stderr themselves** once the corpus is 14 days past its last sync
(`STALE_AFTER_DAYS`). Diagnostics go to stderr like every other progress line
here, so `--json` stdout stays a clean array and existing `| jq` pipelines are
unaffected. The check is wrapped so that a failure inside it can never take down
the search it annotates.

Two numbers repay attention beyond the headline. **`pending embed`** and items
**without topics** are the window where a synced item is findable by keyword but
not yet rankable by `--hybrid` or describable by `topics` — the state
`weekly-sync.sh` exists to avoid, visible here when a pass was skipped or
interrupted. And **`stalest`** catches what a headline age hides: the run above
synced twelve collections today while one stayed a week behind, which is a
partial sync wearing a clean face.

## Organizing

```bash
npm run --silent cli -- classify                    # dry run; --apply to write form:* tags
npm run --silent cli -- enrich                      # dry run; --apply to write topics + summaries
npm run --silent cli -- tags                        # all tags with counts
npm run --silent cli -- topics
npm run --silent cli -- tag 54 mcp agent-skills     # --remove to detach
npm run --silent cli -- topic "agent tooling" --describe "Frameworks for building agents"
npm run --silent cli -- topic 54 "agent tooling"
npm run --silent cli -- summarize 54 "One-line summary."
npm run --silent cli -- link 227 54 --type expands_on --note "why the edge exists"
```

Organization has two halves. `classify` is the deterministic one: it derives a
single `form:<kind>` tag per item (`repo`, `video`, `article`, `product`,
`reference`, `discussion`, `paper`) from host and URL shape alone — no model
call, same answer every run.

`enrich` is the judgement half: it assigns subject topics from a fixed taxonomy
plus a one-line summary. It shells out to the **`claude` CLI**, so it needs no
`ANTHROPIC_API_KEY` — just an authenticated Claude Code install on PATH. Cost is
driven by the number of model calls rather than the number of items (each
invocation reloads Claude Code's own system prompt), so items are batched:
`--batch 20` is the default and lowering it gets expensive fast. Items the model
declines to place get no topic rather than a forced one; they are the review
queue for taxonomy gaps, and they are *not* re-sent on later runs — an item
counts as processed once it has a summary, whether or not it got a topic.

Note that `--apply` gates the **writes, not the model calls**: a dry run still
costs what the real run costs. `--all` re-classifies the whole corpus, so it is
the expensive flag. Rationale and fallbacks: `docs/topic-taxonomy.md`.

The `form:` prefix keeps the two halves apart, so topical tags can never collide
with derived ones.

`recanonicalize` re-derives every canonical URL with the current rules and
merges rows that collapse onto the same one. Run it after changing
`src/canonicalize.ts`, otherwise stored URLs keep the old shape and re-ingesting
a known page duplicates it. It deletes rows when merging, so it dry-runs by
default.

## Search beyond keywords

Keyword FTS is the default ranker. The other two, and when they earn their
cost.

### Semantic search

`embed` vectorizes every chunk that has no current vector, via
`google/gemini-embedding-2` on OpenRouter (768 dims). It needs an
`OPENROUTER_API_KEY`; `enrich` still uses the authenticated `claude` CLI and
needs no key. Like the other passes it dry-runs by default — and here the dry
run is genuinely free, since it counts pending rows without calling the
provider. Roughly 1.6M tokens to embed the corpus from empty.

`search --semantic` ranks by meaning instead of keywords, so it finds an item
that never uses your words. It searches chunks and collapses them to items, so
one item appears once however many passages match. Vectors from a different
model are ignored rather than mixed in — swap the model and `embed --apply`
backfills the difference. Keyword search stays the default: it is instant,
local, and better when you know the exact term.

Semantic reads go through a **local embedded replica** of the database
(`~/.cache/clipbase/replica.db`, override with `CLIPBASE_REPLICA_PATH`), because
scanning every embedding takes ~10ms locally and ~15s against remote Turso. The
first semantic search pulls the database (~8s); later ones sync incrementally
(~200ms). The replica is a pure cache — delete it and the next search rebuilds
it. Writes always go to the remote. Full measurements, and why there is no ANN
index, are in `docs/data-model.md`.

### Hybrid search

`search --hybrid` runs both rankers and fuses them with Reciprocal Rank Fusion,
because the two fail on *different* queries: keyword search misses paraphrases
that share no word with the document, semantic search trails on exact-term
lookups. Fusing costs the same single query embedding as `--semantic`.

Measured over the labelled query set (30 queries, k=10), hybrid beats both on
every metric — MRR 0.816 vs 0.766 semantic and 0.642 FTS at 409 items. The gain
is mostly precision at the top rather than coverage, but not only: on one query
neither method surfaced the answer in its own top 10 and fusion still lifted it
to rank 7, which is the case reading each list 50 deep exists to catch.

Those absolutes are lower than the 0.871 / 0.774 / 0.675 measured at 300 items,
and the drop is **not** readable as a regression: the gold was pooled against
the smaller corpus, so the 109 items added since are scored as irrelevant by
construction. The trade, the constants, and what to reach for when it stops
working are in `docs/retrieval.md`.

## Measuring retrieval

The harness the numbers in `docs/` come from, and how its gold stays honest as
the corpus grows.

### Evaluating retrieval

```bash
npm run --silent cli -- eval                      # all three methods, k=10
npm run --silent cli -- eval --k 5 --json
```

`eval` scores FTS, semantic, and hybrid over `eval/queries.jsonl` — labelled
natural-language queries with graded gold items — on Success@1/@5, MRR, Recall@k
and nDCG@k, plus a per-query first-gold-rank table showing where the methods
disagree. All three read the same replica and share one query embedding per
query, so the comparison is against identical rows and identical vectors.

Gold is graded 3 (answers the query) / 2 (substantially relevant) / 1 (touches
the subject but is not what you wanted). nDCG uses all three; Success@k, MRR and
recall count only grades 2 and up, so a method cannot score a hit on an item the
judge already called not-the-answer. A bare id means grade 2, so an ungraded set
scores exactly as it did before grades existed. Gold items sharing a `group`
label are one answer at two URLs — a repo and its landing page — and every metric
counts the group once, so returning either copy is a full answer and returning
both earns nothing extra.

The run is pinned to the collection its gold was judged over. `eval/queries.jsonl`
→ `eval/queries.collection.json` names the pool's highest item id; items above it
were never judged, and an unjudged hit does not merely score 0, it takes a rank
slot from a real answer. A query set with no pin **fails rather than defaulting to
the whole corpus** — pass `--collection all` to score everything and read the
result as a floor, or `--collection <n>` to name a ceiling by hand.

Run `npm run build` before quoting a number. The `clipbase` on your PATH execs
`dist/`, so a stale build reports the previous version's numbers — recognisable
because the `collection ·` line is missing or wrong, but only if you look.

How far to trust the numbers, and the two failure modes that do not show up in
them, are in `docs/retrieval.md` → *What the query set is worth*.

### Re-judging the gold

Gold ages: it is pooled against the corpus of the day, so items added later score
as irrelevant however relevant they are. `eval-pool` builds the candidate list a
judge works through, and writes nothing.

```bash
npm run --silent cli -- eval-pool                       # candidates per query
npm run --silent cli -- eval-pool --depth 100 --json
npm run --silent cli -- eval-pool --query 2 --ids 85,232 # passages, to judge from
```

The pool is the union of FTS and semantic at depth 50 — what hybrid can rank —
**plus everything already judged for that query**. That last part is not
redundancy: at 409 items, 12 of the 139 existing gold items no longer surface in
either ranker at depth 50, so a pool built from the rankers alone would silently
discard judgements that are still correct. They are marked `!`; a judged
candidate shows its grade and an unjudged one a `·`, so the work left is one
scannable column.

An item marked `!` is a **recall ceiling** — no method can retrieve it, so no
amount of tuning will score it. One is currently grade 3.

`--query <n> --ids <list>` prints the chunks nearest the query for those items,
which is what a judgement should rest on. Titles are what got this set
mis-judged the first time.

`eval-judge` grades those candidates through the `claude` CLI, against the same
rubric and from the same passages. It writes nothing: a full run emits a
proposed query set on stdout, to be redirected and diffed rather than applied,
because replacing gold is a reviewed act.

```bash
npm run --silent cli -- eval-judge --validate --anchors 2   # agreement with the human grades
npm run --silent cli -- eval-judge --anchors 2 > eval/proposed.jsonl
```

`--anchors <n>` shows the judge `n` already-graded items per grade as worked
examples, drawn from other queries and held out of scoring. It exists because
the judge grades relative to whatever surrounds it in the batch; a fixed
reference pulls agreement from 74% to 83% and cuts spurious promotions by a
third. It does not eliminate the one-sided skew — treat a full run as a
proposal, not an answer.

**Run `--validate` before trusting a full run — but do not stop there.** It
grades only the items a human already graded, blind, and reports agreement: 85%
on the relevance cut, 11 stricter against 10 looser.

**That number does not transfer to a real run.** Scoring the same items by the
grades a full run gave them: **79%, and 5 stricter against 21 looser.** The
judge grades to the batch it is shown, and validate mode shows it a batch of
pre-selected gold rather than a pool of mostly-marginal candidates. The first
full run produced 739 gold items against 139, which is why
`eval/proposed.jsonl` is a proposal under review and `eval/queries.jsonl` is
untouched. Full working in `docs/retrieval.md` → *The validation number did not
transfer, and why*.

`rechunk` is the same idea one layer down: it re-derives every item's chunks
from the stored content with the current rules. Run it after changing
`src/chunk.ts` — ingest chunks an item only on the write that first stores its
content, so chunks otherwise keep their original shape forever. It rewrites only
the items whose chunks actually differ, and restamps `chunking_version` on the
rest, so after an `--apply` the whole corpus is at the current version.

## Agents and the nightly run

The two consumers that are not a human at a terminal.

### Using it from an agent

`skills/clipbase/SKILL.md` is the agent-facing contract — which ranker to reach
for, how to read a miss, and what the fields mean. Symlink it in:

```bash
ln -s "$PWD/skills/clipbase" ~/.claude/skills/clipbase
```

It lives here rather than in `~/.claude/skills/` directly so it is versioned
alongside the interface it documents: when a result shape changes, the contract
changes in the same commit. It is deliberately **read-only** — search and read,
never write.

Two things exist for that consumer specifically. Search hits carry `summary` and
`topics`, because a snippet says why an item matched but not what it *is*, and
deciding without them costs a second call that returns the whole document.
`show --no-content` is that second call made cheap: 857 bytes against 84KB on a
large item. With `--no-content` the `content` key is *absent* rather than
`null` — `null` is the honest answer for an `extraction_failed` row, and an
agent has to be able to tell "I didn't ask" from "there's nothing there".

### The nightly catch-up

```bash
clipbase-sync                # sync, then classify + enrich + embed
clipbase-sync --sync-only    # stop after the sync, before the passes that spend
```

Scheduled at 05:00 daily as `com.example.clipbase.sync` — rename the label to
your own reverse-domain before installing. The plist is
version-controlled rather than living only in `~/Library/LaunchAgents`, because
the draft that didn't get committed evaporated with its session:

```bash
cp scripts/com.example.clipbase.sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.clipbase.sync.plist
```

The order is the point. `sync-all` lands items that keyword search can find and
that carry no summary, no topics and no vectors — exactly what an agent triages
on — so a sync without the three passes behind it produces items an agent can
find and cannot describe. `scripts/weekly-sync.sh` (the filename predates the
cadence) runs all four and skips the spending ones when nothing new arrived,
because `enrich` bills per model call and `--apply` gates its writes rather than
its calls. A quiet night therefore costs nothing.

`--sync-only` is **not** a dry run, and is deliberately not called one: by the
time it takes effect, `sync-all` has already pulled, fetched and stored.

**The script refuses to start** without `clipbase` and `defuddle` on PATH — and
`claude` too, unless `--sync-only`. launchd supplies no shell profile and no fnm
hook, and `extract/web.ts` resolves `defuddle` and `firecrawl` off PATH with
`execFile`, so a missing one is not an error the run reports: defuddle ENOENT
falls through to firecrawl, firecrawl ENOENT fails the item, and every URL that
night lands as `extraction_failed:thin_content`, indistinguishable from ordinary
attrition. Exit 127 in `~/Library/Logs/clipbase-sync.log` is that failure made
loud. `yt-dlp` and `firecrawl` only warn — `web.ts` deliberately falls through
when they are absent.

It runs locally on purpose. The laptop has the whole toolchain and an
authenticated `claude`, and its residential IP extracts better than a datacenter
one — `defuddle` fetches directly and did 319 of 398 items, so that gap is the
corpus, not a detail.

**The Raindrop triage upstream runs in the cloud, on its own daily schedule.**
Different failure mode, different answer: that half only touches APIs, so no
residential IP is at stake, and a cloud routine survives a closed laptop. They
stay two schedules rather than one job because sync must land *after* triage —
the Inbox collection is deliberately untracked, so a bookmark is invisible here
until triage files it into one of the 13 tracked collections. Sync is offset to
05:00 against a triage routine firing ~03:00.

One consequence worth knowing: sync pages by Raindrop's `created`, and triage
moves items without touching it. An item that lingers in the Inbox past a cursor
advance is paged over permanently — no error, no failure count. Daily-on-daily
narrows that window to hours but does not close it.

## Design principles

- The data model is the core deliverable; the CLI is deliberately thin. See `docs/data-model.md`.
- Immutable raw layer (extracted content, write-once, trigger-enforced) separated from the agent-writable organization layer (topics, tags, links, summaries), which `classify` and `enrich` now populate through the single write path in `src/organize.ts`.
- Embeddings were deferred until the provider/dimension was decided, with the exact migration pre-written in `docs/data-model.md` — which is why `embed` later landed as a mechanical step rather than a restructuring.
- Idempotent everywhere: re-ingest refreshes metadata (never duplicates, never mutates raw content), Raindrop re-sync only pulls new bookmarks, migrations re-run safely.

## Development

```bash
npm test           # node:test suite against a local libsql file DB
npm run typecheck
```

## License

MIT — see `LICENSE`.
