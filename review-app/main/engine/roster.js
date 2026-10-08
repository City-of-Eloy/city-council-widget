/** Current Mayor and Council, read from the City's own City Council page so
 *  rewrites spell names correctly and stay current after each election.
 *  Falls back to the roster below if the page can't be reached.
 */
"use strict";

const ROSTER_URL = "https://eloyaz.gov/141/City-Council";

// As listed on the City Council page on 2026-10-08. Used only if the page can't be read.
const FALLBACK_ROSTER = `Mayor Andrew Sutton
Vice Mayor Michelle McKinley-Tarango
Councilmember Daniel Snyder
Councilmember Michael Vodrazka
Councilmember Josephine "JoAnne" Galindo
Councilmember Sara Curtis
Councilmember Jose Garcia
City Clerk Mary Myers`;

const ENTITIES = { "&quot;": '"', "&amp;": "&", "&#39;": "'", "&nbsp;": " ", "&rsquo;": "'", "&lsquo;": "'", "&ldquo;": '"', "&rdquo;": '"' };

function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    // Block-level tags start a new line, so menus never run into the roster heading.
    .replace(/<\/?(br|p|div|li|ul|h\d|nav|header|footer|section|table|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] || " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** The part of the page that names the Mayor and Council (the photo caption). */
function rosterSection(text) {
  const first = text.search(/\bMayor\b/);
  if (first === -1) return "";
  // Start one line above the first mention, to keep the caption's heading (e.g. "2025 City Council").
  const lineStart = text.lastIndexOf("\n", first);
  const start = lineStart <= 0 ? 0 : text.lastIndexOf("\n", lineStart - 1) + 1;
  const end = text.indexOf("Mission Statement", first);
  const section = text.slice(start, end === -1 ? first + 1500 : end).trim();
  // Sanity check: the caption names the Mayor and several Councilmembers.
  return (section.match(/Councilmember/gi) || []).length >= 3 ? section : "";
}

/** Returns { text, source } where source is the page URL or "built-in list". */
async function loadCouncilRoster() {
  try {
    const resp = await fetch(ROSTER_URL, {
      headers: { "User-Agent": "eloy-council-review" },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const text = pageText(await resp.text());
      const section = rosterSection(text);
      // The City Clerk is named further down the page.
      const clerk = /City Clerk ([A-Z][a-z]+ [A-Z][a-z]+)/.exec(text);
      if (section) return { text: section + (clerk ? `\nCity Clerk ${clerk[1]}` : ""), source: ROSTER_URL };
    }
  } catch {
    // fall through to the built-in list
  }
  return { text: FALLBACK_ROSTER, source: "built-in list" };
}

module.exports = { loadCouncilRoster, rosterSection, pageText, FALLBACK_ROSTER, ROSTER_URL };
