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
//   Profile key | Name | LinkedIn | Program | Challenge | Who bears it
//   | Approaches (multiple select) | What they bring | What they're seeking
//   | Submitted at (dateTime) | Status (single select: New / Reviewed)
//
// Request (POST JSON): { key, name, linkedin, program, challenge, who, approaches: [], brings, seeks }
// Response: { ok: true } or { error }

const API = "https://api.airtable.com/v0";

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
    const { key, name, linkedin = "", program = "", challenge = "", who = "", approaches = [], brings = "", seeks = "" } = req.body || {};
    if (!key || !name) return res.status(400).json({ error: "key and name required" });

    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const url = `${API}/${baseId}/${encodeURIComponent(table)}`;

    // Approaches is a multiple-select; send an array. Everything else is text/date.
    const fields = {
      "Profile key": key, Name: name, LinkedIn: linkedin, Program: program,
      Challenge: challenge, "Who bears it": who, Approaches: Array.isArray(approaches) ? approaches : [],
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
