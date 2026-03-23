require("dotenv").config();

const cheerio  = require("cheerio");
const browser  = require("./browser");
const groq     = require("./groq");

const { fetchPage, extractLinksFromHtml }                    = require("./lib/fetch");
const { smartExtract, dedup, scoreProfessor, groqWithRetry } = require("./lib/extract");
const { makeEnqueue, extractAZLinks, extractMorePagesHeuristic, obviouslyHasProfessors } = require("./lib/queue");
const { detectInteractiveElements, selectFilter, applyFilterAndExtract, queueAllFilterOptions, getFirstRealOption, SKIP_VALUES } = require("./lib/interact");
const { findDirectoryUrl, getDirectoryFallbackLinks }        = require("./lib/discover");

const MAX_PAGES = parseInt(process.env.MAX_PAGES)     || 30;
const MAX_PROFS = parseInt(process.env.MAX_PROFESSORS) || 500;
const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));

async function playwrightSearch(query, page, log) {
  log(`🔍 Searching: ${query}`);
  try {
    await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded", timeout: 15000,
    });
    await sleep(1500);
    return extractLinksFromHtml(await page.content(), "https://www.google.com")
      .map(l => l.url)
      .filter(u => u.startsWith("http") && !u.includes("google.") && !u.includes("googleapis"))
      .slice(0, 25);
  } catch (e) { log(`Search error: ${e.message}`); return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN AGENT
// ─────────────────────────────────────────────────────────────────────────────

async function runAgent(rawUrl, onProgress) {
  const log = (msg) => { process.stdout.write(`[Agent] ${msg}\n`); onProgress?.(msg); };

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
  const queued        = new Set();   // prevents duplicate queue entries
  const pageQueue     = [];
  const enqueue       = makeEnqueue(pageQueue, visited, queued);

  let pageCount    = 0;
  let currentUrl   = rootUrl;

  const clickFailures = new Map();
  const failedActions = [];

  log("🚀 Launching browser...");
  const ctx  = await browser.getContext();
  const page = await ctx.newPage();
  page.on("pageerror", () => {});
  page.on("console",   () => {});

  try {
    // ── PHASE 1: Load root ──────────────────────────────────────────────────
    log(`📡 Loading: ${rootUrl}`);
    const rootFetch = await fetchPage(rootUrl, page, log);
    visited.add(rootUrl); queued.add(rootUrl); pageCount++;

    report.universityName = (await page.title().catch(() => "")) || domain;
    if (!report.universityName || report.universityName === "about:blank") {
      const $ = cheerio.load(rootFetch.html || rootFetch.text || "");
      report.universityName = $("title").text().trim() || domain;
    }
    log(`🎓 ${report.universityName} [${rootFetch.method}]`);

    // ── PHASE 2: Find directory ─────────────────────────────────────────────
    let directoryUrl = await findDirectoryUrl({
      domain, universityName: report.universityName,
      rootUrl, rootFetch, page, log,
    });

    if (!directoryUrl) {
      // No directory found — queue homepage links and let Phase 4 explore them
      getDirectoryFallbackLinks(rootFetch.links || []).forEach(u => enqueue(u));
      log(`   Queued ${pageQueue.length} homepage directory-like links — handing off to Phase 4`);
      currentUrl = '';
    }

    // ── PHASE 3: Load directory ─────────────────────────────────────────────
    if (directoryUrl && !visited.has(directoryUrl)) {
      currentUrl = directoryUrl;
      log(`📄 Loading directory: ${currentUrl}`);
      const dirFetch = await fetchPage(currentUrl, page, log);
      visited.add(currentUrl); queued.add(currentUrl); pageCount++;
      report.pagesScraped.push(currentUrl);

      extractAZLinks(dirFetch.links, currentUrl, visited, queued).forEach(u => enqueue(u));
      if (pageQueue.length > 0) log(`   ⚡ Queued ${pageQueue.length} A-Z/pagination links`);

      if (obviouslyHasProfessors(currentUrl, dirFetch.text)) {
        const found = await smartExtract(dirFetch.html, dirFetch.text, currentUrl, log);
        log(`   → ${found.length} professors from directory`);
        allProfessors.push(...found);
      }

      // ── 0 professors: try interactive filters ────────────────────────────
      if (allProfessors.length === 0) {
        log(`   🎛️  0 professors — detecting interactive filters...`);
        if (page.url() !== currentUrl) { await browser.navigate(page, currentUrl); await sleep(2000); }

        const interactiveElements = await detectInteractiveElements(page).catch(() => []);
        log(`   Found ${interactiveElements.length} interactive elements`);

        if (interactiveElements.length > 0) {
          const freshText  = await page.evaluate(() => { document.querySelectorAll("script,style,iframe,noscript").forEach(e => e.remove()); return document.body?.innerText?.replace(/\s+/g, " ").trim() || ""; });
          const freshHtml  = await page.content();
          const freshLinks = extractLinksFromHtml(freshHtml, currentUrl);

          await sleep(4000);
          const action = await groqWithRetry(() => groq.decideNextAction({
            currentUrl: page.url(), universityName: report.universityName,
            visited: [...visited], totalFound: 0,
            pageText: freshText, links: freshLinks,
            failedActions: [], interactiveElements,
          }));
          log(`   🤖 Filter action: ${action.action} — ${action.reason}`);

          if (action.action === "select_filter" || interactiveElements.some(e => e.type === "select")) {
            // Always queue ALL real options from every select, regardless of what Groq suggested
            const selects = interactiveElements.filter(e => e.type === "select");
            for (const sel of selects)
              for (const opt of (sel.options || [])) {
                const v = (opt.value || "").toLowerCase().trim();
                if (!opt.value || SKIP_VALUES.has(v)) continue;
                enqueue(`__filter__${sel.selector}__${opt.value}__${page.url()}`);
              }
            log(`   → Queued ${pageQueue.length} filter options`);
            // Apply first real option immediately so we don't have to wait for queue
            const firstSel = selects[0];
            if (firstSel) {
              const firstVal = getFirstRealOption(interactiveElements, firstSel.selector);
              if (firstVal) {
                const found = await applyFilterAndExtract(page, firstSel.selector, firstVal, page.url(), smartExtract, log);
                log(`   → ${found.length} professors after first filter`); allProfessors.push(...found);
              }
            }
          } else if (action.action === "click_text" && action.text) {
            interactiveElements.filter(e => e.type === "filter_link" && e.href).forEach(l => enqueue(l.href));
            const clicked = await browser.clickByText(page, action.text);
            if (clicked) {
              await sleep(2000);
              const found = await smartExtract(await page.content(), await page.evaluate(() => document.body?.innerText?.replace(/\s+/g, " ").trim() || ""), page.url(), log);
              log(`   → ${found.length} professors after click`); allProfessors.push(...found);
            }
          } else if (action.action === "navigate" && action.url) {
            enqueue(action.url);
          } else if (action.action === "extract") {
            const found = await smartExtract(freshHtml, freshText, page.url(), log);
            log(`   → ${found.length} professors from direct extract`); allProfessors.push(...found);
          }
        }
      }

      currentUrl = ""; // Phase 4 owns currentUrl from here
    }

    // ── PHASE 4: Agentic loop ───────────────────────────────────────────────
    let consecutiveUseless = 0;
    const MAX_USELESS = 4;

    while (pageCount <= MAX_PAGES && allProfessors.length < MAX_PROFS) {

      // Pull from queue if currentUrl wasn't explicitly set by an action
      if (!currentUrl || currentUrl === "about:blank" || visited.has(currentUrl)) {
        if (pageQueue.length > 0) currentUrl = pageQueue.shift();
        else break;
      }
      if (visited.has(currentUrl)) { currentUrl = ""; continue; }

      // ── Filter action ────────────────────────────────────────────────────
      if (currentUrl.startsWith("__filter__")) {
        const parts    = currentUrl.split("__").filter(Boolean);
        const selector = parts[1];
        const value    = parts[2];
        const baseUrl  = parts.slice(3).join("__");
        visited.add(currentUrl); queued.add(currentUrl);
        currentUrl = "";
        try {
          const found = await applyFilterAndExtract(page, selector, value, baseUrl, smartExtract, log);
          log(`   → ${found.length} professors from filter "${value}"`);
          allProfessors.push(...found);
          consecutiveUseless = found.length > 0 ? 0 : consecutiveUseless + 1;
        } catch (err) {
          log(`⚠️  Filter error: ${err.message}`);
          consecutiveUseless++;
        }
        if (consecutiveUseless >= MAX_USELESS) break;
        continue;
      }

      // ── Fetch ────────────────────────────────────────────────────────────
      const urlToFetch = currentUrl;
      currentUrl = "";

      const fetched = await fetchPage(urlToFetch, page, log);
      const { text: pageText, links, html } = fetched;
      pageCount++;
      visited.add(urlToFetch); queued.add(urlToFetch);
      report.pagesScraped.push(urlToFetch);
      log(`\n🤖 [${pageCount}/${MAX_PAGES}] [${allProfessors.length} profs] [${fetched.method}]`);
      log(`   ${urlToFetch}`);

      // ── Interactive elements ─────────────────────────────────────────────
      let interactiveElements = [];
      if (fetched.method === "playwright" || !obviouslyHasProfessors(urlToFetch, pageText)) {
        interactiveElements = await detectInteractiveElements(page).catch(() => []);
        if (interactiveElements.length > 0) log(`   🎛️  Found ${interactiveElements.length} interactive elements`);
      }

      // ── Decide action ────────────────────────────────────────────────────
      let action;
      if (obviouslyHasProfessors(urlToFetch, pageText)) {
        log(`   ⚡ Auto-detected — extracting`);
        action = { action: "extract", reason: "auto-detected" };
      } else {
        await sleep(6000);
        try {
          action = await groqWithRetry(() => groq.decideNextAction({
            currentUrl: urlToFetch, universityName: report.universityName,
            visited: [...visited].slice(-8), totalFound: allProfessors.length,
            pageText, links, failedActions, interactiveElements,
          }));
        } catch (err) {
          log(`⚠️  Groq error: ${err.message}`);
          consecutiveUseless++;
          if (consecutiveUseless >= MAX_USELESS) break;
          continue;
        }
      }
      log(`   Action: ${action.action} — ${action.reason}`);

      // ── Execute ──────────────────────────────────────────────────────────

      if (action.action === "done") {
        if (pageQueue.length > 0) continue;
        if (allProfessors.length === 0) {
          log(`   ⚠️  0 professors — Google fallback`);
          const results = await playwrightSearch(`${report.universityName} professors faculty directory`, page, log);
          const best = results.find(u => u.includes(domain) && !visited.has(u));
          if (best) { currentUrl = best; continue; }
        }
        log("✅ Done."); break;
      }

      else if (action.action === "extract") {
        const found = await smartExtract(html, pageText, urlToFetch, log);
        log(`   → ${found.length} professors`);
        allProfessors.push(...found);
        consecutiveUseless = found.length > 0 ? 0 : consecutiveUseless + 1;

        const azLinks = extractAZLinks(links, urlToFetch, visited, queued);
        if (azLinks.length > 0) {
          azLinks.forEach(u => enqueue(u));
          log(`   → ${azLinks.length} A-Z links queued`);
        } else {
          const heuristic = extractMorePagesHeuristic(links, visited, queued);
          if (heuristic.length > 0) {
            heuristic.forEach(u => enqueue(u));
            log(`   → Heuristic: ${heuristic.length} pages queued`);
          } else {
            await sleep(4000);
            const more = await groqWithRetry(() => groq.findMorePages(urlToFetch, pageText, links));
            more.forEach(u => enqueue(u));
            log(`   → AI: ${more.length} pages queued`);
          }
        }
        if (consecutiveUseless >= MAX_USELESS) { log("No more pages."); break; }
      }

      else if (action.action === "select_filter") {
        const selector = action.selector || "select";
        // If Groq picked a placeholder value, fall back to the first real option
        let value = action.value || action.text || "";
        if (!value || SKIP_VALUES.has(value.toLowerCase().trim())) {
          value = getFirstRealOption(interactiveElements, selector) || "";
        }
        if (!value) { consecutiveUseless++; if (consecutiveUseless >= MAX_USELESS) break; }
        else {
          log(`   🎛️  Filter: ${selector} = "${value}"`);
          // Queue ALL real options from this dropdown first
          const queued_count = queueAllFilterOptions(interactiveElements, selector, value, page.url(), enqueue);
          log(`   → Queued ${queued_count} remaining filter options`);
          // Apply first option immediately
          const found = await applyFilterAndExtract(page, selector, value, page.url(), smartExtract, log);
          log(`   → ${found.length} professors after filter`);
          allProfessors.push(...found);
          consecutiveUseless = found.length > 0 ? 0 : consecutiveUseless + 1;
          if (consecutiveUseless >= MAX_USELESS) break;
        }
      }

      else if (action.action === "navigate") {
        const dest = action.url;
        if (!dest || visited.has(dest)) {
          consecutiveUseless++;
        } else {
          currentUrl = dest;
          consecutiveUseless = 0;
        }
        if (consecutiveUseless >= MAX_USELESS) break;
      }

      else if (action.action === "search_web") {
        log(`   🔍 ${action.text}`);
        const results = await playwrightSearch(`${action.text} ${domain}`, page, log);
        const best    = results.find(u => u.includes(domain) && !visited.has(u));
        if (best) { currentUrl = best; consecutiveUseless = 0; }
        else consecutiveUseless++;
        if (consecutiveUseless >= MAX_USELESS) break;
      }

      else if (action.action === "click_text") {
        const failKey   = `${urlToFetch}::${action.text}`;
        const failCount = clickFailures.get(failKey) || 0;
        if (failCount >= 2) {
          log(`   ⏭️  Skip "${action.text}"`);
          failedActions.push({ action: "click_text", text: action.text });
          consecutiveUseless++;
          if (consecutiveUseless >= MAX_USELESS) break;
          continue;
        }
        log(`   🖱️  Click: "${action.text}" (${failCount + 1}/2)`);
        const clicked = await browser.clickByText(page, action.text);
        if (clicked) {
          clickFailures.set(failKey, 0);
          await sleep(2000);
          const newUrl = page.url();
          if (!visited.has(newUrl)) currentUrl = newUrl;
          consecutiveUseless = 0;
        } else {
          const n = failCount + 1;
          clickFailures.set(failKey, n);
          log(`   ❌ Failed (${n}/2)`);
          if (n >= 2) failedActions.push({ action: "click_text", text: action.text });
          consecutiveUseless++;
        }
        if (consecutiveUseless >= MAX_USELESS) break;
      }

      else if (action.action === "search_page") {
        log(`   🔎 search_page: "${action.text}"`);
        await browser.searchOnPage(page, action.text);
        await sleep(2000);
        const newUrl = page.url();
        if (!visited.has(newUrl)) currentUrl = newUrl;
        consecutiveUseless = 0;
      }

      else {
        consecutiveUseless++;
        if (consecutiveUseless >= MAX_USELESS) break;
      }
    }

    // ── PHASE 5: Drain queue (parallel) ────────────────────────────────────
    log(`\n📋 ${pageQueue.length} pages remaining...`);

    const pagePool = await Promise.all([ctx.newPage(), ctx.newPage(), ctx.newPage()]);
    pagePool.forEach(p => { p.on("pageerror", () => {}); p.on("console", () => {}); });

    while (pageQueue.length > 0 && pageCount <= MAX_PAGES && allProfessors.length < MAX_PROFS) {
      const batch = pageQueue.splice(0, 3).filter(u => !visited.has(u));
      if (!batch.length) continue;

      await Promise.all(batch.map(async (url, i) => {
        const bPage = pagePool[i];
        if (visited.has(url)) return;

        if (url.startsWith("__filter__")) {
          const parts    = url.split("__").filter(Boolean);
          const selector = parts[1];
          const value    = parts[2];
          const baseUrl  = parts.slice(3).join("__");
          visited.add(url); queued.add(url);
          try {
            const found = await applyFilterAndExtract(bPage, selector, value, baseUrl, smartExtract, log);
            log(`   → ${found.length} professors from filter "${value}"`);
            allProfessors.push(...found);
          } catch (err) {
            log(`⚠️  Filter error: ${err.message}`);
            report.warnings.push(`${url}: ${err.message}`);
          }
          return;
        }

        try {
          const fetched = await fetchPage(url, bPage, log);
          visited.add(url); queued.add(url); pageCount++;
          report.pagesScraped.push(url);
          const found = await smartExtract(fetched.html, fetched.text, url, log);
          log(`   → ${found.length} professors [${url}]`);
          allProfessors.push(...found);
          extractAZLinks(fetched.links, url, visited, queued).forEach(u => enqueue(u));
          extractMorePagesHeuristic(fetched.links, visited, queued).forEach(u => enqueue(u));
        } catch (err) {
          log(`⚠️  ${err.message}`);
          report.warnings.push(`${url}: ${err.message}`);
        }
      }));
    }

    await Promise.all(pagePool.map(p => p.close().catch(() => {})));

  } finally {
    await browser.closeBrowser();
  }

  // ── PHASE 6: Finalise ───────────────────────────────────────────────────
  log("\n🧹 Finalising...");
  report.professors = dedup(allProfessors)
    .map(p => ({ ...p, _s: scoreProfessor(p) }))
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
