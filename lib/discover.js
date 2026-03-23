const axios   = require("axios");
const cheerio = require("cheerio");
const browser = require("../browser");
const groq    = require("../groq");
const { extractLinksFromHtml } = require("./fetch");
const { groqWithRetry }        = require("./extract");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KNOWN_PATTERNS = [
  "/news-and-events/find-an-expert/by-name",
  "/people", "/people/faculty", "/people/staff",
  "/faculty", "/faculty-staff", "/faculty/all", "/faculty-directory",
  "/staff", "/staff-directory",
  "/directory", "/directory/faculty",
  "/academics", "/academic-staff", "/academics/faculty",
  "/researchers", "/our-people", "/our-team",
  "/about/people", "/about/faculty", "/about/team", "/about/staff",
  "/research/people", "/research/faculty",
  "/team", "/members", "/profiles", "/experts",
  "/find-an-expert", "/search/people",
  "/faculty-members", "/teaching-staff", "/academic-faculty",
  "/people/faculty-staff", "/faculty/directory", "/academics/directory",
];

const FACULTY_KEYWORDS = [
  "professor","faculty","dr.","lecturer","researcher",
  "department","associate","assistant","emeritus","phd",
];

const DIRECTORY_KEYWORDS = [
  "people","faculty","staff","directory","expert","researcher","academic","profiles",
];

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 1: probe known URL patterns — returns best scoring match
// ─────────────────────────────────────────────────────────────────────────────

async function probeDirectoryUrls(domain, log) {
  log("🔎 Probing known directory URL patterns...");

  const results = await Promise.allSettled(
    KNOWN_PATTERNS.map(path =>
      axios.get(`https://${domain}${path}`, {
        timeout: 6000, maxRedirects: 3,
        headers: { "User-Agent": "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36" },
        validateStatus: s => s < 400,
      }).then(res => ({ path, html: res.data }))
    )
  );

  let best      = null;
  let bestScore = 1; // minimum threshold to qualify

  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== "fulfilled") continue;
    const { html } = results[i].value;
    const $        = cheerio.load(html);
    $("script,style,iframe,noscript").remove();
    const text       = $("body").text().toLowerCase();
    const matchCount = FACULTY_KEYWORDS.filter(k => text.includes(k)).length;

    if (matchCount > bestScore) {
      bestScore = matchCount;
      best      = `https://${domain}${KNOWN_PATTERNS[i]}`;
    }
  }

  if (best) {
    log(`✅ Validated directory: ${best} (${bestScore} keywords)`);
    return best;
  }

  log(`   ⚠️  No strong directory found via probe`);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 2: Google search
// ─────────────────────────────────────────────────────────────────────────────

async function googleForDirectory(domain, universityName, page, log) {
  log("🔍 Probe failed — Googling...");

  const search = async (query) => {
    try {
      await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, {
        waitUntil: "domcontentloaded", timeout: 15000,
      });
      await sleep(1500);
      return extractLinksFromHtml(await page.content(), "https://www.google.com")
        .map(l => l.url)
        .filter(u => u.startsWith("http") && !u.includes("google.") && !u.includes("googleapis"))
        .slice(0, 25);
    } catch { return []; }
  };

  const links1 = await search(`${universityName} professors faculty directory site:${domain}`);
  await sleep(2000);
  const links2 = await search(`${domain} faculty staff people directory listing`);

  const combined = [...new Set([...links1, ...links2])].filter(u => u.includes(domain));
  log(`Google found ${combined.length} candidates`);
  if (!combined.length) return null;

  await sleep(4000);
  let url = await groqWithRetry(() => groq.findDirectoryUrl(domain, combined));
  if (url && !url.startsWith("http"))
    url = `https://${domain}${url.startsWith("/") ? url : "/" + url}`;
  log(`🎯 AI picked: ${url}`);
  return url || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy 3: AI picks from homepage links
// ─────────────────────────────────────────────────────────────────────────────

async function aiPickFromHomepage({ universityName, rootUrl, rootFetch, page, log }) {
  log("🤖 AI picking from homepage links...");
  await sleep(4000);
  const { detectInteractiveElements } = require("./interact");
  const interactiveElements = await detectInteractiveElements(page);
  const action = await groqWithRetry(() => groq.decideNextAction({
    currentUrl: rootUrl, universityName,
    visited: [rootUrl], totalFound: 0,
    pageText: rootFetch.text, links: rootFetch.links,
    failedActions: [], interactiveElements,
  }));
  if (action.action === "navigate" && action.url) {
    log(`🎯 AI chose: ${action.url}`);
    return action.url;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry — tries all strategies in order
// ─────────────────────────────────────────────────────────────────────────────

async function findDirectoryUrl({ domain, universityName, rootUrl, rootFetch, page, log }) {
  // Strategy 0: root IS the directory
  const rootIsDirectory = ["profiles","people","faculty","directory","experts","researchers","academics"]
    .some(k => domain.includes(k) || rootUrl.toLowerCase().includes(k));
  if (rootIsDirectory) {
    log(`🎯 Root URL is itself a directory — using directly`);
    return rootUrl;
  }

  // Strategy 1: probe known patterns
  const probed = await probeDirectoryUrls(domain, log);
  if (probed) return probed;

  // Ensure Playwright has a live page before Google search
  if (rootFetch.method === "cheerio") {
    await browser.navigate(page, rootUrl);
    await sleep(1000);
  }

  // Strategy 2: Google
  const googled = await googleForDirectory(domain, universityName, page, log);
  if (googled) return googled;

  // Strategy 3: AI from homepage links
  const aiPicked = await aiPickFromHomepage({ universityName, rootUrl, rootFetch, page, log });
  if (aiPicked) return aiPicked;

  // Strategy 4: caller queues homepage directory-like links as last resort
  return null;
}

function getDirectoryFallbackLinks(links) {
  return links
    .filter(l => DIRECTORY_KEYWORDS.some(k =>
      l.url.toLowerCase().includes(k) || l.text.toLowerCase().includes(k)))
    .slice(0, 5)
    .map(l => l.url);
}

module.exports = { findDirectoryUrl, getDirectoryFallbackLinks };
