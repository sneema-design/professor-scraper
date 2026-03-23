const browser = require("../browser");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Placeholder/invalid option values to skip
const SKIP_VALUES = new Set(["", "0", "all", "any", "none", "select", "-1", "default"]);

async function detectInteractiveElements(page) {
  try {
    return await page.evaluate(() => {
      const els = [];

      document.querySelectorAll("select").forEach(el => {
        const options = Array.from(el.options)
          .map(o => ({ value: o.value, text: o.text.trim() }))
          .filter(o => o.text);
        if (options.length > 0) els.push({
          type: "select",
          selector: el.id ? `select#${el.id}` : el.name ? `select[name="${el.name}"]` : "select",
          name: el.name || el.id || "",
          options: options.slice(0, 30),
        });
      });

      document.querySelectorAll("button, [role='button'], a.btn, input[type='button']").forEach(el => {
        const text = (el.innerText || el.value || "").trim();
        if (text && /load more|show all|show more|next|view all|see all/i.test(text))
          els.push({ type: "button", text });
      });

      document.querySelectorAll("[role='tab'], .filter-btn, .tab-btn, [class*='filter'][class*='btn']").forEach(el => {
        const text = el.innerText?.trim();
        if (text && text.length < 50) els.push({ type: "tab", text });
      });

      document.querySelectorAll("a, li").forEach(el => {
        const text = el.innerText?.trim();
        if (text && /school of|college of|department of|faculty of/i.test(text) && text.length < 80)
          els.push({ type: "filter_link", text, href: el.href || "" });
      });

      return els.slice(0, 40);
    });
  } catch { return []; }
}

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

/**
 * Apply a single filter then extract professors from the resulting page.
 * Waits longer for JS-heavy pages like profiles.stanford.edu.
 */
async function applyFilterAndExtract(page, selector, value, baseUrl, smartExtract, log) {
  if (page.url() !== baseUrl) {
    await browser.navigate(page, baseUrl);
    await sleep(2000);
  }
  const success = await selectFilter(page, selector, value, log);
  if (!success) return [];

  // Wait for content to render — JS-heavy pages need more time
  await page.waitForFunction(
    () => document.body?.innerText?.trim().length > 500,
    { timeout: 8000 }
  ).catch(() => {});
  await sleep(2000);

  const afterHtml = await page.content();
  const afterText = await page.evaluate(() =>
    document.body?.innerText?.replace(/\s+/g, " ").trim() || ""
  );
  return smartExtract(afterHtml, afterText, page.url(), log);
}

/**
 * Queue ALL real options from every select on the page.
 * Ignores placeholder values (all, any, none, 0, etc.).
 * Returns count of newly queued items.
 */
function queueAllFilterOptions(interactiveElements, currentSelector, currentValue, pageUrl, enqueue) {
  // Find the matching dropdown
  const matchingSel = interactiveElements.find(e =>
    e.type === "select" &&
    (e.selector === currentSelector ||
     e.name === currentSelector.replace(/select\[name="(.+)"\]/, "$1"))
  );
  if (!matchingSel) return 0;

  let count = 0;
  for (const opt of (matchingSel.options || [])) {
    const v = (opt.value || "").toLowerCase().trim();
    if (!opt.value || SKIP_VALUES.has(v) || opt.value === currentValue) continue;
    enqueue(`__filter__${currentSelector}__${opt.value}__${pageUrl}`);
    count++;
  }
  return count;
}

/**
 * When Groq picks a bad/placeholder filter value, find the first real option instead.
 */
function getFirstRealOption(interactiveElements, selector) {
  const sel = interactiveElements.find(e =>
    e.type === "select" &&
    (e.selector === selector || e.name === selector.replace(/select\[name="(.+)"\]/, "$1"))
  );
  if (!sel) return null;
  for (const opt of (sel.options || [])) {
    const v = (opt.value || "").toLowerCase().trim();
    if (opt.value && !SKIP_VALUES.has(v)) return opt.value;
  }
  return null;
}

module.exports = {
  detectInteractiveElements,
  selectFilter,
  applyFilterAndExtract,
  queueAllFilterOptions,
  getFirstRealOption,
  SKIP_VALUES,
};
