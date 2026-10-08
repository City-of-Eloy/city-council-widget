/** Turn OpenPublica meetings into widget drafts, and flag the ones a reviewer
 *  should look at closely (tests, empty recordings, duplicate dates).
 */
"use strict";

const LOW_CONTENT_MARKERS = [
  "no substantive content",
  "system test",
  "nonsensical",
  "no actionable outcomes",
  "troubleshooting",
  "no content available",
  "no agenda, minutes, or transcript",
];

const INCOMPLETE_RECORDING = /no (minutes or )?meaningful transcript|transcript (was|is) (not available|unavailable)|(single|only) (nonsensical|unclear) remark|no substantive (public comments|discussion)/i;

const SHORT_RECORDING_MINUTES = 10;

function isCouncilMeeting(title) {
  return /council/i.test(String(title || ""));
}

function meetingKind(title) {
  const t = String(title || "");
  if (/planning\s*(&|and)\s*zoning/i.test(t)) return "Planning & Zoning Commission Meeting";
  if (!isCouncilMeeting(t)) return "Public Meeting";
  if (/special/i.test(t)) return "Special Meeting";
  if (/work\s*session|study\s*session/i.test(t)) return "Work Session";
  return "Regular Meeting";
}

/** "Engineering And Infrastructure (30%)" -> "Engineering And Infrastructure"; drops "Procedural". */
function cleanTopics(topics) {
  return (Array.isArray(topics) ? topics : [])
    .map((t) => String(t).replace(/\s*\(\d+%\)\s*$/, "").trim())
    .filter((t) => t && !/^(procedural|miscellaneous)$/i.test(t))
    .slice(0, 4);
}

/** Split an OpenPublica summary into the opening paragraph and the rest.
 *  The leading "# Title" heading is dropped; the widget shows the date instead. */
function splitSummary(markdown) {
  const text = String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/^#\s+[^\n]*\n+/, "")
    .trim();
  const firstBreak = text.search(/\n\s*\n/);
  const first = firstBreak === -1 ? text : text.slice(0, firstBreak);
  if (/^\s*(#|[-*+]\s|\d+[.)]\s)/.test(first)) return { overview: "", details: text };
  return {
    overview: first.trim(),
    details: firstBreak === -1 ? "" : text.slice(firstBreak).trim(),
  };
}

/** Granicus download link -> the City's Granicus video player page for the same clip. */
function recordingPageUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    const clipId = url.searchParams.get("clip_id");
    if (!/(^|\.)granicus\.com$/i.test(url.hostname) || !clipId) return "";
    const viewId = url.searchParams.get("view_id") || "1";
    return `https://${url.hostname}/MediaPlayer.php?view_id=${encodeURIComponent(viewId)}&clip_id=${encodeURIComponent(clipId)}`;
  } catch {
    return "";
  }
}

function httpsOrEmpty(url) {
  return /^https:\/\//i.test(String(url || "")) ? String(url) : "";
}

/** A new draft from an OpenPublica meeting (from get_meeting, or a listing entry). */
function toDraft(meeting) {
  const summary = meeting.summary || meeting.summary_preview || "";
  const { overview, details } = splitSummary(summary);
  return {
    id: meeting.meeting_id,
    date: meeting.date,
    title: meetingKind(meeting.title),
    overview,
    details,
    topics: cleanTopics(meeting.topics),
    durationMinutes: Number(meeting.duration_minutes) || null,
    // The City's Granicus player when there is one, otherwise OpenPublica's archive copy.
    recordingUrl: recordingPageUrl(meeting.source_url) || httpsOrEmpty(meeting.video_url),
    source: {
      title: String(meeting.title || ""),
      summary: String(summary),
      openpublicaUrl: httpsOrEmpty(meeting.openpublica_url),
    },
  };
}

function isLowContent(meeting) {
  const title = String(meeting.title || "").toLowerCase();
  const summary = String(meeting.summary || meeting.summary_preview || "").toLowerCase();
  return LOW_CONTENT_MARKERS.some((m) => title.includes(m) || summary.includes(m));
}

/** Reasons a reviewer should take a closer look before approving: [{ code, message }].
 *  Code "low-content" means the meeting is hidden automatically. */
function reviewFlags(meeting, allMeetings = []) {
  const flags = [];
  const add = (code, message) => flags.push({ code, message });
  const summary = String(meeting.summary || meeting.summary_preview || "");

  if (!isCouncilMeeting(meeting.title)) {
    add("not-council", "This doesn't look like a City Council meeting (it may be a commission or board).");
  }
  if (isLowContent(meeting)) {
    add("low-content", "Looks like a test or an empty recording, so it was hidden automatically.");
  } else if (INCOMPLETE_RECORDING.test(summary)) {
    add("incomplete", "The summary says the recording was incomplete. Check it against the agenda before approving.");
  }
  // Other real recordings of the same date; automatically hidden tests don't count.
  const sameDay = allMeetings.filter(
    (m) => m.meeting_id !== meeting.meeting_id && m.date === meeting.date && !isLowContent(m)
  );
  if (sameDay.length) {
    add(
      "same-date",
      `There ${sameDay.length === 1 ? "is another recording" : `are ${sameDay.length} other recordings`} for this date. Publish only the best one.`
    );
  }
  const minutes = Number(meeting.duration_minutes);
  if (minutes && minutes < SHORT_RECORDING_MINUTES) {
    add("short", `The recording is only ${minutes} minutes long.`);
  }
  return flags;
}

/** The fields the website widget shows. Nothing else is published. */
function publishedRecord(draft) {
  return {
    id: draft.id,
    date: draft.date,
    title: draft.title,
    overview: draft.overview,
    details: draft.details,
    topics: draft.topics || [],
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
      .sort((a, b) => String(b.date).localeCompare(String(a.date))),
  };
}

module.exports = {
  toDraft,
  reviewFlags,
  publishedRecord,
  buildPublishedFile,
  splitSummary,
  cleanTopics,
  meetingKind,
  recordingPageUrl,
};
