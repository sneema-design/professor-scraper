require("dotenv").config();

const { CheerioCrawler: CheerioOnly } = require("@crawlee/cheerio");
const cheerio  = require("cheerio");
const axios    = require("axios");
const browser  = require("./browser");
const groq     = require("./groq");

process.env.CRAWLEE_LOG_LEVEL = "OFF";
try {
  const { Configuration, LogLevel } = require("@crawlee/core");
  Configuration.getGlobalConfig().set("logLevel", LogLevel.OFF);
} catch {}

const MAX_PAGES  = parseInt(process.env.MAX_PAGES)      || 30;
const MAX_PROFS  = parseInt(process.env.MAX_PROFESSORS)  || 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Crawlee/Cheerio fetch
// ─────────────────────────────────────────────────────────────────────────────

async function crawleeFetch(url, log) {
  return new Promise((resolve) => {
    let resolved = false;

    const cheerioCrawler = new CheerioOnly({
      requestHandlerTimeoutSecs: 15,
      maxRequestRetries: 0,
      async requestHandler({ $, body }) {
        if (resolved) return;

        $("script, style, iframe, noscript").remove();

        const selectors = [
          "#people","#faculty","#staff",".people-list",".faculty-list",
          ".directory","[class*='people']","[class*='faculty']","[class*='staff']",
          "[class*='directory']","[class*='researcher']","[class*='expert']",
          "main","#main","#content",".content","article",
        ];

        let text = "";
        for (const sel of selectors) {
          const t = $(sel).first().text().replace(/\s+/g, " ").trim();
          if (t.length > 300) { text = t; break; }
        }
        if (!text) text = $("body").text().replace(/\s+/g, " ").trim();

        const links = [];
        $("a[href]").each((_, el) => {
          try {
            const href = $(el).attr("href");
            const linkText = $(el).text().replace(/\s+/g, " ").trim().slice(0, 100);
            if (!href || !linkText) return;
            const fullUrl = href.startsWith("http") ? href : new URL(href, url).href;
            if (fullUrl.startsWith("http")) links.push({ url: fullUrl, text: linkText });
          } catch {}
        });

        const html = typeof body === "string" ? body : body?.toString("utf-8") || "";

        if (text.length < 300) {
          resolved = true;
          resolve({ text: null, html: null, links: [], method: "needs_playwright" });
          return;
        }

        log(`   ✅ Cheerio: ${text.length} chars, ${links.length} links`);
        resolved = true;
        resolve({ text, html, links, method: "cheerio" });
      },
      failedRequestHandler() {
        if (!resolved) {
          resolved = true;
          resolve({ text: null, html: null, links: [], method: "needs_playwright" });
        }
      },
    });

    cheerioCrawler.run([url]).catch(() => {
      if (!resolved) {
        resolved = true;
        resolve({ text: null, html: null, links: [], method: "needs_playwright" });
      }
    });
  });
}

async function playwrightFetch(url, page, log) {
  const currentPageUrl = page.url();
  if (currentPageUrl !== url) {
    await browser.navigate(page, url);
  }

  await page.waitForFunction(
    () => document.body?.innerText?.trim().length > 200,
    { timeout: 12000 }
  ).catch(() => {});

  await sleep(2000);

  const text = await page.evaluate(() => {
    document.querySelectorAll("script, style, iframe, noscript").forEach(el => el.remove());
    return document.body?.innerText?.replace(/\s+/g, " ").trim() || "";
  });

  const html  = await page.content();
  const links = extractLinksFromHtml(html, url);

  log(`   🎭 Playwright: ${text.length} chars, ${links.length} links`);
  return { text, html, links, method: "playwright" };
}

function extractLinksFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = [];
  $("a[href]").each((_, el) => {
    try {
      const href = $(el).attr("href");
      const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 100);
      if (!href || !text) return;
      const url = href.startsWith("http") ? href : new URL(href, baseUrl).href;
      if (url.startsWith("http")) links.push({ url, text });
    } catch {}
  });
  return links;
}

async function fetchPage(url, page, log) {
  // Force Playwright for known JS-rendered directory sites
  const forcePlaywright = [
    "profiles.", "people.", "directory.", "experts.", "researchers."
  ].some(k => url.includes(k));

  if (!forcePlaywright) {
    const crawleeResult = await crawleeFetch(url, log);
    if (crawleeResult.method !== "needs_playwright" && crawleeResult.text) {
      return { ...crawleeResult, url };
    }
  }

  const playwrightResult = await playwrightFetch(url, page, log);
  return { ...playwrightResult, url };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect interactive elements (dropdowns, filters, load-more buttons)
// ─────────────────────────────────────────────────────────────────────────────

async function detectInteractiveElements(page) {
  try {
    return await page.evaluate(() => {
      const elements = [];

      // Dropdowns/selects
      document.querySelectorAll("select").forEach(el => {
        const options = Array.from(el.options).map(o => ({ value: o.value, text: o.text.trim() })).filter(o => o.text);
        if (options.length > 0) {
          elements.push({
            type: "select",
            selector: el.id ? `select#${el.id}` : el.name ? `select[name="${el.name}"]` : "select",
            name: el.name || el.id || "",
            options: options.slice(0, 30),
          });
        }
      });

      // Load more / show all buttons
      document.querySelectorAll("button, [role='button'], a.btn, input[type='button']").forEach(el => {
        const text = (el.innerText || el.value || "").trim();
        if (text && /load more|show all|show more|next|view all|see all/i.test(text)) {
          elements.push({ type: "button", text });
        }
      });

      // Filter tabs/chips
      document.querySelectorAll("[role='tab'], .filter-btn, .tab-btn, [class*='filter'][class*='btn']").forEach(el => {
        const text = el.innerText?.trim();
        if (text && text.length < 50) elements.push({ type: "tab", text });
      });

      // School/dept filter links
      document.querySelectorAll("a, li").forEach(el => {
        const text = el.innerText?.trim();
        if (text && /school of|college of|department of|faculty of/i.test(text) && text.length < 80) {
          elements.push({ type: "filter_link", text, href: el.href || "" });
        }
      });

      return elements.slice(0, 40);
    });
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Select dropdown filter
// ─────────────────────────────────────────────────────────────────────────────

async function selectFilter(page, selector, value, log) {
  try {
    const el = page.locator(selector).first();
    if (await el.count() > 0) {
      await el.selectOption(value);
      await page.waitForTimeout(2500);
      await browser.scrollToBottom(page);
      log(`   ✅ Selected: ${selector} = "${value}"`);
      return true;
    }
  } catch (e) {
    log(`   ❌ select_filter failed: ${e.message}`);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cheerio professor extraction (0 tokens)
// ─────────────────────────────────────────────────────────────────────────────

function cheerioExtractProfessors(html, pageUrl) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const results = [];

  const cardSelectors = [
    ".faculty-card", ".people-card", ".staff-card", ".person-card",
    ".faculty-member", ".faculty-item", ".people-item", ".staff-item",
    "[class*='faculty-card']", "[class*='people-card']", "[class*='person-card']",
    "[class*='expert-card']", "[class*='researcher-card']",
    ".views-row", ".view-row",
    ".staff-profile", ".faculty-profile",
    "article.person", "article.staff", "article.faculty",
    "li.person", "li.staff", "li.faculty",
  ];

  for (const sel of cardSelectors) {
    const cards = $(sel);
    if (cards.length >= 2) {
      cards.each((_, el) => {
        const prof = parsePersonCard($, $(el), pageUrl);
        if (prof.name) results.push(prof);
      });
      if (results.length >= 2) break;
    }
  }

  const seen = new Set();
  return results.filter(p => {
    if (!p.name) return false;
    const k = p.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parsePersonCard($, el, pageUrl) {
  let name = "";
  const nameEl = el.find("h1,h2,h3,h4,h5,.name,.faculty-name,.person-name,.staff-name,strong").first();
  if (nameEl.length) name = nameEl.text().replace(/\s+/g, " ").trim();
  if (!name) {
    const lines = el.text().split(/\n+/).map(l => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 3)) {
      if (/^[A-Z][a-z]+([ '-][A-Z][a-z]+){1,4}$/.test(line)) { name = line; break; }
    }
  }
  if (!name || name.length < 3) return {};

  let title = null;
  const titleEl = el.find(".title,.rank,.position,.role,.job-title,.designation").first();
  if (titleEl.length) title = titleEl.text().replace(/\s+/g, " ").trim();
  if (!title) {
    const m = el.text().match(/(Professor|Associate Professor|Assistant Professor|Reader|Lecturer|Dr\.|Emeritus|Dean)[^,\n]*/i);
    if (m) title = m[0].trim();
  }

  let department = null;
  const deptEl = el.find(".department,.dept,.school,.division,.faculty-dept").first();
  if (deptEl.length) department = deptEl.text().replace(/\s+/g, " ").trim();

  let email = null;
  const emailHref = el.find("a[href^='mailto:']").attr("href");
  if (emailHref) email = emailHref.replace("mailto:", "").trim();
  if (!email) {
    const m = el.text().match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (m) email = m[0];
  }

  let phone = null;
  const pm = el.text().match(/(\+?\d[\d\s\-().]{7,}\d)/);
  if (pm) phone = pm[0].trim();

  let research = null;
  const resEl = el.find(".research,.specialization,.interests,.expertise").first();
  if (resEl.length) research = resEl.text().replace(/\s+/g, " ").trim().slice(0, 150);

  let profileUrl = null;
  const profileLink = el.find("a").filter((_, a) => {
    const href = $(a).attr("href") || "";
    return href.includes("profile") || href.includes("people") || href.includes("faculty") || href.includes("staff");
  }).first();
  if (profileLink.length) {
    try {
      const href = profileLink.attr("href");
      profileUrl = href.startsWith("http") ? href : new URL(href, pageUrl).href;
    } catch {}
  }

  return { name, title, department, email, phone, research, profileUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Groq helpers
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

function dedup(list) {
  const seen = new Set();
  return list.filter((p) => {
    const k = (p.name || "").toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function score(p) {
  return (p.name ? 3 : 0) + (p.title ? 2 : 0) + (p.department ? 2 : 0) +
         (p.email ? 3 : 0) + (p.phone ? 2 : 0) + (p.research ? 1 : 0) + (p.profileUrl ? 1 : 0);
}

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

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "fulfilled") {
      const { html } = results[i].value;
      const url = `https://${domain}${KNOWN_PATTERNS[i]}`;

      const $ = cheerio.load(html);
      $("script,style,iframe,noscript").remove();
      const text = $("body").text().toLowerCase();

      const facultyKeywords = [
        "professor", "faculty", "dr.", "lecturer", "researcher",
        "department", "associate", "assistant", "emeritus", "phd",
      ];
      const matchCount = facultyKeywords.filter(k => text.includes(k)).length;

      if (matchCount >= 2) {
        log(`✅ Validated directory: ${url} (${matchCount} keywords)`);
        return url;
      } else {
        log(`   ⚠️  ${KNOWN_PATTERNS[i]} — no faculty content (${matchCount} keywords), skipping`);
      }
    }
  }
  return null;
}

function obviouslyHasProfessors(url, text) {
  const u = url.toLowerCase();
  const t = (text || "").toLowerCase().slice(0, 800);
  const urlMatch = [
    "/people","/faculty","/staff","/directory","/find-an-expert",
    "/find-expert","/researchers","/academics","/our-people",
    "/profiles","/experts","/members","/teaching-staff","/academic-staff","/faculty-members",
  ].some(p => u.includes(p));
  const keywords = ["professor","prof.","dr.","lecturer","associate professor",
    "assistant professor","reader","emeritus","dean","research interest","department of","faculty of"];
  const keywordCount = keywords.filter(w => t.includes(w)).length;
  const namePatterns = (t.match(/\b(prof|dr|professor)\b/gi) || []).length;
  const isPaginated = /\/(find-an-expert|find-expert|people|faculty|directory|staff|researchers|experts).*([?&]page=\d+|\/[a-z]$)/i.test(u);
  return isPaginated || (urlMatch && keywordCount >= 1) || keywordCount >= 4 || namePatterns >= 3;
}

function extractAZLinks(links, currentUrl, visited) {
  try {
    const base        = new URL(currentUrl).origin;
    const currentPath = new URL(currentUrl).pathname;
    return links.map(l => l.url).filter(u => {
      if (!u || visited.has(u)) return false;
      try {
        const parsed = new URL(u);
        if (parsed.origin !== base) return false;
        return (
          /\/by-name\/[a-z]$/i.test(u) || /[?&]letter=[a-z]$/i.test(u) ||
          /[?&]char=[a-z]$/i.test(u)   || /[?&]alpha=[a-z]$/i.test(u) ||
          /[?&]page=\d+/i.test(u)      || /[?&]p=\d+/i.test(u) ||
          /\/page\/\d+/i.test(u)       || /[?&]start=\d+/i.test(u) ||
          /[?&]offset=\d+/i.test(u)    || /[?&]from=\d+/i.test(u) ||
          (parsed.pathname === currentPath &&
           parsed.search !== new URL(currentUrl).search &&
           parsed.search.length > 0)
        );
      } catch { return false; }
    });
  } catch { return []; }
}

function extractMorePagesHeuristic(links, visited) {
  const patterns = [
    /[?&]page=\d+/i, /[?&]letter=[a-z]/i, /\/by-name\/[a-z]/i,
    /[?&]p=\d+/i, /\/page\/\d+/i, /[?&]start=\d+/i, /[?&]offset=\d+/i,
  ];
  return links.map(l => l.url).filter(u => u && !visited.has(u) && patterns.some(p => p.test(u)));
}

async function playwrightSearch(query, page, log) {
  log(`🔍 Searching: ${query}`);
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded", timeout: 15000,
    });
    await sleep(1500);
    const html  = await page.content();
    const links = extractLinksFromHtml(html, "https://www.google.com");
    return links.map(l => l.url)
      .filter(h => h.startsWith("http") && !h.includes("google.com") && !h.includes("googleapis"))
      .slice(0, 25);
  } catch (e) {
    log(`Search error: ${e.message}`);
    return [];
  }
}

async function smartExtract(html, text, pageUrl, log) {
  if (html) {
    const cheerioResults = cheerioExtractProfessors(html, pageUrl);
    if (cheerioResults.length >= 2) {
      log(`   🌿 Cheerio: ${cheerioResults.length} professors (0 tokens)`);
      return cheerioResults;
    }
    log(`   🌿 Cheerio found ${cheerioResults.length} — falling back to Groq`);
  }

  if (!text || text.length < 50) return [];
  await sleep(4000);
  const found = await groqWithRetry(() => groq.extractProfessors(text, pageUrl));
  log(`   🤖 Groq: ${found.length} professors`);
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function runAgent(rawUrl, onProgress) {
  const log = (msg) => {
    process.stdout.write(`[Agent] ${msg}\n`);
    if (onProgress) onProgress(msg);
  };

  const rootUrl = (rawUrl.trim().match(/^https?:\/\//) ? rawUrl.trim() : "https://" + rawUrl.trim()).replace(/\/$/, "");
  const domain  = new URL(rootUrl).hostname;

  const report = {
    url: rootUrl, universityName: "",
    professors: [], pagesScraped: [],
    stats: {}, warnings: [],
    timestamp: new Date().toISOString(),
  };

  const allProfessors = [];
  const visited       = new Set();
  const pageQueue     = [];
  let   pageCount     = 0;
  let   currentUrl    = rootUrl;

  const clickFailures = new Map();
  const failedActions = [];

  log("🚀 Launching browser...");
  const ctx  = await browser.getContext();
  const page = await ctx.newPage();
  page.on("pageerror", () => {});
  page.on("console",   () => {});

  try {
    // ── PHASE 1: Load root ────────────────────────────────────────────────────
    log(`📡 Loading: ${rootUrl}`);
    const rootFetch = await fetchPage(rootUrl, page, log);
    visited.add(rootUrl); pageCount++;
    report.universityName = (await page.title().catch(() => "")) || domain;
    if (!report.universityName || report.universityName === "about:blank") {
      const $ = cheerio.load(rootFetch.html || rootFetch.text || "");
      report.universityName = $("title").text().trim() || domain;
    }
    log(`🎓 ${report.universityName} [${rootFetch.method}]`);

    // ── PHASE 2: Find directory ───────────────────────────────────────────────
// If root URL itself IS a profiles/directory site — use it directly
const rootIsDiretory = ["profiles","people","faculty","directory","experts","researchers","academics"]
  .some(k => domain.includes(k) || rootUrl.toLowerCase().includes(k));

let directoryUrl = rootIsDiretory ? rootUrl : await probeDirectoryUrls(domain, log);
if (rootIsDiretory) log(`🎯 Root URL is itself a directory — using directly`);
    if (!directoryUrl) {
      log("🔍 Probe failed — Googling...");
      if (rootFetch.method === "cheerio") await browser.navigate(page, rootUrl);
      const g1 = await playwrightSearch(
        `${report.universityName} professors faculty directory site:${domain}`, page, log
      );
      await sleep(2000);
      const g2 = await playwrightSearch(
        `${domain} people faculty directory listing`, page, log
      );
      const combined = [...new Set([...g1, ...g2])].filter(r => r.includes(domain));
      log(`Google found ${combined.length} candidates`);
      if (combined.length > 0) {
        await sleep(4000);
        directoryUrl = await groqWithRetry(() => groq.findDirectoryUrl(domain, combined));
        if (directoryUrl && !directoryUrl.startsWith("http")) {
          directoryUrl = `https://${domain}${directoryUrl.startsWith("/") ? directoryUrl : "/" + directoryUrl}`;
        }
        log(`🎯 AI picked: ${directoryUrl}`);
      }
    }

    if (!directoryUrl) {
      log("🤖 AI picking from homepage links...");
      await sleep(4000);
      const interactiveElements = await detectInteractiveElements(page);
      const action = await groqWithRetry(() => groq.decideNextAction({
        currentUrl: rootUrl, universityName: report.universityName,
        visited: [rootUrl], totalFound: 0,
        pageText: rootFetch.text, links: rootFetch.links,
        failedActions: [], interactiveElements,
      }));
      if (action.action === "navigate" && action.url) {
        directoryUrl = action.url;
        log(`🎯 AI chose: ${directoryUrl}`);
      } else {
        (rootFetch.links || [])
          .filter(l => ["people","faculty","staff","directory","expert","researcher","academic","profiles"]
            .some(k => l.url.toLowerCase().includes(k) || l.text.toLowerCase().includes(k)))
          .slice(0, 5)
          .forEach(l => { if (!visited.has(l.url)) pageQueue.push(l.url); });
        log(`   Queued ${pageQueue.length} homepage links`);
      }
    }

    // ── PHASE 3: Load directory ───────────────────────────────────────────────
 currentUrl = directoryUrl || rootUrl;
if (!visited.has(currentUrl) || currentUrl === rootUrl) {
  log(`📄 Loading directory: ${currentUrl}`);
  const dirFetch = await fetchPage(currentUrl, page, log);
  visited.add(currentUrl); pageCount++;
  report.pagesScraped.push(currentUrl);

  const azLinks = extractAZLinks(dirFetch.links, currentUrl, visited);
  if (azLinks.length > 0) {
    log(`   ⚡ Queuing ${azLinks.length} A-Z/pagination links`);
    azLinks.forEach(u => pageQueue.push(u));
  }

  if (obviouslyHasProfessors(currentUrl, dirFetch.text)) {
    const found = await smartExtract(dirFetch.html, dirFetch.text, currentUrl, log);
    log(`   → ${found.length} professors from directory`);
    allProfessors.push(...found);
  }

  if (pageQueue.length > 0) {
    currentUrl = pageQueue.shift();
    const nextFetch = await fetchPage(currentUrl, page, log);
    visited.add(currentUrl); pageCount++;
    report.pagesScraped.push(currentUrl);
    if (obviouslyHasProfessors(currentUrl, nextFetch.text)) {
      const found = await smartExtract(nextFetch.html, nextFetch.text, currentUrl, log);
      log(`   → ${found.length} professors from first queued page`);
      allProfessors.push(...found);
      extractAZLinks(nextFetch.links, currentUrl, visited).forEach(u => { if (!visited.has(u)) pageQueue.push(u); });
      extractMorePagesHeuristic(nextFetch.links, visited).forEach(u => { if (!visited.has(u)) pageQueue.push(u); });
      if (pageQueue.length > 0) {
        currentUrl = pageQueue.shift();
        visited.add(currentUrl); pageCount++;
        report.pagesScraped.push(currentUrl);
      }
    }
  }

  // ── If 0 professors found — detect and interact with filters ─────────────
  if (allProfessors.length === 0) {
    log(`   🎛️  0 professors — detecting interactive filters...`);

    // Make sure Playwright has the page loaded
    if (page.url() !== currentUrl && page.url() !== directoryUrl) {
      await browser.navigate(page, directoryUrl || rootUrl);
      await sleep(2000);
    }

    const interactiveElements = await detectInteractiveElements(page).catch(() => []);
    log(`   Found ${interactiveElements.length} interactive elements`);

    if (interactiveElements.length > 0) {
      // Get fresh page text and links via Playwright
      const freshText  = await page.evaluate(() => {
        document.querySelectorAll("script,style,iframe,noscript").forEach(e => e.remove());
        return document.body?.innerText?.replace(/\s+/g, " ").trim() || "";
      });
      const freshHtml  = await page.content();
      const freshLinks = extractLinksFromHtml(freshHtml, currentUrl);

      await sleep(4000);
      const action = await groqWithRetry(() => groq.decideNextAction({
        currentUrl:          page.url(),
        universityName:      report.universityName,
        visited:             [...visited],
        totalFound:          0,
        pageText:            freshText,
        links:               freshLinks,
        failedActions:       [],
        interactiveElements,
      }));

      log(`   🤖 Filter action: ${action.action} — ${action.reason}`);

      if (action.action === "select_filter") {
        // Queue ALL options from matching dropdown so every school/dept gets scraped
        const selects = interactiveElements.filter(e => e.type === "select");
        for (const sel of selects) {
          for (const opt of (sel.options || [])) {
            if (!opt.value || opt.value === "" || opt.value === "0" || opt.value === "all") continue;
            if (!visited.has(`${currentUrl}::filter::${sel.name}::${opt.value}`)) {
              pageQueue.push(`__filter__${sel.selector}__${opt.value}__${page.url()}`);
            }
          }
        }
        log(`   → Queued ${pageQueue.length} filter options`);

        // Apply the AI-suggested filter first
        if (action.selector && action.value) {
          const success = await selectFilter(page, action.selector, action.value, log);
          if (success) {
            await sleep(2000);
            const afterHtml = await page.content();
            const afterText = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, " ").trim() || "");
            const found = await smartExtract(afterHtml, afterText, page.url(), log);
            log(`   → ${found.length} professors after filter`);
            allProfessors.push(...found);
          }
        }
      }

      else if (action.action === "click_text" && action.text) {
        // Queue all filter links found
        const filterLinks = interactiveElements.filter(e => e.type === "filter_link" && e.href);
        filterLinks.forEach(l => { if (!visited.has(l.href)) pageQueue.push(l.href); });
        log(`   → Queued ${filterLinks.length} filter links`);

        // Click AI-suggested one first
        const clicked = await browser.clickByText(page, action.text);
        if (clicked) {
          await sleep(2000);
          const afterHtml = await page.content();
          const afterText = await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, " ").trim() || "");
          const found = await smartExtract(afterHtml, afterText, page.url(), log);
          log(`   → ${found.length} professors after click`);
          allProfessors.push(...found);
        }
      }

      else if (action.action === "navigate" && action.url) {
        pageQueue.unshift(action.url);
      }

      else if (action.action === "extract") {
        const found = await smartExtract(freshHtml, freshText, page.url(), log);
        log(`   → ${found.length} professors from direct extract`);
        allProfessors.push(...found);
      }
    }
  }
}
   // ── PHASE 4: Agentic loop ─────────────────────────────────────────────────
    let consecutiveUseless = 0;
    const MAX_USELESS = 4;

    while (pageCount <= MAX_PAGES && allProfessors.length < MAX_PROFS) {
      if (!currentUrl || currentUrl === "about:blank" || visited.has(currentUrl)) {
        if (pageQueue.length > 0) currentUrl = pageQueue.shift();
        else break;
      }

      // ── Handle queued filter actions ──────────────────────────────────────
      if (currentUrl.startsWith("__filter__")) {
        const parts    = currentUrl.split("__").filter(Boolean);
        // format: filter__<selector>__<value>__<pageUrl>
        const selector = parts[1];
        const value    = parts[2];
        const baseUrl  = parts.slice(3).join("__"); // URL may contain __

        log(`   🎛️  Applying queued filter: ${selector} = "${value}"`);
        visited.add(currentUrl);

        try {
          if (page.url() !== baseUrl) {
            await browser.navigate(page, baseUrl);
            await sleep(1500);
          }

          const success = await selectFilter(page, selector, value, log);
          if (success) {
            await sleep(2000);
            const afterHtml = await page.content();
            const afterText = await page.evaluate(() =>
              document.body?.innerText?.replace(/\s+/g, " ").trim() || ""
            );
            const found = await smartExtract(afterHtml, afterText, page.url(), log);
            log(`   → ${found.length} professors from filter "${value}"`);
            allProfessors.push(...found);
            consecutiveUseless = 0;
          } else {
            consecutiveUseless++;
          }
        } catch (err) {
          log(`⚠️  Filter error: ${err.message}`);
          consecutiveUseless++;
        }

        currentUrl = pageQueue.length > 0 ? pageQueue.shift() : "";
        continue;
      }

      const fetched  = await fetchPage(currentUrl, page, log);
      const { text: pageText, links, html } = fetched;

      log(`\n🤖 [${pageCount}/${MAX_PAGES}] [${allProfessors.length} profs] [${fetched.method}]`);
      log(`   ${currentUrl}`);
      pageCount++;
      report.pagesScraped.push(currentUrl);
      visited.add(currentUrl);

      // Detect interactive elements
      let interactiveElements = [];
      if (fetched.method === "playwright" || !obviouslyHasProfessors(currentUrl, pageText)) {
        interactiveElements = await detectInteractiveElements(page).catch(() => []);
        if (interactiveElements.length > 0) {
          log(`   🎛️  Found ${interactiveElements.length} interactive elements`);
        }
      }

      let action;
      if (obviouslyHasProfessors(currentUrl, pageText)) {
        log(`   ⚡ Auto-detected — extracting`);
        action = { action: "extract", reason: "auto-detected" };
      } else {
        await sleep(6000);
        try {
          action = await groqWithRetry(() => groq.decideNextAction({
            currentUrl, universityName: report.universityName,
            visited: [...visited].slice(-8), totalFound: allProfessors.length,
            pageText, links, failedActions, interactiveElements,
          }));
        } catch (err) {
          log(`⚠️  Groq error: ${err.message}`);
          if (pageQueue.length > 0) {
            currentUrl = pageQueue.shift();
            await browser.navigate(page, currentUrl);
            visited.add(currentUrl); pageCount++;
            report.pagesScraped.push(currentUrl);
          } else consecutiveUseless++;
          continue;
        }
      }

      log(`   Action: ${action.action} — ${action.reason}`);

      if (action.action === "done") {
        if (pageQueue.length > 0) {
          currentUrl = pageQueue.shift();
          await browser.navigate(page, currentUrl);
          visited.add(currentUrl); pageCount++;
          report.pagesScraped.push(currentUrl);
          continue;
        }
        if (allProfessors.length === 0) {
          log(`   ⚠️  0 professors — Google fallback`);
          const fallback = await playwrightSearch(
            `${report.universityName} professors faculty directory`, page, log
          );
          const best = fallback.filter(u => u.includes(domain))[0];
          if (best && !visited.has(best)) {
            currentUrl = best;
            await browser.navigate(page, currentUrl);
            visited.add(currentUrl); pageCount++;
            report.pagesScraped.push(currentUrl);
            continue;
          }
        }
        log("✅ Done."); break;
      }

      if (action.action === "extract") {
        const found = await smartExtract(html, pageText, currentUrl, log);
        log(`   → ${found.length} professors`);
        allProfessors.push(...found);

        const azLinks = extractAZLinks(links, currentUrl, visited);
        if (azLinks.length > 0) {
          azLinks.forEach(u => { if (!visited.has(u)) pageQueue.push(u); });
          log(`   → ${azLinks.length} A-Z links`);
        } else {
          const heuristic = extractMorePagesHeuristic(links, visited);
          if (heuristic.length > 0) {
            heuristic.forEach(u => { if (!visited.has(u)) pageQueue.push(u); });
            log(`   → Heuristic: ${heuristic.length} pages`);
          } else {
            await sleep(4000);
            const more = await groqWithRetry(() => groq.findMorePages(currentUrl, pageText, links));
            more.forEach(u => { if (!visited.has(u)) pageQueue.push(u); });
            log(`   → AI: ${more.length} pages`);
          }
        }

        if (pageQueue.length > 0) {
          currentUrl = pageQueue.shift();
          log(`   → Next: ${currentUrl}`);
          if (!currentUrl.startsWith("__filter__")) {
            await browser.navigate(page, currentUrl);
            visited.add(currentUrl); pageCount++;
            report.pagesScraped.push(currentUrl);
          }
        } else {
          consecutiveUseless++;
          if (consecutiveUseless >= MAX_USELESS) { log("No more pages."); break; }
        }
        consecutiveUseless = 0;
      }

      else if (action.action === "select_filter") {
        const selector = action.selector || "select";
        const value    = action.value || action.text || "";
        log(`   🎛️  Filter: ${selector} = "${value}"`);

        // Queue all other options from this dropdown for later
        const matchingSel = interactiveElements.find(e => e.type === "select" &&
          (e.selector === selector || e.name === selector.replace(/select\[name="(.+)"\]/, "$1")));
        if (matchingSel) {
          for (const opt of (matchingSel.options || [])) {
            if (!opt.value || opt.value === value || opt.value === "" || opt.value === "0") continue;
            const filterKey = `__filter__${selector}__${opt.value}__${page.url()}`;
            if (!visited.has(filterKey)) pageQueue.push(filterKey);
          }
          log(`   → Queued ${pageQueue.length} remaining filter options`);
        }

        const success = await selectFilter(page, selector, value, log);
        if (success) {
          await sleep(2000);
          const afterHtml = await page.content();
          const afterText = await page.evaluate(() =>
            document.body?.innerText?.replace(/\s+/g, " ").trim() || ""
          );
          const found = await smartExtract(afterHtml, afterText, page.url(), log);
          log(`   → ${found.length} professors after filter`);
          allProfessors.push(...found);
          consecutiveUseless = 0;
        } else {
          consecutiveUseless++;
        }
      }

      else if (action.action === "navigate") {
        const dest = action.url;
        if (!dest || visited.has(dest)) {
          consecutiveUseless++;
          if (pageQueue.length > 0) {
            currentUrl = pageQueue.shift();
            if (!currentUrl.startsWith("__filter__")) {
              await browser.navigate(page, currentUrl);
              visited.add(currentUrl); pageCount++;
              report.pagesScraped.push(currentUrl);
            }
          }
          if (consecutiveUseless >= MAX_USELESS) break;
          continue;
        }
        currentUrl = dest;
        await browser.navigate(page, currentUrl);
        visited.add(currentUrl); pageCount++;
        report.pagesScraped.push(currentUrl);
        consecutiveUseless = 0;
      }

      else if (action.action === "search_web") {
        log(`   🔍 ${action.text}`);
        const results = await playwrightSearch(`${action.text} ${domain}`, page, log);
        const bestUrl = results.filter(u => u.includes(domain))[0];
        if (bestUrl && !visited.has(bestUrl)) {
          currentUrl = bestUrl;
          await browser.navigate(page, currentUrl);
          visited.add(currentUrl); pageCount++;
          report.pagesScraped.push(currentUrl);
          consecutiveUseless = 0;
        } else consecutiveUseless++;
      }

      else if (action.action === "click_text") {
        const failKey   = `${currentUrl}::${action.text}`;
        const failCount = clickFailures.get(failKey) || 0;
        if (failCount >= 2) {
          log(`   ⏭️  Skip "${action.text}"`);
          failedActions.push({ action: "click_text", text: action.text });
          consecutiveUseless++;
          if (pageQueue.length > 0) {
            currentUrl = pageQueue.shift();
            if (!currentUrl.startsWith("__filter__")) {
              await browser.navigate(page, currentUrl);
              visited.add(currentUrl); pageCount++;
              report.pagesScraped.push(currentUrl);
            }
            consecutiveUseless = 0;
          }
          if (consecutiveUseless >= MAX_USELESS) break;
          continue;
        }
        log(`   🖱️  Click: "${action.text}" (${failCount + 1}/2)`);
        const clicked = await browser.clickByText(page, action.text);
        if (clicked) {
          clickFailures.set(failKey, 0);
          await sleep(2000);
          const newUrl = page.url();
          if (!visited.has(newUrl)) {
            currentUrl = newUrl;
            visited.add(currentUrl); pageCount++;
            report.pagesScraped.push(currentUrl);
          }
          consecutiveUseless = 0;
        } else {
          const newCount = failCount + 1;
          clickFailures.set(failKey, newCount);
          log(`   ❌ Failed (${newCount}/2)`);
          if (newCount >= 2) failedActions.push({ action: "click_text", text: action.text });
          consecutiveUseless++;
        }
      }

      else if (action.action === "search_page") {
        log(`   🔎 search_page: "${action.text}"`);
        await browser.searchOnPage(page, action.text);
        await sleep(2000);
        const newUrl = page.url();
        if (!visited.has(newUrl)) {
          currentUrl = newUrl;
          visited.add(currentUrl); pageCount++;
          report.pagesScraped.push(currentUrl);
        }
        consecutiveUseless = 0;
      }

      else { consecutiveUseless++; if (consecutiveUseless >= MAX_USELESS) break; }
    }

    // ── PHASE 5: Drain queue ──────────────────────────────────────────────────
  log(`\n📋 ${pageQueue.length} pages remaining...`);

    // Create pool of 3 Playwright pages for parallel processing
    const pagePool = await Promise.all([
      ctx.newPage(), ctx.newPage(), ctx.newPage()
    ]);
    pagePool.forEach(p => { p.on("pageerror", () => {}); p.on("console", () => {}); });

    while (pageQueue.length > 0 && pageCount <= MAX_PAGES && allProfessors.length < MAX_PROFS) {
      const batch = pageQueue.splice(0, 3).filter(u => !visited.has(u));
      if (!batch.length) continue;

      await Promise.all(batch.map(async (url, i) => {
        const batchPage = pagePool[i];
        if (visited.has(url)) return;

        // Handle filter actions
        if (url.startsWith("__filter__")) {
          const parts    = url.split("__").filter(Boolean);
          const selector = parts[1];
          const value    = parts[2];
          const baseUrl  = parts.slice(3).join("__");
          visited.add(url);
          try {
            if (batchPage.url() !== baseUrl) {
              await browser.navigate(batchPage, baseUrl);
              await sleep(1500);
            }
            const success = await selectFilter(batchPage, selector, value, log);
            if (success) {
              await sleep(2000);
              const afterHtml = await batchPage.content();
              const afterText = await batchPage.evaluate(() =>
                document.body?.innerText?.replace(/\s+/g, " ").trim() || ""
              );
              const found = await smartExtract(afterHtml, afterText, batchPage.url(), log);
              log(`   → ${found.length} professors from filter "${value}"`);
              allProfessors.push(...found);
            }
          } catch (err) {
            log(`⚠️  Filter error: ${err.message}`);
            report.warnings.push(`${url}: ${err.message}`);
          }
          return;
        }

        try {
          const fetched = await fetchPage(url, batchPage, log);
          visited.add(url); pageCount++;
          report.pagesScraped.push(url);
          const found = await smartExtract(fetched.html, fetched.text, url, log);
          log(`   → ${found.length} professors [${url}]`);
          allProfessors.push(...found);
          extractAZLinks(fetched.links, url, visited).forEach(u => { if (!visited.has(u)) pageQueue.push(u); });
          extractMorePagesHeuristic(fetched.links, visited).forEach(u => { if (!visited.has(u)) pageQueue.push(u); });
        } catch (err) {
          log(`⚠️  ${err.message}`);
          report.warnings.push(`${url}: ${err.message}`);
        }
      }));
    }

    // Close pool pages
    await Promise.all(pagePool.map(p => p.close().catch(() => {})));

  } finally {
    await browser.closeBrowser();
  }

  // ── PHASE 6: Finalise ─────────────────────────────────────────────────────
  log("\n🧹 Finalising...");
  report.professors = dedup(allProfessors)
    .map((p) => ({ ...p, _s: score(p) }))
    .sort((a, b) => b._s - a._s)
    .map(({ _s, ...p }) => p);

  report.stats = {
    total:          report.professors.length,
    withEmail:      report.professors.filter(p => p.email).length,
    withPhone:      report.professors.filter(p => p.phone).length,
    withDepartment: report.professors.filter(p => p.department).length,
    withTitle:      report.professors.filter(p => p.title).length,
    withResearch:   report.professors.filter(p => p.research).length,
    pagesScraped:   report.pagesScraped.length,
  };

  log(`\n✅ ${report.professors.length} professors | ${report.pagesScraped.length} pages`);
  return report;
}

module.exports = { runAgent };