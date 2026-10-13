/** Saved transcripts: Documents\Eloy Minutes\Transcripts\<Date> <Meeting> Transcript (clip N).txt
 *
 *  The same folder and file format as the City Clerk's Eloy Minutes app, so a
 *  meeting transcribed by either app is reused by the other and paid for once.
 *  The clip number in the file name is how a later run finds a transcript, so
 *  the date part can be renamed without breaking reuse. The raw Deepgram JSON
 *  goes to Transcripts\raw\clip-N.deepgram.json.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { durationLabel } = require("./granicus");

const RULE = "----";
const MONTHS = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08-24" -> "August 24 2026"; anything else is returned as-is ("Undated" when empty). */
function dateLabel(dateStr) {
  const date = String(dateStr || "").trim();
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return date.replace(/[<>:"/\|?*\x00-\x1f]/g, "").slice(0, 40).trim() || "Undated";
  return `${MONTHS[parseInt(m[2], 10)]} ${parseInt(m[3], 10)} ${m[1]}`;
}

/** Meeting body + type for file names, from the Granicus title (same rules as Eloy Minutes). */
function meetingLabel(title) {
  const t = String(title || "").toLowerCase();
  if (/planning|zoning/.test(t)) return "Planning and Zoning Commission Meeting";
  if (/airport|cemetery|board|committee|commission/.test(t) || !/council/.test(t)) {
    // Other bodies: use the Granicus name itself, minus any date and characters Windows forbids.
    const cleaned = String(title || "")
      .replace(/[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4},?/g, "")
      .replace(/[<>:"/\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s,-]+|[\s,-]+$/g, "")
      .slice(0, 60)
      .trim();
    if (cleaned) return /meeting|session|hearing/i.test(cleaned) ? cleaned : `${cleaned} Meeting`;
  }
  if (/work\s*session|budget/.test(t)) return "City Council Work Session";
  if (/special/.test(t)) return "City Council Special Meeting";
  return "City Council Regular Meeting";
}

function transcriptsDir(outputDir) {
  const dir = path.join(outputDir, "Transcripts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function transcriptStem(clip) {
  return `${dateLabel(clip.date)} ${meetingLabel(clip.title)} Transcript (clip ${clip.clipId})`;
}

/** Newest transcript .txt for this clip, or null. */
function findTranscript(dir, clipId) {
  if (!fs.existsSync(dir)) return null;
  const suffix = `(clip ${clipId}).txt`;
  const hits = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(suffix))
    .map((n) => path.join(dir, n))
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}

/** Map of clipId -> transcript path for every saved transcript. */
function indexTranscripts(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/\(clip (\d+)\)\.txt$/);
    if (m && !map.has(Number(m[1]))) map.set(Number(m[1]), path.join(dir, name));
  }
  return map;
}

function formatDuration(sec) {
  return durationLabel(sec) || "unknown";
}

/**
 * Write the transcript. Replaces any earlier transcript of the same clip.
 * meta: { source, seconds, speakers, parts, warning }
 */
function saveTranscript(dir, clip, body, { raws = null, meta = {} } = {}) {
  const old = findTranscript(dir, clip.clipId);
  const txtPath = path.join(dir, `${transcriptStem(clip)}.txt`);
  const now = new Date();
  const stamp = now.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const header = [
    `Transcript: ${clip.title}`,
    `Date: ${clip.date || "unknown"}${clip.time ? ` ${clip.time}` : ""}`,
    `Granicus clip: ${clip.clipId}  ${clip.playerUrl || ""}`.trim(),
    `Recording length: ${formatDuration(meta.seconds || clip.durationSec)}`,
    `Transcribed: ${stamp} (${meta.source || "automatic transcription"})`,
    meta.speakers ? `Speakers detected: ${meta.speakers} (labels are automatic; "Speaker N" is not a person's identity)` : null,
    meta.parts > 1 ? `Transcribed in ${meta.parts} parts; speaker numbers restart in each part.` : null,
    meta.warning ? `WARNING: ${meta.warning}` : null,
    "This is an automated transcript for drafting minutes. It is not the official record.",
    RULE,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
  fs.writeFileSync(txtPath, header + body.trim() + "\n", "utf-8");
  if (old && path.resolve(old) !== path.resolve(txtPath)) {
    try {
      fs.unlinkSync(old);
    } catch {
      /* open in another program; leave it */
    }
  }

  let jsonPath = null;
  if (raws) {
    const rawDir = path.join(dir, "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    jsonPath = path.join(rawDir, `clip-${clip.clipId}.deepgram.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(raws, null, 1), "utf-8");
  }
  return { txtPath, jsonPath };
}

/** The transcript text without the header block. */
function readTranscriptBody(txtPath) {
  const text = fs.readFileSync(txtPath, "utf-8");
  const lines = text.split(/\r?\n/);
  const idx = lines.indexOf(RULE);
  return (idx >= 0 ? lines.slice(idx + 1) : lines).join("\n").trim();
}

module.exports = {
  transcriptsDir,
  transcriptStem,
  findTranscript,
  indexTranscripts,
  saveTranscript,
  readTranscriptBody,
  dateLabel,
  meetingLabel,
};
