import { test } from "node:test";
import assert from "node:assert/strict";
import { rrfFuse, RRF_K } from "../src/rank.js";

const ids = (lists: number[][]) => rrfFuse(lists).map((h) => h.id);

test("a single list comes back in its own order", () => {
  assert.deepEqual(ids([[7, 3, 9]]), [7, 3, 9]);
});

test("agreement beats a single method's favourite", () => {
  // 5 is second on both lists; 1 and 2 are first on one and absent from the
  // other. Two moderate votes outweigh one strong one — the whole point of RRF.
  const fused = rrfFuse([
    [1, 5, 8],
    [2, 5, 9],
  ]);
  assert.equal(fused[0].id, 5);
  assert.equal(fused[0].score, 2 / (RRF_K + 2));
  assert.deepEqual(fused[0].ranks, [2, 2]);
});

test("an item only one method returns still ranks", () => {
  // The case that motivated hybrid search: FTS misses paraphrase queries
  // entirely, and those items must not be dropped just for being unanimous-less.
  const fused = rrfFuse([[1], [99]]);
  assert.deepEqual(fused.map((h) => h.id).sort(), [1, 99]);
  assert.deepEqual(fused[0].ranks, [1, null]);
  assert.deepEqual(fused[1].ranks, [null, 1]);
});

// 4 tops the first list and is absent from the second; 6 is 2nd on one and only
// 4th on the other. Whether steady-but-lower beats first-and-alone is entirely
// the constant's doing, so both directions are pinned rather than assumed.
const DISAGREEING: number[][] = [
  [4, 6],
  [8, 9, 10, 6],
];

test("rank 1 does not dominate: agreement lower down overtakes it", () => {
  const fused = rrfFuse(DISAGREEING);
  assert.equal(fused[0].id, 6);
  assert.deepEqual(fused[0].ranks, [2, 4]);
  const four = fused.find((h) => h.id === 4) as { score: number };
  assert.ok(fused[0].score > four.score, "two mid placements must beat one top placement");
});

test("a small K sharpens toward whatever ranked first", () => {
  // Same lists, K=0.5: rank 1 is now worth so much more than rank 2 that the
  // single top placement wins. This is the behaviour K=60 exists to avoid.
  assert.equal(rrfFuse(DISAGREEING, 0.5)[0].id, 4);
});

test("ties break deterministically rather than by insertion order", () => {
  const once = rrfFuse([
    [3, 1],
    [1, 3],
  ]);
  const twice = rrfFuse([
    [1, 3],
    [3, 1],
  ]);
  // Both items score identically either way; the lower id settles it, so an
  // eval re-run cannot report movement that is not there.
  assert.deepEqual(once.map((h) => h.id), [1, 3]);
  assert.deepEqual(twice.map((h) => h.id), [1, 3]);
});

test("a repeated id in one list votes once, at its best position", () => {
  const fused = rrfFuse([[5, 5, 5]]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0].score, 1 / (RRF_K + 1));
  assert.deepEqual(fused[0].ranks, [1]);
});

test("empty lists are absorbed, not special-cased by callers", () => {
  assert.deepEqual(ids([[], [4, 2]]), [4, 2]);
  assert.deepEqual(ids([[], []]), []);
  assert.deepEqual(ids([]), []);
});

test("a non-positive K is rejected rather than dividing by zero", () => {
  assert.throws(() => rrfFuse([[1]], 0), /positive/);
  assert.throws(() => rrfFuse([[1]], -1), /positive/);
});
