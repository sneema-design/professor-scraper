const cheerio = require("cheerio");
const groq    = require("../groq");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Adaptive Cheerio extraction — zero tokens, works on any site's markup
// ─────────────────────────────────────────────────────────────────────────────

function cheerioExtractProfessors(html, pageUrl) {
  if (!html) return [];
  const $ = cheerio.load(html);

  // Step 1: find all repeating sibling groups
  const groupMap = new Map();
  $("*").each((_, el) => {
    const tag = el.tagName;
    if (!["div","li","article","section","tr"].includes(tag)) return;
    const siblings = $(el).parent().children(tag);
    if (siblings.length < 3) return;
    const key = `${tag}::${buildFingerprint($, $(el))}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(el);
  });

  // Step 2: score each group — pick the most person-like one
  let bestScore = 0;
  let bestGroup = null;
  for (const [, group] of groupMap) {
    if (group.length < 3) continue;
    const s = scorePerson($, $(group[0]));
    if (s > bestScore) { bestScore = s; bestGroup = group; }
  }
  if (!bestGroup || bestScore < 3) return [];

  // Step 3: extract from winning group
  const seen    = new Set();
  const results = [];
  for (const el of bestGroup) {
    const prof = parseCard($, $(el), pageUrl);
    if (!prof.name) continue;
    const key = prof.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(prof);
  }
  return results;
}

function buildFingerprint($, el) {
  return el.children().toArray().slice(0, 6).map(c => c.tagName).join("-");
}

function scorePerson($, el) {
  let score    = 0;
  const text   = el.text().toLowerCase();
  const html   = el.html() || "";

  if (el.find("h1,h2,h3,h4,h5,h6").length)                          score += 3;
  if (html.includes("mailto:"))                                       score += 3;
  if (el.find("img").length)                                          score += 1;
  if (/profile|people|faculty|staff|researcher/i.test(html))         score += 1;
  if (/\+?\d[\d\s\-().]{7,}\d/.test(text))                           score += 1;
  if (/department|school of|faculty of|division|institute/i.test(text)) score += 2;

  const titleWords = ["professor","associate","assistant","lecturer","dr.","ph.d",
                      "researcher","emeritus","dean","reader","faculty"];
  score += titleWords.filter(w => text.includes(w)).length * 2;

  // penalties
  if (el.find("ul,nav").length > 2)              score -= 3;
  if (el.closest("nav,header,footer").length)    score -= 5;
  if (text.length < 20 || text.length > 3000)    score -= 2;

  return score;
}

function parseCard($, el, pageUrl) {
  // Name
  let name = "";
  const headingEl = el.find("h1,h2,h3,h4,h5,h6").first();
  if (headingEl.length) name = headingEl.text().replace(/\s+/g, " ").trim();
  if (!name) {
    const strongEl = el.find("strong,b").first();
    if (strongEl.length) name = strongEl.text().replace(/\s+/g, " ").trim();
  }
  if (!name) {
    for (const line of el.text().split(/\n+/).map(l => l.trim()).filter(Boolean).slice(0, 4)) {
      if (/^(Dr\.?\s+|Prof\.?\s+)?[A-Z][a-z]+([ '-][A-Z][a-z]+){1,4}$/.test(line)) {
        name = line; break;
      }
    }
  }
  if (!name || name.length < 3 || name.length > 80) return {};

  // Email
  let email = null;
  const mailHref = el.find("a[href^='mailto:']").attr("href");
  if (mailHref) email = mailHref.replace("mailto:", "").split("?")[0].trim();
  if (!email) {
    const m = el.text().match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (m) email = m[0];
  }

  // Title
  let title = null;
  el.find("*").each((_, child) => {
    if (title) return;
    const t = $(child).clone().children().remove().end().text().trim();
    if (/^(Professor|Associate Professor|Assistant Professor|Reader|Lecturer|Senior Lecturer|Emeritus|Dean|Research Fellow|Postdoc)/i.test(t))
      title = t.replace(/\s+/g, " ").slice(0, 100);
  });
  if (!title) {
    const m = el.text().match(/(Professor|Associate Professor|Assistant Professor|Reader|Lecturer|Senior Lecturer|Dr\.|Emeritus|Dean|Research Fellow)[^\n,;]{0,60}/i);
    if (m) title = m[0].trim();
  }

  // Department
  let department = null;
  el.find("*").each((_, child) => {
    if (department) return;
    const t = $(child).clone().children().remove().end().text().trim();
    if (/(Department|School|Faculty|Division|Institute) of /i.test(t) && t.length < 100)
      department = t.replace(/\s+/g, " ");
  });

  // Phone
  let phone = null;
  const pm = el.text().match(/(\+?\d[\d\s\-().]{7,}\d)/);
  if (pm) phone = pm[0].trim();

  // Research
  let research = null;
  el.find("*").each((_, child) => {
    if (research) return;
    const t = $(child).text().trim();
    if (/research interest|speciali[sz]|expertise|focus/i.test($(child).attr("class") || "") && t.length > 10)
      research = t.replace(/\s+/g, " ").slice(0, 150);
  });

  // Profile URL
  let profileUrl = null;
  el.find("a[href]").each((_, a) => {
    if (profileUrl) return;
    const href = $(a).attr("href") || "";
    if (/profile|people|faculty|staff|researcher|about/i.test(href)) {
      try { profileUrl = href.startsWith("http") ? href : new URL(href, pageUrl).href; } catch {}
    }
  });
  if (!profileUrl) {
    const first = el.find("a[href]").first().attr("href");
    if (first) {
      try { profileUrl = first.startsWith("http") ? first : new URL(first, pageUrl).href; } catch {}
    }
  }

  return { name, title, department, email, phone, research, profileUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart extract — tries Cheerio first, falls back to Groq
// ─────────────────────────────────────────────────────────────────────────────

async function smartExtract(html, text, pageUrl, log) {
  if (html) {
    const results = cheerioExtractProfessors(html, pageUrl);
    if (results.length >= 2) {
      log(`   🌿 Cheerio: ${results.length} professors (0 tokens)`);
      return results;
    }
    log(`   🌿 Cheerio found ${results.length} — falling back to Groq`);
  }
  if (!text || text.length < 50) return [];
  await sleep(4000);
  const found = await groqWithRetry(() => groq.extractProfessors(text, pageUrl));
  log(`   🤖 Groq: ${found.length} professors`);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup + score for final report
// ─────────────────────────────────────────────────────────────────────────────

function dedup(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = (p.name || "").toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function scoreProfessor(p) {
  return (p.name ? 3 : 0) + (p.title ? 2 : 0) + (p.department ? 2 : 0) +
         (p.email ? 3 : 0) + (p.phone ? 2 : 0) + (p.research ? 1 : 0) + (p.profileUrl ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Groq retry wrapper (kept here so groq calls are centralised)
// ─────────────────────────────────────────────────────────────────────────────

async function groqWithRetry(fn, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.response?.status === 429 || err?.message?.includes("429");
      if (is429 && i < retries - 1) {
        const wait = (i + 1) * 20000;
        console.log(`[Agent] ⏳ Groq rate limited, waiting ${wait / 1000}s...`);
        await sleep(wait);
      } else throw err;
    }
  }
}

module.exports = { smartExtract, dedup, scoreProfessor, groqWithRetry };
