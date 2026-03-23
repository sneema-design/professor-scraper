// ─────────────────────────────────────────────────────────────────────────────
// Queue helpers — dedup-safe enqueue + URL pattern matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an enqueue function bound to a specific pageQueue + visited/queued Sets.
 * A URL will never be added to the queue more than once, even if multiple pages
 * link to it before it has been visited.
 */
function makeEnqueue(pageQueue, visited, queued) {
  return function enqueue(url) {
    if (!url || visited.has(url) || queued.has(url)) return;
    queued.add(url);
    pageQueue.push(url);
  };
}

/**
 * Extract A-Z / pagination links from a page's link list.
 * Only returns links on the same origin that look like paginated directory pages.
 * Pass the `queued` Set as the third argument so already-queued URLs are skipped.
 */
function extractAZLinks(links, currentUrl, visited, queued = new Set()) {
  try {
    const base        = new URL(currentUrl).origin;
    const currentPath = new URL(currentUrl).pathname;
    const currentSearch = new URL(currentUrl).search;

    return links.map(l => l.url).filter(u => {
      if (!u || visited.has(u) || queued.has(u)) return false;
      try {
        const parsed = new URL(u);
        if (parsed.origin !== base) return false;
        return (
          /\/by-name\/[a-z]$/i.test(u)  ||
          /[?&]letter=[a-z]$/i.test(u)  ||
          /[?&]char=[a-z]$/i.test(u)    ||
          /[?&]alpha=[a-z]$/i.test(u)   ||
          /[?&]page=\d+/i.test(u)       ||
          /[?&]p=\d+/i.test(u)          ||
          /\/page\/\d+/i.test(u)        ||
          /[?&]start=\d+/i.test(u)      ||
          /[?&]offset=\d+/i.test(u)     ||
          /[?&]from=\d+/i.test(u)       ||
          (parsed.pathname === currentPath &&
           parsed.search !== currentSearch &&
           parsed.search.length > 0)
        );
      } catch { return false; }
    });
  } catch { return []; }
}

/**
 * Broader heuristic — catches pagination patterns regardless of base path.
 * Pass the `queued` Set as the third argument so already-queued URLs are skipped.
 */
function extractMorePagesHeuristic(links, visited, queued = new Set()) {
  const patterns = [
    /[?&]page=\d+/i, /[?&]letter=[a-z]/i, /\/by-name\/[a-z]/i,
    /[?&]p=\d+/i, /\/page\/\d+/i, /[?&]start=\d+/i, /[?&]offset=\d+/i,
  ];
  return links.map(l => l.url)
    .filter(u => u && !visited.has(u) && !queued.has(u) && patterns.some(p => p.test(u)));
}

/**
 * Returns true if the URL + page text strongly suggest a professor listing.
 */
function obviouslyHasProfessors(url, text) {
  const u = url.toLowerCase();
  const t = (text || "").toLowerCase().slice(0, 800);

  const urlMatch = [
    "/people","/faculty","/staff","/directory","/find-an-expert","/find-expert",
    "/researchers","/academics","/our-people","/profiles","/experts","/members",
    "/teaching-staff","/academic-staff","/faculty-members",
  ].some(p => u.includes(p));

  const keywords = [
    "professor","prof.","dr.","lecturer","associate professor","assistant professor",
    "reader","emeritus","dean","research interest","department of","faculty of",
  ];
  const keywordCount  = keywords.filter(w => t.includes(w)).length;
  const namePatterns  = (t.match(/\b(prof|dr|professor)\b/gi) || []).length;
  const isPaginated   = /\/(find-an-expert|find-expert|people|faculty|directory|staff|researchers|experts).*([?&]page=\d+|\/[a-z]$)/i.test(u);

  return isPaginated || (urlMatch && keywordCount >= 1) || keywordCount >= 4 || namePatterns >= 3;
}

module.exports = { makeEnqueue, extractAZLinks, extractMorePagesHeuristic, obviouslyHasProfessors };
