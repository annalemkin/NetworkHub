// /api/save — persists a finished profile interview to Airtable.
//
// The site calls this when a student finishes (or edits) their interview. Upserts
// by the student's identity key (LinkedIn URL, or normalized name as fallback —
// the same profileKey() the front-end uses), so re-taking the interview updates
// the existing row instead of duplicating it.
//
// Secrets live in env vars — never in the page:
//   AIRTABLE_TOKEN        — required; needs data.records:read + data.records:write
//                           scoped to the base below (make a NEW token for this —
//                           the existing pull token is read-only by design)
//   AIRTABLE_BASE_ID      — required; the interview base: appsSZLqnodyyyUrR
//                           ("Ecopreneurship — Profile Interviews")
//   AIRTABLE_TABLE        — optional; table name, default "Responses"
//   ALLOWED_ORIGIN        — optional; lock CORS to the site's own origin in prod
//
// The Airtable table already exists with these fields (created 2026-07-23):
//   Profile key | Name | LinkedIn | Program | Challenge | Who they're building for
//   | Stage (single select) | Approaches (multiple select) | What they bring
//   | What they're seeking | Submitted at (dateTime) | Status (single select: New / Reviewed)
//
// Request (POST JSON): { key, name, linkedin, program, challenge, customer, stage, approaches: [], brings, seeks }
// Response: { ok: true } or { error }

const API = "https://api.airtable.com/v0";

// The five stages the app offers, mirroring this.STAGES in Atlas Map.dc.html. Anything else
// is dropped rather than sent.
//
// This exists because `typecast: true` is set on the write, and for a singleSelect typecast
// does NOT mean "reject unknown values" — it means "create them". Posting a stage of
// "Not A Real Stage" silently added exactly that as a sixth option, coloured blue, sitting in
// the picker for everyone. Verified against the live base, then cleaned up. Approaches has
// the same exposure but genuinely needs typecast for its twelve names, so the narrow fix is
// to validate the one free-text-ish field the client controls rather than drop typecast and
// break the multi-select.
const STAGES = new Set([
  "Just an idea", "Building a prototype", "Running a pilot",
  "Early customers / revenue", "Raising a round",
]);

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || "Responses";
  if (!token || !baseId) return res.status(500).json({ error: "server_not_configured" });

  try {
    const { key, name, linkedin = "", program = "", challenge = "", customer = "", stage = "", approaches = [], brings = "", seeks = "" } = req.body || {};
    if (!key || !name) return res.status(400).json({ error: "key and name required" });

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const url = `${API}/${baseId}/${encodeURIComponent(table)}`;

    // Approaches is a multiple-select; send an array. Everything else is text/date.
    const fields = {
      "Profile key": key, Name: name, LinkedIn: linkedin, Program: program,
      Challenge: challenge, "Who they're building for": customer,
      // single select — only a stage the app actually offers. An unrecognised one is dropped,
      // not written: with typecast on, sending it would ADD it as a new option (see STAGES).
      ...(STAGES.has(String(stage).trim()) ? { Stage: String(stage).trim() } : {}),
      Approaches: Array.isArray(approaches) ? approaches : [],
      "What they bring": brings, "What they're seeking": seeks,
      "Submitted at": new Date().toISOString(),
    };

    // find an existing row for this student (upsert on Profile key)
    const findUrl = `${url}?filterByFormula=${encodeURIComponent(`{Profile key}="${key.replace(/"/g, '\\"')}"`)}&maxRecords=1`;
    const found = await fetch(findUrl, { headers }).then((r) => r.json());
    if (found.error) throw new Error(found.error.message || "airtable_lookup_failed");

    const existing = found.records && found.records[0];
    // typecast lets Airtable accept the Approaches option names; Status set to New only on first insert
    const write = existing
      ? fetch(`${url}/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ fields, typecast: true }) })
      : fetch(url, { method: "POST", headers, body: JSON.stringify({ records: [{ fields: { ...fields, Status: "New" } }], typecast: true }) });
    const result = await write.then((r) => r.json());
    if (result.error) throw new Error(result.error.message || "airtable_write_failed");

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("save error:", err);
    return res.status(500).json({ error: "save_failed" });
  }
}
