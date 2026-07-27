// /api/profiles — returns every saved profile interview, so the map can fold all
// students' answers into matching at page load (the aggregate half of the loop:
// /api/save writes one student's answers; this reads everyone's).
//
// Same env vars as /api/save.js (AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE,
// ALLOWED_ORIGIN). GET, no body. Response:
//   { profiles: { [key]: {name, challenge, who, approaches: [], brings, seeks} } }

const API = "https://api.airtable.com/v0";

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || "Responses";
  if (!token || !baseId) return res.status(500).json({ error: "server_not_configured" });

  try {
    const headers = { Authorization: `Bearer ${token}` };
    const profiles = {};
    let offset;
    do {
      const url = `${API}/${baseId}/${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ""}`;
      const page = await fetch(url, { headers }).then((r) => r.json());
      if (page.error) throw new Error(page.error.message || "airtable_read_failed");
      for (const rec of page.records || []) {
        const f = rec.fields || {};
        const key = f["Profile key"];
        if (!key) continue;
        profiles[key] = {
          name: f.Name || "",
          challenge: f.Challenge || "",
          who: f["Who bears it"] || "",
          approaches: Array.isArray(f.Approaches) ? f.Approaches : [],   // multiple-select → array
          brings: f["What they bring"] || "",
          seeks: f["What they're seeking"] || "",
        };
      }
      offset = page.offset;
    } while (offset);

    res.setHeader("Cache-Control", "public, max-age=60"); // light cache; profiles change rarely
    return res.status(200).json({ profiles });
  } catch (err) {
    console.error("profiles error:", err);
    return res.status(500).json({ error: "profiles_failed" });
  }
}
