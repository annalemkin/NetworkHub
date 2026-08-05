// /api/save — persists a finished profile interview to Airtable.
//
// The site calls this when a student finishes (or edits) their interview. Upserts on the
// student's Profile key, so re-taking the interview updates the existing row rather than
// duplicating it — that upsert IS the update path, there is no second endpoint for editing.
//
// THE KEY COMES FROM THE SESSION, NEVER THE BODY. This endpoint used to take `key` from the
// request, which was survivable only because nothing called it: the app had a "FUTURE:"
// comment where the fetch belonged. Wiring the interview up without fixing that would have
// been precisely the open door CLAUDE.md warns about — anyone could POST a key and overwrite
// any student's interview answers, and those answers drive who the whole map recommends. Now
// it derives the key the same way /api/exchange and /api/intros do: from the verified Clerk
// session, server-side. A `key` in the body is ignored.
//
// Secrets live in env vars — never in the page:
//   CLERK_SECRET_KEY      — required; verifies the caller's session
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
// Request (POST JSON): { name?, linkedin?, program?, challenge, customer, stage, approaches: [], brings, seeks }
//   Authorization: Bearer <clerk session token>
// Response: { ok: true, profileKey } | { error }

import { createClerkClient, verifyToken } from "@clerk/backend";

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

// the account's own profile key, and the name on the account. Identical to /api/exchange's —
// same identity, same rule, and deliberately the same code shape so a reader can see they
// cannot drift into disagreeing about who someone is.
async function sessionProfileKey(clerk, userId, airtableGet) {
  const user = await clerk.users.getUser(userId);
  const fromMeta = (user.publicMetadata && user.publicMetadata.profileKey) || "";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  if (fromMeta) return { profileKey: String(fromMeta), name };
  const formula = encodeURIComponent(`{Clerk user id}='${userId.replace(/'/g, "\\'")}'`);
  const j = await airtableGet(`Accounts?filterByFormula=${formula}&maxRecords=1`);
  const f = ((j.records || [])[0] || {}).fields || {};
  return { profileKey: f["Status"] === "Linked" ? String(f["Profile key"] || "") : "", name };
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  const secretKey = process.env.CLERK_SECRET_KEY;
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || "Responses";
  if (!secretKey || !token || !baseId) return res.status(500).json({ error: "server_not_configured" });

  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const airtableGet = async (pathname) => {
    const r = await fetch(`${API}/${baseId}/${pathname}`, { headers });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || j.error.type || "airtable_error");
    return j;
  };

  let userId;
  try {
    const auth = String(req.headers.authorization || "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!bearer) return res.status(401).json({ error: "signed_out" });
    const payload = await verifyToken(bearer, { secretKey });
    userId = payload.sub;
    if (!userId) throw new Error("no_sub");
  } catch (e) {
    return res.status(401).json({ error: "signed_out" });
  }

  try {
    const clerk = createClerkClient({ secretKey });
    const { profileKey: key, name: acctName } = await sessionProfileKey(clerk, userId, airtableGet);
    // signed in but not connected to anyone on the map — there is no row that is theirs to write
    if (!key) return res.status(403).json({ error: "not_linked" });

    // ---------- GET: this person's own saved answers, for pre-filling the edit ----------
    // Scoped to the session exactly like the write. This is what makes "come back and change
    // your answers" work on a different browser than the one you first answered on — the
    // local copy in localStorage only ever knew about this device.
    if (req.method === "GET") {
      const findUrl = `Responses?filterByFormula=${encodeURIComponent(`{Profile key}="${key.replace(/"/g, '\\"')}"`)}&maxRecords=1`;
      const found = await airtableGet(findUrl.replace(/^Responses/, encodeURIComponent(table)));
      const f = ((found.records || [])[0] || {}).fields || {};
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        profileKey: key,
        // null rather than {} when they've never answered, so the client can tell "no row yet"
        // from "answered and left everything blank"
        answers: (found.records || []).length ? {
          challenge: f.Challenge || "",
          customer: f["Who they're building for"] || "",
          stage: (f.Stage && f.Stage.name) || f.Stage || "",
          approaches: Array.isArray(f.Approaches) ? f.Approaches.map((a) => (a && a.name) || a) : [],
          brings: f["What they bring"] || "",
          seeks: f["What they're seeking"] || "",
        } : null,
      });
    }

    // `key` is NOT read from the body — see the header note. A body key is ignored entirely.
    const { name, linkedin = "", program = "", challenge = "", customer = "", stage = "", approaches = [], brings = "", seeks = "" } = req.body || {};
    // the account's own name wins; the body's is a fallback for an account with no name set
    const rowName = acctName || String(name || "").trim();
    if (!rowName) return res.status(400).json({ error: "name required" });

    const url = `${API}/${baseId}/${encodeURIComponent(table)}`;

    // Approaches is a multiple-select; send an array. Everything else is text/date.
    const fields = {
      "Profile key": key, Name: rowName, LinkedIn: linkedin, Program: program,
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

    return res.status(200).json({ ok: true, profileKey: key });
  } catch (err) {
    console.error("save error:", err);
    return res.status(500).json({ error: "save_failed" });
  }
}
