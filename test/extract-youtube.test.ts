import { test } from "node:test";
import assert from "node:assert/strict";
import { transcriptFromJson3, youtubeVideoId } from "../src/extract/youtube.js";

const ID = "zjkBMFhNj_g";

test("every URL shape the same video is saved under yields one id", () => {
  // Canonicalization already folds these together for the dedupe key; the
  // transcript path has to agree with it or a re-ingest of the short form
  // silently takes the page-fetcher route instead.
  assert.equal(youtubeVideoId(`https://youtube.com/watch?v=${ID}`), ID);
  assert.equal(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(youtubeVideoId(`https://m.youtube.com/watch?v=${ID}`), ID);
  assert.equal(youtubeVideoId(`https://youtu.be/${ID}`), ID);
  assert.equal(youtubeVideoId(`https://youtube.com/shorts/${ID}`), ID);
  assert.equal(youtubeVideoId(`https://youtube.com/live/${ID}`), ID);
  assert.equal(youtubeVideoId(`https://youtube.com/embed/${ID}`), ID);
});

test("playback and playlist noise does not change the id", () => {
  assert.equal(youtubeVideoId(`https://youtube.com/watch?v=${ID}&list=PL123&t=42s&si=abc`), ID);
  assert.equal(youtubeVideoId(`https://youtu.be/${ID}?si=abc&t=42`), ID);
});

test("anything that is not a video is null, including malformed input", () => {
  // Null is the ordinary answer, not an error: it is what routes every other
  // host to the page fetchers.
  assert.equal(youtubeVideoId("https://example.com/watch?v=abc"), null);
  assert.equal(youtubeVideoId("https://youtube.com"), null);
  assert.equal(youtubeVideoId("https://youtube.com/@channel"), null);
  assert.equal(youtubeVideoId("https://youtube.com/watch"), null);
  assert.equal(youtubeVideoId("not a url"), null);
  assert.equal(youtubeVideoId("ftp://youtube.com/watch?v=abc"), null);
});

// The real shape, trimmed: a window-definition event carrying no segs, two
// caption events, and the append event that expresses a rolling line break.
const CAPTIONS = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 3589680, id: 1, wpWinPosId: 1 },
    {
      tStartMs: 160,
      segs: [{ utf8: "hi", acAsrConf: 0 }, { utf8: " everyone", tOffsetMs: 160 }],
    },
    { tStartMs: 2270, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 2280, segs: [{ utf8: "so" }, { utf8: " recently" }] },
  ],
});

test("segments concatenate in order, and a roll is a newline not a repeat", () => {
  // The reason this reads json3 and not vtt: vtt re-emits each displayed row
  // every time a line scrolls in, so the same sentence lands three or four
  // times and has to be de-duplicated by guesswork.
  assert.equal(transcriptFromJson3(CAPTIONS), "hi everyone\nso recently");
});

test("an event with no segs is skipped rather than throwing", () => {
  const onlyWindow = JSON.stringify({ events: [{ tStartMs: 0, id: 1 }] });
  assert.equal(transcriptFromJson3(onlyWindow), "");
});

test("unusable caption files yield empty, so the caller falls through", () => {
  assert.equal(transcriptFromJson3("<!doctype html>"), "");
  assert.equal(transcriptFromJson3(""), "");
  assert.equal(transcriptFromJson3("{}"), "");
  assert.equal(transcriptFromJson3(JSON.stringify({ events: [] })), "");
  assert.equal(transcriptFromJson3(JSON.stringify({ events: [{ segs: [{ utf8: 7 }] }] })), "");
});
