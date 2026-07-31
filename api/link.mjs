// /api/link — connects a signed-in account to a person on the map (BACKEND.md, Identity).
//
// POST only, and only with a valid Clerk session. Flow, in order:
//   1. verified session → the account's primary email (server-side only)
//   2. Accounts table already says Linked (Anna linked them by hand) → done
//   3. Directory table email match → linked
//   4. body.linkedin, normalised to in/<slug>, exact match against data.js → linked
//   5. nothing matched → the account is upserted into the Accounts review queue
//
// body.unlink undoes a match: the person pressed "That's not me" on the dot they were
// linked to. It clears their profile key and ticks "Not me" in the queue, which is sticky —
// step 3 would otherwise re-link them to the same wrong person on their next sign-in, and
// they'd have no way to say so twice. Only Anna clears it, by linking them by hand.
//
// Responses: { status: "linked", profileKey } | { status: "needs_linkedin" }
//          | { status: "unmatched" } | { status: "unlinked" }
// NON-NEGOTIABLE: no email ever appears in a response. The lookup is server-side; the
// browser only ever sees a profile key. The profile key comes from the verified session's
// email or an exact LinkedIn match — never from a client-supplied key.
//
// Env: CLERK_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID (+ optional ALLOWED_ORIGIN).

import { createClerkClient, verifyToken } from "@clerk/backend";

const API = "https://api.airtable.com/v0";

// LinkedIn URL → canonical "in/<slug>" — same logic as liKey() in airtable-pull.js. People
// paste ?trk= junk, trailing slashes, http vs https, and sometimes just the slug; a bare
// slug (no dots, no spaces) is accepted as-is. Exact matching only — no guessing.
export function liKey(url) {
  const s = String(url || "").trim().toLowerCase();
  const m = s.match(/linkedin\.com\/(?:in|pub)\/([^\/?#]+)/);
  if (m) return "in/" + decodeURIComponent(m[1]).replace(/\/+$/, "");
  if (/^[a-z0-9][a-z0-9\-_.%]*$/.test(s) && !s.includes(".com")) return "in/" + decodeURIComponent(s).replace(/\/+$/, "");
  return "";
}

const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");
const profileKeyOf = (p) => (String(p.linkedin || "").trim().toLowerCase()) || norm(p.name);

// data.js is deployed alongside the functions; fetch it from this same deployment rather
// than the filesystem so nothing depends on how Vercel bundles the function. Cached for
// the life of the warm instance — the people list changes at most weekly.
let _people = null;
export async function loadPeople(host) {
  if (_people) return _people;
  const base = process.env.VERCEL_URL || host;
  if (!base) throw new Error("no_host_for_data_js");
  const src = await fetch(`${base.startsWith("http") ? base : "https://" + base}/data.js`).then((r) => {
    if (!r.ok) throw new Error("data_js_fetch_failed");
    return r.text();
  });
  const win = {};
  new Function("window", src)(win);
  _people = (win.FALLBACK_PEOPLE || []).concat(win.ALUMNI_PEOPLE || []);
  return _people;
}

// exact LinkedIn match against the map — returns the matched person's profile key or ""
export function matchLinkedIn(people, input) {
  const want = liKey(input);
  if (!want) return "";
  const hit = people.find((p) => liKey(p.linkedin) === want);
  return hit ? profileKeyOf(hit) : "";
}

async function airtable(pathname, opts = {}) {
  const r = await fetch(`${API}/${process.env.AIRTABLE_BASE_ID}/${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.type || "airtable_error");
  return j;
}

// Directory lookup: signed-in email → profile key. Server-side only, case-insensitive.
async function directoryLookup(email) {
  if (!email) return "";
  const esc = email.toLowerCase().replace(/'/g, "\\'");
  const formula = encodeURIComponent(`LOWER({Email})='${esc}'`);
  const j = await airtable(`Directory?filterByFormula=${formula}&maxRecords=1`);
  const rec = (j.records || [])[0];
  return (rec && rec.fields["Profile key"]) || "";
}

async function accountsRow(userId) {
  const esc = userId.replace(/'/g, "\\'");
  const formula = encodeURIComponent(`{Clerk user id}='${esc}'`);
  const j = await airtable(`Accounts?filterByFormula=${formula}&maxRecords=1`);
  return (j.records || [])[0] || null;
}

// one row per account, upserted on Clerk user id — this is Anna's review queue
async function upsertAccount(fields) {
  await airtable("Accounts", {
    method: "PATCH",
    body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ["Clerk user id"] }, records: [{ fields }] }),
  });
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server_not_configured" });

  // ---- session check: identity comes from the verified token, never the request body ----
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

  try {
    const clerk = createClerkClient({ secretKey });
    const user = await clerk.users.getUser(userId);
    const primary = (user.emailAddresses || []).find((e) => e.id === user.primaryEmailAddressId);
    // only a VERIFIED email may match — an unverified address proves nothing
    const email = primary && primary.verification && primary.verification.status === "verified" ? primary.emailAddress : "";
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
    const claimed = String((req.body && req.body.linkedin) || "").slice(0, 300);
    const unlink = !!(req.body && req.body.unlink);

    const finishLinked = async (profileKey) => {
      // publicMetadata is the durable, server-set record the app reads on sign-in
      await clerk.users.updateUserMetadata(userId, { publicMetadata: { profileKey } });
      // linking resolves any earlier dispute — a hand-link from Anna is the answer to it
      await upsertAccount({ "Clerk user id": userId, ...(email ? { Email: email } : {}), Name: name, "Profile key": profileKey, Status: "Linked", "Not me": false, ...(claimed ? { "Claimed LinkedIn": claimed } : {}) });
      return res.status(200).json({ status: "linked", profileKey });
    };

    const existing = await accountsRow(userId);
    const exF = existing ? existing.fields : {};

    // "That's not me" — the only path that can UNDO a match, and it is always the account's
    // own. Nothing from the browser is trusted here except the intent: the key being cleared
    // is the one the session already carries.
    if (unlink) {
      await clerk.users.updateUserMetadata(userId, { publicMetadata: { profileKey: null } });
      await upsertAccount({ "Clerk user id": userId, ...(email ? { Email: email } : {}), Name: name, "Profile key": "", Status: "Pending", "Not me": true });
      return res.status(200).json({ status: "unlinked" });
    }

    // hand-linked by Anna in the review queue → honor it before anything else
    if (exF["Status"] && exF["Status"] !== "Pending" ) {
      if (exF["Status"] === "Linked" && exF["Profile key"]) return finishLinked(exF["Profile key"]);
      return res.status(200).json({ status: "unmatched" });   // Rejected — queued and closed
    }
    // step 1 — email match, entirely server-side. Skipped for anyone who has already said
    // the match was wrong: their email is exactly what produced the wrong dot, so running it
    // again would hand them the same one. They can still claim a LinkedIn URL at step 2 —
    // that's their own answer rather than ours, and it clears the dispute if it matches.
    const byEmail = exF["Not me"] ? "" : await directoryLookup(email);
    if (byEmail) return finishLinked(byEmail);

    // step 2 — exact LinkedIn match, if they offered one
    if (claimed) {
      const byLi = matchLinkedIn(await loadPeople(req.headers.host), claimed);
      if (byLi) return finishLinked(byLi);
      await upsertAccount({ "Clerk user id": userId, ...(email ? { Email: email } : {}), Name: name, "Claimed LinkedIn": claimed, Status: "Pending" });
      return res.status(200).json({ status: "unmatched" });
    }

    // step 3 — nothing to go on yet: queue the account, ask the browser for a LinkedIn URL
    await upsertAccount({ "Clerk user id": userId, ...(email ? { Email: email } : {}), Name: name, Status: "Pending" });
    // already asked and they had no answer last time → don't re-ask forever
    if (exF["Claimed LinkedIn"]) return res.status(200).json({ status: "unmatched" });
    return res.status(200).json({ status: "needs_linkedin" });
  } catch (err) {
    console.error("link error:", err);
    return res.status(500).json({ error: "link_failed" });
  }
}
