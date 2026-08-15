# Retrieval ranking — decision record

Decided 2026-07-25. Records how `clipbase search` ranks, why, and what to try
instead if it stops working. The schema side lives in `docs/data-model.md`
(`items_fts`, *Vectors*); this record is about ranking.

## Context

Three rankers now exist over the same 409-item corpus:

- **FTS** — bm25 over `items_fts`. Local, instant, no API key.
- **semantic** — cosine over `chunks.embedding`, one query embedding per search.
- **hybrid** — the two fused.

The retrieval eval (`clipbase eval`, `eval/queries.jsonl`, 30 labelled queries)
is what made a third ranker worth building. After the FTS `OR` fix, FTS and
semantic scored 0.555 and 0.750 nDCG@10 — but they **missed on different
queries**. FTS returned no gold at all for the two paraphrase queries (persistent
memory, context window), where the question shares no surface word with the
document. Semantic trailed FTS on exact-term lookups (sandbox, local LLMs,
generic-UI), where the wanted item says the literal words and a neighbouring
item merely means something similar.

Two rankers failing on disjoint query sets is the precondition for fusion being
worth anything. If one dominated the other everywhere, the answer would be to
delete the loser.

## Decisions

### 1. Fuse on rank (RRF), not on normalized scores

`src/rank.ts`. Score-based fusion has to put bm25 and cosine on a common scale.
bm25 returns unbounded negatives whose magnitude depends on corpus statistics —
document count, average length, term rarity — and cosine is bounded 0..1. Any
mapping between them is a calibration, and a calibration fitted at one corpus
size is a hidden parameter that silently rots as the corpus grows: nothing
fails, results just quietly get worse. That was an argument in the abstract when
it was written at 300 items; the corpus reached 409 a week later, and rank-based
fusion needed no attention when it did.

Reciprocal Rank Fusion throws the scores away and keeps only position:

```
score(d) = Σ 1 / (K + rank of d in that list)
```

There is nothing to calibrate, so the ranker cannot drift out of tune with the
corpus. The cost is real and worth stating: RRF discards *margin*. A semantic hit
at cosine 0.95 and one at 0.55 are just ranks 1 and 2, and fusion cannot tell
that the first was far more confident.

### 2. K = 60

`RRF_K` in `src/rank.ts`. K damps the advantage of rank 1 — at 60, the step from
rank 1 to rank 2 is about 1.6%, so one method's confident-but-wrong top hit
cannot outvote agreement further down. That damping *is* the mechanism; a small K
collapses fusion back toward "whatever one method put first", which is the
behaviour being fused away. 60 is the constant from Cormack et al. (2009) and the
default in most implementations since. Both directions are pinned in
`test/rank.test.ts` so the constant's effect is visible rather than assumed.

Not tuned against the eval. 30 queries is better than the 12 this was first
written against, and still too few to fit a hyperparameter to without largely
fitting the query set. The same objection applies to weighting the lists
(decision 4) — one is not a freer parameter than the other.

### 3. Candidate depth 50, not `limit`

`CANDIDATE_DEPTH` in `src/commands/search.ts`. Each method is read 50 deep before
fusing, then the fused list is cut to `limit`. Fusing only the top `limit` of each
throws away the reason to fuse: an item FTS ranks 14th and semantic ranks 3rd is
exactly the item fusion should surface, and it cannot if neither list was read
past 10. FTS recall@10 was 0.639 and semantic 0.825, so those near-misses are
real and sit just below the cut.

Affordable because reads go through the embedded replica (`docs/data-model.md` →
*Why no ANN index*), where the extra rows cost single-digit milliseconds and the
FTS side is free.

### 4. Equal weights, for now

Semantic beats FTS on every aggregate metric, so weighting it higher is the
obvious next knob. It is deliberately not turned: unweighted RRF is the honest
baseline, and the eval now exists to say whether a weight earns its place. Adding
a weight *and* measuring it in the same change would leave no way to attribute
the result.

### 5. FTS stays the default; hybrid is opt-in

`clipbase search` is still bm25 unless `--hybrid` or `--semantic` is passed.
Hybrid needs `OPENROUTER_API_KEY` and the local replica; the bare command must
keep working with neither. Hybrid also spends a query embedding per search,
which the default path should not do silently.

### 6. Graded relevance, and an answer threshold of 2

`src/eval.ts`. Gold items carry a grade: 3 answers the query, 2 is substantially
relevant, 1 touches the subject but is not what you wanted. nDCG uses all three
with exponential gain (2^g − 1); Success@1/@5, MRR and recall count only grades
2 and up.

The threshold is not a taste call, it is a bug fix. Counting any judged item as
a hit means a method scores a success on an item the judge explicitly called
not-the-answer. Measured, on *"my agent keeps rewriting code that already
works"*: semantic puts a grade-1 item at rank 1 while the item that actually
answers sits at 24. Without the threshold that query reports Success@1 = 1.0 and
semantic appears to beat hybrid overall — a conclusion produced entirely by the
noise floor.

A bare id parses as grade 2, so an ungraded set scores exactly as it did before
grades existed: it clears the threshold, and a uniform grade cancels out of nDCG,
which divides by its own ideal. That fixed point is pinned in `test/eval.test.ts`
and is what made it possible to introduce the metric and then change the data,
attributing each result separately.

## Measured (2026-07-25, 300 items)

30 queries, k=10, same corpus, same replica, one shared query embedding per
query so all three see identical vectors. These are the numbers the ranker was
chosen on; for the same eval re-run at 409 items, and why its lower absolutes
are not a regression, see *Limit 1, arriving on schedule* below.

| metric      |   FTS | semantic | hybrid |
|-------------|------:|---------:|-------:|
| Success@1   | 0.567 |    0.700 |  0.800 |
| Success@5   | 0.800 |    0.867 |  0.933 |
| MRR         | 0.675 |    0.774 |  0.871 |
| Recall@10   | 0.655 |    0.792 |  0.849 |
| nDCG@10     | 0.564 |    0.727 |  0.766 |

Hybrid still wins every metric. Against the previous 12-query set, **the old
numbers were understating it**: hybrid's margin over semantic widened on every
metric, most sharply on the two the old set called flat — recall +0.017 → +0.057,
nDCG +0.007 → +0.037.

That revises, without overturning, the conclusion drawn from the 12 queries.
Fusion is still mostly buying precision at the top: MRR gains +0.097 against
recall's +0.057. But "fusion reorders what semantic already retrieved and finds
nothing new" was an artifact of a query set too easy and too narrow to show the
difference. One query settles it:

- **rewriting-code** — FTS **–**, semantic **–**, **hybrid 7**. Neither input put
  the answer in its own top 10 (FTS ranked it 33rd, semantic 24th); fusion
  surfaced it at 7. Agreement between two mediocre rankings beat both. This is
  precisely what decision 3 — reading each list 50 deep rather than to `limit` —
  was built to catch, and the old query set contained no case that exercised it.

Two more carry the trade:

- **generic-UI** — FTS 4, semantic 7, **hybrid 2**. Fusion beat both inputs.
  Neither method was confident, both were roughly right, and agreement promoted
  the item over each list's own noise.
- **stale-instructions** — FTS 3, semantic **–**, **hybrid 6**. The honest cost.
  FTS alone would have served this query better; fusion dragged a good keyword
  hit down behind a semantic list that had nothing. Hybrid is a trade, and these
  queries are what pays for the wins above.

## What the query set is worth

`eval/queries.jsonl`, 30 queries. Every graded item was read — its actual
`item_content` and the chunks the query matches — not just its title. Each
carries a `why` recording the judgement. That is a real improvement on the
previous set, which was drafted from titles and topics; re-judging those 12
found gold sets badly under-inclusive (the first query's grew from 5 items to
18, and FTS's own top hit for it had been scored as a miss).

Three limits, and they are the ones that matter:

1. **Judged by pooling, so recall beyond the pool is unmeasured.** Candidates
   come from the union of FTS and semantic at depth 50 — exactly the set hybrid
   can rank — plus anything already judged (see *The pool is gold ∪ FTS ∪
   semantic* below). An item no method retrieves and no one has judged is
   invisible to the judging and scores as irrelevant. Standard practice (this is
   how TREC builds gold), and the standard bias: it cannot discover what all
   methods miss together.
2. **Judged by the same author who wrote the queries and the ranker.** Reading
   the content removes the "is this plausibly about X" error; it does not remove
   the author's idea of what the query meant.
3. **11 of 409 items are unreachable and excluded.** Items with no extracted
   content never reach `items_fts` (the trigger fires on `item_content` insert)
   and have no chunks, so no method can return them. Item 9, *Browser Use Cloud*,
   is genuinely relevant to the browser-control query and is left out of its gold
   on purpose: including it would measure ingestion, not ranking. That gap is
   real, it is just not this file's job to report it.

### Limit 1, arriving on schedule (2026-07-27)

`sync-all` took the corpus from 300 items to 409 in one run. Re-running the eval
against the enlarged corpus, with the gold sets unchanged:

| method | MRR @300 | MRR @409 | S@1 | S@5 | recall | nDCG |
|---|---|---|---|---|---|---|
| hybrid | 0.871 | **0.816** | 0.733 | 0.900 | 0.815 | 0.720 |
| semantic | 0.774 | 0.766 | 0.700 | 0.867 | 0.756 | 0.693 |
| FTS | 0.675 | 0.642 | 0.533 | 0.833 | 0.638 | 0.543 |

**The ordering held: hybrid is still first on every metric.** That is the result
worth keeping. The absolute drop is *not* readable as a regression, and the
reason is limit 1 above rather than anything about the rankers.

Gold was pooled against the 300-item corpus, so every item added since scores as
irrelevant by construction, however relevant it is. Measured: **about a fifth of
every method's top-10 is now unjudged material** — 60 of 300 slots for hybrid,
61 of 294 for semantic, 64 of 300 for FTS, all items above #302. On three
queries hybrid's *rank-1* result is an unjudged new item and is scored as a
miss, including `#316` for the persistent-memory query.

So the honest reading is that this measurement cannot separate "ranking got
worse" from "gold is now incomplete", and it should not be quoted as evidence of
either. What it does establish is that the *relative* verdict survives a 36%
corpus increase. Restoring an absolute number means re-judging over a pool drawn
from the current corpus — which is the work item, not a re-run of `eval`.

### The pool is gold ∪ FTS ∪ semantic, not FTS ∪ semantic (2026-07-29)

`clipbase eval-pool` builds that pool. The candidate universe for a query is the
union of both rankers at depth 50 — exactly what hybrid can rank, since RRF only
reorders those two lists — **plus every id already judged for it**.

Unioning the existing gold is the part that is easy to get wrong, and the first
run over the 409-item corpus is why it is not optional:

| | |
|---|---|
| candidates pooled | 2533 across 30 queries (mean 84) |
| already judged | 139 |
| left to judge | 2394 |
| **judged items neither ranker reaches at depth 50** | **12 of 139 (9%)** |

Those 12 are healthy items — real content, fully chunked, fully embedded — that
109 new items pushed past the depth cut. A pool built from the rankers alone
would have dropped them silently, discarding judgements that are still correct
and shrinking the recall denominator with them. They are flagged `!` in the
report and sort last, having no rank to sort by.

One of them is **grade 3**: item 85 (*Headroom*, "compress tool outputs, logs,
files before they reach the LLM") for the context-window query. A top-grade
answer that no method can currently retrieve is a **recall ceiling**, not a
judging artifact — `Recall@10` cannot reach 1.0 on that query however the
rankers are tuned, and it is worth knowing that before anyone tunes them.

### What the LLM judge is worth (2026-07-29)

2394 candidates is past hand-judging, so `clipbase eval-judge` grades them
through the `claude` CLI against the same rubric. Before trusting it on the
2394, it was run on the **139 items a human had already graded** — blind, with
the existing grade never in the prompt — and scored against them.

| | | |
|---|---|---|
| agreement on relevance (grade ≥ 2) | **118/139** | **85%** |
| exact grade | 96/139 | 69% |
| within one grade | 137/139 | 99% |
| judge stricter than the human | 11 | |
| judge looser than the human | 10 | |

The relevance cut is the row that matters: Success@k, MRR and recall see only
grade ≥ 2, so 85% is the figure that bounds how much a re-judged gold can be
trusted. Exact-grade agreement is softer than it looks — 99% within one grade
means the judge and the human essentially never disagree about *kind*, only
about where the 2/3 line sits, and nDCG barely moves on that.

The disagreement here is symmetric — 11 stricter against 10 looser — which
would be noise that cancels in an aggregate. **It does not survive contact with
a real run. See the next section: this number does not transfer.**

Two cautions the run surfaced:

- **Q20 (go-to-market tooling) is the outlier**: 4 of the 10 looser calls are in
  that one query, where the human read "GTM" narrowly and the judge did not.
  A query whose disagreements cluster is a query whose *wording* is ambiguous,
  not one where the judge failed. Re-read it by hand before accepting its gold.
- **This measured the judge on the hard slice.** All 139 are items a human
  already thought worth grading. The 2394 are mostly obvious non-matches, where
  agreement should run higher — so 85% is closer to a floor than an average.

### The validation number did not transfer, and why (2026-07-29)

The full run over all 30 queries produced **739 gold items against 139**, and
**290 relevant (grade ≥ 2) against 87** — a 3.3× increase in the only tier the
headline metrics can see. That is too large to accept on the strength of an 85%
agreement figure, so the figure was re-derived from the run itself.

Scoring the *same 139 human-graded items* by the grades the **full run** gave
them (excluding the 4 queries with a failed batch, so a lost batch is not read
as a demotion):

| | validate mode | full run |
|---|---|---|
| agreement on relevance | 85% | **79%** |
| exact grade | 69% | 60% |
| judge stricter | 11 | **5** |
| judge looser | 10 | **21** |

**The judge grades more generously in a real run than in validation, and the
cause is batch composition.** Validate mode puts ~5 pre-selected gold items in a
batch — every candidate is already plausible. A real batch is ~20 drawn from the
whole pool and is mostly marginal, and against weak neighbours a middling item
reads as good. The scale is relative to the batch, so it moves with the batch.

This is a flaw in the validation method, not only in the judge: **it measured
the judge in a context the judge never actually runs in.** Any `--validate`
figure quoted in isolation is optimistic for that reason.

The consequence is that the 4:1 looser skew is systematic, not noise, and by the
standard set one section above — a one-sided judge shifts every metric and
quietly rewrites the ranking — **this proposed gold must not be cut over as-is.**
It sits at `eval/proposed.jsonl` for review, and `eval/queries.jsonl` is
untouched.

Two supporting details, both pointing the same way:

- Of 185 newly-relevant items, only **61 (33%)** come from the post-sync corpus
  the human could never have judged. The other **124 (67%)** existed when the
  gold was written, and the human either graded them 1 or left them out. Corpus
  growth explains a third of the increase, not the increase.
- On items the human explicitly graded, the full run **promoted 24 and demoted
  6**. A judge that mostly disagrees upward is recalibrating the threshold, not
  finding missed answers.

The 2026-07-25 hand re-judge grew query 0's gold from 5 items to 18 and was
correct to, so "the old gold is under-inclusive" is a live hypothesis and not
merely a rationalisation — but it cannot be separated from judge drift by this
run. (Settled by hand review — see *The promotions, reviewed by hand* below:
drift, except on the one deliberately broad query.) Distinguishing them by
machine alone needs a judge calibrated in production-shaped batches:
anchor each batch with a few known-graded items, or re-validate using full pool
batches and score only the graded subset, which is what the table above does
after the fact.

### Anchoring the scale helps, and is not enough (2026-07-29)

If the judge grades relative to its batch, give it a fixed reference. `--anchors
<n>` puts `n` already-graded items per grade ahead of the task as worked
examples — their passages, their grade, their recorded reason — drawn from
*other* queries and held out of scoring, so they fix the scale without revealing
an answer being measured.

**It does not work, and the way it fails is the useful part.** Measured first on
12 queries it looked like a clear win — 74% to 83% on the relevance cut. Run
over all 30 and scored on the 26 queries both runs completed (113 items, six
anchor items held out of both sides):

| | unanchored | anchored |
|---|---|---|
| agreement on relevance | 79% | **79%** |
| exact grade | 61% | 64% |
| judge stricter | 5 | 8 |
| judge looser | 19 | 16 |
| promotion rate | 17% | 14% |

Nothing on the metric that matters. Splitting by distance from the two queries
the anchors were drawn from says why:

| | unanchored | anchored | |
|---|---|---|---|
| queries 0–11, near the anchor queries | 74% | 81% | **+8** |
| queries 12–29, far from them | 83% | 77% | **−7** |

**The anchors teach the subject, not the scale.** They help where the query
resembles the ones they came from and hurt where it does not, and the two
cancel. A fixed global anchor set is therefore the wrong instrument: the judge
is not missing a definition of "grade 2", it is reading relevance off whatever
material is nearest to hand — the batch before, the worked examples now.

The first measurement was also a self-inflicted selection artifact. The 12-query
subset was chosen to keep the run cheap, and queries 0 and 1 — the anchors'
source — sit inside it. **Validate a calibration fix on queries the calibration
was not drawn from**, or the measurement is circular.

Two things worth recording about building the anchors, because both were wrong
on the first attempt and neither was obvious:

- **Anchors must spread across queries.** Taken in order they all landed in
  query 0, which both taught that query's subject alongside the scale and
  subtracted six items from the scoring of the query holding the most gold.
- **A worked example cannot be required to carry a reason.** All 48 grade-3
  items record a `why` and **none of the 52 grade-1 items do** — they are bare
  ids. Requiring one left the bottom of the scale with no example at all, which
  is exactly the boundary the judge drifts across. A reason is now preferred and
  never required.

Cross-checking against the recall ceiling: the anchored judge demotes **none of
the 12 unreachable items** below the relevance cut. It agrees with the human on
every one that sits at or above it — #85 at grade 3, #152 and #122 at 2 — and
raises #17 from 2 to 3. Every promotion it proposed among the twelve (#25, #232,
#21) was rejected by hand. **The ceiling is settled, not conditional.**

Two corrections to how this was first written down, both worth the space because
each is a mistake the data invites:

- **It is 4 items, not 12.** Twelve is the count of unreachable *judged* items;
  eight of them are grade 1 and never entered the relevance denominator. What
  actually caps `Recall@10` is the four at grade 2+ — #85 (Q2), #152 (Q15), #122
  (Q17), #17 (Q24) — one query each. Counting judged items and counting the
  ceiling are different sums, and the pool report prints the first.
- **A grade belongs to a (query, item) pair, not to an item.** The claim that
  the judge demoted #152 and #122 came from the *unanchored* run, where #122 is
  graded 1 on **Q0** and #152 is graded 1 on **Q8** — queries where neither is
  gold and both are ordinary pool candidates. On their own gold queries that run
  grades them 2 and 3, the same as the human. Reading a pooled grade as a
  property of the item silently moved a judgement across queries.

`eval-pool --query <n> --ids <list>` shows the passages behind a judgement: the
chunks nearest the query, not the document's opening ones. Judging from titles is
the error this query set already corrected once, and a document's head is barely
better — a GitHub README opens with badges. Item 85 illustrates the cost: its two
nearest chunks are its badge row and a comparison table, which is a lead on *why*
it falls out of reach, and a hint that chunk-level chrome is worth a look.

### The promotions, reviewed by hand (2026-07-29)

The 19 promotions — items the human graded 1 that the judge raised to 2+ — were
the direct test of the under-inclusive-gold hypothesis, reviewed one query at a
time from the passages. **16 of 19 rejected. The judge's threshold is simply
lower; the old gold was not under-inclusive** — with one narrow exception below.

Three observations from the rejections, each usable beyond this run:

- **The judge's rationale is more reliable than its grade.** In nearly every
  rejection the reason itself named the miss on the query's defining axis —
  "but docs not session memory", "not shadcn", "no cold boot perf numbers" —
  and the grade said 2 anyway. The judge reads "substantially relevant" as
  *to the topic area*; the scale means *to the query*. When rationale and grade
  disagree, believe the rationale.
- **Five rejections re-litigated calls the query notes had already made** — Q0's
  note defines grade 1 as exactly the codebase-wiki class it promoted twice,
  Q13's note rules on item 91 by name, and crabbox was promoted on Q28 after
  being deliberately excluded on Q1. A judge with the notes in its prompt still
  graded against them.
- **Jargon queries are the worst place to accept promotions.** Q27 (shadcn) and
  Q28 (MicroVM cold boot) exist to test exact-term retrieval; promoting
  near-misses that lack the term would blunt what those queries measure.

The exception: **all three accepted promotions sit on Q20**, the deliberately
broad go-to-market query — Adspirer, Intempt and Synter, each squarely an
agent-runs-marketing product, each now grade 3. The validate run had already
flagged Q20 as the query whose disagreements cluster ("the human read GTM
narrowly"), and that prediction held. The generalisation: **on specific queries
the judge's excess promotions are threshold noise; on broad topical queries
they are signal worth reviewing.**

The review itself was cheap — 19 items in one sitting, from passages grouped by
query. The sheet's design (verdicts pre-filled, judge reason visible, human
grade beside it) is what made the rationale-versus-grade inconsistency visible
at all.

### The demotions, reviewed by hand (2026-07-29)

The 8 demotions — existing gold at 2+ that the judge dropped to 1, each
pre-filled to *remove* a grade already paid for — are the promotions' mirror,
and they do not behave like them. **4 of 8 rejected, against 16 of 19 on the
promotions.** The judge is markedly more reliable pointing down than up.

The split is not noise. It falls on a single axis: **who read the document.**

| accepted (judge right) | the human graded from the title |
|---|---|
| #150 Q5 local LLMs | "self-hosted agent OS" — but what runs locally is the cockpit; Ollama is 1 of 9 providers, the rest cloud. The same shape as #137, already a named distractor in that query's note. |
| #268 Q13 debug MCP | 8323 words with zero occurrences of *inspector*, *debug*, *troubleshoot*, *stdio* or *schema* (the 28 "log" hits are all "catalog"). Running servers under Docker is the deploy category the note excluded by name on #252. |
| #57 Q16 CLAUDE.md | `curl … >> CLAUDE.md`, no repo analysis anywhere. The human's own item note concedes it: "not a generator". |
| #101 Q28 MicroVM | No MicroVM, no Firecracker, no boot timings. The pitch is the inverse of cold boot — always-on, no teardowns. |

| rejected (judge wrong) | the judge graded from chunks or vocabulary |
|---|---|
| #100 Q7 agent inbox | "file-transfer identity, not send/receive mail" is false: inbound SMTP with exact-domain DKIM, `check_inbox`/`read_message` MCP tools, mail to `openclaw-dev@…` lands in the agent's inbox, and verified agents send to other hosts. |
| #97 Q11 browser agent | The reason is its own confession — "relevant title but passages are only badges/links". The document is squarely on-query: multi-page agent, form filling, MCP browser control. |
| #32, #73 Q18 article→video | Both rejected as "not from articles", against a query whose note reads *"Paraphrase: no corpus item uses the phrase 'written article'."* #73 in particular reads README and landing-page prose, synthesises per-act narration, and renders a voiced, captioned video — text to produced video, end to end. |

Three things this adds to the promotions writeup:

- **The two agents fail in complementary directions, on the same missing
  evidence.** A title-graded human over-credits identity; a chunk-graded judge
  under-credits documents whose nearest chunks are chrome. Both are cured by
  reading the item, and demotions are where the human's version of the error
  surfaces — promotions could not expose it, because there the human's grade of
  1 was the conservative one.
- **Chunk chrome is now the leading cause of judge error, not threshold
  drift.** #97 and item 85 in the recall-ceiling analysis are the same defect
  seen from two directions: a badge row outranking the README body. That makes
  chunk-level chrome stripping a retrieval fix with a measured cost, no longer
  just "worth a look".
- **The note-conflict signal cuts both ways.** Session 6 used "judge reason
  contradicts a query note" as the fastest reject signal; #32 and #73 are two
  more instances. But **#101 is the first note that failed verification
  itself** — it claims "a sandbox-provider isolation comparison" the stored
  document does not contain (there is one positioning line). Either the note was
  written from the live page or extraction dropped a section. Notes are evidence,
  not ground truth; the passages are.

Running total: 27 of 176 reviewed, 149 to go (45 new-3, 104 new-2). Gold stands
at 288 (235 relevant) — still not quotable until the rest are reviewed.

### Measuring the agent reviewer before trusting it (2026-08-02)

The remaining 149 items are past hand-reviewing in one sitting, so they went to a
fan-out of agents that read each stored document and checked the judge's grade
against it. That is a second judge grading the first, and it earns the same gate
the first one got: **measure it before the cutover.**

The gate was a blind re-run over the 27 items already decided by hand, with the
`VERDICT` lines redacted and the agents blocked from this file, the changelog and
the handoffs — all of which name these items and their answers. One line had to
come out of the rubric too: the count of how many promotions were rejected by
hand is the answer key for exactly this set.

**Compute the degenerate baseline first, or the agreement number means nothing.**

| | score |
|---|---|
| always side with the existing human grade | 20/27 (74%) |
| always side with the judge | 7/27 (26%) |
| the agent reviewer | 21/27 (78%) |

78% against a 74% baseline is a one-item difference. Read as an aggregate the run
says nothing — and a reviewer that hit the baseline by deferring would still be
worthless on 149 items that *have* no human grade to defer to. What made the run
usable was the breakdown:

| | agreement |
|---|---|
| **HIGH confidence** (15 items) | **15/15** |
| **MEDIUM confidence** (12 items) | **6/12** |
| demotions (baseline 50%) | 6/8 |
| promotions (baseline 84%) | 15/19 |
| excluding Q20 | 20/23 |

Four things worth keeping:

- **Confidence has to be its own field.** The first pass folded it into the
  verdict as an `UNCERTAIN` option and returned **zero uncertain across 149
  items** — with nowhere to put doubt, the model put it in the grade. Split into
  a separate axis, the same method reported 98 of 149 as MEDIUM. Uncertainty does
  not disappear when you remove the place to record it; it migrates into the
  answer.
- **The failure mode is hedging to the middle.** All six calibration errors were
  the grade **2**, chosen because the item sat between 1 and 3. The rubric now
  names this and adds the test: if you pick 2 and cannot say what would have made
  it a 1 or a 3, that is MEDIUM at best.
- **It beats deferral where deferral is hard and loses where it is easy** —
  +25 points over baseline on demotions, −5 on promotions. That is the shape of
  a reviewer rather than a parrot, and it is invisible in the aggregate.
- **Q20 again.** Three of the six errors land on the broad GTM query the validate
  run flagged as the ambiguous-wording outlier back in session 5. Excluding it,
  agreement is 87%. That query has now predicted its own disagreements three
  times; it is a property of the query, not of whoever is grading.

Independent corroboration arrived free. The 149 were reviewed twice — once under
the miscalibrated rubric, once under the gated one — and the two runs agree on
**50 of 50 HIGH items (100%)** and 71 of 98 MEDIUM (72%). All 27 disagreements
sit in the band the method itself flags as unsure. Two differently-prompted
passes converging exactly where one claims confidence is stronger evidence than
the 15 calibration observations alone.

So the 50 HIGH calls were applied — 23 confirming a judge grade of 3, 25 dropping
a proposed 2 to 1, plus one 3→1 and one 3→2, each resting on a quoted line or a
verified absence rather than a judgement. The other **99 remain for a human**.
The MEDIUM rate (66%) came in well *above* the calibration set's 44%, which is
the opposite of the prediction: the new items are an easier population but a
harder task, because "what does this earn" has no anchor where "which of these
two claims is right" had one.

Running total: 77 of 176 reviewed. Gold 288 (209 relevant), still not quotable.

### The one item this set caught, and what fixing it cost

Item 5 (Karpathy's LLM talk, the answer to the video query) stored a YouTube 403
page instead of the transcript — the only one of 35 youtube.com items that failed
that way, and it carried `status='ok'` regardless. It now holds the real
12,175-word transcript.

Three things that fix taught, all of which outlast it:

1. **A length gate cannot detect a wrong document.** The 403 page was 1,972 words
   and `isThin` cuts at 100, so it stored clean. A later refetch returned a
   111-word player shell, which also cleared the gate. `src/extract/web.ts` needs
   a validity check (`Error 403`, `Sign in to confirm`, `unusual traffic`)
   independent of length.
2. **`status='ok'` plus content is treated as unimprovable.** `ingestUrl` returns
   early for any such item, so a bad extraction is permanent — a re-ingest is a
   no-op, and repairing item 5 meant deleting a write-once `item_content` row by
   hand. There is no supported path back.
3. **firecrawl is not reliable on YouTube.** One fetch returned the full
   transcript; five consecutive fetches after it returned the bot-block shell.
   The transcript came from `yt-dlp` auto-captions instead. 34 of 35 youtube.com
   items have real transcripts, so this is a flake to detect and retry, not a
   broken pipeline — but the detection is the missing piece.

**Fixing the data made FTS score worse**, which is worth sitting with. On the
video query FTS fell from rank 9 to outside the top 10, and the aggregates dropped
with it (Success@5 0.833 → 0.800, recall 0.688 → 0.655). Nothing regressed: the
403 page was short, so bm25's length normalization flattered it, and the real
transcript is 12,175 words against a 3,124-word corpus average. bm25 discounts a
long document's term matches, so the item is now *harder* for keyword search
despite containing far more of what the query asks about — it ranks 7th for
"scaling OR laws" behind items with the phrase only in a title.

Semantic did not move (rank 1), because it scores chunks and never sees the
document length. That is the sharpest argument in this file for not shipping FTS
alone as the corpus takes on long documents, and it arrived by accident.

### The remaining 99, decided by hand (2026-08-04)

All 99 are now human-decided, plus four adjustments to calls applied in an
earlier pass. Gold is **287 items, 146 graded 2 or 3, forming 142 answer
groups** — the four near-duplicate echoes carry their real grades and their
group counts once, which is what recall divides by. Every relevant item was
graded by a person. Reasons live in `eval/reviewed.json` — one per decision,
resting on a quoted line or a verified absence — because `review.md` cannot carry
them (`apply-review.mts` parses `^VERDICT: [0-3]$`, so anything trailing breaks
it). Session 7's 50 HIGH calls lost their evidence to `/private/tmp`; this pass
does not repeat that.

**The conclusion never moved.** Three gold sets, same 30 queries, k=10:

| | | FTS | semantic | hybrid |
|---|---|---|---|---|
| Success@1 | original hand gold (84 relevant) | 0.500 | 0.667 | 0.733 |
| | judge-accepted (209 relevant) | 0.533 | 0.733 | 0.800 |
| | **human-reviewed (142 relevant)** | 0.500 | 0.700 | 0.800 |
| MRR | original | 0.621 | 0.743 | 0.805 |
| | judge-accepted | 0.660 | 0.807 | 0.865 |
| | **human-reviewed** | 0.637 | 0.784 | 0.854 |
| Recall | original | 0.612 | 0.745 | 0.749 |
| | judge-accepted | 0.507 | 0.618 | 0.623 |
| | **human-reviewed** | 0.576 | 0.675 | 0.691 |
| nDCG | original | 0.529 | 0.678 | 0.691 |
| | judge-accepted | 0.488 | 0.634 | 0.659 |
| | **human-reviewed** | 0.499 | 0.645 | 0.667 |

Hybrid > semantic > FTS on all five metrics under all three sets. Two sessions of
judging and a full hand pass did not change the answer this eval exists to give.
What the pass bought is **recall, 0.623 → 0.691**, by removing 67 non-answers from
the denominator; every other metric moved ≤0.011. The error it prevented was
specific and directional, not general — accepting the judge would have understated
recall by seven points while leaving Success@1 identical.

**The MEDIUM band is worth less than a constant.** Session 7 gated the agent
reviewer on 12 MEDIUM observations and got 6/12. With 99:

| | agreement with the human grade |
|---|---|
| **always answer 1** (degenerate baseline) | **62/99 (63%)** |
| the judge's pre-fill, i.e. what shipping unreviewed would mean | 28/99 (28%) |
| agent reviewer, pass A | 67/99 (68%) |
| agent reviewer, pass B | 54/99 (55%) |
| both passes where they agreed *with each other* | 48/72 (67%) |

Four things worth keeping:

- **Compute the degenerate baseline again, on the new population.** Pass A beats
  always-answer-1 by five points and pass B is eight points *below* it. Session 7
  computed a baseline against the *human grade* on items that had one; on items
  that have none, the baseline is the modal grade, and nobody checked it. The
  MEDIUM band must never be auto-applied.
- **Concordance between two passes is not evidence at MEDIUM.** Where both passes
  agreed with each other, the human still overruled 1 in 3. At HIGH the same
  signal held 50/50; the inference does not transfer down a confidence band.
- **Divergence localises the answer even when it does not settle it.** Where the
  passes disagreed, the human picked one of their two grades 25 times out of 27 —
  so a divergent pair is a two-way question, not an open one.
- **The judge over-grades everywhere, not just at 2.** Of 79 proposed 2s, 50 became
  1; of 20 proposed 3s, 12 became 1. It would have added 99 answers where 35 were
  earned. Session 7 named hedging-to-the-middle as the *reviewer's* failure; the
  *judge's* is inflation across the scale.

**Rules the pass settled**, now recorded in `eval/reviewed.json` and applied
throughout:

1. Grade against the query as a literal search, benchmarked against the items
   already graded 3 for that query.
2. A grade belongs to a (query, item) pair. gstack is 1, 2, 1, 2 across four
   queries — it *ships* a browser and only *mentions* someone else's isolation.
3. **Canonical + echo** for near-duplicates — *superseded the same day by
   equivalence classes; recorded because the reasoning is why the field exists.*
   Where one publisher states the same
   claims at two URLs, the fuller entry keeps its grade and the other drops to 1.
   It stays in gold, so returning it earns nDCG credit rather than scoring as
   noise, but it leaves the recall denominator, so no method is punished for
   returning one copy instead of two. A repo and a third party's article about it
   are *not* echoes. Five pairs found: 335/336, 20/131, 159/202, 93/101, 53/326.
4. Grade from the mechanism a document ships, not from framing that reuses the
   query's vocabulary. This was the reviewer's leading error and it recurred.
5. A real capability bundled in a larger product is 1; a claim with no mechanism
   is 1; only an item off the subject entirely is 0.

**Q20's ambiguity had a cause, and it is now fixed in the note.** The query had
flagged itself three times (session 5's validate run, three of six calibration
errors in session 7). The cause was not wording: *GTM* had no settled definition
for the grader. Notes are grader instructions and never reach retrieval
(`spec.query` is what gets searched), so the definition was pinned in Q20's note
without touching the query text or comparability. Two other notes restated corpus
counts that the corpus had outgrown — Q2's "only two items address tool output"
and Q15's "only item 156 satisfies both" — the same silent-drift failure the skill
had before PR #22. Both now state the rule and no count.

**Gold is quotable for a 411-item collection, not for the live corpus.** The pool
these judgements were drawn from tops out at item 411; the corpus is now 485. All
76 never-pooled items are graded 0 by omission, and they take **89 rank slots in
some method's top-10 across 27 of the 30 queries** — 67 distinct (query, item)
pairs, drawn from 38 distinct items. Unjudged hits do not merely score zero, they
occupy rank slots and push real answers down. Every number in the table
above is therefore a floor, and understated unevenly: a method better at surfacing
recent items looks worse. Two fixes, in order: record a collection ceiling in the
query set and filter eval candidates to it, so the measurement matches what was
judged; then re-pool over 412–485. `#420 agentbox` ("Run multiple agents in
parallel sandboxed VMs, with a single command") is a clear Q17 grade-3 that today's
eval scores as a miss.

### The pin, and what it was worth (2026-08-04)

The first of those two fixes is in. `eval/queries.jsonl` now has a sibling
`eval/queries.collection.json` holding `{maxItemId: 411, pooledAt}`, and `eval`
filters candidates to that ceiling **inside each search's `WHERE`**, before
`LIMIT` and before fusion. Four things about the shape, in the order they were
argued:

- **A sibling file, not a header line in the JSONL.** Five `.mts` scripts
  hand-parse that file and index queries by array position; a header would shift
  every `Q<n>` by one. It also survives `apply-review.mts` by construction — the
  script never reads it, so a fold cannot drop it.
- **An id cutoff verified by a timestamp, never a timestamp cutoff.** The pool is
  a set of ids and the prose already talks in ids. `fetched_at` is disqualified
  outright: `upsertItem` overwrites it on re-ingest, so a fetched-before cutoff
  would evict judged items — item 5, the transcript repair, is a grade-3 answer a
  re-fetch would push outside its own collection. The one assumption ids carry is
  that they are monotonic, which holds only while the highest row is never
  deleted, and `recanonicalize --apply` deletes item rows. So `pooledAt` exists
  as a **check**: any item under the ceiling whose `created_at` postdates pooling
  is a reused id, and the run fails naming it.
- **In SQL, not on the returned ranking.** Post-filtering hands back fewer than k
  hits — shortest for the method best at surfacing recent items, so it flips the
  bias instead of removing it — and it cannot be made to work for hybrid at all:
  RRF scores positions, an ineligible item above an eligible one shifts that
  item's rank by different amounts in the two lists, and the fused order changes.
  A test pins that difference on a fixture where the top hit swaps.
- **A missing pin fails the run.** Defaulting to "no ceiling" reproduces the
  understated numbers with nothing on screen to say so, and those are the numbers
  that get quoted. `--collection all` waives it and prints an UNPINNED warning in
  the same place as the numbers.

**The numbers, as a fourth measurement — not a better run of the third.** Same 30
queries, same gold, same k. The unpinned column reproduces the human-reviewed row
above exactly, which is the check that the ceiling is the only thing that changed:

| | | FTS | semantic | hybrid |
|---|---|---|---|---|
| Success@1 | whole corpus (485, a floor) | 0.500 | 0.700 | 0.800 |
| | **items 1–411 (judged)** | 0.533 | 0.700 | 0.800 |
| Success@5 | whole corpus | 0.833 | 0.900 | 0.900 |
| | **items 1–411** | 0.833 | 0.933 | 0.933 |
| MRR | whole corpus | 0.637 | 0.784 | 0.854 |
| | **items 1–411** | 0.657 | 0.787 | 0.854 |
| Recall | whole corpus | 0.576 | 0.675 | 0.691 |
| | **items 1–411** | 0.585 | 0.685 | 0.716 |
| nDCG | whole corpus | 0.499 | 0.645 | 0.667 |
| | **items 1–411** | 0.513 | 0.658 | 0.690 |

The pinned row is the shipping number, measured after equivalence classes and
after #410 was corrected from 3 to 2: FTS recall and nDCG each gain ~0.003 where
a group's second URL now answers, and semantic nDCG gives back 0.001 on the one
query #410 sits in.

Every aggregate moved up or held, and the largest movements are hybrid recall
(+0.025) and hybrid nDCG (+0.022) — the two metrics that count what fills the
whole top-10 rather than what sits at the top. **The conclusion still never
moved**, though the claim needs one word of care: hybrid > semantic > FTS
strictly on Success@1, MRR, recall and nDCG, and Success@5 is a *tie* between
hybrid and semantic (0.933 pinned, 0.900 unpinned). That tie predates the pin.

**The floor argument does not extend to hybrid, and it is worth being exact
about why.** For FTS and semantic the pinned list is the unpinned list with
ineligible rows deleted and order preserved, so every metric weakly improves —
that much is forced. RRF is *not* order-preserving under deletion: score is
`Σ 1/(K + rank)`, two eligible items gain unequal amounts when an ineligible one
above them is removed, and the fused order can shuffle downward. It did:
**hybrid's first answering rank on Q23 moved 7 → 10** under the ceiling, which is
also why hybrid MRR is flat to three decimals (+0.033 of Success@5 has to buy at
least 0.0011 of MRR, so something else gave the mass back). The pin cannot be
described as "can only raise the numbers" for a fused ranker — that it did raise
them here is an observation, not a guarantee. It is the same non-monotonicity
`searchHybrid` invokes to justify filtering in SQL rather than after fusion.

**One approximation, recorded so it is not later reported as a bug.**
`items_fts` still indexes all 485 documents, so bm25's IDF and average document
length are computed over the full corpus. *Membership* is exact — no unjudged
item can occupy a rank slot, which is the entire bias being removed — but FTS's
ordering among eligible items is not bit-identical to an index built over 1–411.
Semantic is exactly equivalent (cosine per chunk depends on nothing global);
hybrid inherits FTS's approximation only through rank order. Exactness would need
a second FTS index over the subset, which is disproportionate.

**`eval-pool` and `eval-judge` stay uncapped, deliberately.** Pooling is what
extends the collection; capping it would make re-pooling 412–485 impossible.
**`maxItemId` moves in the same commit as the re-pooled gold, never separately.**

### Gold equivalence classes, superseding rule 3 (2026-08-04)

Canonical + echo was a stopgap, and it bought the right thing — the echo leaves
the recall denominator — but it pays for it by lying about relevance. Demoting
the second URL to grade 1 says "this only touches the subject" when it answers
the query as well as its twin, and the next re-pool regrades from evidence and
silently undoes it. Identity is not a relevance claim, so it needs its own field.

`GoldItem` now takes `group?: string`, a product slug. **An item with no group is
its own group of one**, which is the whole design: every metric is defined over
groups, and the current behaviour is the identity reduction of the general one
rather than a branch beside it.

- **IDCG** takes one representative per group, at the group's *maximum* member
  grade — the ideal has to be a ranking a method could actually produce, and
  returning the group's best member is the best it can do.
- **DCG credits each group once**, at the best `gain × discount` any of its
  in-top-k members earns. This is load-bearing, not tidiness: cap only the ideal
  and nDCG goes to **1.45** on gold `{A g3 grp X, B g3 grp X, C g2}` ranked
  `[A,B,C]`. It is 0.956 with the cap — the second copy earns nothing further,
  but it still spent rank 2, which the ideal spent on C.
- **Not** the group's best grade at its first member's rank, the tempting
  alternative: that scores a grade-1 echo at rank 1 as if the answer were there,
  the exact failure `RELEVANT_GRADE = 2` exists to stop.
- **recall** counts groups with an answering (grade 2+) member over groups whose
  best member is grade 2+. A group graded 1 throughout is in neither.
- **Success@1/@5, MRR and firstGoldRank do not change and needed no code.** They
  are existential or earliest-rank predicates over *items*; deduplication cannot
  move which hit is earliest.

**The code ships without the data migration, on purpose.** `eval/queries.jsonl`
still carries the five pairs (335/336, 20/131, 159/202, 93/101, 53/326) under
rule 3, so no published number moves yet. Tagging them means restoring each
echo's grade to what it earns alone, and two of the five are a judgement rather
than a lift: `reviewed.json` records no echo rationale for 53/326, and Q28's
`101 = 1` predates the canonical+echo rule (93 is not in Q28's gold at all), so
it is an older independent call. Re-derive both from evidence and record them in
`reviewed.json`. When it lands, expect **nDCG only** to move — Q22's ideal falls
2.6% and Q27's 7.2% as each loses a redundant slot — and recall, Success@1/@5 and
MRR to sit still, because the stopgap already removed the echoes from every
denominator. A flat table there is the change working, not the change doing
nothing.

Two guards come with it, because a label is cheap to typo and invisible
afterwards: `parseQuerySpecs` rejects an id carrying different labels in
different queries, and `apply-review.mts` carries `group` through the fold — a
verdict regrades a (query, item) pair, it does not decide whether two URLs are
one product. Nothing catches two genuinely different products given the same
slug, which would merge two answers into one; keep labels product-specific.

**The class with no home.** Codebase-wiki tooling — codealmanac (24), plasma-ai/wiki
(25), cartographer (337), and the four like them — is graded 1 in every query it
appears in, and there is no query where it scores as an answer. Holding it at 1 in
Q0 is right (Q0 is a paraphrase test whose answers are purpose-built memory layers,
and promoting the class costs recall 0.50 → 0.37), but the gap is real. The same
shape appeared in Q20, where skills-for-an-agent and SaaS-that-does-it share one
query. Both want a sibling query — "a knowledge base my coding agent writes and
maintains itself", "claude skills for go-to-market" — where each one's answers are
the other's strongest distractors. Neither is worth writing alone: "skills" is in
the titles, so token match would solve it and measure nothing.

### The judge's error has a direction, and a tell (2026-08-05)

Re-pooling for items 412–485 put **316 (query, item) pairs** above the 411 ceiling,
drawn from **70** of the 76 never-pooled items. The judge ran over the *whole* pool
rather than those 316, which costs about 88% of the compute on pairs already
settled by hand. It buys the thing that makes the rest of this section possible:
batches stay production-shaped, and 279 already-decided pairs get re-graded blind
as a side effect. Narrowing the batches to the new material would have measured a
calibration the judge never uses — the mistake recorded under "The validation
number did not transfer".

The run: 142 batches, 0 failures, **7 candidates ungraded** of 2579. An ungraded
candidate is absent from the proposed set, which reads identically to one judged
irrelevant, so the count is the only thing separating silence from a verdict.

Against the 279 human grades, holding out the six anchors:

| | |
|---|---|
| exact grade match | 160/279 = **57.3%** |
| answer/not (≥2) | 191/279 = **68.5%** |
| graded higher than the human | **98** |
| graded lower | **21** |

The aggregate agrees with session 8's 63/68/55% figures, but the aggregate was
never the useful number. **The error runs one way.** Of 138 items a human graded
1, the judge promoted **82** across the answer boundary — 66 to a 2, 16 to a 3.
In the other direction it reproduced **66 of 76** human 3s, and graded 0 to
**none of the 141** items a human called an answer.

So the two grades are worth completely different amounts. Precision of the
judge's **3**, for "is really an answer": 82/98 = **84%**. Precision of its **2**:
53/119 = **45%**. A pre-filled 3 mostly stands; a pre-filled 2 is a coin flip that
lands wrong slightly more often than right.

**The tell.** In 9 of the 14 items the judge pre-filled as a 2, its own stated
reason contains the demotion argument — "not a control panel", "not a generator
tool", "not the running agent itself", "not coding-specific", "CLI use unclear".
It writes down why the item fails the query and grades it an answer anyway. That
is mechanically detectable and worth exploiting: a reason carrying a negation of
the query's own terms is the cheapest demotion candidate in the sheet.

The prediction transferred. Of the 25 pairs the judge claimed as answers above the
ceiling, **12 survived human review** — 48%, against the 45% the precision figure
predicted. Twelve dropped to grade 1, seven held at 3, five at 2.

Two consequences for `make-repool-review.mts`. It surfaces the judge's **grade-1**
rows, not just 2 and 3, because 1-vs-2 is the boundary that decides what the eval
measures and the boundary the judge gets wrong. And it surfaces **grade-0** rows
when either ranker put them in the top 10 — a false 0 is the one error a sheet
cannot catch by construction, since it reaches nobody. That rescue is cheap
insurance rather than a live worry: 0 of 141 human-relevant items were graded 0,
which is also what makes it defensible to drop the 231 unrescued grade-0 pairs
without reading them.

### Folding the re-pool, and reading the drop it caused (2026-08-06)

The 120-row sheet is decided and folded. Gold goes **287 → 375 items, 146 → 162
relevant**, and the pin moves to **487** in the same commit. Every row was decided
by hand and every one carries its reason, so nothing in the set is standing on a
judge pre-fill by default.

Yield by block, against what the prior session predicted:

| block | rows | became answers | predicted |
|---|---|---|---|
| judge claims an answer | 25 | 13 | 11–12 (45% precision) |
| judge says grade 1 | 60 | **3** | 6–7 (11% base rate) |
| grade-0 rescues | 35 | **0** | low |

The grade-1 block came in at **5%**, half the below-ceiling base rate. The rescue
block returned **nothing** at the answer level — three items moved 0 → 1 and none
went higher. That is the second independent confirmation that the judge does not
lose answers downward, and it is what makes dropping the 231 unrescued grade-0
pairs defensible rather than merely convenient.

**The tell runs backwards too.** The demotion signal — a stated reason that negates
the query's own terms — has an inverse worth the same: a reason that *concedes* the
query's subject and demotes on a secondary attribute. Two of the three promotions
came from it. "microVM sandbox discussion, no cold boot performance figures" grants
the subject of Q28 and withholds the grade over a missing detail; "sandbox is minor
feature of a CRM agent app, not the focus" demotes on prominence while the passage
argues a real isolation stance. It is not automatic: the same shape fires on Q22's
sitepins pair (markdown editor, wrong platform) and must be refused there, because
the mirror item — native macOS, not an editor — has an equal claim, and promoting
both turns four near-misses into answers on a query with one true item.

**`maxItemId` is an id, not a count.** The corpus holds 485 items across ids
1..487, because `items.id` is a rowid alias and two ids are gone after deletes.
Pinning to 485 looks right, reads right in a handoff, and leaves gold at 486 and
487 above the ceiling — which `eval` rejects on load. The guard test asserts the
literal so the ceiling can only move as a deliberate edit.

**Reading the metric drop.** Recall and nDCG fell on all three methods. Almost
none of it is the new gold. Scoring old gold at the new ceiling separates the two
causes:

| hybrid | old gold / 411 | old gold / 487 | new gold / 487 | corpus | gold |
|---|---|---|---|---|---|
| Success@1 | 0.800 | 0.800 | 0.800 | — | — |
| MRR | 0.854 | 0.854 | 0.854 | — | — |
| Recall | 0.716 | 0.691 | **0.682** | −0.025 | −0.009 |
| nDCG | 0.690 | 0.668 | **0.663** | −0.022 | −0.005 |

**The corpus effect is 3–4× the gold effect.** The drop is 76 items becoming
eligible to compete for rank slots, not 88 gold items diluting anything. The old
pin was scoring a corpus that no longer existed and flattering the numbers by
hiding recent competitors — the same understatement recorded under "The pin, and
what it was worth", now paid for rather than predicted. FTS is the exception and
gains outright (+0.033 on Success@1, Success@5 and MRR), because Q17's new gold at
417 and 420 lands at rank 1.

Only **5 of 90** query×method first-gold ranks moved. Two are worth keeping:

- **Q13 semantic, 4 → 6.** Ids 434 and 463 take the top two slots, both graded 0
  by hand. Item **463 holds rank 2** for "how do I test and debug an MCP server I am
  building" on the strength of a bare `## MCP Tools` heading — a whole chunk that is
  one heading and nothing else. A real precision failure the old ceiling was hiding,
  and a chunking problem rather than a ranking one. (Corrected 2026-08-13: this
  section shipped saying 463 ranked *first*; the fold session's own rank dump —
  `now: 434 463 268 …, rank 1: id 434, rank 2: id 463` — and the pool sheet
  (`434 · s1`, `463 · s2`) both put 434 first. The slip started in that session's
  summary prose and traveled from here into everything downstream.)
- **Q2 hybrid, 5 → 6.** Id 486 enters at rank 3 as a legitimate grade 1 and pushes
  an answer down a slot. Working as designed: a grade-1 item takes the rank slot
  whatever it is graded, and the grade only decides the nDCG credit.

Nothing unpooled displaced anything, in either case.

**Extraction noise ranks.** Medium's Speechify "Text to speech" link survived
extraction on item 458 and is now indexed as content: semantic rank **2** for
"clone a voice and generate speech from text", rank 6 for the article-to-video
query. Unlike the 13 known extraction failures, this one does not fail loudly —
it produces a confident wrong hit near the top of the list. Page furniture that
survives extraction is worse than content that does not.

**The FTS approximation is dormant, not fixed.** The caveat recorded under "The
pin, and what it was worth" — `items_fts` indexes every document, so bm25 draws
IDF and average document length from the whole corpus while membership is
filtered to the ceiling — does not bite at a ceiling of 487, because the filter
now excludes nothing and the statistics are computed over exactly the scored set.
It returns the moment item 488 is ingested, silently and with no symptom, and
stays wrong until the next re-pool moves the ceiling back up to the corpus. Read
any number measured between an ingest and a re-pool with the caveat live again.

**A reason has to travel with its grade.** `apply-review.mts` scraped the `why`
for every added gold item from the sheet's `JUDGE:` line, so an item a human moved
off the pre-fill arrived in gold carrying the argument for the grade it no longer
had — three rescued items would have shipped reading "(graded 0 — not in the
judge's proposed set)" while sitting at grade 1. That is session 7's failure at the
last hop: the grade survives, the reason does not. It now takes the ledger as an
optional argument, prefers a human reason wherever one exists, and reports the
split so a forgotten ledger reads `0 from the ledger` instead of passing silently.

### The heading was not a passage (2026-08-08)

Item 463 taking a top-two semantic slot on a bare `## MCP Tools` chunk is fixed in the chunker, at
`CHUNKING_VERSION` 3. `src/chunk.ts` splits before every heading line and then let
the accumulator flush between the heading and the block it labels, so the label
was embedded as a passage in its own right — and three on-topic words beat a
1400-char passage that is merely mostly on-topic, because `search --semantic`
collapses chunks to items by max score.

**The symptom is 0.06% of the corpus and the defect is 11.6%.** Measured over the
8522 stored chunks, counting a chunk as misplaced when its last line is a bare
heading and it has a line above: 5 are a heading and nothing else, and **985 more
end on a heading whose body went to the next chunk** — the same accumulator, the
other side of the flush, and the same divorce of a passage from its title. Only
316 chunks lead with their heading, so a heading lands on the wrong side of a
boundary 3.1× more often than the right one. 368 of 472 items are affected.

The fix binds a heading to the first *piece* of the following block rather than to
the block. An oversized block is sliced to `TARGET_CHARS` afterwards, and the
slice joins words with single spaces, so binding before it flattens the heading
into the word stream: over the 66 items with an oversized block under a heading,
the one-line block-level version still leaves 2 trailing-heading chunks where the
piece-level one leaves none.

**Binding stops at the ceiling, because the alternative is destroying a table to
save a heading.** Re-splitting a bound pair to get it back under `MAX_CHARS` runs
it through the same word-packer, which discards the whitespace it splits on: a
2395-char markdown table under a 9-char heading came out as three fragments on a
single line, 83 newlines gone, and item 13's 41 chained `#` lines lost 84 more.
Past the ceiling the headings are emitted on their own again and the accumulator
packs them as v2 did — a heading stranded once is cheaper than a table flattened,
and the trade only arises where a heading run plus its block exceeds 2400 chars.
A document ending on a heading is the mirror case: with no block beneath to bind
to, the heading joins the passage *above* rather than standing alone, which is
backwards-absorption used only where forwards does not exist.

Simulated over every item's real content: heading-only **5 → 0**, trailing-heading
**985 → 7**, leading-heading 316 → 1270, chunks 8522 → 8532, longest chunk 2398,
nothing over `MAX_CHARS`. **No line is lost or reflowed anywhere**: the multiset of
non-empty lines is identical before and after on all 472 items, so only boundaries
move. **That holds for this fix and stops at its edge** — the footer strip in the
next section deletes lines by design, so the claim does not survive being carried
to the applied state, which ships both. It was carried anyway; see the correction
under "The rank moved and the aggregate did not follow". All 7 residual trailing
headings are item 13, where the split reads `#`
comment lines inside a fenced `.env` sample as headings and chains 41 of them past
the ceiling — the accidental-heading case the guard above deliberately accepts, and
fencing-aware splitting is its real cure.

**Rejected: a minimum-content floor.** Absorbing undersized chunks forward is 2.6×
cheaper to reprocess and it does fix item 463 — but it fixes 5 of the 990 misplaced
headings and leaves 985 passages separated from their titles. It also absorbs the
329 badge/link rows into adjacent real passages, diluting a good chunk's vector
with a URL blob; inert junk that never wins a query is strictly better than that.
Chrome stripping stays where "Chunk chrome is now the leading cause of judge
error" already sites it, in the extractor — no chunker variant moved that count off
329.

**Cost, and what is not yet known.** `rechunk` deletes and reinserts every chunk of
a changed item, so this drops **7360 embeddings and re-embeds 7370 — 86% of a
from-empty rebuild**, not the 10 chunks the net count suggests. Nothing here is an
eval result: the numbers above are simulation against stored `item_content`, and
whether Q13's first-gold rank moves off 6 is unmeasured until `rechunk --apply`,
`embed --apply` and `eval` have run. Gold is unaffected — it is (query, item)
pairs and item ids do not move, so no re-judge is required. **It has since been
applied and measured — see "The rank moved and the aggregate did not follow"
below, where the prediction in this paragraph half fails.**

### Cutting Medium's footer, and refusing the general rule (2026-08-08)

Resolves "Extraction noise ranks" above. Medium's site footer — the nav block
from the help-centre link to EOF, closing on Speechify's "Text to speech" ad —
is now cut before chunking, keyed on those two link targets and nothing else. It
rides inside the `CHUNKING_VERSION` 3 that the heading fix above opened, because
neither has been applied yet: two boundary-moving changes in one version cost one
re-embed, and shipping them as 3 and 4 would cost two.

**Host completeness is the finding.** 37 of 472 content-bearing items carry the
footer, and that is **100% of every Medium-family item in the corpus**:
medium.com 26/26, and 11 more across `*.medium.com`, `pub.towardsai.net` and
`blog.stackademic.com`. **Both fetchers leak it** — 22 defuddle, 15 firecrawl,
identical block, defuddle splitting each link over three lines — so this was
never fixable by preferring one fetcher, and a one-line pattern would have
fixed the smaller half.

Measured against every stored document before writing the rule, and again on top
of the heading fix: fires on 37, misses none of the 37 that carry the footer,
touches none of the other 435, grows nothing, empties nothing. Chunks in the
affected items go **597 → 556**, of which 522 are byte-identical and 34 reflow;
the corpus goes 8532 → 8491. The seven items that genuinely discuss voice
cloning (#133, #402, #324, #474, #121, #111, #54, all github.com — including
both gold answers for the query item 458 hijacked) come through unchanged,
because the rule never reads the words "text to speech", only two link targets.

**The general rules were measured and refused.** Dropping every chunk with
fewer than 12 words outside links, URLs and headings takes **716 of 8522 chunks
(8.4%) across 262 items**, among them item 7's table of contents, item 104's
docs index and item 22's sentence "agent-standard keeps day-to-day work safe
with:". Dropping link-dense *final* chunks takes 171, and destroys GitHub's
`## About` repo description on ~147 items, where the sidebar shares a chunk with
the one line most worth retrieving. Both trade a silent precision failure for a
loud recall failure across a larger population. The ceiling on any link-density
rule is 408 chunks (4.8%), and most of that is GitHub — i.e. not safely
reachable. Furniture removal stays exact-signature until a measurement says
otherwise.

**Why the derived layer.** `item_content` is write-once by trigger, so
repairing the 37 stored documents at the raw layer means 37 refetches against a
paywall, and `ingest`'s `kept` path would leave the furniture in place on any
that came back blocked. The failure is chunk-layer only, so the raw layer does
not need to change: `rechunk` repairs all 37 for free. The strip also runs in
`extractWeb`, before the thin/blocked gates, so newly ingested pages are clean
at rest and the gates judge the text that actually gets stored.

**The exact signature needs a shape test behind it.** Two link targets are enough
to identify the footer and not enough to authorise the cut, because
`chunkMarkdown` runs this on every item on every host — and the article this
corpus is most likely to collect next is a post *about* Medium's Speechify
integration, which can open a line with the help-centre link and name the ad
below it. The two markers alone would delete the rest of it silently: no log
line, no `FailureReason`, and `writeContent`'s shrink warning only fires on the
`replacing` path. So the cut is refused when any removed line reaches eight words
with link targets dropped. Across all 37 real cuts no removed line does — a
footer is labels and URLs — so the guard costs nothing today and is there for the
document the corpus has not collected yet.

**Residual, and the narrowing is not a closure.** Two things survive. `items_fts`
still indexes the footer in those 37 stored documents, which this change does not
touch: measured impact is nil, since bm25 length normalisation buries a 3-word
tail in a 2210-word document and item 458 sits at **FTS rank 22** for the query it
takes semantic rank 2 on. And the cut ends *at* the help-centre link, so Medium's
author-bio and tag block — which sits immediately above it — still becomes the
final chunk on all 37: item 458 now ends on 18 words of `[Sqlite] [Claude Code]
… Written by Marc Bara`, #293 on 21, #460 on 10. That is the same mechanism one
notch weaker, and it is topical enough to take a rank slot for a query like
"claude code sqlite". The specific hijack is fixed and no TTS vocabulary
survives; the chunk layer for these items is narrowed, not clean.

**This moves the numbers and the move has to be attributed.** 14 of the 37 carry
gold grades, and item 227 is grade 2 for "turn a written article into a produced
video automatically" — the same query item 458 pollutes at rank 6. Sequence is
`rechunk --apply`, then `embed --apply`, then `eval`; running `embed` first ships
unembedded chunks that drop out of semantic search entirely. On its own this
would be 556 chunks to re-embed, ~75k tokens, about a cent — but it does not go
on its own. Measured against the chunks actually stored, the two changes together
touch **383 items, delete 7535 embeddings and re-embed 7504**, with the corpus
landing at 8491 chunks. The heading fix alone was 368 items and 7370, so the
strip adds 15 items and ~134 chunks rather than a second pass over everything —
22 of the 37 were already changing. That is the whole argument for landing both
before applying either: sequenced the other way it is two rebuilds, not one.

### The rank moved and the aggregate did not follow (2026-08-08)

Both fixes above are applied. `rechunk --apply` rewrote **383 items**, the corpus
went **8522 → 8491 chunks**, and `embed --apply` re-embedded **7504 chunks for
2,333,013 tokens** — 25% more than the 1.4–1.9M the estimate carried, because that
estimate divided characters by four and this corpus is denser than that. At the
~$0.15/M rate this class of model charges, roughly **$0.35**.

**The two defects are fixed and the numbers went the wrong way.**

| | FTS | semantic | hybrid | hybrid before |
|---|---|---|---|---|
| Success@1 | 0.533 | 0.667 | **0.767** | 0.800 |
| Success@5 | 0.867 | 0.933 | 0.900 | — |
| MRR | 0.670 | 0.762 | **0.830** | 0.854 |
| Recall | 0.562 | 0.660 | **0.678** | 0.682 |
| nDCG | 0.495 | 0.625 | **0.654** | 0.663 |

**FTS is the control, and it held.** Success@1 0.533, Success@5 0.867 and MRR
0.670 reproduce the pinned baseline to three decimals, which is exactly right:
`items_fts` indexes `item_content`, chunking never touched it, so any FTS movement
would have meant something else changed underneath this measurement. Nothing did.

**What the fixes bought, at the item level.** Q13 — "how do I test and debug an
MCP server I am building" — moves **semantic 6 → 4**: the bare `## MCP Tools`
chunk that held a top-two slot no longer exists, bound now to the 1410-char table it
labels. "Clone a voice and generate speech from text" returns its first gold at
**semantic rank 1**, and item 458's three-word Speechify chunk is gone from the
corpus. Both stated failures are closed.

**What it cost, at the aggregate.** Hybrid gives back 0.033 of Success@1, 0.024 of
MRR, 0.009 of nDCG and 0.004 of recall; semantic moves the same direction against
the whole-corpus row it can be compared to (0.700 / 0.784 / 0.675 / 0.645). One
query's worth of Success@1 on a 30-query set is the instrument's resolution, not a
result — but recall and nDCG drifting the same way says this is mild net
reordering rather than noise alone. Moving boundaries on 383 items changes
max-score-per-item everywhere, and slightly more queries lost a slot than won one.

**Kept anyway, and the reasoning is not "it is already paid for".** The defect was
real and measurable — 990 of 8522 chunks had a heading on the wrong side of a
boundary, and a three-word label outranked every real passage on a live query.
Nothing was lost that was not meant to go: the heading fix moves boundaries
without touching a line — the multiset of non-empty lines is identical before and
after on all 472 items *for that change alone* — and the only deletions are the
900 non-empty lines (~46k chars) that `stripSiteFurniture` removes across 37 items
by design. What the eval says is that fixing it is worth about one rank slot in
the aggregate, which is a cost, not a refutation.

> **Corrected 2026-08-12.** This paragraph originally read "No content was lost:
> the multiset of non-empty lines is identical before and after on all 472 items,"
> inherited verbatim from "The heading was not a passage" above — where it is
> true, because that fix only moves boundaries. Applied as a pair with the footer
> strip it is false: the strip cuts from the last help-centre link to EOF. Verified
> against the replica — item 458's stored document still contains
> `speechify.com/medium`, and zero of its chunks do; re-running the rule over all
> stored content fires on 37 items for 900 non-empty lines. The two fixes shipped
> in one `CHUNKING_VERSION` to pay one re-embed, so any claim about the applied
> state has to cover both. Reverting means a second
7500-chunk re-embed to return to a state with a known precision bug in it.

**The gap in this measurement, and it is ours.** *Which* query lost Success@1 is
unknown, because no per-query first-gold table was recorded before the apply — only
the aggregates and the five ranks the last session happened to write down. The
per-query table prints on every run and costs nothing to keep. **Record it in the
decision log before any change that moves chunk boundaries**, or the next drop is
un-attributable the same way this one is.

So here it is, as of this run, for the next one to diff against — first gold rank,
FTS / semantic / hybrid, `–` where the method returns none in the top 10:

```
 1 /  1 /  1   persistent memory for AI coding agents that survives acro…
 1 /  3 /  1   run untrusted AI-generated code safely in an isolated san…
 – /  5 /  7   keep a coding agent's context window from filling up with…
 1 /  1 /  1   the original transformer paper that introduced self-atten…
 – /  1 /  4   beginner video explainer on how large language models work
 1 /  3 /  1   running open-source LLMs locally on your own hardware, of…
 1 /  1 /  1   how to evaluate the quality of a RAG retrieval pipeline
 1 /  1 /  1   give an AI agent its own email inbox to send and receive …
 2 /  1 /  1   spec-driven development workflow for AI coding agents
 3 /  1 /  1   stop AI from generating bland generic-looking user interf…
 1 /  1 /  1   a Unix password manager that stores secrets as GPG-encryp…
 1 /  2 /  1   let an AI agent control a web browser to navigate and cli…
 1 /  – /  4   turn my existing command line scripts into MCP tools
 1 /  4 /  1   how do I test and debug an MCP server I am building
 1 /  2 /  1   self-hosted control panel for n8n automation with error t…
 4 /  4 /  1   a library of reusable prompts I can run from the command …
 1 /  1 /  1   generate a CLAUDE.md file for an existing repository
 1 /  1 /  2   run several coding agents at once on the same repo withou…
10 /  1 /  2   turn a written article into a produced video automatically
 1 /  1 /  1   clone a voice and generate speech from text
 2 /  1 /  1   AI agents that run go-to-market and marketing operations
 3 /  1 /  1   a fast cross-platform alternative to Make for running bui…
 1 /  1 /  1   a native markdown editor for macOS
 – /  2 /  8   my agent keeps rewriting code that already works
 3 /  – /  7   stop an agent from confidently following out-of-date proj…
 4 /  1 /  1   an agent skill that writes job applications without inven…
 2 /  1 /  1   teach me a topic and quiz me to check I actually remember…
 2 /  1 /  1   shadcn ui components for building agent interfaces
 1 /  1 /  1   MicroVM cold boot performance for agent sandboxes
 2 /  1 /  1   Paul Graham essay about doing great work
```

Seven queries hold hybrid off rank 1, and the three worst — rank 7 for "context
window filling up with junk", 8 for "my agent keeps rewriting code that already
works", 7 for "out-of-date project conventions" — are the paraphrase queries with
no known-item answer, where FTS returns nothing at all and fusion has one list to
work from. That is where the next gain is, and it is a retrieval problem rather
than a chunking one.

### Repairing an item the pin was lying about (2026-08-08)

Item 461's extraction was retried and succeeded — 4185 words where there had been
none — and #370's Substack reader link was resolved to its publication URL, which
ingested as **item 488**. Failures go 13 → 12.

**A recovered item breaks the pin quietly.** The ceiling asserts that every item
up to 487 was judged for every query, and 461 was judged with no text at all: it
was an extraction failure when the pool was built. Recovering it put 4185
unjudged words *inside* the pinned range, where an unjudged hit does not merely
score 0, it takes a rank slot. That is the same failure the ceiling exists to
prevent, arriving from underneath it rather than above. **Re-ingesting a failed
item is a gold event, not a maintenance one.**

461 was therefore pooled against all 30 queries and hand-graded on four:

| query | grade | reason |
|---|---|---|
| persistent memory across sessions | 1 | a plain-file library as the memory that outlasts a session, but a human discipline rather than a tool like #328 |
| spec-driven development workflow | 1 | the alignment interview produces a spec, but for business operations, not a coding-agent loop |
| library of reusable prompts | 1 | read-and-paste templates like #297, but a founder system containing prompts rather than a prompt library |
| out-of-date project instructions | 2 | "files are replaced, never appended", so a session's first read is never stale — prevention rather than detection, the same shape as #12 at grade 2 |

Grading against the neighbours already in each query's gold is what settled three
of the four. #297 is a genuine prompt library graded 2 for being paste-rather-than-CLI,
so 461 grading *below* it is consistent rather than harsh; #328 is a product that
writes the knowledge base for you, so a discipline that asks you to write it
yourself sits under it. The comparison is the method — a grade argued from the
query text alone drifts, a grade argued against an item already graded does not.

**The cost of honest gold, and the direction it went.** Success@1, Success@5 and
MRR do not move on any method. Hybrid recall goes 0.678 → **0.671** and nDCG 0.654
→ **0.651**; FTS recall 0.562 → 0.560. All of it is denominator: one grade-2 that
nothing retrieves, and three grade-1s enlarging each query's ideal DCG. No
retrieval behaviour changed.

**The grade to be most suspicious of was the one that cost the most.** Q24 reads
FTS 3 / semantic – / hybrid 7, so a grade 2 that landed in the top 10 would have
converted a miss into a hit and flattered three metrics at once — exactly the
upward pull "The judge's error has a direction" warns about, and the reason to
distrust an argued grade on that query in particular. 461 does not reach the top
10 there on any method, so the grade bought a recall penalty instead. Worth
recording because the suspicion was correct in shape and wrong in outcome: the
check that settles it is whether the item ranks, not how confident the reason
reads.

**Every first-gold rank is unchanged** — all 30 rows, all three methods, identical
to the table above. Neither 461's new content nor item 488 displaced anything, so
that table stands as the baseline rather than being invalidated by these two
ingests.

**The ceiling stays at 487, and item 488 stays out of gold.** 488 scores 0.55–0.60
against every query in the set, which is background, and no query in the set is
about audience growth. Moving the pin to 488 would assert it had been judged
against 30 queries when it was judged against three. The consequence is that the
FTS approximation recorded above is **live again** — `items_fts` draws IDF and
average document length from 488 items while membership is filtered to 487 — so
every number in this section is measured under it. It stays live until a re-pool
moves the ceiling, which is not worth doing for one background item.

**Still unjudged inside the range:** nothing else known. #370 remains as an
`extraction_failed` row pointing at the Substack reader link, superseded by 488
but not cleaned up, and nothing in the pipeline reconciles a superseded duplicate.

## If this stops working

In rough order of what to reach for:

1. **Hybrid stops beating semantic as the corpus grows.** Symptom: MRR
   converges, or hybrid falls behind. Likely cause is FTS quality degrading with
   scale and dragging fusion. Fix: weight the lists (decision 4) before touching
   anything else — it is one parameter and the eval measures it directly.
2. **Recall is the binding constraint, not ordering.** Symptom: gold items
   absent from *both* candidate lists, so no fusion can help. Fix: raise
   `CANDIDATE_DEPTH`, then chunking (size, overlap) — fusion cannot rank what
   retrieval never returned.
3. **The eval stops discriminating.** Symptom: all three methods score near
   1.000. Fix: harder queries. Done once already — Success@5 had ceilinged at
   1.000 on the 12-query set and now reads 0.933 — and the lever that worked was
   query difficulty, not more queries: the paraphrase and multi-constraint
   queries are where the methods still separate, while the known-item baselines
   are solved by all three. Graded relevance is already in place (decision 6);
   the next reach is queries no current method answers, found by looking outside
   the judging pool rather than inside it.
4. **Margin turns out to matter.** Symptom: a clearly-better semantic hit keeps
   losing to a mediocre item both methods agree on. Fix: score-based fusion with
   per-corpus normalization, accepting the calibration cost decision 1 avoided —
   or a cross-encoder reranker over the fused top-k, which sidesteps the scale
   problem by rescoring query and passage together.
5. **Two rankers become the wrong shape.** `rrfFuse` takes N lists, not two, so
   a third signal (recency, topic match, a reranker) fuses in without touching
   the fusion code — only the caller.
