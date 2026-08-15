// Reciprocal Rank Fusion: combine several rankings of the same items into one.
// Kept pure so it unit-tests without a database or the embedding API.
//
// Why fuse on rank rather than score. bm25 returns unbounded negatives whose
// scale depends on corpus statistics; cosine similarity is bounded 0..1. Putting
// those on a common scale needs a normalization that is calibrated per corpus
// and drifts as the corpus grows — a hidden parameter that silently rots. RRF
// discards the scores and keeps only position, so there is nothing to calibrate.
//
//   score(d) = Σ  1 / (K + rank of d in that list)
//              lists containing d
//
// An item both methods rank moderately well outranks one that a single method
// loves and the other never returns, which is exactly the disagreement the
// retrieval eval found between FTS and semantic search.

// K damps the advantage of rank 1: at K=60 the step from rank 1 to rank 2 is
// ~1.6%, so one method's confident-but-wrong top hit cannot outvote agreement
// further down. Lower K sharpens toward whatever each method put first — which
// is the behaviour fusion exists to avoid. 60 is the constant from Cormack et
// al. (2009) and the default in every implementation since.
export const RRF_K = 60;

export interface FusedHit {
  id: number;
  score: number;
  /** 1-indexed position in each input list, null where that list missed it. */
  ranks: (number | null)[];
}

/**
 * Fuse ranked id lists, best-first, into one ranking. Lists may be different
 * lengths, may overlap in any way, and may be empty. Ordering is total and
 * deterministic — score, then best single rank, then id — because an eval that
 * reorders ties between runs reports movement that is not there.
 */
export function rrfFuse(lists: number[][], k = RRF_K): FusedHit[] {
  if (!Number.isFinite(k) || k <= 0) throw new Error("RRF k must be a positive number");

  const byId = new Map<number, FusedHit>();
  lists.forEach((list, listIndex) => {
    const seen = new Set<number>();
    list.forEach((id, i) => {
      // A list that repeats an id must not vote for it twice; only its best
      // position counts.
      if (seen.has(id)) return;
      seen.add(id);

      let hit = byId.get(id);
      if (!hit) {
        hit = { id, score: 0, ranks: lists.map(() => null) };
        byId.set(id, hit);
      }
      const rank = i + 1;
      hit.ranks[listIndex] = rank;
      hit.score += 1 / (k + rank);
    });
  });

  // Every hit in the map was placed by at least one list, so this is never a
  // min over an empty set.
  const bestRank = (h: FusedHit) =>
    Math.min(...h.ranks.filter((r): r is number => r !== null));

  return [...byId.values()].sort(
    (a, b) => b.score - a.score || bestRank(a) - bestRank(b) || a.id - b.id,
  );
}
