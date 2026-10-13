/** Speech-to-text with Deepgram (pre-recorded API, Nova-3, speaker diarization).
 *
 *  Plain fetch, no SDK. The audio is uploaded as bytes because Granicus only
 *  serves video to browser-like requests, so Deepgram cannot fetch it itself.
 *  Deepgram's synchronous API gives up after 10 minutes of processing; long
 *  recordings (or a timeout) fall back to transcribing one-hour parts.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { TranscribeError, CancelledError, throwIfCancelled } = require("./errors");
const { splitAudio, unlinkQuiet } = require("./media");

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const MODEL = "nova-3";
const BASE_PARAMS = {
  model: MODEL,
  language: "en",
  smart_format: "true",
  punctuate: "true",
  diarize: "true",
  paragraphs: "true",
  utterances: "true",
};
const CHUNK_SEC = 3600;
const MAX_KEYTERMS = 50;
const MERGE_GAP_SEC = 5;

/** Raised internally when the file should be retried in parts. */
class NeedsChunking extends Error {}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new CancelledError());
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new CancelledError());
        },
        { once: true }
      );
    }
  });
}

/** Terms from resources/reference/keyterms.txt (names Deepgram should spell right). */
function loadKeyterms(referenceDir) {
  if (!referenceDir) return [];
  const file = path.join(referenceDir, "keyterms.txt");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .slice(0, MAX_KEYTERMS);
}

function buildUrl(keyterms = []) {
  const qs = new URLSearchParams(BASE_PARAMS);
  for (const term of keyterms) qs.append("keyterm", term);
  return `${DEEPGRAM_URL}?${qs.toString()}`;
}

/** One synchronous Deepgram request for one audio file. Returns the parsed JSON. */
async function deepgramRequest({ apiKey, filePath, keyterms, signal, timeoutMs = 11 * 60 * 1000 }) {
  const body = fs.readFileSync(filePath);
  let serverRetries = 0;
  let rateRetries = 0;
  for (;;) {
    throwIfCancelled(signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let resp;
    try {
      resp = await fetch(buildUrl(keyterms), {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": "audio/mpeg" },
        body,
        signal: combined,
      });
    } catch (e) {
      if (signal && signal.aborted) throw new CancelledError();
      // Node's fetch (undici) gives up waiting for response headers after 5 minutes,
      // before our own timeout; treat both as "too slow, try in parts".
      const code = e && e.cause && e.cause.code;
      if ((e && e.name === "TimeoutError") || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
        throw new NeedsChunking("timeout");
      }
      throw new TranscribeError(
        `Could not reach Deepgram (${e.message || e}). Check the internet connection, then try again.`
      );
    }

    if (resp.ok) {
      try {
        return await resp.json();
      } catch (e) {
        if (signal && signal.aborted) throw new CancelledError();
        if (e && e.name === "TimeoutError") throw new NeedsChunking("timeout reading response");
        throw new TranscribeError(`Deepgram sent back a response the app could not read (${e.message || e}). Try again.`);
      }
    }

    let detail = "";
    try {
      const err = await resp.json();
      detail = err.err_msg || err.message || err.reason || JSON.stringify(err).slice(0, 200);
    } catch {
      /* no JSON body */
    }
    throwIfCancelled(signal);
    const s = resp.status;
    if (s === 401) {
      throw new TranscribeError(
        "Deepgram rejected the saved API key. It may have been replaced or revoked. Paste the City's current Deepgram key in Settings.",
        { needsKey: true, keyKind: "deepgram" }
      );
    }
    if (s === 402) {
      throw new TranscribeError("The City's Deepgram account is out of credit or has a billing problem. Contact IT.");
    }
    if (s === 403) {
      throw new TranscribeError(
        `The Deepgram key is not allowed to make this request (${detail}). Ask IT to check it.`
      );
    }
    if (s === 413 || s === 504) throw new NeedsChunking(`HTTP ${s}`);
    if (s === 429 && rateRetries < 3) {
      rateRetries++;
      const n = Number(resp.headers.get("retry-after"));
      const wait = (Number.isFinite(n) && n > 0 ? n : 15) * 1000;
      await sleep(Math.min(wait, 60000), signal);
      continue;
    }
    if (s >= 500 && serverRetries < 1) {
      serverRetries++;
      await sleep(5000, signal);
      continue;
    }
    if (s === 429) throw new TranscribeError("Deepgram is limiting requests right now. Wait a minute, then try again.");
    if (s >= 500) throw new TranscribeError("Deepgram is having a problem right now. Wait a few minutes, then try again.");
    throw new TranscribeError(`Deepgram could not transcribe the audio (HTTP ${s}: ${detail || "no details"}).`);
  }
}

// ---------- formatting ----------

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Majority speaker of the words between start and end (for paragraphs that lack a speaker field). */
function speakerFromWords(words, start, end) {
  const counts = new Map();
  for (const w of words) {
    if (w.start >= start - 0.01 && w.end <= end + 0.01 && w.speaker != null) {
      counts.set(w.speaker, (counts.get(w.speaker) || 0) + 1);
    }
  }
  let best = null;
  let n = 0;
  for (const [sp, c] of counts) if (c > n) [best, n] = [sp, c];
  return best;
}

/**
 * Deepgram JSON -> "[HH:MM:SS] Speaker N: text" turns separated by blank lines.
 * Paragraphs are preferred (they break on speaker changes); utterances are the
 * fallback; the flat transcript is the last resort.
 */
function formatTranscript(raw, { offsetSec = 0 } = {}) {
  const alt = (((raw || {}).results || {}).channels || [{}])[0]?.alternatives?.[0] || {};
  const words = alt.words || [];
  const turns = [];
  // Same speaker within a short pause = one turn; a long pause starts a new
  // timestamped turn so the clerk can find it in the video.
  const push = (start, end, speaker, text) => {
    text = String(text || "").trim();
    if (!text) return;
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker && start - last.end < MERGE_GAP_SEC) {
      last.text += " " + text;
      last.end = end;
    } else {
      turns.push({ start, end, speaker, text });
    }
  };

  const paragraphs = alt.paragraphs && alt.paragraphs.paragraphs;
  const utterances = raw && raw.results && raw.results.utterances;
  if (Array.isArray(paragraphs) && paragraphs.length) {
    for (const p of paragraphs) {
      const speaker = p.speaker != null ? p.speaker : speakerFromWords(words, p.start, p.end);
      push(p.start, p.end, speaker, (p.sentences || []).map((s) => s.text).join(" "));
    }
  } else if (Array.isArray(utterances) && utterances.length) {
    for (const u of utterances) push(u.start, u.end, u.speaker, u.transcript);
  } else if (alt.transcript) {
    return alt.transcript.trim();
  }

  return turns
    .map((t) => {
      const who = t.speaker != null ? `Speaker ${t.speaker + 1}` : "Speaker ?";
      return `[${fmtTime(t.start + offsetSec)}] ${who}: ${t.text}`;
    })
    .join("\n\n");
}

/** Number of distinct speakers in a Deepgram response (for the progress log). */
function countSpeakers(raw) {
  const set = new Set();
  for (const u of (raw && raw.results && raw.results.utterances) || []) if (u.speaker != null) set.add(u.speaker);
  return set.size;
}

// ---------- main entry ----------

/**
 * Transcribe one MP3. Returns { text, raws, parts, seconds, speakers }.
 * raws: [{ offsetSec, response }] so the raw JSON can be saved for reference.
 */
async function transcribeAudio({
  audioPath,
  durationSec,
  apiKey,
  referenceDir,
  tempDir,
  onProgress,
  signal,
}) {
  if (!apiKey) {
    throw new TranscribeError(
      "Add the City's Deepgram API key in Settings to transcribe recordings.",
      { needsKey: true, keyKind: "deepgram" }
    );
  }
  const keyterms = loadKeyterms(referenceDir);
  const report = (text) => onProgress && onProgress(text);
  const chunkAfter = parseInt(process.env.ELOY_CHUNK_AFTER_SEC || String(4 * 3600), 10);

  if (!durationSec || durationSec <= chunkAfter) {
    try {
      report("Transcribing the recording (usually 1 to 3 minutes)…");
      const response = await deepgramRequest({ apiKey, filePath: audioPath, keyterms, signal });
      return {
        text: formatTranscript(response),
        raws: [{ offsetSec: 0, response }],
        parts: 1,
        seconds: (response.metadata && response.metadata.duration) || durationSec || null,
        speakers: countSpeakers(response),
      };
    } catch (e) {
      if (!(e instanceof NeedsChunking)) throw e;
      report("The recording is long for one request; transcribing it in one-hour parts instead…");
    }
  } else {
    report("Long recording: transcribing it in one-hour parts…");
  }

  const parts = await splitAudio({ inputPath: audioPath, chunkSec: CHUNK_SEC, outDir: tempDir, signal });
  try {
    const raws = [];
    const texts = [];
    let offset = 0;
    const speakers = new Set();
    for (let i = 0; i < parts.length; i++) {
      report(`Transcribing part ${i + 1} of ${parts.length}…`);
      let response;
      try {
        response = await deepgramRequest({ apiKey, filePath: parts[i], keyterms, signal });
      } catch (e) {
        if (e instanceof NeedsChunking) {
          throw new TranscribeError("Deepgram timed out even on a one-hour part. Try again later; if it keeps happening, contact IT.");
        }
        throw e;
      }
      raws.push({ offsetSec: offset, response });
      const text = formatTranscript(response, { offsetSec: offset });
      texts.push(
        parts.length > 1
          ? `--- Part ${i + 1} of ${parts.length} (starts at ${fmtTime(offset)}; speaker numbers restart in each part) ---\n\n${text}`
          : text
      );
      for (const u of (response.results && response.results.utterances) || []) {
        if (u.speaker != null) speakers.add(`${i}:${u.speaker}`);
      }
      offset += (response.metadata && response.metadata.duration) || CHUNK_SEC;
    }
    return { text: texts.join("\n\n"), raws, parts: parts.length, seconds: offset, speakers: speakers.size };
  } finally {
    parts.forEach(unlinkQuiet);
  }
}

module.exports = {
  MODEL,
  transcribeAudio,
  deepgramRequest,
  formatTranscript,
  countSpeakers,
  loadKeyterms,
  buildUrl,
  fmtTime,
};
