// /api/interview — the AI interviewer behind "Improve my matches" in the Student view.
//
// The site posts the conversation so far; Claude asks the next question (with smart
// follow-ups when an answer is vague), and when it has enough it calls the
// record_profile tool, which ends the interview and hands the site a structured
// profile to save (see /api/save.js) and recompute matches with.
//
// Deploy: Vercel serverless function (also works on Netlify/Cloudflare with the
// usual handler-signature tweaks). Secrets live in env vars — never in the page:
//   ANTHROPIC_API_KEY   — required
//   ALLOWED_ORIGIN      — optional; lock CORS to the site's own origin in prod
//
// Request  (POST JSON): { student: {name, venture, focus}, messages: [{role, content}] }
//   - messages uses the Anthropic shape: role "user" = the student's answers,
//     role "assistant" = the interviewer's questions. First call: messages: [].
// Response (JSON): { reply: "next question" }            — interview continues
//               or { done: true, profile: {...} }        — interview finished
//
// The structured profile matches what the front-end already stores per student:
//   { challenge, customer, approaches[], brings, seeks }

import Anthropic from "@anthropic-ai/sdk";

const APPROACHES = [
  "Hardware / physical product", "Software / AI / data", "Scientific R&D",
  "Policy & advocacy", "Finance & capital", "Community & co-design",
  "Go-to-market / scaling", "Behavior change", "Measurement & standards",
  "Infrastructure & operations", "Education & storytelling", "Partnerships & coalitions",
];

const recordProfile = {
  name: "record_profile",
  description:
    "Save the student's completed profile. Call this ONLY when you have collected " +
    "answers (or explicit skips) for all five topics: their live challenge, who they are " +
    "building it for, how they work, what they bring, and what they seek.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      challenge: { type: "string", description: "The real, current challenge they're navigating, in their own words (may be empty if skipped)" },
      customer:  { type: "string", description: "Who they are building this for — their first customer or user" },
      approaches: {
        type: "array",
        description: "How they tend to work a problem — pick only from the allowed list",
        items: { type: "string", enum: APPROACHES },
      },
      brings: { type: "string", description: "Knowledge/experience they bring that others may not have" },
      seeks:  { type: "string", description: "What they're trying to figure out or find help with" },
    },
    required: ["challenge", "customer", "approaches", "brings", "seeks"],
    additionalProperties: false,
  },
};

const systemPrompt = (student) => `You are the profile interviewer for The Ecopreneurship Network, a networking map of Stanford Ecopreneurship students and alumni. You are talking with ${student.name}${student.venture ? ` of ${student.venture}` : ""}.${student.focus ? `\nTheir project, in their words: ${student.focus}` : ""}

Your job is a short, warm, conversational interview covering five topics, so the map can surface non-obvious connections — students in different sectors who tackle problems the same way, hit the same walls, or hold knowledge someone else needs:
1. A real challenge they're navigating right now (live, not hypothetical)
2. Who they're building this for — their first customer or user, as specifically as they can put it
3. How they tend to work a problem — map their answer onto the allowed approaches list
4. What knowledge or experience they bring that others in the room may not have
5. What they're trying to figure out, or find help with

Rules:
- One question at a time. Keep each question to one or two sentences.
- If an answer is vague or generic ("fundraising is hard"), ask ONE specific follow-up to get something concrete ("What specifically breaks down — finding investors, or converting conversations?"). Never more than one follow-up per topic.
- If they want to skip a topic, accept it gracefully and move on (record it as an empty string).
- Do not lecture, summarize their answers back at length, or add filler. Warm but efficient — the whole interview should feel like five minutes.
- When all five topics are covered, call record_profile. Do not announce that you are saving; just call the tool.`;

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { student = {}, messages = [] } = req.body || {};
    if (!student.name) return res.status(400).json({ error: "student.name required" });

    const client = new Anthropic(); // ANTHROPIC_API_KEY from env

    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: systemPrompt(student),
      tools: [recordProfile],
      messages: messages.length
        ? messages
        : [{ role: "user", content: "(The student just opened the interview — greet them briefly and ask your first question.)" }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "record_profile");
    if (toolUse) {
      return res.status(200).json({ done: true, profile: toolUse.input });
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return res.status(200).json({ reply: text });
  } catch (err) {
    console.error("interview error:", err);
    return res.status(500).json({ error: "interview_failed" });
  }
}
