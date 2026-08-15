// Retrieval metrics, kept pure so they unit-test without a database or the
// embedding API. A method under test produces a ranked list of item ids; the
// query set says which ids are relevant (the "gold" set). Everything here is
// arithmetic over those two lists.

/**
 * A judged item. `grade` is how relevant it is to the query, not how good the
 * item is:
 *
 *   3 — answers the query; the item you were looking for
 *   2 — substantially relevant; properly covers what was asked
 *   1 — marginally relevant; touches the subject but is not what you wanted
 *
 * An id absent from the gold set is graded 0 by omission. That is a real claim
 * and the weak point of any judged set: it is only true to the depth actually
 * judged (see `eval/queries.jsonl`).
 */
export interface GoldItem {
  id: number;
  grade: 1 | 2 | 3;
  why?: string; // the judgement's justification; for humans, ignored by scoring
  /**
   * Items that are one answer at two URLs — a repo and its landing page — share
   * a group label, and every metric counts the group once. A grade is a claim
   * about a (query, item) pair; a group is a claim about the *items*, true
   * whatever the query, which is what makes it survive re-judging: the next pass
   * regrades from evidence and would silently undo a grade demotion used as a
   * stand-in for identity.
   */
  group?: string;
}

/**
 * A bare id is shorthand for grade 2 — "this answers the query", which is what
 * an unqualified gold id claimed before grades existed. Choosing 2 rather than 1
 * keeps an ungraded set scoring exactly as it used to: it clears the threshold
 * the yes/no metrics use, and a uniform grade cancels out of nDCG, which divides
 * by its own ideal. Grade 1 is a claim you have to make on purpose.
 */
export type GoldEntry = number | GoldItem;

export interface QuerySpec {
  query: string;
  gold: GoldEntry[];
  note?: string; // why these are the answers; for humans, ignored by scoring
}

export function normalizeGold(entries: GoldEntry[]): GoldItem[] {
  return entries.map((e) => (typeof e === "number" ? { id: e, grade: 2 } : e));
}

export interface QueryMetrics {
  firstGoldRank: number | null; // 1-indexed rank of the first gold hit, null if none in top k
  hit1: 0 | 1; // a gold item is the top result
  hit5: 0 | 1; // a gold item appears in the top 5
  reciprocalRank: number; // 1/firstGoldRank, 0 if no gold in top k
  recall: number; // answer groups surfaced in top k / total answer groups
  ndcg: number; // nDCG@k with binary relevance
}

export interface AggregateMetrics {
  queries: number;
  success1: number; // mean hit1
  success5: number; // mean hit5
  mrr: number; // mean reciprocalRank
  recall: number; // mean recall@k
  ndcg: number; // mean nDCG@k
}

// log2(i+1) is the standard rank discount: a hit at rank 1 is worth 1/log2(2)=1,
// rank 2 is 1/log2(3), and so on, so later hits contribute less.
const discount = (rank1Indexed: number) => 1 / Math.log2(rank1Indexed + 1);

// Exponential gain, the standard pairing for graded relevance: a grade-3 item is
// worth 7, grade 2 is 3, grade 1 is 1. The gap widens faster than the grades do,
// so burying the item that actually answers the query under two that merely
// touch the subject is scored as the real loss it is — linear gain would call
// that nearly a wash.
//
// nDCG is unchanged by a set that uses one grade throughout, whatever that grade
// is: a constant gain factors out of both DCG and the ideal it divides by. That
// is what lets an ungraded set score exactly as it did before grading existed.
const gain = (grade: number) => 2 ** grade - 1;

/**
 * The grade at which a hit counts as answering the query, for the metrics that
 * are yes/no rather than graded — Success@1/@5, MRR, recall.
 *
 * 2, not 1, and the difference is not cosmetic. Grade 1 means "touches the
 * subject but is not what you wanted", so counting it as a success reports a
 * win for a result the judge already called wrong. Measured: on "my agent keeps
 * rewriting code that already works", semantic puts a grade-1 item at rank 1
 * while the item that answers the query sits at 24 — a threshold of 1 scores
 * that query Success@1 = 1.
 *
 * Grade 1 still counts in nDCG, where it earns a small gain and takes its place
 * in the ideal ranking. It is worth more than an unjudged item and less than an
 * answer, which is exactly what a graded metric is for.
 */
export const RELEVANT_GRADE = 2;

// An item with no group is its own group of one, so a set that declares none is
// scored by exactly the arithmetic that scored it before groups existed — the
// general case reduces to the old one term by term rather than branching around
// it. `#` cannot collide with a label, which is a product slug.
const groupKey = (g: GoldItem) => g.group ?? `#${g.id}`;

// One grade per group: the best any member earns. Max, not the canonical's
// grade, because the ideal ranking has to be one a method could actually
// produce, and returning the group's best member is the best it can do.
function groupGrades(graded: GoldItem[]): number[] {
  const best = new Map<string, number>();
  for (const g of graded) {
    const key = groupKey(g);
    best.set(key, Math.max(best.get(key) ?? 0, g.grade));
  }
  return [...best.values()];
}

/**
 * Score one method's ranking for one query. `ranked` is item ids best-first;
 * only the first `k` are considered.
 *
 * Relevance is graded for nDCG and thresholded for everything else, so the two
 * kinds of metric answer different questions: nDCG asks "how good is this
 * ordering", the rest ask "did the user get an answer at all".
 */
export function scoreRanking(ranked: number[], gold: GoldEntry[], k: number): QueryMetrics {
  const graded = normalizeGold(gold);
  const byId = new Map(graded.map((g) => [g.id, g]));
  const answers = (id: number | undefined) =>
    id !== undefined && (byId.get(id)?.grade ?? 0) >= RELEVANT_GRADE;
  const topK = ranked.slice(0, k);

  let firstGoldRank: number | null = null;
  const bestPerGroup = new Map<string, number>();
  const foundGroups = new Set<string>();
  topK.forEach((id, i) => {
    const g = byId.get(id);
    if (g === undefined) return;
    const rank = i + 1;
    const key = groupKey(g);
    // nDCG sees every judged hit; the threshold metrics only see answers. A
    // group earns its best member's contribution and no more: returning the
    // second copy took a rank slot the ideal spent on another answer, so paying
    // for both would put nDCG above 1. Max of products, never the group's best
    // grade at its first member's rank — that would score a grade-1 echo at
    // rank 1 as if the answer were there.
    bestPerGroup.set(key, Math.max(bestPerGroup.get(key) ?? 0, gain(g.grade) * discount(rank)));
    if (g.grade < RELEVANT_GRADE) return;
    if (firstGoldRank === null) firstGoldRank = rank;
    foundGroups.add(key);
  });
  const dcg = [...bestPerGroup.values()].reduce((sum, value) => sum + value, 0);

  // Ideal DCG: one representative per group in the best possible order —
  // highest grade first, packed into the top ranks and capped by k. nDCG divides
  // by it, so 1.0 means "no ranking of this gold set could have scored better".
  const groups = groupGrades(graded);
  const idealGrades = [...groups].sort((a, b) => b - a).slice(0, k);
  const idcg = idealGrades.reduce((sum, grade, i) => sum + gain(grade) * discount(i + 1), 0);

  // Recall is over the answers only. Dividing by the whole gold set would let a
  // query with many marginal judgements look worse than one judged less
  // thoroughly — punishing the careful judging this set exists to record. A
  // group whose members are all grade 1 is in neither numerator nor denominator.
  const answerCount = groups.filter((grade) => grade >= RELEVANT_GRADE).length;

  return {
    firstGoldRank,
    hit1: answers(topK[0]) ? 1 : 0,
    hit5: topK.slice(0, 5).some((id) => answers(id)) ? 1 : 0,
    reciprocalRank: firstGoldRank ? 1 / firstGoldRank : 0,
    recall: answerCount ? foundGroups.size / answerCount : 0,
    ndcg: idcg ? dcg / idcg : 0,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function aggregate(perQuery: QueryMetrics[]): AggregateMetrics {
  return {
    queries: perQuery.length,
    success1: mean(perQuery.map((m) => m.hit1)),
    success5: mean(perQuery.map((m) => m.hit5)),
    mrr: mean(perQuery.map((m) => m.reciprocalRank)),
    recall: mean(perQuery.map((m) => m.recall)),
    ndcg: mean(perQuery.map((m) => m.ndcg)),
  };
}
