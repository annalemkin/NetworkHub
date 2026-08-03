// /api/mentorship — mentor matches for the Energy & Climate Mentorship programme.
//
//   GET → { role: "student" | "alum" | null, name, matches: [ … ] }
//
// A different population from the map (DECISIONS.md, 2026-07-28): 111 alumni and ~10
// students who answered an interest form, deliberately NOT on the public map and holding
// none of the data the map's matching engine runs on. So this has its own scorer, and it is
// asymmetric — a student is shown alumni, an alum is shown students.
//
// NON-NEGOTIABLE, same rule as /api/link and /api/exchange:
//   - identity comes from the verified session's email, looked up server-side. The browser
//     never sends a key and never receives an email — not its own, not anyone else's.
//   - you only ever get YOUR OWN matches. There is no endpoint here that lists the cohort;
//     these people consented to a mentorship programme, not to being browsed.
//
// Airtable: base AIRTABLE_BASE_ID, tables "Mentorship Students" and "Mentorship Alumni".
// Env: CLERK_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID (+ optional ALLOWED_ORIGIN).

import { createClerkClient, verifyToken } from "@clerk/backend";
// the map's own people, and the LinkedIn-slug key everything is deduped on — both already
// written and cached in /api/link, so this reuses them rather than keeping a second copy
import { loadPeople, liKey } from "./link.mjs";

const API = "https://api.airtable.com/v0";
const STUDENTS = "Mentorship Students";
const ALUMNI = "Mentorship Alumni";

// How many matches to show. Small on purpose: the point is a handful of people worth writing
// to, and a long list is the same as no recommendation at all.
const LIMIT = 5;

// "Other/still exploring" is not a topic — two people who both ticked it have nothing in
// common, and counting it would pull the "still exploring" crowd together at the top.
const NOT_A_TOPIC = /^other\b|still exploring/i;

export const topicsOf = (raw) =>
  String(raw || "").split(",").map((t) => t.trim()).filter((t) => t && !NOT_A_TOPIC.test(t));

const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

// City, roughly. The location field is free text — "SF Bay Area, CA, USA", "LONDON",
// "Cambridge (MA, US) / Bengaluru (India)" — so this takes the first chunk and lowercases it.
// Deliberately strict: a wrong "you're both in London" is worse than no location bonus.
export const cityOf = (raw) => norm(String(raw || "").split(/[,/(]/)[0]).replace(/\.$/, "");

// Inverse document frequency over the population being ranked: 78 of the 111 alumni ticked
// "Batteries & energy storage", so sharing it says almost nothing, while a shared "Finance"
// is informative. Necessary, but nowhere near sufficient — see roleEvidence.
// Only people who were ASKED the topic question count towards rarity. Once the pool included
// the map cohort, who never saw those checkboxes, every tick started looking vanishingly rare
// — a topic held by 3 of 125 scored ~3.5, so the handful of form responses outranked a
// hundred and twenty people on a field those hundred and twenty were never shown. Rarity is
// only meaningful within the population that answered.
export function idfOver(rows) {
  const asked = rows.filter((r) => (r.topics || []).length);
  const df = new Map();
  asked.forEach((r) => new Set(r.topics.map(norm)).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const n = Math.max(1, asked.length);
  return (topic) => Math.log((n + 1) / ((df.get(norm(topic)) || 0) + 1));
}

// What somebody's job says they actually do, per topic.
//
// This is the load-bearing signal, and the reason the ranking means anything. The six topic
// checkboxes cannot separate people: 110 alumni occupy only 29 distinct combinations, 18 of
// them identical, so a ranking built on ticks alone is alphabetical order wearing a rosette.
// A job title is close to unique — "Principal Investor, Momentum Capital", "Chief Counsel,
// Pacific Gas and Electric", "Head of Carbon Markets" — and it is evidence rather than
// aspiration: it says where this person can actually open a door.
//
// Patterns are deliberately narrow. A false "works in finance" on somebody's mentor card is
// worse than a quiet one, because the student writes to them on the strength of it.
export const ROLE_EVIDENCE = {
  "Finance": /\b(invest\w*|capital|equity|ventures?|\bvc\b|fund(s|ing)?|financ\w*|bank\w*|portfolio|m&a|private equity)\b/i,
  "Policy & regulation": /\b(policy|policies|regulat\w*|counsel|attorney|\blaw\b|law firm|legal|commission|public affairs|government|advoca\w*|\bpuc\b|\bcpuc\b|energy commission)\b/i,
  "AI/Software": /\b(\bai\b|artificial intelligence|software|machine learning|\bml\b|data|analytics|cloud|platform|product manager|\bcto\b|deeplearning|modeling|optimization)\b/i,
  "Batteries & energy storage": /\b(batter\w*|storage|\bbess\b|electrochem\w*|materials|cell(s)?)\b/i,
  // Two tiers, because working at a utility is not the same as working ON the grid.
  //
  // "grid", "transmission", "substation" and the rest name the work, so they stand alone.
  // "power" and "electric" mostly name an employer — Pacific Gas and Electric, Aspen Power,
  // Schneider Electric — and crediting them handed grid-technical credit to a lawyer and a
  // product manager. They now only count when the same string also names a technical
  // function. Co-occurrence anywhere, not adjacency: "System Planning Engineer; Green
  // Mountain Power" is a real grid engineer and the two halves sit in different clauses.
  "Grid infrastructure": /\b(grid|utilit\w*|transmission|distribution|interconnect\w*|substation|\biso\b)\b|^(?=[\s\S]*\b(?:engineer|engineering|technician|technical|systems?|planning|operations?|infrastructure)\b)[\s\S]*\b(?:power(?!ed)|electric\w*)\b/i,
};

// The same idea on the student side, read from what they're studying. Weaker evidence than a
// job — a degree says what someone is learning, not what they can already do — but it is the
// difference between an alum seeing a ranked list and seeing five people who ticked the same
// boxes. Kept broad-brush on purpose: a major maps to the ground it obviously covers and no
// further, so "Mechanical Engineering" earns grid and storage but not finance or policy.
export const PROGRAM_EVIDENCE = {
  "Finance": /\b(\bmba\b|\bgsb\b|business|finance|financial|economics|management science|\bms&e\b)\b/i,
  "Policy & regulation": /\b(policy|public policy|\blaw\b|\bjd\b|international policy|environmental (policy|science|studies)|civil and environmental|\bcee\b|systems engineering)\b/i,
  // "electrical engineering" is deliberately absent: it already earns grid evidence below,
  // which is the ground it obviously covers, and an EE degree does not by itself mean
  // software or AI work. The EE↔software overlap is real but lives in what someone
  // specialises in, so it has to be named — a bare major is not evidence of it.
  "AI/Software": /\b(computer science|\bcs\b|\bms&e\b|management science|data science|statistics|artificial intelligence|\bai\b|machine learning|symbolic systems|signal processing|controls?|embedded systems)\b/i,
  "Batteries & energy storage": /\b(chemistry|chemical engineering|materials science|material science|\bmatsci\b|mechanical engineering|\bme\b|applied physics|physics)\b/i,
  "Grid infrastructure": /\b(electrical engineering|\bee\b|mechanical engineering|energy (science|engineering|resources)|civil and environmental|\bcee\b|systems engineering|earth systems)\b/i,
};

// which of a person's stated topics their own text actually backs up. The map differs by
// side: a job title for an alum, a course of study for a student.
export const roleEvidence = (text, topics, map = ROLE_EVIDENCE) => {
  const t = String(text || "");
  if (!t || /^\s*(retired|n\/a|none|undecided)\b/i.test(t)) return [];
  return topics.filter((topic) => { const re = map[topic]; return re && re.test(t); });
};

// And the same idea again for someone who is on the map rather than on a mentorship form.
// They never answered the six topic checkboxes, so there is nothing to compare ticks against
// — but they wrote about what they are building, which is better evidence than a checkbox
// ever was. Read against the venture, the project description, the asks and offers, and the
// sector tags, all of it prose, so the patterns have to be narrower than the job-title ones:
// a project description says "business model" and "data center" in passing, and neither is a
// claim to work in AI.
export const MAP_EVIDENCE = {
  "Finance": /\b(project financ\w*|financ\w*|investor\w*|investment|capital|funding|carbon (credits?|markets?)|insur\w*|underwrit\w*|offtake)\b/i,
  "Policy & regulation": /\b(policy|policies|regulat\w*|permit\w*|complian\w*|tariffs?|legislat\w*|standards body|public utilit\w*|government agenc\w*)\b/i,
  "AI/Software": /\b(\bai\b|artificial intelligence|machine learning|\bml\b|software|algorithm\w*|analytics|\bllm\b|computer vision|digital twin|predictive|data(?! ?cent)\w*)\b/i,
  "Batteries & energy storage": /\b(batter\w*|energy storage|storage system\w*|\bbess\b|anode|cathode|electrolyte|lithium|sodium-ion|electrochem\w*|thermal storage)\b/i,
  "Grid infrastructure": /\b(grid|microgrid|transmission|distribution network|substation|interconnect\w*|utilit\w*|demand response|load flexibilit\w*|virtual power plant|\bvpp\b|electricity market|capacity market)\b/i,
};

// a person's own evidence text and the map that reads it — an alum is their job, a mentorship
// student is their programme, a map student is what they wrote about their venture
export const evidenceOf = (person, topics) => {
  if (!person) return [];
  if (person.role) return roleEvidence(person.role, topics, ROLE_EVIDENCE);
  if (person.mapText) return roleEvidence(person.mapText, topics, MAP_EVIDENCE);
  return roleEvidence(person.program || "", topics, PROGRAM_EVIDENCE);
};

// Rank the other side of the programme for one person.
//
// Order of importance: what they actually do — a job for an alum, a degree for a student —
// then how much of it overlaps what you said you're interested in, then whether they're in
// your city. Breadth is penalised: someone who ticked all six topics has told you nothing,
// and shouldn't outrank someone who ticked the two that matter and works in one of them.
//
// Both directions read evidence now. Mentors are here to help, and an alum deciding who to
// give an hour to deserves better than five names who ticked the same boxes.
export function rankMatches(me, others, limit = LIMIT) {
  const idf = idfOver(others);
  const mine = new Set(me.topics.map(norm));
  const myCity = cityOf(me.location);
  return others
    .map((o) => {
      const shared = o.topics.filter((t) => mine.has(norm(t)));
      // only count evidence for topics *I* care about — a brilliant policy lawyer is not a
      // match for someone who came here about batteries
      const evidence = evidenceOf(o, me.topics);
      // Diminishing returns on evidence, for the same reason breadth is penalised below: a
      // four-department degree or a job title that touches everything shouldn't win on volume.
      // The second matching area is worth about half the first, the fourth about a fifth.
      let score = shared.reduce((s, t) => s + idf(t), 0) + Math.sqrt(evidence.length) * 2.2;
      const sameCity = !!myCity && myCity === cityOf(o.location);
      if (sameCity) score += 0.6;
      if (/5\+/.test(o.stage || "")) score += 0.25;
      // ticking everything is not the same as knowing everything
      score -= 0.12 * Math.max(0, o.topics.length - 2);
      return { ...o, shared, evidence, sameCity, score };
    })
    // a shared tick that everyone made, with nothing in the job to back it, is not a match
    .filter((o) => (o.evidence.length > 0 || o.shared.length >= 2) && o.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

async function airtable(pathname, opts = {}) {
  const r = await fetch(`${API}/${process.env.AIRTABLE_BASE_ID}/${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json();
  if (j.error) throw new Error(typeof j.error === "string" ? j.error : j.error.message || j.error.type || "airtable_error");
  return j;
}

// Whole table, every page. Both tables are small (111 and 12) and read at most once per
// sign-in, so this is cheaper than filtering twice against Airtable.
async function loadTable(table, map) {
  const out = [];
  let offset;
  do {
    const page = await airtable(`${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ""}`);
    for (const rec of page.records || []) out.push(map(rec.fields || {}));
    offset = page.offset;
  } while (offset);
  return out;
}

// The student form was submitted more than once by some people (three rows for one person at
// the time of writing), so rows are collapsed on the identity key rather than trusted 1:1.
export const dedupe = (rows) => {
  const seen = new Map();
  rows.forEach((r) => { const k = r.key || norm(r.name); if (k && !seen.has(k)) seen.set(k, r); });
  return [...seen.values()];
};

const studentOf = (f) => ({
  key: norm(f["Profile key"] || f.Name), name: f.Name || "", email: norm(f.Email),
  topics: topicsOf(f["Topic areas"]),
  stage: f["Stanford Affiliation"] || "",          // how far along: undergrad, master's, PhD, GSB
  program: f["Program (major/degree)"] || "",      // what they study — the evidence text for this side
  location: "", linkedin: f["LinkedIn URL"] || "",
  hoping: f["Hoping to experience"] || "",
});
// A current student as they exist on the map. They never answered the mentorship form, so
// they have no topics and no city — everything about them has to come out of what they wrote
// about their venture, which `mapText` gathers for MAP_EVIDENCE to read. Their key is the
// LinkedIn slug so it lands in the same space as the mentorship tables' Profile key.
const mapStudentOf = (p) => ({
  key: liKey(p.linkedin) || norm(p.name), name: p.name || "", email: "",
  topics: [], stage: (p.programs || [])[0] || "", program: (p.venture || "").trim(),
  location: "", linkedin: p.linkedin || "",
  // their own words about what they need — the most useful line on a card, and the reason to
  // write to them rather than to somebody else
  hoping: (p.asks || "").trim(),
  mapText: [p.venture, p.focus, p.asks, p.offers, (p.tags || []).join(" ")].filter(Boolean).join(" · "),
});

const alumOf = (f) => ({
  key: norm(f["Profile key"] || f.Name), name: f.Name || "", email: norm(f.Email),
  topics: topicsOf(f["Topic areas"]), stage: (f["Career Stage"] && f["Career Stage"].name) || f["Career Stage"] || "",
  role: f["Current Role and Institution"] || "", location: f.Location || "", linkedin: f["LinkedIn URL"] || "",
  hoping: f["Hoping to experience"] || "",
});

// what the browser is allowed to see about a match: enough to decide whether to reach out,
// and nothing else. No email, ever — an introduction is the programme's to make.
const publicMatch = (m, side) => ({
  name: m.name,
  // an alum is their job; a student is what they study and how far along — "Mechanical
  // Engineering · Undergraduate" places them in a way either half alone doesn't
  detail: side === "alum" ? m.role : [m.program, m.stage].filter(Boolean).join(" · "),
  location: m.location || "",
  shared: m.shared,
  // the topics their own work or study actually backs up — what the card leads with, because
  // it is the only part of the match that isn't just two people ticking the same box
  evidence: m.evidence || [],
  // what they said they were hoping for, in their own words. Often the most useful line on
  // the card and the only unprompted thing either side wrote, so it goes to the browser too.
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

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server_not_configured" });

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
    // only a VERIFIED address may match — the same rule /api/link uses. An unverified one
    // would let anyone claim a participant's matches by typing their address at sign-up.
    const email = primary && primary.verification && primary.verification.status === "verified" ? norm(primary.emailAddress) : "";
    const metaKey = norm((user.publicMetadata && user.publicMetadata.profileKey) || "");
    if (!email && !metaKey) return res.status(200).json({ role: null, matches: [] });

    const [students, alumni] = await Promise.all([
      loadTable(STUDENTS, studentOf).then(dedupe),
      loadTable(ALUMNI, alumOf).then(dedupe),
    ]);

    // WHO GETS A PANEL AT ALL is decided here, and only by the two mentorship tables. The
    // pool an alum is *shown* grew to the whole current cohort below, but that must not make
    // those 122 people eligible themselves — nobody gets an unasked-for mentors panel because
    // they happen to be on the map.
    const isMe = (r) => (email && r.email === email) || (metaKey && r.key === metaKey);
    const meStudent = students.find(isMe);
    const meAlum = meStudent ? null : alumni.find(isMe);
    const me = meStudent || meAlum;
    // signed in, but not on either mentorship list — nothing to say, and nothing leaked
    if (!me) return res.status(200).json({ role: null, matches: [] });

    const side = meStudent ? "alum" : "student";
    let pool;
    if (meStudent) {
      // a student's mentors: the 111 who volunteered to mentor, and nobody else
      pool = alumni;
    } else {
      // An alum's students: the whole current cohort on the map, plus the handful who filled
      // in the mentorship form but have no map profile yet. Ten form responses was never the
      // real answer to "who could I help" — a hundred and twenty-two people are already here
      // describing what they're building. Deduped on the LinkedIn slug for the one person who
      // is on both lists; the form entry wins, since it carries their stated topics.
      const onMap = (await loadPeople(req.headers.host))
        .filter((p) => p.status === "current")
        .map(mapStudentOf);
      pool = dedupe(students.concat(onMap));
    }
    pool = pool.filter((r) => r.key !== me.key);
    const ranked = rankMatches(me, pool);
    const matches = ranked.map((m) => publicMatch(m, side));

    // How much these are worth, so the interface can say so rather than implying more than
    // the data supports: "role" means the ranking is standing on what people actually do or
    // build, "topics" means it is two sets of checkboxes overlapping and should be read as a
    // starting point. The interface takes its wording from this rather than from which side
    // you are on, because both sides can now be either.
    const basis = ranked.some((m) => m.evidence.length) ? "role" : "topics";

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      role: meStudent ? "student" : "alum", name: me.name, shows: side, basis,
      // the viewer's own topics that their job backs up — the app turns these into map
      // filters for "browse more students", so the browse lands somewhere relevant
      myEvidence: evidenceOf(me, me.topics),
      matches,
    });
  } catch (err) {
    console.error("mentorship error:", err);
    return res.status(500).json({ error: "mentorship_failed" });
  }
}
