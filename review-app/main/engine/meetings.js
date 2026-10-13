/** Turn Granicus recordings into widget drafts, and flag the ones a reviewer
 *  should look at closely (tests, short or duplicate recordings, other boards).
 */
"use strict";

const COUNCIL_KINDS = new Set(["council", "special", "work-session"]);
const SHORT_RECORDING_SEC = 10 * 60;
const ID_PREFIX = "granicus-";

/** Meeting id used in the review state and the published file. */
function clipKey(clipId) {
  return `${ID_PREFIX}${clipId}`;
}

/** Granicus clip number in a video link (MediaPlayer.php?clip_id=N or /player/clip/N), or null. */
function clipIdFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)granicus\.com$/i.test(u.hostname)) return null;
    const q = u.searchParams.get("clip_id");
    if (q && /^\d+$/.test(q)) return Number(q);
    const m = u.pathname.match(/\/clip\/(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** The clip a record is about: from its id, or from its video link for records
 *  published before the move to Granicus (they had OpenPublica ids). */
function recordClipId(record) {
  const m = String((record && record.id) || "").match(/^granicus-(\d+)$/);
  return m ? Number(m[1]) : clipIdFromUrl(record && record.recordingUrl);
}

/** Give a record from before the move to Granicus its clip id, so it matches the listing. */
function normalizeRecord(record) {
  const clipId = recordClipId(record);
  const id = clipId ? clipKey(clipId) : record.id;
  return id === record.id ? record : { ...record, id };
}

/** The "Meeting type" shown on the website. */
function meetingKind(clip) {
  switch (clip.kind) {
    case "council":
      return "Regular Meeting";
    case "special":
      return "Special Meeting";
    case "work-session":
      return "Work Session";
    case "pz":
      return "Planning & Zoning Commission Meeting";
    case "test":
      return "Test Recording";
    default:
      return "Public Meeting";
  }
}

/** What the reviewer sees about the recording; refreshed from the listing each time. */
function sourceOf(clip) {
  return {
    clipId: clip.clipId,
    title: String(clip.title || ""),
    kind: clip.kind,
    kindLabel: clip.kindLabel,
    time: clip.time || null,
    durationSec: clip.durationSec || null,
    durationLabel: clip.durationLabel || "",
    playerUrl: clip.playerUrl,
    agendaUrl: clip.agendaUrl || null,
    minutesUrl: clip.minutesUrl || null,
  };
}

/** A new draft from a Granicus listing entry. The summary starts empty; Claude or the reviewer writes it. */
function toDraft(clip) {
  return {
    id: clipKey(clip.clipId),
    date: clip.date || null,
    title: meetingKind(clip),
    overview: "",
    details: "",
    durationMinutes: clip.durationSec ? Math.round(clip.durationSec / 60) : null,
    recordingUrl: clip.playerUrl,
    source: sourceOf(clip),
  };
}

/** Reasons a reviewer should take a closer look before approving: [{ code, message }].
 *  Code "low-content" means the recording is hidden automatically. */
function reviewFlags(clip, listing = []) {
  const flags = [];
  const add = (code, message) => flags.push({ code, message });

  if (clip.lowContent) {
    add("low-content", "Looks like a test or an empty recording, so it was hidden automatically.");
  } else {
    if (!COUNCIL_KINDS.has(clip.kind)) {
      add("not-council", `This is a ${clip.kindLabel || "non-Council"} recording, not a City Council meeting.`);
    }
    if (clip.durationSec && clip.durationSec < SHORT_RECORDING_SEC) {
      add("short", `The recording is only ${Math.round(clip.durationSec / 60)} minutes long.`);
    }
  }
  if (!clip.date) {
    add("no-date", "Granicus doesn't show a date for this recording. Enter the meeting date before approving.");
  }
  // Other real recordings of the same date; automatically hidden tests don't count.
  const sameDay = listing.filter((m) => m.clipId !== clip.clipId && m.date && m.date === clip.date && !m.lowContent);
  if (sameDay.length) {
    add(
      "same-date",
      `There ${sameDay.length === 1 ? "is another recording" : `are ${sameDay.length} other recordings`} for this date. Publish only the best one.`
    );
  }
  return flags;
}

function httpsOrEmpty(url) {
  return /^https:\/\//i.test(String(url || "")) ? String(url) : "";
}

/** The fields the website widget shows. Nothing else is published. */
function publishedRecord(draft) {
  return {
    id: draft.id,
    date: draft.date,
    title: draft.title,
    overview: draft.overview,
    details: draft.details,
    durationMinutes: draft.durationMinutes || null,
    recordingUrl: httpsOrEmpty(draft.recordingUrl),
  };
}

function buildPublishedFile(drafts) {
  return {
    version: 1,
    updated: new Date().toISOString(),
    meetings: drafts
      .map(publishedRecord)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
  };
}

module.exports = {
  COUNCIL_KINDS,
  clipKey,
  clipIdFromUrl,
  recordClipId,
  normalizeRecord,
  meetingKind,
  sourceOf,
  toDraft,
  reviewFlags,
  publishedRecord,
  buildPublishedFile,
};
