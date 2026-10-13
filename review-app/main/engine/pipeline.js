/** Granicus recording -> transcript -> Claude summary.
 *
 *  Shared by the app (main.js) and e2e-test.js so the test exercises the exact
 *  path the reviewer uses. No Electron imports; folders come in through `dirs`:
 *  { output, temp, reference }.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const granicus = require("./granicus");
const media = require("./media");
const { transcribeAudio } = require("./transcribe");
const transcripts = require("./transcripts");
const { writeSummary } = require("./summarize");
const { loadCouncilRoster } = require("./roster");
const { CancelledError, SummaryError, TranscribeError, throwIfCancelled } = require("./errors");

function fmtEta(sec) {
  if (sec == null || !isFinite(sec)) return "";
  if (sec < 60) return "less than a minute left";
  const m = Math.round(sec / 60);
  return `about ${m} minute${m === 1 ? "" : "s"} left`;
}

/**
 * Get a transcript for the clip: saved file, Granicus captions, or Deepgram.
 * Resolves { body, txtPath, reused, source }.
 */
async function obtainTranscript({ clip, retranscribe, keys, dirs, report, signal }) {
  const tdir = transcripts.transcriptsDir(dirs.output);

  if (!retranscribe) {
    const existing = transcripts.findTranscript(tdir, clip.clipId);
    if (existing) {
      const when = new Date(fs.statSync(existing).mtimeMs).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
      report(`Using the transcript saved on ${when}: ${path.basename(existing)}`);
      return { body: transcripts.readTranscriptBody(existing), txtPath: existing, reused: true, source: "saved" };
    }
  }

  // Granicus captions are empty for Eloy today, but cost one request to check.
  report("Checking Granicus for captions…");
  const captions = await granicus.fetchCaptions(clip.clipId, { signal });
  if (captions.length > 500) {
    report("Using the captions published on Granicus.");
    const { txtPath } = transcripts.saveTranscript(tdir, clip, captions, { meta: { source: "Granicus captions" } });
    return { body: captions, txtPath, reused: false, source: "captions" };
  }

  if (!keys.deepgram) {
    throw new TranscribeError("Add the City's Deepgram API key in Settings to transcribe this recording.", {
      needsKey: true,
      keyKind: "deepgram",
    });
  }

  fs.mkdirSync(dirs.temp, { recursive: true });
  const audioPath = path.join(dirs.temp, `clip-${clip.clipId}-${Date.now()}.mp3`);
  try {
    let durationSec = clip.durationSec;
    if (!durationSec) {
      try {
        durationSec = await media.probeDurationSec(clip.mp4Url || clip.hlsUrl, { headers: granicus.MEDIA_HEADERS, signal });
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        durationSec = null;
      }
    }

    report(
      `Downloading the meeting audio from Granicus${durationSec ? ` (${granicus.durationLabel(Math.round(durationSec))} recording)` : ""}…`
    );
    const audio = await media.extractAudio({
      inputUrls: [clip.mp4Url, clip.hlsUrl],
      outPath: audioPath,
      headers: granicus.MEDIA_HEADERS,
      durationSec,
      signal,
      onProgress: ({ percent, etaSec, source }) => {
        const pct = percent != null ? `${Math.round(percent)}%` : "";
        const eta = fmtEta(etaSec);
        report(
          `Downloading the meeting audio${source === "fallback" ? " (backup stream)" : ""}… ${[pct, eta].filter(Boolean).join(", ")}`,
          { percent, transient: true }
        );
      },
    });
    let warning = null;
    if (audio.short) {
      warning =
        `The audio ended at ${granicus.durationLabel(Math.round(audio.seconds))} but Granicus lists the recording as ` +
        `${granicus.durationLabel(durationSec)}. The end of the meeting may be missing.`;
      report(`WARNING: ${warning}`);
    }
    report(`Audio ready (${granicus.durationLabel(Math.round(audio.seconds))}).`, { percent: 100, transient: true });

    throwIfCancelled(signal);
    const result = await transcribeAudio({
      audioPath,
      durationSec: audio.seconds,
      apiKey: keys.deepgram,
      referenceDir: dirs.reference,
      tempDir: dirs.temp,
      onProgress: (t) => report(t),
      signal,
    });
    if (!result.text.trim()) {
      throw new TranscribeError(
        "The transcription found no speech in this recording. Check that the video has sound, or pick another meeting."
      );
    }
    const { txtPath } = transcripts.saveTranscript(tdir, clip, result.text, {
      raws: result.raws,
      meta: {
        source: "automatic transcription",
        seconds: result.seconds || audio.seconds,
        speakers: result.speakers,
        parts: result.parts,
        warning,
      },
    });
    report(`Transcript saved (${result.speakers || "unknown number of"} speakers): ${path.basename(txtPath)}`);
    return { body: result.text, txtPath, reused: false, source: "deepgram" };
  } finally {
    if (process.env.ELOY_KEEP_AUDIO !== "1") media.unlinkQuiet(audioPath);
  }
}

/** The posted agenda text from Granicus, or "" when there is none or it can't be read. */
async function obtainAgenda({ clip, report, signal }) {
  if (clip.agendaUrl === null) return "";
  report("Reading the posted agenda from Granicus…");
  try {
    const { agendaText } = await granicus.fetchAgenda(clip.clipId, { signal });
    if (agendaText) return agendaText;
    report("Granicus has no agenda for this meeting; summarizing from the transcript alone.");
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    report(`Could not read the Granicus agenda (${e.message}); summarizing from the transcript alone.`);
  }
  return "";
}

/**
 * The whole job for one clip (from granicus.resolveClip). `draft` is the
 * reviewer's current text, if any. Resolves
 * { overview, details, transcriptPath, transcriptReused, transcriptSource, agendaUsed }.
 */
async function summarizeClip({ clip, draft = {}, retranscribe = false, keys = {}, dirs, onProgress, signal }) {
  const report = (text, extra = {}) => onProgress && onProgress({ text, ...extra });

  // Check the Anthropic key first so no transcription money is spent on a job that cannot finish.
  if (!keys.anthropic) {
    throw new SummaryError("Add the City's Anthropic API key in Settings to write summaries.", { needsKey: true, keyKind: "anthropic" });
  }

  const transcript = await obtainTranscript({ clip, retranscribe, keys, dirs, report, signal });
  throwIfCancelled(signal);
  const agendaText = await obtainAgenda({ clip, report, signal });
  throwIfCancelled(signal);

  report("Checking the current Council roster on eloyaz.gov…");
  const roster = await loadCouncilRoster();
  throwIfCancelled(signal);

  report("Claude is writing the summary. This can take a minute or two…");
  const suggestion = await writeSummary(
    { clip, draft, transcript: transcript.body, agendaText, roster },
    { apiKey: keys.anthropic, onProgress: (t) => report(t, { transient: true }), signal }
  );
  return {
    ...suggestion,
    transcriptPath: transcript.txtPath,
    transcriptReused: transcript.reused,
    transcriptSource: transcript.source,
    agendaUsed: Boolean(agendaText),
  };
}

module.exports = { summarizeClip, obtainTranscript, obtainAgenda };
