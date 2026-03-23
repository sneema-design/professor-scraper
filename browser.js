require("dotenv").config();
const { chromium } = require("playwright");

let _browser = null;
let _context = null;

async function getBrowser() {
  if (_browser) return _browser;
  _browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

async function getContext() {
  if (_context) return _context;
  const browser = await getBrowser();
  _context = await browser.newContext({
    userAgent: process.env.USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  return _context;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _context = null;
  }
}

async function navigate(page, url) {
  try {
    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: parseInt(process.env.PAGE_TIMEOUT) || 30000,
    });
  } catch {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: parseInt(process.env.PAGE_TIMEOUT) || 30000,
    });
    await page.waitForTimeout(2500);
  }
  await scrollToBottom(page);
  await page.waitForTimeout(800);
}

async function scrollToBottom(page) {
  const maxDepth = parseInt(process.env.SCROLL_DEPTH) || 12000;
  await page.evaluate(async (max) => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 600);
        total += 600;
        if (total >= Math.min(document.body.scrollHeight, max)) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  }, maxDepth);
}

async function getLinks(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href]"))
      .map((a) => ({
        url: a.href,
        text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
      }))
      .filter((l) => l.url.startsWith("http") && l.text.length > 0)
  );
}

async function getTitle(page) { return page.title(); }

async function clickByText(page, text) {
  try {
    await page.getByText(text, { exact: false }).first().click();
    await page.waitForTimeout(1500);
    await scrollToBottom(page);
    return true;
  } catch { return false; }
}

async function searchOnPage(page, query) {
  try {
    const input = page.locator(
      'input[type="search"], input[type="text"], input[name*="search"], input[placeholder*="search" i]'
    ).first();
    if (await input.count() > 0) {
      await input.fill(query);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2000);
      await scrollToBottom(page);
      return true;
    }
  } catch {}
  return false;
}

module.exports = {
  getBrowser, getContext, closeBrowser, navigate,
  getLinks, getTitle, clickByText, searchOnPage, scrollToBottom,
};