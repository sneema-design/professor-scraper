require("dotenv").config();
const axios = require("axios");

const MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const KEY   = process.env.GROQ_API_KEY;

async function ask(systemPrompt, userPrompt, maxTokens = 1024) {
  if (!KEY) throw new Error("GROQ_API_KEY not set in .env");
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      temperature: 0,
      max_tokens:  maxTokens,
    },
    {
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      timeout: 45000,
    }
  );
  return res.data.choices[0].message.content.trim();
}

function parseJSON(raw) {
  try { return JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch {
    const m = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    return null;
  }
}

async function decideNextAction(state) {
  const system = `You are an AI agent controlling a web browser to scrape ALL professors/faculty from a university website.
You are SMART and understand complex, dynamic university websites.

IMPORTANT RULES:
- If you see a profiles/directory page with filters (school, department dropdowns) — use select_filter or click_text to open ALL results
- If the page has a "Show All", "View All", "Load More" button — click it
- If you see an A-Z directory — navigate through each letter  
- If page has a search box for people — use search_page with empty string to get all
- If you see school/department filter links — click each one to get all professors
- Never give up — always try to interact before saying done
- If click fails twice, try navigate with direct URL instead
- If the page is a faculty/people/profiles/directory page — ALWAYS extract`;

  const failedStr = state.failedActions?.length
    ? `\nFAILED ACTIONS — DO NOT REPEAT:\n${state.failedActions.map(f => `- ${f.action}: "${f.text || f.url}"`).join("\n")}`
    : "";

  const interactiveStr = state.interactiveElements?.length
    ? `\nINTERACTIVE ELEMENTS ON PAGE:\n${JSON.stringify(state.interactiveElements, null, 2)}`
    : "";

  const user = `University: ${state.universityName}
Current URL: ${state.currentUrl}
Pages visited: ${state.visited.slice(-8).join(", ")}
Professors found so far: ${state.totalFound}
${failedStr}

Page text (first 2000 chars):
---
${(state.pageText || "").slice(0, 2000)}
---

Links on page (top 60):
${(state.links || []).slice(0, 60).map((l, i) => `[${i}] "${l.text}" -> ${l.url}`).join("\n")}
${interactiveStr}

Decide the BEST next action. Return JSON:
{
  "action": "navigate" | "extract" | "search_web" | "click_text" | "search_page" | "select_filter" | "done",
  "url": "full URL if navigate",
  "text": "exact text to click if click_text, or search query if search_page/search_web",
  "selector": "CSS selector if select_filter (e.g. 'select[name=school]')",
  "value": "option value if select_filter (e.g. 'engineering' or 'all')",
  "reason": "brief reason"
}

Action guide:
- "navigate": go to a URL directly
- "extract": page has professor list ready — extract NOW
- "click_text": click button/tab/filter/letter — e.g. "School of Engineering", "Load More", "A", "Show All"
- "select_filter": select a dropdown option — for school/dept filter dropdowns
- "search_page": use page search box — try empty string "" to get all results
- "search_web": Google for the faculty directory (use when truly lost)
- "done": absolutely no more professors anywhere on this site

SMART examples:
- profiles.stanford.edu → click_text "School of Engineering" (then each school)
- find-an-expert/by-name → navigate to each letter A-Z
- page with dept dropdown → select_filter with selector and value
- page with "Show All Faculty" button → click_text "Show All Faculty"
- page with "Load More" → click_text "Load More"
- page already showing professors → extract

Return ONLY raw JSON.`;

  const raw    = await ask(system, user, 600);
  const parsed = parseJSON(raw);
  if (parsed) return parsed;
  return { action: "extract", reason: "parse failed — attempting extraction" };
}

async function findDirectoryUrl(domain, searchResults) {
  const system = `You are helping find the official professor/faculty directory URL for a university.`;
  const user   = `University domain: ${domain}

Web search results:
${searchResults.slice(0, 20).join("\n")}

Which single URL is the BEST faculty/professor directory that lists ALL or many professors?
Prefer: /people, /faculty, /staff, /directory, /find-expert, /researchers, /profiles, /academics
Avoid: login, events, news, admissions, single-person profiles

Return ONLY the best URL as plain text.`;

  const raw = await ask(system, user, 200);
  return raw.trim().replace(/['"]/g, "");
}

async function extractProfessors(pageText, pageUrl) {
  const chunks = [];
  for (let i = 0; i < pageText.length; i += 5000) {
    chunks.push(pageText.slice(i, i + 5000));
  }

  const all = [];
  for (const chunk of chunks) {
    const system = `You extract structured professor/faculty data from university webpage text. Return only valid JSON.`;
    const user   = `Extract ALL professors/faculty from this text.

Return a JSON array. Each object:
{
  "name": "Full name — REQUIRED. Real person only (e.g. 'Prof. Jane Smith'). Skip if no real name.",
  "title": "Academic rank or null (Professor / Associate Professor / Assistant Professor / Reader / Lecturer / Emeritus / Dean)",
  "department": "Department or faculty name or null",
  "email": "email or null",
  "phone": "phone number or null",
  "research": "research interests max 150 chars or null",
  "profileUrl": "their profile page URL or null"
}

STRICT RULES:
- Real full names only. No nav text, headings, or generic roles without a name.
- Never invent data. Only extract what is explicitly written.
- Return ONLY raw JSON array. No markdown. Empty result = []

Page: ${pageUrl}
---
${chunk}
---`;

    const raw   = await ask(system, user, 4096);
    const found = parseJSON(raw);
    if (Array.isArray(found)) {
      all.push(...found.filter((p) => p?.name?.trim().length > 3));
    }
  }
  return all;
}

async function findMorePages(pageUrl, pageText, links) {
  const system = `You find additional pages that contain more professor/faculty listings.`;
  const user   = `Current page: ${pageUrl}

Page text snippet:
---
${pageText.slice(0, 1000)}
---

Links (top 60):
${links.slice(0, 60).map((l, i) => `[${i}] "${l.text}" -> ${l.url}`).join("\n")}

Find ALL links that lead to MORE professor listings:
- Pagination (Next, page 2, 3...)
- A-Z letter navigation (A, B, C...)
- Sub-department or sub-faculty pages
- "Load more" style links

Return JSON array of URLs only, max 30:
["url1", "url2", ...]
If none: []`;

  const raw  = await ask(system, user, 800);
  const urls = parseJSON(raw);
  return Array.isArray(urls) ? urls.filter((u) => typeof u === "string" && u.startsWith("http")) : [];
}

module.exports = { decideNextAction, findDirectoryUrl, extractProfessors, findMorePages, parseJSON };