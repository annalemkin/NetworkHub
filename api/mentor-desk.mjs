// /api/mentor-desk — the mentoring relationship, as opposed to the mentoring *match*.
//
//   GET  → { role, pairs: [...], decisions: {...} }
//   POST → records one mentor's decision about one suggested student
//          Body: { student, decision: "accepted"|"declined"|"none", offers: [...] }
//
// /api/mentorship answers "who should meet whom". This answers "who actually is meeting whom,
// and what has this mentor already said about the people they were shown". Two different
// lifetimes: a match is recomputed on every request, a pairing outlives the ranking that
// suggested it, so it cannot live in the same place.
//
// TWO AIRTABLE TABLES, BOTH OPTIONAL:
//
//   "Mentor Pairings"   — the owner's own list, maintained by hand. This is the authority on
//                         who a student's mentors ARE; the ranking never promotes itself into
//                         a pairing. Fields: Mentor key, Student key, Status, Since, Note.
//   "Mentor Decisions"  — written by this endpoint when a mentor accepts or declines someone
//                         they were suggested. Accepting is NOT a pairing: it tells the
//                         programme team this mentor is willing, and they make the call.
//                         Fields: Mentor key, Student key, Decision, Offers, Updated.
//
// NEITHER TABLE HAS TO EXIST. Missing tables come back as 403/404 from Airtable and are
// swallowed into an empty result, so this ships before the tables do and lights up on its own
// when they appear. That is deliberate: the alternative is a dashboard that 500s until someone
// remembers to build a table by hand.
//
// Identity rules, same as /api/mentorship and /api/link:
//   - the mentor is taken from the VERIFIED session email, never from the request body
//   - you can only read your own pairings and write your own decisions
//   - no email address is ever returned to the browser
//
// Env: CLERK_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID (+ optional ALLOWED_ORIGIN).

import { createClerkClient, verifyToken } from "@clerk/backend";
import { loadPeople, liKey } from "./link.mjs";

const API = "https://api.airtable.com/v0";
const PAIRINGS = "Mentor Pairings";
const DECISIONS = "Mentor Decisions";

// Airtable singleSelects: typecast CREATES an unknown option rather than rejecting it, so an
// unrecognised value would quietly add itself to the picker. Same lesson as intros.mjs.
const DECISION_VALUES = new Set(["accepted", "declined", "none"]);
// what a mentor can say they'd give this particular student — the students' own vocabulary,
// so a mentor's offer and a student's ask are written in the same words
const OFFER_MAX = 24, OFFER_LEN = 60;

const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
// Both tables are keyed on whatever the owner types, and she types LinkedIn URLs. liKey
// normalises a full URL, a bare slug or an already-normalised key to the same "in/slug", so a
// pairing still matches whichever form ended up in the cell. Falls back to a normalised name.
const keyOf = (v) => liKey(v) || norm(v);

// pathname arrives already encoded, same contract as intros.mjs and exchange.mjs
async function airtable(pathname, opts = {}) {
  const r = await fetch(`${API}/${process.env.AIRTABLE_BASE_ID}/${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message || j.error.type || "airtable_error");
  return j;
}

// A table that hasn't been created yet is not an error condition here — see the note above.
// Anything else still throws, so a real outage doesn't masquerade as "no pairings".
async function optionalTable(table) {
  try {
    const j = await airtable(`${encodeURIComponent(table)}?pageSize=100`);
    return { ok: true, records: j.records || [] };
  } catch (e) {
    const m = String((e && e.message) || e);
    // "Could not find table X in application app…" is Airtable's real wording for a table that
    // hasn't been created — note it's "not FIND", so a /not found/ pattern misses it entirely.
    if (/NOT_FOUND|TABLE_NOT_FOUND|INVALID_PERMISSIONS|not found|could not find|permission/i.test(m)) return { ok: false, records: [] };
    throw e;
  }
}

// Which mentorship list this account is on, by verified email. Deliberately a separate lookup
// from /api/link's map matching: a mentor has no dot, and being on the map is not what makes
// somebody a mentor.
async function whoAmI(email, metaKey) {
  const out = { role: null, key: "" };
  if (!email && !metaKey) return out;
  for (const [table, role] of [["Mentorship Alumni", "mentor"], ["Mentorship Students", "student"]]) {
    const t = await optionalTable(table);
    if (!t.ok) continue;
    const hit = t.records.find((r) => {
      const f = r.fields || {};
      return (email && norm(f.Email) === email) || (metaKey && keyOf(f["Profile key"]) === keyOf(metaKey));
    });
    if (hit) {
      const f = hit.fields || {};
      return { role, key: keyOf(f["Profile key"] || f["LinkedIn URL"] || f.Name), name: f.Name || "" };
    }
  }
  return out;
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

  let userId = "";
  try {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) throw new Error("no_token");
    const claims = await verifyToken(token, { secretKey });
    userId = claims && claims.sub;
    if (!userId) throw new Error("no_sub");
  } catch (e) {
    return res.status(401).json({ error: "signed_out" });
  }

  try {
    const clerk = createClerkClient({ secretKey });
    const user = await clerk.users.getUser(userId);
    const primary = (user.emailAddresses || []).find((e) => e.id === user.primaryEmailAddressId);
    // verified only — the same rule /api/link and /api/mentorship use. An unverified address
    // would let anyone claim a mentor's desk by typing their address at sign-up.
    const email = primary && primary.verification && primary.verification.status === "verified"
      ? norm(primary.emailAddress) : "";
    const metaKey = String((user.publicMetadata && user.publicMetadata.profileKey) || "");

    const me = await whoAmI(email, metaKey);
    // a map student who is on no mentorship list still has pairings to read — their key is the
    // profile key /api/link gave them
    const myKey = me.key || keyOf(metaKey);
    if (!myKey) return res.status(200).json({ role: null, pairs: [], decisions: {} });
    const iAmMentor = me.role === "mentor";

    // ---------- POST: one mentor's decision about one student ----------
    if (req.method === "POST") {
      if (!iAmMentor) return res.status(403).json({ error: "mentors_only" });
      const body = typeof req.body === "object" && req.body ? req.body : {};
      const student = keyOf(body.student);
      const decision = norm(body.decision) || "none";
      if (!student) return res.status(400).json({ error: "no_student" });
      if (!DECISION_VALUES.has(decision)) return res.status(400).json({ error: "bad_decision" });
      const offers = Array.isArray(body.offers)
        ? [...new Set(body.offers.map((o) => clean(o, OFFER_LEN)).filter(Boolean))].slice(0, OFFER_MAX)
        : [];

      const t = await optionalTable(DECISIONS);
      if (!t.ok) return res.status(200).json({ ok: false, reason: "no_table" });
      const existing = t.records.find((r) => {
        const f = r.fields || {};
        return keyOf(f["Mentor key"]) === myKey && keyOf(f["Student key"]) === student;
      });
      const fields = {
        "Mentor key": myKey, "Student key": student,
        Decision: decision, Offers: offers.join(", "),
        Updated: new Date().toISOString().slice(0, 10),
      };
      // upsert on the pair, so a mentor changing their mind edits one row rather than leaving
      // a trail the programme team has to read in date order
      if (existing) {
        await airtable(`${encodeURIComponent(DECISIONS)}/${existing.id}`, { method: "PATCH", body: JSON.stringify({ fields }) });
      } else {
        await airtable(encodeURIComponent(DECISIONS), { method: "POST", body: JSON.stringify({ records: [{ fields }] }) });
      }
      return res.status(200).json({ ok: true });
    }

    // ---------- GET ----------
    const [pairT, decT, people] = await Promise.all([
      optionalTable(PAIRINGS),
      optionalTable(DECISIONS),
      loadPeople(req.headers.host).catch(() => []),
    ]);

    // the map person behind a key, for the name and venture a card needs. Mentors aren't on the
    // map, so their half is filled from the mentorship table instead.
    const byKey = new Map();
    people.forEach((p) => { const k = keyOf(p.linkedin) || norm(p.name); if (k) byKey.set(k, p); });
    const mentorsT = await optionalTable("Mentorship Alumni");
    const mentorByKey = new Map();
    (mentorsT.records || []).forEach((r) => {
      const f = r.fields || {};
      const k = keyOf(f["Profile key"] || f["LinkedIn URL"] || f.Name);
      if (k) mentorByKey.set(k, f);
    });

    const pairs = (pairT.records || [])
      .map((r) => r.fields || {})
      .filter((f) => norm(f.Status) !== "ended")
      .filter((f) => keyOf(f[iAmMentor ? "Mentor key" : "Student key"]) === myKey)
      .map((f) => {
        const otherKey = keyOf(f[iAmMentor ? "Student key" : "Mentor key"]);
        const mp = byKey.get(otherKey), mf = mentorByKey.get(otherKey);
        return {
          key: otherKey,
          // never an email — a pairing existing is not consent to be written to directly
          name: (mf && mf.Name) || (mp && mp.name) || otherKey,
          detail: (mf && mf["Current Role and Institution"]) || (mp && mp.venture) || "",
          program: (mf && mf["Career Stage"]) || ((mp && (mp.programs || [])[0]) || ""),
          offer: (mf && (mf["Hoping to experience"] || "")) || (mp && mp.offers) || "",
          ask: (mp && mp.asks) || "",
          linkedin: (mf && mf["LinkedIn URL"]) || (mp && mp.linkedin) || "",
          since: f.Since || "", note: f.Note || "", status: f.Status || "Active",
        };
      });

    // this mentor's own past decisions, keyed by student, so the roster can be split into
    // Suggested / Accepted / Declined without a second request
    const decisions = {};
    (decT.records || []).forEach((r) => {
      const f = r.fields || {};
      if (keyOf(f["Mentor key"]) !== myKey) return;
      decisions[keyOf(f["Student key"])] = {
        decision: norm(f.Decision) || "none",
        offers: String(f.Offers || "").split(",").map((x) => x.trim()).filter(Boolean),
      };
    });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      role: me.role, name: me.name || "", pairs, decisions,
      // so the interface can say "ask Anna to set this up" rather than showing an empty shelf
      tables: { pairings: pairT.ok, decisions: decT.ok },
    });
  } catch (err) {
    console.error("mentor-desk error:", err);
    return res.status(500).json({ error: "server_error" });
  }
}
