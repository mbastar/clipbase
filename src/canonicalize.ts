// Canonical URL = dedupe key. Strips tracking params and normalizes the
// parts that never change page identity; leaves meaningful query params
// (and their order) alone.

const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "ref_src",
  "s_kwcid",
]);

// Hosts that serve one document under several names. Mobile variants are the
// same page for dedupe purposes; `www.` is stripped from every host below.
const HOST_ALIASES: Record<string, string> = {
  "m.youtube.com": "youtube.com",
  "m.facebook.com": "facebook.com",
  "mobile.twitter.com": "twitter.com",
};

// Hosts where exactly one query param carries page identity and everything
// else is playback/referrer noise (youtube's app, pp, ra, si, t). Allowlisting
// beats blocklisting here: youtube keeps inventing these.
const IDENTITY_PARAMS: Record<string, Set<string>> = {
  "youtube.com": new Set(["v"]),
};

function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

// github.com/owner/repo/tree/main is the repo root — the same page as
// /owner/repo. Only the bare default-branch form: /tree/main/src is a real
// subpath and must stay distinct.
function normalizePath(hostname: string, pathname: string): string {
  if (hostname === "github.com") {
    return pathname.replace(/\/tree\/(main|master)$/, "");
  }
  return pathname;
}

export function canonicalizeUrl(raw: string): { canonical: string; domain: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }

  // youtu.be/<id> is a watch URL wearing a short coat. Rewrite it first so the
  // youtube identity-param rule below applies to it too.
  if (stripWww(url.hostname) === "youtu.be") {
    const videoId = url.pathname.slice(1).replace(/\/+$/, "");
    if (videoId) {
      url = new URL(`${url.protocol}//youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    }
  }

  const bareHost = stripWww(url.hostname);
  const hostname = HOST_ALIASES[bareHost] ?? bareHost;
  const identity = IDENTITY_PARAMS[hostname];

  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    const k = key.toLowerCase();
    if (identity) {
      if (identity.has(k)) params.append(key, value);
      continue;
    }
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) continue;
    params.append(key, value);
  }

  const trimmedPath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const pathname = normalizePath(hostname, trimmedPath);
  const search = params.toString();
  const port = url.port ? `:${url.port}` : "";
  // URL already lowercases protocol/hostname and drops default ports.
  const canonical = `${url.protocol}//${hostname}${port}${pathname}${search ? `?${search}` : ""}`;
  return { canonical, domain: hostname };
}
