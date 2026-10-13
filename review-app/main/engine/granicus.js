/** Granicus client for the City of Eloy's meeting video archive.
 *
 *  Reads the public listing page (ViewPublisher), the per-clip player page
 *  (HLS stream URL), and the generated agenda page. All parsers are pure
 *  functions so the smoke test can run them against saved fixtures.
 *
 *  Granicus' CloudFront refuses media requests that lack a browser
 *  User-Agent and a Referer from the Granicus site, so MEDIA_HEADERS must be
 *  sent with every video / audio request (ffmpeg gets them as arguments).
 */
"use strict";

const { GranicusError, CancelledError } = require("./errors");

const SITE = "https://eloyaz.granicus.com";
const VIEW_ID = 1;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MEDIA_HEADERS = { "User-Agent": BROWSER_UA, Referer: `${SITE}/` };

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// ---------- small text helpers ----------

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  ndash: "–", mdash: "—", hellip: "…", bull: "•",
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : m));
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
}

/** Tag-free, entity-decoded, whitespace-collapsed text of an HTML fragment. */
function cleanText(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

/** "October 12, 2026 - 5:56 PM" -> { date: "2026-10-12", time: "5:56 PM" } (or nulls). */
function parseGranicusDate(text) {
  const m = String(text).match(
    /([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s*-?\s*(\d{1,2}:\d{2})\s*([AaPp])\.?\s*[Mm]\.?)?/
  );
  if (!m) return { date: null, time: null };
  const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3)));
  if (month < 0) return { date: null, time: null };
  const date = `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(parseInt(m[2], 10)).padStart(2, "0")}`;
  const time = m[4] ? `${m[4]} ${m[5].toUpperCase()}M` : null;
  return { date, time };
}

/** "01h 29m" -> 5340 */
function parseDuration(text) {
  const m = String(text).match(/(\d+)\s*h\s*(\d+)\s*m/i);
  return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 : null;
}

function durationLabel(sec) {
  if (!sec) return "";
  const total = Math.round(sec / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Meeting type from the free-text Granicus name. */
function classifyMeeting(name) {
  const n = String(name || "").toLowerCase();
  if (/system\s*test|^\s*test\s*$|new event|audio issue/.test(n)) return "test";
  if (/planning|zoning|p\s*&\s*z\b/.test(n)) return "pz";
  if (/airport|cemetery|board|committee|commission/.test(n)) return "board";
  if (/work\s*session|budget/.test(n)) return "work-session";
  if (/special/.test(n)) return "special";
  if (/council/.test(n)) return "council";
  return "other";
}

const KIND_LABELS = {
  council: "City Council",
  special: "Special Session",
  "work-session": "Work Session",
  pz: "Planning & Zoning",
  board: "Board / Committee",
  test: "Test",
  other: "Other",
};

function lowContent(kind, durationSec) {
  return kind === "test" || (durationSec != null && durationSec < 300);
}

// ---------- HTTP ----------

async function getText(url, { signal, timeoutMs = 45000, what = "Granicus" } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let resp;
  try {
    resp = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, redirect: "follow", signal: combined });
  } catch (e) {
    if (signal && signal.aborted) throw new CancelledError();
    if (e && e.name === "TimeoutError") {
      throw new GranicusError(`${what} did not respond in time. Check the internet connection, then try again.`);
    }
    throw new GranicusError(
      `Could not reach ${what} (${e.message || e}). Check the internet connection, then try again.`
    );
  }
  if (!resp.ok) {
    throw new GranicusError(`${what} returned an error (HTTP ${resp.status}). Try again in a few minutes.`);
  }
  try {
    return await resp.text();
  } catch (e) {
    if (signal && signal.aborted) throw new CancelledError();
    throw new GranicusError(`${what} stopped responding partway through. Check the internet connection, then try again.`);
  }
}

// ---------- listing ----------

/** Parse the archived meetings out of ViewPublisher.php. Pure; throws if nothing parses. */
function parseListingHtml(html) {
  const tables = String(html).match(/<table[^>]*id="archive"[\s\S]*?<\/table>/gi) || [];
  const meetings = [];
  const seen = new Set();
  for (const table of tables) {
    const rows = table.match(/<tr[^>]*class="listingRow"[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const clipMatch = row.match(/MediaPlayer\.php\?[^'"]*clip_id=(\d+)/i);
      if (!clipMatch) continue; // no video for this row
      const clipId = parseInt(clipMatch[1], 10);
      if (seen.has(clipId)) continue;
      seen.add(clipId);

      const nameCell = row.match(/<td[^>]*headers="Name"[^>]*>([\s\S]*?)<\/td>/i);
      const dateCell = row.match(/<td[^>]*headers="Date[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const durCell = row.match(/<td[^>]*headers="Duration[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const minutesM = row.match(/(MinutesViewer\.php\?[^'"\s]+)/i);
      const title = nameCell ? cleanText(nameCell[1]) : `Clip ${clipId}`;
      const { date, time } = parseGranicusDate(dateCell ? cleanText(dateCell[1]) : "");
      const durationSec = durCell ? parseDuration(cleanText(durCell[1])) : null;
      const kind = classifyMeeting(title);

      meetings.push({
        clipId,
        title,
        date,
        time,
        durationSec,
        durationLabel: durationLabel(durationSec),
        kind,
        kindLabel: KIND_LABELS[kind],
        agendaUrl: /AgendaViewer\.php/i.test(row) ? `${SITE}/AgendaViewer.php?view_id=${VIEW_ID}&clip_id=${clipId}` : null,
        minutesUrl: minutesM ? `${SITE}/${decodeEntities(minutesM[1])}` : null,
        playerUrl: `${SITE}/player/clip/${clipId}?view_id=${VIEW_ID}`,
        lowContent: lowContent(kind, durationSec),
      });
    }
  }
  if (!meetings.length) {
    throw new GranicusError(
      "The Granicus meeting list could not be read; the page layout may have changed. Contact IT."
    );
  }
  // Newest first (Granicus already orders this way; the sort keeps it so if not).
  meetings.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || b.clipId - a.clipId);
  return meetings;
}

async function listMeetings({ signal } = {}) {
  const html = await getText(`${SITE}/ViewPublisher.php?view_id=${VIEW_ID}`, { signal, what: "Granicus" });
  return parseListingHtml(html);
}

// ---------- clip input ----------

/** Accepts "288", "clip 288", or any Granicus URL with clip_id=288 or /player/clip/288. */
function parseClipInput(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  let m = s.match(/clip_id=(\d+)/i) || s.match(/\/(?:player\/)?clip\/(\d+)/i) || s.match(/\/videos\/(\d+)\b/i);
  if (m) return parseInt(m[1], 10);
  m = s.match(/^(?:clip\s*#?\s*)?(\d{1,7})$/i);
  return m ? parseInt(m[1], 10) : null;
}

// ---------- player page ----------

function parsePlayerHtml(html) {
  const h = String(html);
  const titleM = h.match(/<title>([\s\S]*?)<\/title>/i);
  let hlsUrl = null;
  const vu = h.match(/video_url\s*=\s*"([^"]+\.m3u8[^"]*)"/i);
  if (vu) hlsUrl = vu[1];
  if (!hlsUrl) {
    const src = h.match(/<source[^>]*type="application\/x-mpegurl"[^>]*src="([^"]+)"/i);
    if (src) hlsUrl = src[1];
  }
  if (hlsUrl && hlsUrl.startsWith("//")) hlsUrl = "https:" + hlsUrl;
  let mp4Url = null;
  const fileM = hlsUrl && hlsUrl.match(/archive\/([^/]+)\/([^/]+\.mp4)/i);
  if (fileM) mp4Url = `https://archive-video.granicus.com/${fileM[1]}/${fileM[2]}`;
  const capM = h.match(/<track[^>]*kind="captions"[^>]*src="([^"]+)"/i);
  return {
    title: titleM ? cleanText(titleM[1]) : "",
    hlsUrl,
    mp4Url,
    captionsUrl: capM ? new URL(decodeEntities(capM[1]), SITE).href : null,
  };
}

async function fetchPlayer(clipId, { signal } = {}) {
  const html = await getText(`${SITE}/player/clip/${clipId}?view_id=${VIEW_ID}`, {
    signal,
    what: "The Granicus video page",
  });
  const info = parsePlayerHtml(html);
  if (!info.hlsUrl) {
    throw new GranicusError(
      `Granicus has no video recording for clip ${clipId}. Check the link or pick another meeting.`
    );
  }
  return info;
}

// ---------- agenda page ----------

const ROMAN_VALUES = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
const PRESENTER = /^(?:[A-Z][A-Za-z.'’-]*\s+){0,3}[A-Z][A-Za-z.'’-]+(?:,\s*[A-Z]{2,5})?$/;

/**
 * One agenda item cell. Granicus lays the presenter's name out at the end of
 * the first line after a long run of &nbsp;s; pull it out so it does not get
 * glued into the item title.
 */
function parseItemCell(html) {
  const segments = String(html).split(/<br\s*\/?>/i);
  let presenter = "";
  const first = segments[0].split(/(?:&nbsp;\s*){3,}/);
  if (first.length >= 2) {
    const candidate = cleanText(first[first.length - 1]);
    if (candidate && PRESENTER.test(candidate)) {
      presenter = candidate;
      segments[0] = first.slice(0, -1).join(" ");
    }
  }
  const text = cleanText(segments.join(" "));
  return { text, presenter };
}

/** Level of an agenda number given what came before: 0 = section, 1 = letter, 2 = number. */
function itemLevel(number, state) {
  const bare = number.replace(/\.$/, "");
  const nextRoman = ROMAN_VALUES[state.romanIndex + 1];
  const nextLetter = state.letter ? String.fromCharCode(state.letter.charCodeAt(0) + 1) : "A";
  if (/^[A-Z]$/.test(bare) && bare === nextLetter && bare !== nextRoman) return 1;
  if (bare === nextRoman || ROMAN_VALUES.includes(bare)) return 0;
  if (/^[A-Z]$/.test(bare)) return 1;
  if (/^\d+$/.test(bare)) return 2;
  return -1; // not an item number: continuation of the previous item
}

/** Turn GeneratedAgendaViewer.php HTML into { date, time, title, agendaText }. */
function parseAgendaHtml(html) {
  const h = String(html);
  const body = (h.match(/<body[\s\S]*<\/body>/i) || [h])[0];

  // Header: "PUBLIC NOTICE / City Council Meeting / Meets / Monday, October 12, 2026 / 6:00 p.m."
  const firstItem = body.search(/<td[^>]*class\s*=\s*"numberspace"/i);
  const headerText = cleanText(firstItem > 0 ? body.slice(0, firstItem) : body.slice(0, 4000));
  const dm =
    headerText.match(/Meets\s+(?:[A-Za-z]+,\s+)?([A-Za-z]+\s+\d{1,2},\s+\d{4})/i) ||
    headerText.match(/([A-Za-z]+\s+\d{1,2},\s+\d{4})/);
  const { date } = parseGranicusDate(dm ? dm[1] : "");
  const tm = headerText.match(/(\d{1,2}:\d{2})\s*([ap])\.?\s*m\.?/i);
  const time = tm ? `${tm[1]} ${tm[2].toUpperCase()}M` : null;
  const titleM = headerText.match(/PUBLIC NOTICE\s+(.+?)\s+Meets\b/i);

  const lines = [];
  const seen = new Set();
  const state = { romanIndex: -1, letter: null };
  const tables = body.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const num = table.match(/<td[^>]*class\s*=\s*"numberspace"[^>]*>([\s\S]*?)<\/td>/i);
    if (!num) continue;
    const number = cleanText(num[1]);
    const cell = table.slice(num.index + num[0].length).match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    const { text, presenter } = parseItemCell(cell ? cell[1] : "");
    if (!text) continue;
    const key = `${number} ${text}`;
    if (seen.has(key)) continue; // Granicus repeats section headings
    seen.add(key);

    const level = itemLevel(number, state);
    if (level === -1) {
      // A stray row (Granicus sometimes splits a number like "0.2303 acres" into its own row).
      if (lines.length) lines[lines.length - 1].text += ` ${number} ${text}`;
      continue;
    }
    if (level === 0) {
      state.romanIndex = ROMAN_VALUES.indexOf(number.replace(/\.$/, ""));
      state.letter = null;
    } else if (level === 1) {
      state.letter = number.replace(/\.$/, "");
    }
    lines.push({ level, number, text, presenter });
  }

  const header = [titleM ? titleM[1] : "", dm ? dm[1] : "", time || ""].filter(Boolean).join(" | ");
  const rendered = lines.map(
    (l) => `${["", "    ", "        "][l.level]}${l.number} ${l.text}${l.presenter ? ` (Presenter: ${l.presenter})` : ""}`
  );
  const agendaText = rendered.length ? `${header}\n\n${rendered.join("\n")}` : "";
  return {
    date,
    time,
    title: titleM ? titleM[1] : "",
    agendaText: agendaText.length >= 200 ? agendaText : "",
  };
}

async function fetchAgenda(clipId, { signal } = {}) {
  const html = await getText(`${SITE}/AgendaViewer.php?view_id=${VIEW_ID}&clip_id=${clipId}`, {
    signal,
    what: "The Granicus agenda page",
  });
  return parseAgendaHtml(html);
}

// ---------- captions ----------

/** VTT -> "[HH:MM:SS] text" lines, or "" when the file has no cues (the usual case today). */
function parseVtt(vtt) {
  const out = [];
  const blocks = String(vtt).replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const m = block.match(/(\d{2}):(\d{2}):(\d{2})[.,]\d{3}\s*-->[^\n]*\n([\s\S]+)/);
    if (!m) continue;
    const text = cleanText(m[4]);
    if (text) out.push(`[${m[1]}:${m[2]}:${m[3]}] ${text}`);
  }
  return out.join("\n");
}

/** Granicus captions as transcript text; "" when none exist or the request fails. */
async function fetchCaptions(clipId, { signal } = {}) {
  try {
    const vtt = await getText(`${SITE}/videos/${clipId}/captions.vtt`, { signal, timeoutMs: 20000 });
    return parseVtt(vtt);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return "";
  }
}

// ---------- resolve ----------

/**
 * Everything the pipeline needs for one clip. `listing` (optional) supplies
 * the date and duration; otherwise the agenda page supplies the date.
 */
async function resolveClip(input, { listing = null, signal } = {}) {
  const clipId = typeof input === "number" ? input : parseClipInput(input);
  if (!clipId) {
    throw new GranicusError(
      "That does not look like a Granicus video link. Paste the link from the video player " +
        "(it contains clip_id= or /player/clip/) or just the clip number."
    );
  }
  const meta = listing ? listing.find((m) => m.clipId === clipId) : null;
  const player = await fetchPlayer(clipId, { signal });

  const clip = {
    clipId,
    title: (meta && meta.title) || player.title || `Clip ${clipId}`,
    date: meta ? meta.date : null,
    time: meta ? meta.time : null,
    durationSec: meta ? meta.durationSec : null,
    agendaUrl: meta ? meta.agendaUrl : `${SITE}/AgendaViewer.php?view_id=${VIEW_ID}&clip_id=${clipId}`,
    playerUrl: `${SITE}/player/clip/${clipId}?view_id=${VIEW_ID}`,
    hlsUrl: player.hlsUrl,
    mp4Url: player.mp4Url,
    source: meta ? "listing" : "player",
  };

  if (!meta) {
    // Not in the list: the agenda page is the only place Granicus shows the date.
    try {
      const agenda = await fetchAgenda(clipId, { signal });
      clip.date = agenda.date;
      clip.time = agenda.time;
      if (!agenda.agendaText) clip.agendaUrl = null;
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      clip.agendaUrl = null;
    }
  }
  clip.kind = classifyMeeting(clip.title);
  clip.kindLabel = KIND_LABELS[clip.kind];
  clip.durationLabel = durationLabel(clip.durationSec);
  clip.lowContent = lowContent(clip.kind, clip.durationSec);
  return clip;
}

module.exports = {
  SITE,
  BROWSER_UA,
  MEDIA_HEADERS,
  KIND_LABELS,
  listMeetings,
  parseListingHtml,
  parseClipInput,
  parsePlayerHtml,
  fetchPlayer,
  parseAgendaHtml,
  fetchAgenda,
  parseVtt,
  fetchCaptions,
  resolveClip,
  classifyMeeting,
  parseGranicusDate,
  durationLabel,
};
