// /api/track — anonymous usage counts. One row per event in the "Usage Events" table.
//
//   POST { event, detail? }  →  204, always fire-and-forget from the browser
//
// WHAT THIS DELIBERATELY DOES NOT DO, and why it is the only endpoint here without a session
// check. Every other write path in this repo derives identity server-side from a verified
// Clerk session, because it writes something ATTRIBUTED to a person. This one writes the
// opposite: a count with nobody attached. Requiring a session would mean the request carried
// an identity, and then the only thing standing between that identity and the row would be
// this file remembering not to write it. Not asking is a stronger guarantee than asking and
// discarding.
//
// So, explicitly:
//   - no Authorization header is read, and none is accepted
//   - no email, no Clerk user id, no profile key — the browser has no way to send one that
//     this endpoint would look at
//   - no IP address, no user-agent, no referer is stored. Vercel sees the IP at the network
//     layer, as any host must; it never reaches Airtable
//   - no cookie is set or read, so there is no session and no way to join rows into a person
//
// CLAUDE.md says: never add an endpoint that takes user-submitted content without a
// server-side session check. This one is the exception, and it earns it by taking no free
// user content at all. Both fields are closed vocabularies — `event` must be one of the six
// below, `detail` one of a short allowlist — so the set of rows this endpoint can ever write
// is finite and enumerable, whoever is posting to it. That is the property that makes an open
// endpoint acceptable here; a validation pattern would not have been, because a pattern
// admits anything shaped right, including somebody's name.
//
// KNOWN GAP: there is no rate limit. Serverless has no shared state to count against, so a
// script could still inflate the counts or run up Airtable writes. It cannot leak anything or
// write anything unexpected — the worst case is noisy, wrong numbers. If that matters, the
// fix is a Vercel WAF rule or a rate limiter in front, not a secret in the page (which is
// public by definition and would only look like protection).
//
// Env: AIRTABLE_TOKEN (needs data.records:write), AIRTABLE_BASE_ID (appsSZLqnodyyyUrR),
//      AIRTABLE_USAGE_TABLE (optional, default "Usage Events"), ALLOWED_ORIGIN (optional).

const API = "https://api.airtable.com/v0";

// The complete vocabulary. An unknown event is a bug or an abuse attempt, not a new metric —
// adding one is a code change, on purpose, so the table can never fill with arbitrary strings.
export const EVENTS = new Set([
  "page_view",
  "sign_in",
  "mentorship_open",
  "mentorship_draft_email",
  "mentorship_browse_more",
  "ask_offer_post",
]);

// Detail is an ALLOWLIST, not a character class.
//
// A pattern was the obvious first move — lowercase, no "@", no ":" — and it is not enough. It
// rejects an email and a URL, and happily accepts "anna lemkin" and "in/sylvia-chin-connect",
// which are exactly the things that must never land in this table. The endpoint is open, so
// "the frontend only ever sends safe labels" is a statement about today's callers, not about
// what the endpoint will accept from anyone who posts to it.
//
// So Detail may only be a value the app is known to send. Everything else is dropped —
// silently and without error, because losing a label costs nothing and storing a stray
// identifier is the single thing this endpoint exists not to do. Adding a new label is a code
// change here, the same deal as adding a new event.
const DIM_KEYS = new Set(["domains", "skills", "customergroup", "solutioncharacteristics"]);
const DETAIL_LITERALS = new Set([
  "reopened",              // mentorship panel reopened from the pill
  "evidence", "topics",    // which register a draft email was written in
  "filtered", "all",       // whether "browse more" carried sector filters
  "both", "ask", "offer", "empty", // which side of an exchange post was filled in
]);
export const cleanDetail = (raw) => {
  const d = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!d || d.length > 60) return "";
  if (DETAIL_LITERALS.has(d)) return d;
  // a dimension list, e.g. "domains skills" — any space-separated subset of the four keys
  const parts = d.split(/\s+/);
  if (parts.length <= DIM_KEYS.size && parts.every((p) => DIM_KEYS.has(p))) return d;
  return "";
};

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_USAGE_TABLE || "Usage Events";
  if (!token || !baseId) return res.status(500).json({ error: "server_not_configured" });

  // Vercel parses JSON bodies; a string body (sendBeacon posts text/plain) is parsed here.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const event = String((body && body.event) || "").trim();
  if (!EVENTS.has(event)) return res.status(400).json({ error: "unknown_event" });
  const detail = cleanDetail(body && body.detail);

  try {
    const r = await fetch(`${API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        records: [{ fields: { Event: event, ...(detail ? { Detail: detail } : {}), At: new Date().toISOString() } }],
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || j.error.type || "airtable_write_failed");
  } catch (err) {
    // Logged, never surfaced. A analytics write that fails is not the visitor's problem, and
    // the caller ignores the response anyway — but a silent 204 here would hide a broken
    // token for weeks, so it goes to the function log.
    console.error("track error:", err);
    return res.status(500).json({ error: "track_failed" });
  }
  return res.status(204).end();
}
