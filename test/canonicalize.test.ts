import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl } from "../src/canonicalize.js";

test("strips utm_* and known tracking params, keeps meaningful ones", () => {
  const { canonical } = canonicalizeUrl(
    "https://example.com/post?utm_source=x&id=42&utm_campaign=y&fbclid=abc&gclid=z",
  );
  assert.equal(canonical, "https://example.com/post?id=42");
});

test("normalizes trailing slash, fragment, case, default port", () => {
  assert.equal(
    canonicalizeUrl("HTTPS://Example.COM:443/Post/#section").canonical,
    "https://example.com/Post",
  );
  assert.equal(canonicalizeUrl("https://example.com/").canonical, "https://example.com");
  assert.equal(canonicalizeUrl("https://example.com").canonical, "https://example.com");
});

test("same page in different saved forms canonicalizes identically", () => {
  const forms = [
    "https://example.com/a/b/?utm_medium=email",
    "https://example.com/a/b#frag",
    "https://EXAMPLE.com/a/b/",
  ];
  const canonicals = new Set(forms.map((f) => canonicalizeUrl(f).canonical));
  assert.equal(canonicals.size, 1);
});

test("domain drops www prefix", () => {
  assert.equal(canonicalizeUrl("https://www.example.com/x").domain, "example.com");
});

test("preserves path case and meaningful query order", () => {
  const { canonical } = canonicalizeUrl("https://example.com/Docs?b=2&a=1");
  assert.equal(canonical, "https://example.com/Docs?b=2&a=1");
});

test("www is stripped from the canonical, not just the domain", () => {
  const { canonical, domain } = canonicalizeUrl("https://www.example.com/x");
  assert.equal(canonical, "https://example.com/x");
  assert.equal(domain, "example.com");
  assert.equal(canonicalizeUrl("https://example.com/x").canonical, canonical);
});

test("youtube: mobile host, www, and bare host are one video", () => {
  const forms = [
    "https://m.youtube.com/watch?v=4jy0T98dYoI&pp=ugUEEgJlbg%3D%3D&ra=m",
    "https://www.youtube.com/watch?app=desktop&v=4jy0T98dYoI&ra=m",
    "https://youtube.com/watch?v=4jy0T98dYoI&si=ywPJ2AAxdLnTf81V",
    "https://www.youtube.com/watch?t=1469s&v=4jy0T98dYoI",
    "https://youtu.be/4jy0T98dYoI",
  ];
  const canonicals = new Set(forms.map((f) => canonicalizeUrl(f).canonical));
  assert.equal(canonicals.size, 1);
  assert.equal([...canonicals][0], "https://youtube.com/watch?v=4jy0T98dYoI");
  assert.equal(canonicalizeUrl(forms[0]).domain, "youtube.com");
});

test("youtube: different videos stay distinct", () => {
  assert.notEqual(
    canonicalizeUrl("https://m.youtube.com/watch?v=aaaaaaaaaaa").canonical,
    canonicalizeUrl("https://m.youtube.com/watch?v=bbbbbbbbbbb").canonical,
  );
});

test("github: bare default-branch tree URL is the repo root", () => {
  const repo = "https://github.com/calesthio/OpenMontage";
  assert.equal(canonicalizeUrl(`${repo}/tree/main`).canonical, repo);
  assert.equal(canonicalizeUrl(`${repo}/tree/master`).canonical, repo);
});

test("github: a real subpath under tree/ stays distinct", () => {
  const sub = "https://github.com/calesthio/OpenMontage/tree/main/src";
  assert.equal(canonicalizeUrl(sub).canonical, sub);
});

test("identity-param hosts do not leak the rule to other hosts", () => {
  // `v` is not special off youtube; unrelated params survive elsewhere.
  assert.equal(
    canonicalizeUrl("https://example.com/watch?v=1&other=2").canonical,
    "https://example.com/watch?v=1&other=2",
  );
});

test("rejects invalid URLs and non-http schemes", () => {
  assert.throws(() => canonicalizeUrl("not a url"), /invalid URL/);
  assert.throws(() => canonicalizeUrl("ftp://example.com/x"), /unsupported URL scheme/);
});
