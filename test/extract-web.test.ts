import { test } from "node:test";
import assert from "node:assert/strict";
import { extractWeb, isThin, isBlocked, type WebFetchers } from "../src/extract/web.js";
import { stripSiteFurniture } from "../src/extract/furniture.js";
import { mediumFooter } from "./helpers.js";

const rich = "word ".repeat(300);
const thin = "just a few words here";

// The shape that defeated the length check: a full-length page that is not the
// document it claims to be. Item 5 held one of these for three sessions.
const blockedLong = `Sign in to confirm you're not a bot\n\n${rich}`;

// A real article, with nothing a furniture rule may touch.
const body = `# Real Article\n\n${rich.trim()}`;

function fetchers(overrides: Partial<WebFetchers>): WebFetchers {
  return {
    defuddle: async () => null,
    firecrawl: async () => null,
    youtube: async () => null,
    ...overrides,
  };
}

const VIDEO = "https://youtube.com/watch?v=zjkBMFhNj_g";

test("isThin boundary sits at 100 words", () => {
  assert.equal(isThin("w ".repeat(99).trim()), true);
  assert.equal(isThin("w ".repeat(100).trim()), false);
  assert.equal(isThin(""), true);
});

test("rich defuddle result wins without calling firecrawl", async () => {
  let firecrawlCalled = false;
  const result = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: rich, title: "T", author: "A", published: "2024-01-01" }),
    firecrawl: async () => {
      firecrawlCalled = true;
      return rich;
    },
  }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.method, "defuddle");
  assert.equal(result.title, "T");
  assert.equal(firecrawlCalled, false);
});

test("thin defuddle falls back to firecrawl, keeps defuddle metadata", async () => {
  const result = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: thin, title: "Real Title" }),
    firecrawl: async () => rich,
  }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.method, "firecrawl");
  assert.equal(result.title, "Real Title");
});

test("defuddle error (null) falls back to firecrawl", async () => {
  const result = await extractWeb("https://example.com", undefined, fetchers({
    firecrawl: async () => `# Scraped Title\n\n${rich}`,
  }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.method, "firecrawl");
  assert.equal(result.title, "Scraped Title");
});

test("both thin -> not ok, nothing stored as content", async () => {
  const result = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: thin, title: "Paywalled" }),
    firecrawl: async () => thin,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.title, "Paywalled");
});

test("a page that arrived but was a stub is thin_content, not fetch_error", async () => {
  const result = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: thin, title: "Login Required" }),
    firecrawl: async () => thin,
  }));
  assert.equal(result.ok === false && result.reason, "thin_content");
});

test("a stub from either fetcher alone still reads as thin_content", async () => {
  const defuddleOnly = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: thin }),
  }));
  assert.equal(defuddleOnly.ok === false && defuddleOnly.reason, "thin_content");

  const firecrawlOnly = await extractWeb("https://example.com", undefined, fetchers({
    firecrawl: async () => thin,
  }));
  assert.equal(firecrawlOnly.ok === false && firecrawlOnly.reason, "thin_content");
});

test("nothing coming back at all is fetch_error", async () => {
  const result = await extractWeb("https://example.com", undefined, fetchers({}));
  assert.equal(result.ok === false && result.reason, "fetch_error");
});

test("a block page is caught however long it is", () => {
  // The whole point: this passes the thin threshold comfortably.
  assert.equal(isThin(blockedLong), false);
  assert.equal(isBlocked(blockedLong), true);
});

test("markers are only read at the head, so an article about bot walls survives", () => {
  // A corpus about agents and scraping is full of documents that discuss the
  // very phrases the gate looks for. Anything past the head is prose, not a
  // wall — the check that keeps this gate from eating the library.
  const article = `# Defeating bot walls\n\n${"word ".repeat(2000)}\naccess denied is what you see when`;
  assert.equal(isBlocked(article), false);

  const wall = `Access Denied\n\nYou do not have permission to view this page.\n${rich}`;
  assert.equal(isBlocked(wall), true);
});

test("bare 'captcha' is not a marker: it is a feature real documents advertise", () => {
  // Verified against the real corpus — this wording appears in items #36 and
  // #82, both legitimate. Re-check against real content before adding markers.
  const legit = `# Browser Use\n\nFree tier: proxies, captcha solving, and more.\n${rich}`;
  assert.equal(isBlocked(legit), false);
});

test("a blocked defuddle result falls through to firecrawl", async () => {
  const result = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: blockedLong, title: "YouTube" }),
    firecrawl: async () => `# Real Talk\n\n${rich}`,
  }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.method, "firecrawl");
});

test("blocked from both fetchers is blocked_content, not thin_content", async () => {
  const result = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: blockedLong }),
    firecrawl: async () => blockedLong,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "blocked_content");
});

test("a video goes to yt-dlp first, and no page fetcher is called at all", async () => {
  // Order is the point. On this host defuddle returns a 1-word shell and
  // firecrawl returned a bot wall five times of six, so reaching them at all
  // is three minutes spent to be told nothing.
  let pageFetched = false;
  const markFetched = async () => {
    pageFetched = true;
    return null;
  };
  const result = await extractWeb(VIDEO, undefined, fetchers({
    defuddle: markFetched,
    firecrawl: markFetched,
    youtube: async () => ({ content: rich, title: "The Talk", author: "A", published: "2023-11-23" }),
  }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.method, "yt-dlp");
  assert.equal(result.title, "The Talk");
  assert.equal(result.author, "A");
  assert.equal(result.published, "2023-11-23");
  assert.equal(pageFetched, false);
});

test("no transcript falls through to the page fetchers rather than failing", async () => {
  // yt-dlp may be absent, and a video page can still carry a real description.
  const result = await extractWeb(VIDEO, undefined, fetchers({
    youtube: async () => null,
    defuddle: async () => ({ content: rich, title: "Description" }),
  }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.method, "defuddle");
});

test("a transcript that comes back blocked or thin does not get stored", async () => {
  // The transcript path is not exempt from the gate that made this repairable.
  const blocked = await extractWeb(VIDEO, undefined, fetchers({
    youtube: async () => ({ content: blockedLong }),
    defuddle: async () => ({ content: rich, title: "Fallback" }),
  }));
  assert.equal(blocked.ok && blocked.method, "defuddle");

  const stub = await extractWeb(VIDEO, undefined, fetchers({
    youtube: async () => ({ content: thin }),
    firecrawl: async () => rich,
  }));
  assert.equal(stub.ok && stub.method, "firecrawl");
});

test("a video whose every path fails still reports the actionable reason", async () => {
  const result = await extractWeb(VIDEO, undefined, fetchers({
    youtube: async () => null,
    firecrawl: async () => blockedLong,
  }));
  assert.equal(result.ok === false && result.reason, "blocked_content");
});

test("a blocked transcript outranks a thin page, same as any other fetcher", async () => {
  // The rule is "a block seen by any fetcher wins". Adding a third fetcher
  // that the rule did not cover would have quietly recorded thin_content —
  // the reason that means "do not bother retrying".
  const result = await extractWeb(VIDEO, undefined, fetchers({
    youtube: async () => ({ content: blockedLong }),
    defuddle: async () => ({ content: thin }),
  }));
  assert.equal(result.ok === false && result.reason, "blocked_content");
});

test("a useless transcript still means something answered, so not fetch_error", async () => {
  const result = await extractWeb(VIDEO, undefined, fetchers({
    youtube: async () => ({ content: thin }),
  }));
  assert.equal(result.ok === false && result.reason, "thin_content");
});

test("an ordinary page never reaches the transcript path", async () => {
  let ytCalled = false;
  await extractWeb("https://example.com", undefined, fetchers({
    youtube: async () => {
      ytCalled = true;
      return null;
    },
    defuddle: async () => ({ content: rich }),
  }));
  assert.equal(ytCalled, false);
});

test("an article about text to speech is not furniture, however loudly it says so", () => {
  // The population the strip must never touch. The corpus holds seven items
  // that discuss voice cloning in their own prose — #133, #402, #324, #474,
  // #121, #111, #54, all github.com — and #133 and #402 are the two gold
  // answers for "clone a voice and generate speech from text", the query item
  // 458's footer hijacked at semantic rank 2. The rule never reads the words:
  // it reads two link targets, so an article that links Speechify on purpose
  // keeps every word of itself.
  const article = `# Voicebox\n\nClone a voice and generate speech from text, locally.\nA hosted alternative is [Speechify](https://speechify.com).\n\n${rich.trim()}`;
  assert.equal(stripSiteFurniture(article), article);
});

test("both markers are required, so a Medium help article keeps its ending", () => {
  // Without this clause the rule reads "cut everything after any Medium link",
  // which is a recall bug wearing a precision fix's clothes.
  const page = `${body}\n\n[Help](https://help.medium.com/hc/en-us) explains the rest.`;
  assert.equal(stripSiteFurniture(page), page);
});

test("the cut starts at the last help-centre link, so prose that links it survives", () => {
  const prose = `${body}\n\n[Help](https://help.medium.com/hc/en-us) is where I filed the bug.\n\nThen it was fixed.`;
  assert.equal(stripSiteFurniture(prose), prose, "no footer, nothing to cut");
  assert.equal(stripSiteFurniture(`${prose}\n\n${mediumFooter("firecrawl")}`), prose);
});

test("item 458's footer comes off in both fetchers' shapes, and only the footer", () => {
  // 15 of the 37 affected items arrived through firecrawl and 22 through
  // defuddle, which emits the same block with the label on its own lines. A
  // pattern that matched one shape would have fixed the smaller half and read
  // as a firecrawl bug.
  assert.equal(stripSiteFurniture(`${body}\n\n${mediumFooter("firecrawl")}`), body);
  assert.equal(stripSiteFurniture(`${body}\n\n${mediumFooter("defuddle")}`), body);
});

test("a document with no furniture is returned byte-identical", () => {
  const readme = `# agent-standard\n\n[Readme](#readme-ov-file) · [MIT license](LICENSE)\n\n${rich.trim()}`;
  assert.equal(stripSiteFurniture(readme), readme);
});

// The article this corpus would actually collect, and the one the two markers
// alone would gut: a post about Medium's Speechify integration, opening a line
// with the help-centre link and naming the ad below it. chunkMarkdown runs this
// on every host, so nothing else stands between that page and a silent cut.
test("prose below the head refuses the cut, however well the signature matches", () => {
  const review = [
    body,
    "[Help](https://help.medium.com/hc/en-us) is where I filed it, and the reply",
    "was that [Speechify](https://speechify.com/medium?source=x) is staying put.",
    "",
    "A real closing paragraph that has every right to survive this function.",
  ].join("\n\n");
  assert.equal(stripSiteFurniture(review), review);
});

// The footer's own lines have to stay under the prose bar, or the guard above
// switches the fix off for the 37 items it exists to repair.
test("no line of the real footer reads as prose", () => {
  for (const shape of ["firecrawl", "defuddle"] as const) {
    assert.equal(stripSiteFurniture(`${body}\n\n${mediumFooter(shape)}`), body, shape);
  }
});

// Reachable only through chunkMarkdown, where an empty return would have
// rechunk delete every chunk of the item and insert none in their place.
test("a page that is nothing but footer is left alone rather than emptied", () => {
  const footer = mediumFooter("firecrawl");
  assert.equal(stripSiteFurniture(footer), footer);
});

test("the footer never reaches stored content, from either page fetcher", async () => {
  const viaDefuddle = await extractWeb("https://medium.com/@a/post", undefined, fetchers({
    defuddle: async () => ({ content: `${body}\n\n${mediumFooter("defuddle")}`, title: "T" }),
  }));
  assert.equal(viaDefuddle.ok && viaDefuddle.content, body);

  const viaFirecrawl = await extractWeb("https://medium.com/@a/post", undefined, fetchers({
    firecrawl: async () => `${body}\n\n${mediumFooter("firecrawl")}`,
  }));
  assert.equal(viaFirecrawl.ok && viaFirecrawl.content, body);
});

test("stripping the footer does not turn an article into thin_content", async () => {
  // The gate runs on what gets stored, so the strip moves the word count it is
  // measured against. It is 13 words on firecrawl's shape and 35 on defuddle's,
  // and the smallest of the 37 affected items is 401 words after the cut — but
  // an article a little over the threshold must still read as an article.
  const short = `# Short Post\n\n${"word ".repeat(120).trim()}`;
  const result = await extractWeb("https://medium.com/@a/post", undefined, fetchers({
    defuddle: async () => ({ content: `${short}\n\n${mediumFooter("defuddle")}`, title: "T" }),
  }));
  assert.ok(result.ok);
  assert.equal(result.ok && result.content, short);
});

test("a block seen by either fetcher outranks a thin result from the other", async () => {
  // A block says the request was refused, which is worth retrying; thin says
  // the page is a wall, which is not. The actionable reason must win.
  const blockedFirst = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: blockedLong }),
    firecrawl: async () => thin,
  }));
  assert.equal(blockedFirst.ok === false && blockedFirst.reason, "blocked_content");

  const blockedSecond = await extractWeb("https://example.com", undefined, fetchers({
    defuddle: async () => ({ content: thin }),
    firecrawl: async () => blockedLong,
  }));
  assert.equal(blockedSecond.ok === false && blockedSecond.reason, "blocked_content");
});
