// /api/mentorship — mentor matches for the Energy & Climate Mentorship programme.
//
//   GET → { role: "student" | "alum" | null, name, dims, matches: [ … ] }
//   GET ?dims=domains,skills → score on only those dimensions
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

// "Other/still exploring" is not a category — two people who both ticked it have nothing in
// common, and counting it would pull the "still exploring" crowd together at the top.
const NOT_A_TOPIC = /^other\b|still exploring/i;

const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// FOUR DIMENSIONS, NOT ONE LIST
// ---------------------------------------------------------------------------
//
// Until now the whole system was one flat list of five topics. That conflates four different
// questions that a mentor match actually turns on:
//
//   domains                  — what subject matter you know
//   skills                   — what you can *do*
//   customerGroup            — who you have sold to / worked for
//   solutionCharacteristics  — what shape of thing you build
//
// A grid-domain policy lawyer and a grid-domain hardware engineer used to be the same match.
// They are not. Each dimension is scored independently and the scores are summed, so a caller
// can ask for any subset — `rankMatches(me, pool, { dims: ["skills"] })`, or ?dims= on the
// endpoint — and get a ranking that stands only on that.
//
// ONLY `domains` HAS DATA TODAY. The intake forms ask one question ("Topic areas") and it
// feeds `domains`; the other three are empty for every single person until intake is updated.
// That is the expected state, not a bug, and the engine has to treat it as one: an empty
// dimension has no shared ticks, earns no evidence, and takes no breadth penalty, so it adds
// exactly zero. Scores with all four dimensions active are identical to the old one-list
// scores — which is the test that the degradation is really graceful.
export const DIMENSIONS = ["domains", "skills", "customerGroup", "solutionCharacteristics"];

// Evidence maps, per dimension, per source text. Three sources, because the population has
// three kinds of person and each wrote something different about themselves:
//
//   role     an alum's job title — the strongest signal here, and the reason the ranking
//            means anything. A title is close to unique and it is evidence rather than
//            aspiration: it says where this person can actually open a door.
//   program  a mentorship student's course of study. Weaker — a degree says what someone is
//            learning, not what they can already do — but broad-brush and honest.
//   map      what a current student wrote about their venture. Prose, so the patterns have to
//            be narrower than the job-title ones: a project description says "business model"
//            and "data center" in passing and neither is a claim to work in either.
//
// A source with nothing honest to say about a dimension gets NO map at all rather than a
// stretched one (a degree does not tell you who your customers are). A missing map yields no
// evidence, which is the right answer.
//
// Patterns stay deliberately narrow throughout. A false "works in finance" on somebody's
// mentor card is worse than a quiet one, because the student writes to them on the strength
// of it.
const DIMS = {
  // -------------------------------------------------------------------------
  // DOMAINS — the original five topics, renamed. Same categories, same regexes; this is now
  // one dimension of four instead of the whole system. The rename is display-facing: the
  // intake forms still send the old strings, and `aliases` below is what bridges them.
  // -------------------------------------------------------------------------
  domains: {
    label: "Domains",
    categories: ["Energy & grid", "Batteries & storage", "AI/Software", "Climate finance", "Policy & regulation"],
    // raw form value (normalised) → canonical category. The forms are not being touched in
    // this step, so every existing tick arrives under its old name and lands here.
    aliases: {
      "grid infrastructure": "Energy & grid",
      "batteries & energy storage": "Batteries & storage",
      "finance": "Climate finance",
    },
    role: {
      "Climate finance": /\b(invest\w*|capital|equity|ventures?|\bvc\b|fund(s|ing)?|financ\w*|bank\w*|portfolio|m&a|private equity)\b/i,
      "Policy & regulation": /\b(policy|policies|regulat\w*|counsel|attorney|\blaw\b|law firm|legal|commission|public affairs|government|advoca\w*|\bpuc\b|\bcpuc\b|energy commission)\b/i,
      "AI/Software": /\b(\bai\b|artificial intelligence|software|machine learning|\bml\b|data|analytics|cloud|platform|product manager|\bcto\b|deeplearning|modeling|optimization)\b/i,
      "Batteries & storage": /\b(batter\w*|storage|\bbess\b|electrochem\w*|materials|cell(s)?)\b/i,
      // Two tiers, because working at a utility is not the same as working ON the grid.
      //
      // "grid", "transmission", "substation" and the rest name the work, so they stand alone.
      // "power" and "electric" mostly name an employer — Pacific Gas and Electric, Aspen
      // Power, Schneider Electric — and crediting them handed grid-technical credit to a
      // lawyer and a product manager. They now only count when the same string also names a
      // technical function. Co-occurrence anywhere, not adjacency: "System Planning Engineer;
      // Green Mountain Power" is a real grid engineer and the halves sit in different clauses.
      "Energy & grid": /\b(grid|utilit\w*|transmission|distribution|interconnect\w*|substation|\biso\b)\b|^(?=[\s\S]*\b(?:engineer|engineering|technician|technical|systems?|planning|operations?|infrastructure)\b)[\s\S]*\b(?:power(?!ed)|electric\w*)\b/i,
    },
    // A major maps to the ground it obviously covers and no further, so "Mechanical
    // Engineering" earns grid and storage but not finance or policy.
    program: {
      "Climate finance": /\b(\bmba\b|\bgsb\b|business|finance|financial|economics|management science|\bms&e\b)\b/i,
      "Policy & regulation": /\b(policy|public policy|\blaw\b|\bjd\b|international policy|environmental (policy|science|studies)|civil and environmental|\bcee\b|systems engineering)\b/i,
      // "electrical engineering" is deliberately absent: it already earns grid evidence below,
      // which is the ground it obviously covers, and an EE degree does not by itself mean
      // software or AI work. The EE↔software overlap is real but lives in what someone
      // specialises in, so it has to be named — a bare major is not evidence of it.
      "AI/Software": /\b(computer science|\bcs\b|\bms&e\b|management science|data science|statistics|artificial intelligence|\bai\b|machine learning|symbolic systems|signal processing|controls?|embedded systems)\b/i,
      "Batteries & storage": /\b(chemistry|chemical engineering|materials science|material science|\bmatsci\b|mechanical engineering|\bme\b|applied physics|physics)\b/i,
      "Energy & grid": /\b(electrical engineering|\bee\b|mechanical engineering|energy (science|engineering|resources)|civil and environmental|\bcee\b|systems engineering|earth systems)\b/i,
    },
    map: {
      "Climate finance": /\b(project financ\w*|financ\w*|investor\w*|investment|capital|funding|carbon (credits?|markets?)|insur\w*|underwrit\w*|offtake)\b/i,
      "Policy & regulation": /\b(policy|policies|regulat\w*|permit\w*|complian\w*|tariffs?|legislat\w*|standards body|public utilit\w*|government agenc\w*)\b/i,
      "AI/Software": /\b(\bai\b|artificial intelligence|machine learning|\bml\b|software|algorithm\w*|analytics|\bllm\b|computer vision|digital twin|predictive|data(?! ?cent)\w*)\b/i,
      "Batteries & storage": /\b(batter\w*|energy storage|storage system\w*|\bbess\b|anode|cathode|electrolyte|lithium|sodium-ion|electrochem\w*|thermal storage)\b/i,
      "Energy & grid": /\b(grid|microgrid|transmission|distribution network|substation|interconnect\w*|utilit\w*|demand response|load flexibilit\w*|virtual power plant|\bvpp\b|electricity market|capacity market)\b/i,
    },
  },

  // -------------------------------------------------------------------------
  // SKILLS — what you can do, as distinct from what you know about. NO INTAKE DATA YET.
  // -------------------------------------------------------------------------
  skills: {
    label: "Skills",
    categories: ["Technical & engineering", "Business & strategy", "Policy & regulatory", "Investment & finance", "Sales & BD"],
    aliases: {},
    // A job title names a skill more directly than it names anything else, so this is the
    // source with most to say once the ticks exist.
    role: {
      "Technical & engineering": /\b(engineer\w*|technical|\bcto\b|scientist|research (scientist|engineer|associate)|\br&d\b|architect|developer|technician|principal investigator)\b/i,
      // "business development" is deliberately absent — it reads as Sales & BD, below.
      "Business & strategy": /\b(strateg\w*|\bceo\b|\bcoo\b|co-?founder|founder|general manager|chief of staff|corporate development|head of (product|business)|product (manager|lead|director)|operations (director|manager|lead))\b/i,
      "Policy & regulatory": /\b(policy|policies|regulat\w*|counsel|attorney|\blaw\b|legal|commission|public affairs|government relations|advoca\w*|complian\w*|\bpuc\b|\bcpuc\b)\b/i,
      "Investment & finance": /\b(invest\w*|capital|equity|ventures?|\bvc\b|fund(s|ing)?|financ\w*|bank\w*|portfolio|m&a|private equity|\bcfo\b|treasur\w*)\b/i,
      // "project development" is the energy sector's name for origination — finding sites,
      // offtakers and counterparties — so it belongs here rather than under engineering.
      "Sales & BD": /\b(sales|business development|project development|\bbd\b|commercial (lead|director|manager)|account (executive|manager)|partnerships?|go-?to-?market|\bgtm\b|customer success|origination)\b/i,
    },
    // A degree does say something about skill — an MBA is business, a JD is regulatory.
    // "Sales & BD" has no entry on purpose: nobody's major tells you they can sell.
    program: {
      "Technical & engineering": /\b(engineering|engineer|computer science|\bcs\b|physics|chemistry|materials? science|\bmatsci\b|applied physics|mechanical|electrical|\bee\b|\bme\b|civil|chemical)\b/i,
      "Business & strategy": /\b(\bmba\b|\bgsb\b|business|management|management science|\bms&e\b|economics)\b/i,
      "Policy & regulatory": /\b(policy|public policy|\blaw\b|\bjd\b|international policy|e-?iper|environmental (policy|studies)|political science)\b/i,
      "Investment & finance": /\b(finance|financial|\bmba\b|\bgsb\b|economics)\b/i,
    },
    // Venture prose is about the venture, not the founder's CV, so this is the thinnest of
    // the three and stays narrow enough that a passing phrase can't earn a skill claim.
    map: {
      "Technical & engineering": /\b(prototyp\w*|patent\w*|\br&d\b|bench-?scale|pilot plant|lab-?(tested|scale)|we (are )?(build|building|engineer\w*)ing?)\b/i,
      "Business & strategy": /\b(business model|unit economics|go-?to-?market strateg\w*|scal(e|ing) strateg\w*|market entry)\b/i,
      "Policy & regulatory": /\b(policy|regulat\w*|permit\w*|complian\w*|standards? body|tariffs?)\b/i,
      "Investment & finance": /\b(project financ\w*|fundrais\w*|capital stack|underwrit\w*|blended finance)\b/i,
      "Sales & BD": /\b(first customers?|paying customers?|offtake|distribution partner\w*|channel partner\w*|sales pipeline)\b/i,
    },
  },

  // -------------------------------------------------------------------------
  // CUSTOMER GROUP — who you have actually sold to or worked for. NO INTAKE DATA YET.
  // -------------------------------------------------------------------------
  customerGroup: {
    label: "Customer group",
    categories: ["Enterprise/B2B", "Government & public sector", "Utilities", "Consumers", "Nonprofits/NGOs"],
    aliases: {},
    // A title rarely names your customer, but your employer does: counsel at a utility knows
    // utilities, an analyst at a state agency knows the public sector.
    role: {
      "Enterprise/B2B": /\b(enterprise|\bb2b\b|corporate|industrial|commercial (and|&) industrial|\bc&i\b|manufactur\w*)\b/i,
      "Government & public sector": /\b(government|federal|municipal|public sector|state of|city of|department of|\bdoe\b|\bepa\b|\bnrel\b|national lab\w*|commission|legislat\w*|congress\w*|agency)\b/i,
      "Utilities": /\b(utilit\w*|\biou\b|\biso\b|\brto\b|grid operator|electric cooperative|\bpg&e\b|\bpuc\b|\bcpuc\b|pacific gas|edison)\b/i,
      "Consumers": /\b(consumer\w*|residential|homeowner\w*|\bb2c\b|household\w*|direct-?to-?consumer)\b/i,
      "Nonprofits/NGOs": /\b(non-?profit|\bngo\b|foundation|philanthrop\w*|charit\w*)\b/i,
    },
    // No `program` map, on purpose: a course of study says nothing whatever about who you
    // have sold to, and inventing a link here is exactly the kind of false claim that puts a
    // student in front of the wrong mentor.
    program: {},
    // Venture prose is the strongest source for this one — founders name their customer.
    map: {
      "Enterprise/B2B": /\b(\bb2b\b|enterprise\w*|industrial (customers?|clients?|sites?|facilit\w*)|commercial (and|&) industrial|\bc&i\b|corporate (buyers?|clients?)|data ?cent\w*|manufactur\w*)\b/i,
      "Government & public sector": /\b(government\w*|municipal\w*|public sector|state agenc\w*|federal agenc\w*|cities|public schools?|public health)\b/i,
      "Utilities": /\b(utilit\w*|grid operator\w*|\biso\b|\brto\b|electric cooperative|distribution (utilit|compan)\w*)\b/i,
      "Consumers": /\b(consumers?|households?|homeowners?|residential|\bb2c\b|renters?|direct-?to-?consumer)\b/i,
      "Nonprofits/NGOs": /\b(non-?profit|\bngo\b|community organi[sz]ations?|philanthrop\w*)\b/i,
    },
  },

  // -------------------------------------------------------------------------
  // SOLUTION CHARACTERISTICS — the shape of the thing, not its subject. NO INTAKE DATA YET.
  // -------------------------------------------------------------------------
  solutionCharacteristics: {
    label: "Solution characteristics",
    categories: ["Hardware", "Software/platform", "Services/consulting", "Policy/advocacy", "Financing/capital"],
    aliases: {},
    role: {
      "Hardware": /\b(hardware|manufactur\w*|mechanical|device\w*|equipment|factory|production|process engineer\w*|materials?)\b/i,
      "Software/platform": /\b(software|platform|\bsaas\b|\bcto\b|data|analytics|cloud|product manager|full-?stack|developer)\b/i,
      "Services/consulting": /\b(consult\w*|advisor\w*|advisory|professional services|agency)\b/i,
      "Policy/advocacy": /\b(policy|advoca\w*|counsel|attorney|legal|regulat\w*|public affairs|government relations|lobby\w*)\b/i,
      "Financing/capital": /\b(invest\w*|capital|fund(s|ing)?|financ\w*|bank\w*|equity|portfolio|underwrit\w*|\bcfo\b|treasur\w*)\b/i,
    },
    // Broad-brush, same licence the domain `program` map takes: a major says something about
    // what shape of thing you'd be able to build. "Services/consulting" has no entry — no
    // degree implies it.
    program: {
      "Hardware": /\b(mechanical engineering|materials? science|\bmatsci\b|chemical engineering|applied physics|physics|chemistry|electrical engineering)\b/i,
      "Software/platform": /\b(computer science|\bcs\b|data science|statistics|symbolic systems|artificial intelligence|machine learning|software)\b/i,
      "Policy/advocacy": /\b(public policy|policy|\bjd\b|\blaw\b|international policy|political science)\b/i,
      "Financing/capital": /\b(\bmba\b|\bgsb\b|finance|financial|economics)\b/i,
    },
    map: {
      "Hardware": /\b(hardware|device\w*|manufactur\w*|reactor|electroly[sz]er|turbine|module\w*|equipment|factory|pilot plant|prototyp\w*)\b/i,
      "Software/platform": /\b(software|platform|\bsaas\b|marketplace|dashboard|algorithm\w*|\bapi\b|analytics|digital twin|mobile app)\b/i,
      "Services/consulting": /\b(consult\w*|advisory|installer\w*|deployment services|managed services?|training program\w*)\b/i,
      "Policy/advocacy": /\b(policy|advoca\w*|regulat\w*|standards? body|campaign\w*|coalition\w*)\b/i,
      "Financing/capital": /\b(financ\w*|capital|fund(s|ing)?|loan\w*|leas(e|ing)|insur\w*|carbon (credits?|markets?)|offtake|underwrit\w*)\b/i,
    },
  },
};

export { DIMS };

// normalised raw value → canonical category, per dimension. Built once from `categories`
// (a category is always its own alias) plus the explicit `aliases` bridge.
const CANON = Object.fromEntries(Object.entries(DIMS).map(([d, cfg]) => [
  d,
  new Map([
    ...cfg.categories.map((c) => [norm(c), c]),
    ...Object.entries(cfg.aliases).map(([raw, c]) => [norm(raw), c]),
  ]),
]));

// Values the forms send that no dimension recognises. Reported once per cold start rather
// than per row: silently dropping a checkbox somebody added to the form is the kind of data
// loss that shows up months later as "matching got worse and nobody knows why".
const unknownSeen = new Set();

// One dimension's ticks out of a raw comma-separated form value. Anything not in that
// dimension's vocabulary is dropped: an unrecognised string can never earn evidence (the
// regex maps are keyed by category) but it would still inflate the breadth penalty and skew
// that dimension's rarity, so keeping it would be worse than losing it.
export const ticksOf = (raw, dim = "domains") => {
  const canon = CANON[dim];
  if (!canon) return [];
  const out = [];
  for (const part of String(raw || "").split(",")) {
    const t = part.trim();
    if (!t || NOT_A_TOPIC.test(t)) continue;
    const c = canon.get(norm(t));
    if (c) { if (!out.includes(c)) out.push(c); }
    else if (!unknownSeen.has(dim + "|" + norm(t))) {
      unknownSeen.add(dim + "|" + norm(t));
      console.warn(`mentorship: unrecognised ${dim} value from the form, ignored: ${JSON.stringify(t)}`);
    }
  }
  return out;
};

// An empty per-dimension tick set for everyone, so every person has the same shape and no
// call site has to guard for a missing dimension.
export const emptyDims = () => Object.fromEntries(DIMENSIONS.map((d) => [d, []]));

// City, roughly. The location field is free text — "SF Bay Area, CA, USA", "LONDON",
// "Cambridge (MA, US) / Bengaluru (India)" — so this takes the first chunk and lowercases it.
// Deliberately strict: a wrong "you're both in London" is worse than no location bonus.
export const cityOf = (raw) => norm(String(raw || "").split(/[,/(]/)[0]).replace(/\.$/, "");

// Inverse document frequency, WITHIN ONE DIMENSION, over the population being ranked: 78 of
// the 111 alumni ticked "Batteries & storage", so sharing it says almost nothing, while a
// shared "Climate finance" is informative. Necessary, but nowhere near sufficient — see the
// evidence maps.
//
// Only people who were ASKED that dimension's question count towards its rarity. Once the
// pool included the map cohort, who never saw those checkboxes, every tick started looking
// vanishingly rare — a topic held by 3 of 125 scored ~3.5, so the handful of form responses
// outranked a hundred and twenty people on a field those hundred and twenty were never shown.
// Rarity is only meaningful within the population that answered, and now that there are four
// questions "the population that answered" is a different set for each one: nobody has
// answered `skills` yet, so nobody counts towards its rarity.
export function idfOver(rows, dim = "domains") {
  const ticks = (r) => (r.dims && r.dims[dim]) || [];
  const asked = rows.filter((r) => ticks(r).length);
  const df = new Map();
  asked.forEach((r) => new Set(ticks(r).map(norm)).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const n = Math.max(1, asked.length);
  return (cat) => Math.log((n + 1) / ((df.get(norm(cat)) || 0) + 1));
}

// which of a person's stated ticks their own text actually backs up
export const evidenceIn = (text, ticks, map) => {
  const t = String(text || "");
  if (!t || !map || /^\s*(retired|n\/a|none|undecided)\b/i.test(t)) return [];
  return ticks.filter((cat) => { const re = map[cat]; return re && re.test(t); });
};

// a person's own evidence text and the map that reads it, for one dimension — an alum is
// their job, a mentorship student is their programme, a map student is what they wrote about
// their venture
export const evidenceOf = (person, ticks, dim = "domains") => {
  if (!person || !ticks || !ticks.length) return [];
  const cfg = DIMS[dim];
  if (!cfg) return [];
  if (person.role) return evidenceIn(person.role, ticks, cfg.role);
  if (person.mapText) return evidenceIn(person.mapText, ticks, cfg.map);
  return evidenceIn(person.program || "", ticks, cfg.program);
};

// Only the dimensions a caller asked for, and only ones that exist. Unknown keys are dropped
// rather than silently swapped for the default — see parseDims, which turns "you asked for
// nothing valid" into a 400 rather than quietly scoring on all four.
export const resolveDims = (dims) =>
  (Array.isArray(dims) ? dims : DIMENSIONS).filter((d) => DIMENSIONS.includes(d));

// Rank the other side of the programme for one person.
//
// Order of importance: what they actually do — a job for an alum, a degree for a student —
// then how much of it overlaps what you said you're interested in, then whether they're in
// your city. Breadth is penalised: someone who ticked every box in a dimension has told you
// nothing, and shouldn't outrank someone who ticked the two that matter and works in one.
//
// Both directions read evidence. Mentors are here to help, and an alum deciding who to give
// an hour to deserves better than five names who ticked the same boxes.
//
// The maths per dimension is exactly what it was when there was only one: IDF-weighted shared
// ticks, plus sqrt(evidence) * 2.2, minus the breadth penalty. It now runs once per active
// dimension and the results are added up. A dimension nobody has answered contributes a clean
// zero on all three terms, so turning all four on today gives the same ranking as before.
export function rankMatches(me, others, opts = {}) {
  const dims = resolveDims(opts.dims);
  const limit = opts.limit == null ? LIMIT : opts.limit;
  const myDims = me.dims || emptyDims();
  // one IDF per dimension, each over only the people who answered that dimension
  const idf = Object.fromEntries(dims.map((d) => [d, idfOver(others, d)]));
  const mine = Object.fromEntries(dims.map((d) => [d, new Set((myDims[d] || []).map(norm))]));
  const myCity = cityOf(me.location);

  return others
    .map((o) => {
      const oDims = o.dims || emptyDims();
      const byDim = {};
      let score = 0;
      for (const d of dims) {
        const theirs = oDims[d] || [];
        const shared = theirs.filter((t) => mine[d].has(norm(t)));
        // only count evidence for categories *I* care about — a brilliant policy lawyer is
        // not a match for someone who came here about batteries
        const evidence = evidenceOf(o, myDims[d] || [], d);
        const sharedScore = shared.reduce((s, t) => s + idf[d](t), 0);
        // Diminishing returns on evidence, for the same reason breadth is penalised: a
        // four-department degree or a job title that touches everything shouldn't win on
        // volume. The second matching area is worth about half the first, the fourth a fifth.
        const evidenceScore = Math.sqrt(evidence.length) * 2.2;
        // ticking everything is not the same as knowing everything
        const breadth = 0.12 * Math.max(0, theirs.length - 2);
        byDim[d] = { shared, evidence, sharedScore, evidenceScore, breadth, score: sharedScore + evidenceScore - breadth };
        score += byDim[d].score;
      }
      // Not per-dimension: where somebody lives and how far along they are are facts about
      // the person, not about a dimension, and counting them once per active dimension would
      // make the city bonus four times bigger just because four toggles were on.
      const sameCity = !!myCity && myCity === cityOf(o.location);
      if (sameCity) score += 0.6;
      if (/5\+/.test(o.stage || "")) score += 0.25;
      // flattened across the active dimensions, for the card and the filter below
      const shared = dims.flatMap((d) => byDim[d].shared);
      const evidence = dims.flatMap((d) => byDim[d].evidence);
      return { ...o, shared, evidence, byDim, sameCity, score };
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

// The one intake question that exists today answers `domains`. The other three dimensions
// stay empty until the forms are updated — the engine is built to expect that.
const dimsFromForm = (f) => ({ ...emptyDims(), domains: ticksOf(f["Topic areas"], "domains") });

const studentOf = (f) => ({
  key: norm(f["Profile key"] || f.Name), name: f.Name || "", email: norm(f.Email),
  dims: dimsFromForm(f),
  stage: f["Stanford Affiliation"] || "",          // how far along: undergrad, master's, PhD, GSB
  program: f["Program (major/degree)"] || "",      // what they study — the evidence text for this side
  location: "", linkedin: f["LinkedIn URL"] || "",
  hoping: f["Hoping to experience"] || "",
});
// A current student as they exist on the map. They never answered the mentorship form, so
// they have no ticks in any dimension and no city — everything about them has to come out of
// what they wrote about their venture, which `mapText` gathers for the `map` evidence maps to
// read. Their key is the LinkedIn slug so it lands in the same space as the mentorship
// tables' Profile key.
const mapStudentOf = (p) => ({
  key: liKey(p.linkedin) || norm(p.name), name: p.name || "", email: "",
  dims: emptyDims(), stage: (p.programs || [])[0] || "", program: (p.venture || "").trim(),
  location: "", linkedin: p.linkedin || "",
  // their own words about what they need — the most useful line on a card, and the reason to
  // write to them rather than to somebody else
  hoping: (p.asks || "").trim(),
  mapText: [p.venture, p.focus, p.asks, p.offers, (p.tags || []).join(" ")].filter(Boolean).join(" · "),
});

const alumOf = (f) => ({
  key: norm(f["Profile key"] || f.Name), name: f.Name || "", email: norm(f.Email),
  dims: dimsFromForm(f), stage: (f["Career Stage"] && f["Career Stage"].name) || f["Career Stage"] || "",
  role: f["Current Role and Institution"] || "", location: f.Location || "", linkedin: f["LinkedIn URL"] || "",
  hoping: f["Hoping to experience"] || "",
});

// what the browser is allowed to see about a match: enough to decide whether to reach out,
// and nothing else. No email, ever — an introduction is the programme's to make.
const publicMatch = (m, side, dims) => ({
  name: m.name,
  // an alum is their job; a student is what they study and how far along — "Mechanical
  // Engineering · Undergraduate" places them in a way either half alone doesn't
  detail: side === "alum" ? m.role : [m.program, m.stage].filter(Boolean).join(" · "),
  location: m.location || "",
  shared: m.shared,
  // the categories their own work or study actually backs up — what the card leads with,
  // because it is the only part of the match that isn't just two people ticking the same box
  evidence: m.evidence || [],
  // the same two, split by dimension, for an interface that wants to say WHICH kind of
  // overlap this is. Flat `shared`/`evidence` above stay as they were so the current card
  // keeps working untouched.
  byDim: Object.fromEntries(dims.map((d) => [d, {
    shared: (m.byDim[d] || {}).shared || [],
    evidence: (m.byDim[d] || {}).evidence || [],
    score: Number(((m.byDim[d] || {}).score || 0).toFixed(3)),
  }])),
  // what they said they were hoping for, in their own words. Often the most useful line on
  // the card and the only unprompted thing either side wrote, so it goes to the browser too.
  hoping: m.hoping || "",
  sameCity: m.sameCity,
  linkedin: m.linkedin || "",
});

// ?dims=domains,skills → ["domains","skills"]. Absent means all four. Present but naming
// nothing real is an error rather than a silent fallback: a typo'd toggle that quietly scores
// on everything looks exactly like a toggle that works.
export function parseDims(raw) {
  if (raw == null || raw === "") return { dims: DIMENSIONS };
  const want = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  const dims = resolveDims(want);
  if (!dims.length) return { dims: null, bad: want };
  return { dims };
}

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
      // is on both lists; the form entry wins, since it carries their stated ticks.
      const onMap = (await loadPeople(req.headers.host))
        .filter((p) => p.status === "current")
        .map(mapStudentOf);
      pool = dedupe(students.concat(onMap));
    }
    pool = pool.filter((r) => r.key !== me.key);
    const ranked = rankMatches(me, pool, { dims });
    const matches = ranked.map((m) => publicMatch(m, side, dims));

    // How much these are worth, so the interface can say so rather than implying more than
    // the data supports: "role" means the ranking is standing on what people actually do or
    // build, "topics" means it is two sets of checkboxes overlapping and should be read as a
    // starting point. The interface takes its wording from this rather than from which side
    // you are on, because both sides can now be either.
    const basis = ranked.some((m) => m.evidence.length) ? "role" : "topics";

    const myEvidenceByDim = Object.fromEntries(
      dims.map((d) => [d, evidenceOf(me, (me.dims || emptyDims())[d] || [], d)]),
    );

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      role: meStudent ? "student" : "alum", name: me.name, shows: side, basis,
      // which dimensions this ranking was actually scored on, echoed back so a caller can
      // see that its toggles landed
      dims,
      // the viewer's own categories that their job backs up — the app turns these into map
      // filters for "browse more students", so the browse lands somewhere relevant
      myEvidence: dims.flatMap((d) => myEvidenceByDim[d]),
      myEvidenceByDim,
      matches,
    });
  } catch (err) {
    console.error("mentorship error:", err);
    return res.status(500).json({ error: "mentorship_failed" });
  }
}
