// /api/admin-pairs — the programme owner's view of who is matched with whom.
//
//   POST { keys: [profileKey, …] }
//     → { emails, mentors: { confirmed, suggested }, roster, counts }
//
// STAFF ONLY, AND THE ONLY PLACE IN THIS APP THAT RETURNS AN EMAIL ADDRESS.
//
// Every other endpoint here is built so email never reaches the browser — /api/mentorship says
// so in its own header, /api/mentor-desk returns names and roles and nothing else. This one
// exists precisely to hand the owner addresses so she can write the introduction, so the gate
// has to carry weight the others don't:
//
//   - publicMetadata.staff must be true, read from the Clerk user server-side. That half of the
//     metadata is server-set and arrives signed in the session token; unsafeMetadata is
//     client-writable and is never consulted. A non-staff session gets 403 and no body.
//   - nothing here is logged. No console.log of an address, and the catch-all logs a message
//     only — an Airtable error object can carry record fields, so it is never spread into logs.
//   - emails are returned ONLY for the keys the caller asked about, and only as a flat map. No
//     endpoint on this app lists the address book.
//
// WHY THE PAIRING IS SPLIT ACROSS CLIENT AND SERVER. Reciprocity pairs are computed in the
// browser and only their KEYS are sent here, because reciprocity() lives inside the page's
// component class with six helpers and two vocabularies behind it, and the page has no module
// loader — lifting it into something a serverless function could import means real plumbing for
// no gain. The browser already holds every person's asks and offers. Mentor pairings are the
// other way round: the 111 alumni exist only in Airtable and rankMatches is already here. So
// each half is computed where its data and its engine already are, and neither is duplicated.
//
// Env: CLERK_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID (+ optional ALLOWED_ORIGIN).

import { createClerkClient, verifyToken } from "@clerk/backend";
import { loadPeople, liKey } from "./link.mjs";
import { studentOf, alumOf, mapStudentOf, rankMatches, dedupe, emptyDims } from "./mentorship.mjs";

const API = "https://api.airtable.com/v0";
const ACCOUNTS = "Accounts";
const PAIRINGS = "Mentor Pairings";
const DECISIONS = "Mentor Decisions";
const STUDENTS = "Mentorship Students";
const ALUMNI = "Mentorship Alumni";

// mirrors HIDDEN_PROGRAMS in Atlas Map.dc.html and mentorship.mjs — see the note there
const HIDDEN_PROGRAMS = ["ecoramp"];
// a suggestion is only worth surfacing if it would have been the student's top pick
const SUGGEST_PER_STUDENT = 1;
// how many keys one request may ask about. Not a security boundary — the caller is already
// staff — but a cap keeps a runaway client from asking for the whole address book in one go.
const MAX_KEYS = 600;

const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");
const keyOf = (v) => liKey(v) || norm(v);

async function airtable(pathname, opts = {}) {
  const r = await fetch(`${API}/${process.env.AIRTABLE_BASE_ID}/${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message || j.error.type || "airtable_error");
  return j;
}

// Same contract as /api/mentor-desk: a table that hasn't been made yet reads as empty rather
// than as an outage, so this view works before the owner has created everything.
async function optionalTable(table) {
  try {
    const out = [];
    let offset = "";
    do {
      const j = await airtable(`${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ""}`);
      out.push(...(j.records || []));
      offset = j.offset || "";
    } while (offset && out.length < 2000);
    return { ok: true, records: out };
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/NOT_FOUND|TABLE_NOT_FOUND|INVALID_PERMISSIONS|not found|could not find|permission/i.test(m)) return { ok: false, records: [] };
    throw e;
  }
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
    // THE GATE. Server-set metadata only; a visitor cannot grant themselves this by editing the
    // page, and no part of the body below is computed before this check passes.
    if (!(user.publicMetadata && user.publicMetadata.staff))
      return res.status(403).json({ error: "staff_only" });

    const body = typeof req.body === "object" && req.body ? req.body : {};
    const wanted = Array.isArray(body.keys)
      ? [...new Set(body.keys.map(keyOf).filter(Boolean))].slice(0, MAX_KEYS)
      : [];

    const [accountsT, pairingsT, decisionsT, studentsT, alumniT, people] = await Promise.all([
      optionalTable(ACCOUNTS), optionalTable(PAIRINGS), optionalTable(DECISIONS),
      optionalTable(STUDENTS), optionalTable(ALUMNI),
      loadPeople(req.headers.host).catch(() => []),
    ]);

    const mapPeople = people.filter(
      (p) => !((p.programs || []).length && (p.programs || []).every((x) => HIDDEN_PROGRAMS.includes(norm(x)))),
    );

    // ---------- emails, by profile key ----------
    //
    // Two sources, because a person can be known to this system two different ways and the
    // architecture deliberately keeps email out of data.js and out of the interview Responses:
    //
    //   Accounts.Email     — only exists once somebody has SIGNED IN; /api/link writes it there.
    //                        Status must be "Linked": a Pending row is an unresolved claim, and
    //                        treating it as identity would attach an address to the wrong person.
    //   Mentorship tables  — carry Email natively, from the interest form, sign-in or not.
    //
    // Anyone with neither is returned absent rather than omitted silently, so the interface can
    // show the pair and flag the gap instead of hiding a real match.
    const emails = {};
    const addEmail = (k, e) => { const kk = keyOf(k), ee = norm(e); if (kk && ee && !emails[kk]) emails[kk] = ee; };
    (accountsT.records || []).forEach((r) => {
      const f = r.fields || {};
      if (norm(f.Status) !== "linked") return;
      addEmail(f["Profile key"], f.Email);
    });
    [...(studentsT.records || []), ...(alumniT.records || [])].forEach((r) => {
      const f = r.fields || {};
      addEmail(f["Profile key"] || f["LinkedIn URL"] || f.Name, f.Email);
    });

    // Only keys this response is actually about leave the function. That is the caller's list
    // PLUS the two sides of every pairing this endpoint itself returns — filled in after the
    // mentor work below, because the caller cannot ask for keys it has not received yet.
    //
    // Getting this wrong is not a leak but it is a silent failure: the first version returned
    // the asked-for keys only, so all 87 suggested pairings reported "no email on file" while
    // every one of the 111 mentors had an address sitting right there. The point of the screen
    // is the address.
    const emailsOut = {};
    const includeKey = (k) => { const kk = keyOf(k); if (kk && emails[kk]) emailsOut[kk] = emails[kk]; };
    wanted.forEach(includeKey);

    // ---------- mentor pairings ----------
    const students = dedupe((studentsT.records || []).map((r) => studentOf(r.fields || {})));
    const alumni = dedupe((alumniT.records || []).map((r) => alumOf(r.fields || {})));
    const alumByKey = new Map(alumni.map((a) => [a.key, a]));
    const mapCurrent = mapPeople.filter((p) => p.status === "current").map(mapStudentOf);
    const studentPool = dedupe(students.concat(mapCurrent));
    const studentByKey = new Map(studentPool.map((s) => [s.key, s]));

    const pairRows = (pairingsT.records || []).map((r) => r.fields || {}).filter((f) => norm(f.Status) !== "ended");
    const pairCtx = new Map();
    pairRows.forEach((f) => pairCtx.set(`${keyOf(f["Mentor key"])}|${keyOf(f["Student key"])}`, f));

    // how many live mentees each mentor already carries — a pairing row, or an acceptance the
    // owner hasn't turned into one yet. Both are commitments from the mentor's side.
    const load = {};
    const bump = (k) => { const kk = keyOf(k); if (kk) load[kk] = (load[kk] || 0) + 1; };
    pairRows.forEach((f) => bump(f["Mentor key"]));

    const decisionRows = (decisionsT.records || []).map((r) => r.fields || {});
    const decided = new Set();      // mentor|student pairs already ruled on, either way
    const confirmed = [];
    decisionRows.forEach((f) => {
      const mk = keyOf(f["Mentor key"]), sk = keyOf(f["Student key"]);
      if (!mk || !sk) return;
      decided.add(`${mk}|${sk}`);
      if (norm(f.Decision) !== "accepted") return;
      if (!pairCtx.has(`${mk}|${sk}`)) bump(mk);   // accepted but not yet written up as a pairing
      const ctx = pairCtx.get(`${mk}|${sk}`) || {};
      const a = alumByKey.get(mk), s = studentByKey.get(sk);
      confirmed.push({
        kind: "confirmed",
        mentorKey: mk, mentorName: (a && a.name) || mk, mentorDetail: (a && a.role) || "",
        studentKey: sk, studentName: (s && s.name) || sk, studentDetail: (s && s.program) || "",
        since: ctx.Since || "", note: ctx.Note || "",
        offers: String(f.Offers || "").split(",").map((x) => x.trim()).filter(Boolean),
        // paired up AND written up, versus accepted and waiting for the owner to formalise it
        formalised: pairCtx.has(`${mk}|${sk}`),
      });
    });

    // Suggested = the ranking's top pick per student that nobody has acted on. Surfacing these
    // next to the confirmed ones is the point: it shows who is stalled, not just who is served.
    const suggested = [];
    studentPool.forEach((s) => {
      const ranked = rankMatches(s, alumni.filter((a) => a.key !== s.key), {});
      const top = ranked.filter((m) => !decided.has(`${keyOf(m.key)}|${s.key}`)).slice(0, SUGGEST_PER_STUDENT);
      top.forEach((m) => suggested.push({
        kind: "suggested",
        mentorKey: keyOf(m.key), mentorName: m.name, mentorDetail: m.role || "",
        studentKey: s.key, studentName: s.name, studentDetail: s.program || "",
        evidence: m.evidence || [], shared: m.shared || [], sameCity: !!m.sameCity,
      }));
    });

    // ---------- the mentor roster, for the sector lookup ----------
    // Every mentor, matched or not. Domains only — the one dimension with real intake answers,
    // and the same categories the matching engine scores on, so a filter here means the same
    // thing a match does.
    const roster = alumni.map((a) => ({
      key: a.key, name: a.name, detail: a.role || "", location: a.location || "",
      cohort: a.stage || "", linkedin: a.linkedin || "",
      domains: ((a.dims || emptyDims()).domains || []),
      mentees: load[a.key] || 0,
      hasEmail: !!emails[a.key],
    }));

    // now the pairings this response carries — see includeKey above
    [...confirmed, ...suggested].forEach((m) => { includeKey(m.mentorKey); includeKey(m.studentKey); });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      emails: emailsOut,
      mentors: { confirmed, suggested },
      roster,
      counts: { asked: wanted.length, withEmail: Object.keys(emailsOut).length,
                confirmed: confirmed.length, suggested: suggested.length, roster: roster.length },
      tables: { accounts: accountsT.ok, pairings: pairingsT.ok, decisions: decisionsT.ok,
                students: studentsT.ok, alumni: alumniT.ok },
    });
  } catch (err) {
    // message only — an Airtable error object can carry record fields, and record fields here
    // include Email. Never spread the error into a log.
    console.error("admin-pairs error:", (err && err.message) || "unknown");
    return res.status(500).json({ error: "server_error" });
  }
}
