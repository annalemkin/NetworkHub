// /api/peers — student-to-student matches on the map, from the mentorship engine.
//
//   GET → { role, name, dims, dimsSource, matches: [ … ] }
//   GET ?dims=domains,skills → score on only those dimensions
//
// WHY THIS EXISTS ALONGSIDE "Find your connections" RATHER THAN REPLACING IT
//
// The map already ranks peers, in egoData(), on reciprocity: does their offer meet my ask,
// does mine meet theirs. That answers "who can help whom" — a two-way, immediately actionable
// question, and the premise the whole site is built on ("Built on reciprocity").
//
// The four-dimension engine in /api/mentorship answers a different question: who works on the
// same ground as me — same domain, same skills, same customers, same shape of solution. That
// is adjacency, not reciprocity. Two people can be a perfect four-dimension match and have
// nothing to offer each other, and the best reciprocal match on the map is often someone from
// a completely different sector who happens to hold the one intro you need.
//
// Folding one score into the other would average two different meanings into a number that
// means neither, and would make the reason label on a card incoherent — "Can help you with X"
// and "Works the same ground as you" are not points on one scale. Replacing egoData would
// throw away reciprocity, which is the thing this community actually runs on. So: a second,
// clearly-labelled surface, and egoData is left exactly as it is.
//
// HONESTY DISCIPLINE — the guarantee 675d670 unified between the ego cards and the drafted
// emails must hold here too, and this surface is where it bites hardest. Almost nobody on the
// map has answered a dimension question: their ticks are INFERRED from venture prose by
// inferTicks(). So dimsSource travels with every match, per dimension, and the client applies
// the same claim / hedge / share split generateMentorIntro uses. A peer card may say "you both
// work in batteries" only where somebody actually said so; otherwise it hedges. The one
// dimension that can be self-reported today is customerGroup, from the interview's "who
// they're building for" answer — see customerFromInterview below.
//
// NON-NEGOTIABLE, same as /api/mentorship: identity comes from the verified session, you only
// ever get YOUR OWN matches, and no email ever reaches the browser.
//
// Env: CLERK_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID (+ optional ALLOWED_ORIGIN).

import { createClerkClient, verifyToken } from "@clerk/backend";
import { loadPeople, liKey } from "./link.mjs";
// ONE engine. Everything below is imported rather than reimplemented — a second copy of the
// scoring would be a second set of honesty rules to keep in step, which is the bug this whole
// sequence of changes has been about.
import {
  DIMENSIONS, DIMS, emptyDims, withInferredTicks, inferTicks, rankMatches, evidenceOf, parseDims,
} from "./mentorship.mjs";

const API = "https://api.airtable.com/v0";
const RESPONSES = "Responses";
const LIMIT = 6;

const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

async function airtable(pathname) {
  const r = await fetch(`${API}/${process.env.AIRTABLE_BASE_ID}/${pathname}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message || j.error.type || "airtable_error");
  return j;
}

// Everyone's interview answers, keyed by Profile key. These are the only SELF-REPORTED signal
// on the map side — everything else about a map person is prose we read.
async function loadInterviews() {
  const out = new Map();
  let offset;
  do {
    const page = await airtable(`${encodeURIComponent(RESPONSES)}?pageSize=100${offset ? `&offset=${offset}` : ""}`);
    for (const rec of page.records || []) {
      const f = rec.fields || {};
      const k = norm(f["Profile key"]);
      if (k) out.set(k, f);
    }
    offset = page.offset;
  } while (offset);
  return out;
}

// The interview asks "who are you building this for" in free text. That is a customerGroup
// answer in the person's own words, so it is read against the SAME regex map the dimension
// already uses — no second vocabulary — and what it yields is marked "form", because the
// person wrote it about themselves in answer to that question. Nothing else in the interview
// maps cleanly onto a dimension: approaches is its own taxonomy, stage isn't a dimension at
// all, and forcing them in would manufacture provenance that isn't there.
export const customerFromInterview = (text) => {
  const t = String(text || "").trim();
  if (!t) return [];
  const map = DIMS.customerGroup.map;   // prose, so the prose map — same one inferTicks uses
  return DIMS.customerGroup.categories.filter((c) => { const re = map[c]; return re && re.test(t); });
};

// A map person as the engine sees them. Ticks come from inferTicks via withInferredTicks
// (prose → dimensions), except customerGroup when they answered the interview, which is real.
export function peerOf(p, interviews) {
  const key = (liKey(p.linkedin) || norm(p.name));
  const f = interviews.get(norm(String(p.linkedin || "").trim().toLowerCase())) || interviews.get(norm(p.name)) || interviews.get(key) || null;
  const base = {
    key, name: p.name || "", email: "",
    program: (p.venture || "").trim(),
    stage: (p.programs || [])[0] || "",
    location: "", linkedin: p.linkedin || "",
    hoping: (p.asks || "").trim(),
    dims: emptyDims(),
    mapText: [p.venture, p.focus, p.asks, p.offers, (p.tags || []).join(" ")].filter(Boolean).join(" · "),
  };
  const person = withInferredTicks(base, { formDomains: false });
  // Domains too, but ONLY here. withInferredTicks deliberately leaves domains alone, because
  // for a mentorship person it holds real self-reported answers and guessing over them would
  // be a downgrade. A map person has no domain answer at all — source is "none", not "form" —
  // so there is nothing to overwrite, and leaving it empty just discards the richest map we
  // have on exactly the prose it was written for. Marked inferred like everything else.
  if (!person.dims.domains.length) {
    const d = inferTicks(person, "domains");
    if (d.length) { person.dims = { ...person.dims, domains: d }; person.dimsSource = { ...person.dimsSource, domains: "inferred" }; }
  }
  const stated = f ? customerFromInterview(f["Who they're building for"]) : [];
  if (stated.length) {
    person.dims = { ...person.dims, customerGroup: stated };
    person.dimsSource = { ...person.dimsSource, customerGroup: "form" };
  }
  return person;
}

// what the browser may see about a peer. Same shape as /api/mentorship's publicMatch, so the
// client can run one renderer over both — and, more to the point, one honesty rule.
const publicPeer = (m, dims) => ({
  name: m.name,
  detail: [m.program, m.stage].filter(Boolean).join(" · "),
  location: m.location || "",
  shared: m.shared,
  evidence: m.evidence || [],
  byDim: Object.fromEntries(dims.map((d) => [d, {
    shared: (m.byDim[d] || {}).shared || [],
    evidence: (m.byDim[d] || {}).evidence || [],
    score: Number(((m.byDim[d] || {}).score || 0).toFixed(3)),
    source: (m.dimsSource || {})[d] || "none",
  }])),
  hoping: m.hoping || "",
  sameCity: m.sameCity,
  linkedin: m.linkedin || "",
});

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const rawDims = req.query && "dims" in req.query
    ? req.query.dims
    : new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("dims");
  const { dims, bad } = parseDims(rawDims);
  if (!dims) return res.status(400).json({ error: "unknown_dims", unknown: bad, known: DIMENSIONS });

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server_not_configured" });

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
    const user = await clerk.users.getUser(userId);
    const metaKey = norm((user.publicMetadata && user.publicMetadata.profileKey) || "");
    // not linked to anyone on the map — there is no "me" to rank against
    if (!metaKey) return res.status(200).json({ role: null, matches: [] });

    const [people, interviews] = await Promise.all([loadPeople(req.headers.host), loadInterviews()]);
    // peers means the CURRENT cohort — alumni are the mentorship panel's job, and mixing them
    // in here would quietly turn a peer list into a mentor list
    const pool = people.filter((p) => p.status === "current").map((p) => peerOf(p, interviews));

    const me = pool.find((p) => p.key === metaKey || norm(p.linkedin) === metaKey || norm(p.name) === metaKey);
    if (!me) return res.status(200).json({ role: null, matches: [] });

    const ranked = rankMatches(me, pool.filter((p) => p.key !== me.key), { dims, limit: LIMIT });
    const matches = ranked.map((m) => publicPeer(m, dims));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      role: "peer", name: me.name, dims,
      dimsSource: Object.fromEntries(dims.map((d) => [d, (me.dimsSource || {})[d] || "none"])),
      myEvidenceByDim: Object.fromEntries(dims.map((d) => [d, evidenceOf(me, (me.dims || emptyDims())[d] || [], d)])),
      matches,
    });
  } catch (err) {
    console.error("peers error:", err);
    return res.status(500).json({ error: "peers_failed" });
  }
}
