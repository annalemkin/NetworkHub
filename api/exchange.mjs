// /api/exchange — the asks and offers people post about themselves (BACKEND.md, Asks & offers).
//
//   GET  → { exchange: { [profileKey]: { asks, offers, askTags: [], offerTags: [], updatedAt } } }
//          Public, like the rest of the map: DECISIONS.md (2026-07-27) keeps asks and offers
//          visible without an account. No emails, no account ids — only what people wrote.
//   POST → upserts the SIGNED-IN person's row. Body: { asks, offers, askTags, offerTags }.
//
// NON-NEGOTIABLE: the row written is chosen by the verified session, never by the request
// body. A client-supplied profile key would let anyone overwrite anyone else's asks. The key
// comes from the Clerk user's publicMetadata (set by /api/link) or, for someone Anna linked
// by hand, from their Linked row in the Accounts table.
//
// Airtable: base AIRTABLE_BASE_ID, table "Exchange" (tblb2hPHUMqgsvZHL), upsert on Profile key.
// Env: CLERK_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID (+ optional ALLOWED_ORIGIN).

import { createClerkClient, verifyToken } from "@clerk/backend";

const API = "https://api.airtable.com/v0";
const TABLE = "Exchange";

// The shared exchange vocabulary — must stay identical to `this.EXCHANGE` in
// `Atlas Map.dc.html`. It is duplicated here on purpose: the browser can send any string it
// likes, and writing an unrecognised one into Airtable would either fail the write or (with
// typecast) quietly invent a new option nobody can match against. Anything not on this list
// is dropped.
const EXCHANGE = [
  "Intros: energy, grid & storage", "Intros: data centers & large loads", "Intros: farmers & agribusiness",
  "Intros: pharma & life sciences", "Intros: insurance & risk", "Intros: cities & government",
  "Intros: manufacturing & industrial", "Intros: corporate sustainability teams", "Intros: NGOs & community orgs",
  "Intros: investors & funders", "Intros: mobility & automotive", "Intros: consumer brands & retail",
  "Intros: water & waste", "Intros: international & regional networks",
  "Regulatory & policy expertise", "Carbon markets, MRV & accounting", "Manufacturing & scale-up expertise",
  "Chemistry & materials expertise", "Hardware & IoT engineering", "Software, data & AI",
  "Business model & go-to-market", "Fundraising & investor readiness", "Customer discovery & interviews",
];

// free text is optional next to the tags, so a generous cap is enough to stop abuse without
// truncating anyone writing a real paragraph
const MAX_TEXT = 600;

export const cleanTags = (v) => (Array.isArray(v) ? v.filter((t) => EXCHANGE.includes(t)).slice(0, EXCHANGE.length) : []);
export const cleanText = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

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
// Accounts review queue when Anna linked them by hand and they haven't signed in since
async function sessionProfileKey(clerk, userId) {
  const user = await clerk.users.getUser(userId);
  const fromMeta = (user.publicMetadata && user.publicMetadata.profileKey) || "";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  if (fromMeta) return { profileKey: String(fromMeta), name };
  const formula = encodeURIComponent(`{Clerk user id}='${userId.replace(/'/g, "\\'")}'`);
  const j = await airtable(`Accounts?filterByFormula=${formula}&maxRecords=1`);
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

  if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID)
    return res.status(500).json({ error: "server_not_configured" });

  // ---------- GET: everyone's posted asks and offers ----------
  if (req.method === "GET") {
    try {
      const exchange = {};
      let offset;
      do {
        const page = await airtable(`${encodeURIComponent(TABLE)}?pageSize=100${offset ? `&offset=${offset}` : ""}`);
        for (const rec of page.records || []) {
          const f = rec.fields || {};
          const key = f["Profile key"];
          if (!key) continue;
          exchange[key] = {
            asks: f.Asks || "", offers: f.Offers || "",
            askTags: Array.isArray(f["Ask tags"]) ? f["Ask tags"] : [],
            offerTags: Array.isArray(f["Offer tags"]) ? f["Offer tags"] : [],
            updatedAt: f["Updated at"] || "",
          };
        }
        offset = page.offset;
      } while (offset);
      // deliberately uncached: someone who posts expects to see it from another browser on
      // the next load, and at this traffic (a few hundred people, opened occasionally) we are
      // nowhere near Airtable's ~5 requests/second
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ exchange });
    } catch (err) {
      console.error("exchange read error:", err);
      return res.status(500).json({ error: "exchange_failed" });
    }
  }

  // ---------- POST: write the signed-in person's own row ----------
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: "server_not_configured" });

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
    const { profileKey, name } = await sessionProfileKey(clerk, userId);
    // signed in but not connected to anyone on the map — there is no row to write
    if (!profileKey) return res.status(403).json({ error: "not_linked" });

    const b = req.body || {};
    const fields = {
      "Profile key": profileKey,
      Asks: cleanText(b.asks), Offers: cleanText(b.offers),
      "Ask tags": cleanTags(b.askTags), "Offer tags": cleanTags(b.offerTags),
      "Clerk user id": userId,
      "Updated at": new Date().toISOString(),
      ...(name ? { Name: name } : {}),
    };
    await airtable(encodeURIComponent(TABLE), {
      method: "PATCH",
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ["Profile key"] }, records: [{ fields }] }),
    });

    return res.status(200).json({ ok: true, profileKey });
  } catch (err) {
    console.error("exchange write error:", err);
    return res.status(500).json({ error: "exchange_save_failed" });
  }
}
