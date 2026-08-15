// FTS5 MATCH syntax treats quotes, hyphens, AND/OR/NOT, parens, etc. as
// operators. User and agent queries are data, not syntax: every token is
// wrapped as a quoted phrase (internal quotes doubled), so nothing a user types
// is parsed as an operator and this can never throw a syntax error.
//
// Tokens are joined with OR, not the implicit AND that adjacency gives. AND
// requires every token — stopwords included — to appear in one document, so a
// single absent word ("the ... paper that introduced ...") empties the result
// set; a retrieval eval found this collapsed 8 of 12 natural-language questions
// to zero rows. OR asks for any token and lets bm25 rank by how many, and how
// rare, the matches are: low-IDF words like "the" contribute almost nothing, so
// documents hitting the distinctive terms still sort to the top.

// One OR clause per token. Real queries are a handful of words; the cap only
// bounds a pathological one so the MATCH expression cannot blow up.
const MAX_TERMS = 32;

export function escapeFtsQuery(query: string): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const token of query.split(/\s+/)) {
    if (!token || seen.has(token)) continue; // drop blanks and repeated tokens
    seen.add(token);
    terms.push(`"${token.replaceAll('"', '""')}"`);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.join(" OR ");
}
