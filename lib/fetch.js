const { CheerioCrawler: CheerioOnly } = require("@crawlee/cheerio");
const cheerio = require("cheerio");
const browser = require("../browser");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.CRAWLEE_LOG_LEVEL = "OFF";
try {
  const { Configuration, LogLevel } = require("@crawlee/core");
  Configuration.getGlobalConfig().set("logLevel", LogLevel.OFF);
} catch {}

async function crawleeFetch(url, log) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    const fail = ()    => done({ text: null, html: null, links: [], method: "needs_playwright" });

    const crawler = new CheerioOnly({
      requestHandlerTimeoutSecs: 15,
      maxRequestRetries: 0,
      async requestHandler({ $, body }) {
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
        if (text.length < 300) { fail(); return; }

        const links = extractLinksFromCheerio($, url);
        const html  = typeof body === "string" ? body : body?.toString("utf-8") || "";
        log(`   ✅ Cheerio: ${text.length} chars, ${links.length} links`);
        done({ text, html, links, method: "cheerio" });
      },
      failedRequestHandler: fail,
    });

    crawler.run([url]).catch(fail);
  });
}

async function playwrightFetch(url, page, log) {
  if (page.url() !== url) await browser.navigate(page, url);

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

function extractLinksFromCheerio($, baseUrl) {
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

function extractLinksFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  return extractLinksFromCheerio($, baseUrl);
}

async function fetchPage(url, page, log) {
  const forcePlaywright = ["profiles.","people.","directory.","experts.","researchers."]
    .some(k => url.includes(k));

  if (!forcePlaywright) {
    const result = await crawleeFetch(url, log);
    if (result.method !== "needs_playwright" && result.text) return { ...result, url };
  }
  return { ...await playwrightFetch(url, page, log), url };
}

module.exports = { fetchPage, extractLinksFromHtml, playwrightFetch };
