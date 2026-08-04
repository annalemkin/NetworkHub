// /api/intros — a log of who you've reached out to (BACKEND.md, Sent Intros).
//
//   POST { targetName, targetKey?, channel } → appends ONE row for the signed-in sender
//   GET                                      → { intros: [ … ] }, YOUR OWN rows and nobody else's
//
// This is the opposite of /api/track in every respect, and the two must not be confused.
// /api/track writes counts with nobody attached and therefore needs no session. This writes
// "person A contacted person B", which is exactly the kind of row that must never be
// attributable to the wrong person or readable by the wrong one. So:
//
//   - the SENDER is the verified session, never the request body. A client-supplied sender
//     key would let anyone write outreach history into someone else's name — the same rule,
//     and the same reason, as /api/exchange's Profile key.
//   - GET filters on the session's own key server-side. There is no endpoint here that lists
//     the log, and no parameter that widens it. Who a person is quietly asking for help is
//     theirs; a leak here is a social one, not just a privacy one.
//   - no email is read or written, in either direction.
//
// Airtable: base AIRTABLE_BASE_ID, table "Sent Intros" (tbl7OZt14qXt01Ztw). Append-only —
// one row per send, unlike Exchange which upserts a single row per person.
// Env: CLERK_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID (+ optional ALLOWED_ORIGIN).

import { createClerkClient, verifyToken } from "@clerk/backend";

const API = "https://api.airtable.com/v0";
const TABLE = "Sent Intros";

// Which reach-out flow this came from. A singleSelect, and singleSelects are why this is a
// whitelist rather than a length check: Airtable's typecast CREATES an unknown option rather
// than rejecting it (learned the hard way on Responses.Stage), so an unrecognised channel
// would quietly add itself to the picker. Nothing here sends typecast, and nothing here
// sends a channel that isn't one of these two.
const CHANNELS = new Set(["Map", "Mentorship"]);

// A display name and an identity key, both from the browser. They describe the RECIPIENT, who
// has no session here, so they cannot be derived server-side the way the sender is — the
// honest mitigation is a tight cap and no interpretation. Worst case someone logs a wrong
// name into their own private list.
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

async function airtable(pathname, opts = {}) {
  const r = await fetch(`${API}/${process.env.AIRTABLE_BASE_ID}/${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message || j.error.type || "airtable_error");
  return j;
}

// the account's own profile key: set on the Clerk user by /api/link, or read from the
// Accounts review queue when Anna linked them by hand and they haven't signed in since.
// Identical to /api/exchange's — same identity, same rule.
async function sessionProfileKey(clerk, userId) {
  const user = await clerk.users.getUser(userId);
  const fromMeta = (user.publicMetadata && user.publicMetadata.profileKey) || "";
  if (fromMeta) return String(fromMeta);
  const formula = encodeURIComponent(`{Clerk user id}='${userId.replace(/'/g, "\\'")}'`);
  const j = await airtable(`Accounts?filterByFormula=${formula}&maxRecords=1`);
  const f = ((j.records || [])[0] || {}).fields || {};
  return f["Status"] === "Linked" ? String(f["Profile key"] || "") : "";
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server_not_configured" });

  // BOTH methods require a session — there is no anonymous read here, by design
  let userId;
  try {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ error: "signed_out" });
    const payload = await verifyToken(token, { secretKey });
    userId = payload.sub;
    if (!userId) throw new Error("no_sub");
  } catch (e) {
    return res.status(401).json({ error: "signed_out" });
  }

  let senderKey;
  try {
    const clerk = createClerkClient({ secretKey });
    senderKey = await sessionProfileKey(clerk, userId);
  } catch (err) {
    console.error("intros identity error:", err);
    return res.status(500).json({ error: "intros_failed" });
  }
  // signed in but not connected to anyone on the map — nothing to attribute a send to, and
  // nothing of theirs to read back
  if (!senderKey) return res.status(200).json({ intros: [], notLinked: true });

  // ---------- GET: this person's own log ----------
  if (req.method === "GET") {
    try {
      const formula = encodeURIComponent(`{Sender key}='${senderKey.replace(/'/g, "\\'")}'`);
      const intros = [];
      let offset;
      do {
        const page = await airtable(`${encodeURIComponent(TABLE)}?pageSize=100&filterByFormula=${formula}${offset ? `&offset=${offset}` : ""}`);
        for (const rec of page.records || []) {
          const f = rec.fields || {};
          // belt and braces: the formula already scopes this, but a row that isn't theirs must
          // never reach the browser even if the filter is ever edited wrongly
          if (String(f["Sender key"] || "") !== senderKey) continue;
          intros.push({
            name: f["Target name"] || "",
            key: f["Target key"] || "",
            channel: (f.Channel && f.Channel.name) || f.Channel || "",
            at: f["Sent at"] || "",
          });
        }
        offset = page.offset;
      } while (offset);
      intros.sort((a, b) => String(b.at).localeCompare(String(a.at)));   // newest first
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ intros });
    } catch (err) {
      console.error("intros read error:", err);
      return res.status(500).json({ error: "intros_failed" });
    }
  }

  // ---------- POST: log one send ----------
  try {
    const b = req.body || {};
    const targetName = clean(b.targetName, 120);
    const channel = clean(b.channel, 20);
    if (!targetName) return res.status(400).json({ error: "targetName required" });
    if (!CHANNELS.has(channel)) return res.status(400).json({ error: "unknown_channel" });

    await airtable(encodeURIComponent(TABLE), {
      method: "POST",
      body: JSON.stringify({
        records: [{ fields: {
          "Sender key": senderKey,
          "Target name": targetName,
          "Target key": clean(b.targetKey, 200),
          Channel: channel,
          "Sent at": new Date().toISOString(),
        } }],
      }),
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("intros write error:", err);
    return res.status(500).json({ error: "intros_failed" });
  }
}
