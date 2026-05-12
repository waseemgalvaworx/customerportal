// extractContactName
// -----------------------------------------------------------------------------
// The Job Management system does NOT (currently) store a dedicated
// "customer contact name" column on the jobs table. Instead, when a
// customer drops off goods using a named employee (their driver, foreman,
// etc.), the operator typing the job into the admin app records that
// person's name inside the FREE-TEXT `notes` field — usually with one of
// a handful of common prefixes:
//
//     Brought by: John Doe
//     Contact: John
//     Driver: John Doe
//     Delivered by John Doe
//     Drop off: John
//     Collected by: John Doe
//     Reception: John
//
// This helper parses that name back out so the customer portal can show
// it as a first-class field ("Brought by: John Doe") on the job card and
// in the Job Details summary, without needing a schema change.
//
// Resolution rules:
//   * Case-insensitive prefix match against a known list.
//   * Only consume up to the first newline / end-of-line so we don't pull
//     unrelated content from multi-line notes.
//   * Trim surrounding punctuation / whitespace.
//   * Reject obvious garbage (empty / single-character / numeric-only).
//   * Cap at ~60 chars so a malformed note can't blow up the UI layout.
//
// We intentionally try MULTIPLE prefixes and return the FIRST plausible
// match — operators are inconsistent in the wild so the parser has to be
// forgiving. If no prefix matches we return null and the UI hides the
// "Brought by" row entirely.

const PREFIX_PATTERNS: RegExp[] = [
  // "Brought by John" / "Brought by: John"
  /(?:^|\n|[.;|·•\-–—])\s*brought\s*by\s*[:\-–—]?\s*([^\n;|·•]+)/i,
  // "Delivered by John"
  /(?:^|\n|[.;|·•\-–—])\s*delivered\s*by\s*[:\-–—]?\s*([^\n;|·•]+)/i,
  // "Collected by John"
  /(?:^|\n|[.;|·•\-–—])\s*collected\s*by\s*[:\-–—]?\s*([^\n;|·•]+)/i,
  // "Dropped (off) by John"
  /(?:^|\n|[.;|·•\-–—])\s*dropp?ed(?:\s*off)?\s*by\s*[:\-–—]?\s*([^\n;|·•]+)/i,
  // "Drop off: John" / "Drop-off: John"
  /(?:^|\n|[.;|·•\-–—])\s*drop[\s\-]*off\s*[:\-–—]\s*([^\n;|·•]+)/i,
  // "Driver: John"
  /(?:^|\n|[.;|·•\-–—])\s*driver\s*[:\-–—]\s*([^\n;|·•]+)/i,
  // "Contact: John" / "Contact person: John"
  /(?:^|\n|[.;|·•\-–—])\s*contact(?:\s*person)?\s*[:\-–—]\s*([^\n;|·•]+)/i,
  // "Reception: John" / "Received from John"
  /(?:^|\n|[.;|·•\-–—])\s*reception\s*[:\-–—]\s*([^\n;|·•]+)/i,
  /(?:^|\n|[.;|·•\-–—])\s*received\s*from\s*[:\-–—]?\s*([^\n;|·•]+)/i,
  // "From: John" — most generic, last so the more specific patterns win
  /(?:^|\n)\s*from\s*[:\-–—]\s*([^\n;|·•]+)/i,
];

const MIN_LEN = 2;
const MAX_LEN = 60;

// Reject candidates that are obviously not a person's name — pure
// numbers, single letters, all-punctuation, or known status tokens that
// sometimes follow "From:" in operator notes.
const DENY_VALUES = new Set([
  'pending', 'in progress', 'inprogress', 'workshop', 'acid', 'galva',
  'galvanizing', 'finishing', 'ready', 'shipped', 'delivered',
  'cancelled', 'canceled', 'archived',
  'na', 'n/a', 'none', 'nil', 'tbd', 'tba', 'unknown',
]);

const NUMERIC_RE = /^[\d\s.,/\\-]+$/;
const PUNCT_ONLY_RE = /^[\s\W_]+$/;

export function extractContactName(notes?: string | null): string | null {
  if (!notes || typeof notes !== 'string') return null;
  const text = notes.trim();
  if (text.length === 0) return null;

  for (const re of PREFIX_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    let candidate = (m[1] || '').trim();
    if (!candidate) continue;

    // Strip a single leading punctuation token if any survived the regex
    // (e.g. "Brought by - John" → m[1] = "- John").
    candidate = candidate.replace(/^[\s:\-–—,.]+/, '').replace(/[\s:\-–—,.]+$/, '');

    // Stop at the first run of two-or-more spaces (separates name from
    // free-form trailing content like "John Doe   please call him 555-…").
    const dblSpaceIdx = candidate.search(/\s{2,}/);
    if (dblSpaceIdx > 0) candidate = candidate.slice(0, dblSpaceIdx).trim();

    // Stop at common trailing separators inside the same line.
    candidate = candidate.split(/\s+(?:phone|tel|cell|mob|mobile|number|no\.?|#)\b/i)[0].trim();

    if (candidate.length < MIN_LEN || candidate.length > MAX_LEN) continue;
    if (NUMERIC_RE.test(candidate)) continue;
    if (PUNCT_ONLY_RE.test(candidate)) continue;
    if (DENY_VALUES.has(candidate.toLowerCase())) continue;

    // Strip wrapping quotes / parentheses.
    candidate = candidate.replace(/^["'(\[]+|["')\]]+$/g, '').trim();
    if (candidate.length < MIN_LEN) continue;

    return candidate;
  }

  return null;
}

export default extractContactName;
