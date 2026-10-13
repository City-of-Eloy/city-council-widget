/** Audio extraction with the bundled ffmpeg (ffmpeg-static).
 *
 *  ffmpeg streams the meeting video straight from Granicus and writes only a
 *  small mono MP3 (about 30 MB per hour), so the 1 GB+ video never touches the
 *  disk. No Electron imports: the smoke and e2e tests use this module as-is.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { MediaError, CancelledError } = require("./errors");

/** Path to ffmpeg.exe, fixed up for the packaged app (binaries cannot run from inside app.asar). */
function ffmpegPath() {
  let p = process.env.FFMPEG_BIN;
  if (!p) {
    try {
      p = require("ffmpeg-static");
    } catch {
      p = null;
    }
  }
  if (p) p = p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (!p || !fs.existsSync(p)) {
    throw new MediaError("The audio tool (ffmpeg) that ships with Eloy Council Summaries is missing. Reinstall the app.");
  }
  return p;
}

/** Header options ffmpeg needs so Granicus' CloudFront serves the media. */
function headerArgs(headers = {}) {
  const args = [];
  if (headers["User-Agent"]) args.push("-user_agent", headers["User-Agent"]);
  if (headers.Referer) args.push("-referer", headers.Referer);
  return args;
}

/**
 * Run ffmpeg. Resolves { code, stderrTail }; rejects with CancelledError when
 * the signal fires (the process is killed first).
 */
function runFfmpeg(args, { signal, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new CancelledError());
    let child;
    try {
      child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return reject(e instanceof MediaError ? e : new MediaError(`Could not start the audio tool: ${e.message || e}`));
    }
    let stderr = "";
    let stdoutBuf = "";
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGKILL");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      if (!onStdoutLine) return;
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        onStdoutLine(stdoutBuf.slice(0, idx).trim());
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (e) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(new MediaError(`The audio tool failed to run: ${e.message || e}`));
    });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (cancelled) return reject(new CancelledError());
      resolve({ code, stderrTail: stderr.trim() });
    });
  });
}

function friendlyFfmpegError(stderrTail) {
  const s = stderrTail || "";
  if (/403|Forbidden/i.test(s)) {
    return "Granicus refused the video download (HTTP 403). Granicus may have changed how it serves video; contact IT.";
  }
  if (/404|Not Found/i.test(s)) return "Granicus could not find this recording (HTTP 404).";
  if (/timed out|Connection|resolve|network|Failed to resolve|I\/O error/i.test(s)) {
    return "The video download was interrupted. Check the internet connection, then try again.";
  }
  const last = s.split("\n").filter(Boolean).pop() || "unknown error";
  return `The audio could not be extracted from the video (${last.slice(0, 200)}).`;
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/**
 * Pull the audio track from the first source that works.
 * inputUrls: e.g. [mp4Url, hlsUrl]. durationSec drives the progress percent.
 * Resolves { outPath, seconds, inputUrl, short }; short = audio ended well
 * before the expected duration on every source (kept, but the caller warns).
 */
async function extractAudio({
  inputUrls,
  outPath,
  headers = {},
  durationSec = null,
  bitrate = process.env.ELOY_AUDIO_BITRATE || "64k",
  onProgress,
  signal,
}) {
  const urls = (inputUrls || []).filter(Boolean);
  if (!urls.length) throw new MediaError("No video address was found for this meeting.");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let lastError = null;
  let best = null;
  for (let i = 0; i < urls.length; i++) {
    const inputUrl = urls[i];
    const tmp = `${outPath}.part${i}.mp3`;
    let seconds = 0;
    let lastReport = 0;
    const started = Date.now();
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      ...headerArgs(headers),
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "15",
      "-rw_timeout", "60000000",
      "-i", inputUrl,
      "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", bitrate,
      "-progress", "pipe:1", "-nostats",
      tmp,
    ];
    let result;
    try {
      result = await runFfmpeg(args, {
        signal,
        onStdoutLine: (line) => {
          const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
          if (!m) return;
          seconds = parseInt(m[1], 10) / 1e6;
          const now = Date.now();
          if (onProgress && now - lastReport > 1500) {
            lastReport = now;
            const percent = durationSec ? Math.min(99, (seconds / durationSec) * 100) : null;
            const rate = seconds / Math.max(1, (now - started) / 1000); // media seconds per second
            const etaSec = durationSec && rate > 0 ? Math.max(0, (durationSec - seconds) / rate) : null;
            onProgress({ seconds, percent, etaSec, source: i === 0 ? "primary" : "fallback" });
          }
        },
      });
    } catch (e) {
      unlinkQuiet(tmp);
      if (best) unlinkQuiet(best.tmp);
      throw e; // cancelled, or ffmpeg could not start at all
    }

    const ok = result.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1024;
    if (!ok) {
      unlinkQuiet(tmp);
      lastError = new MediaError(friendlyFfmpegError(result.stderrTail));
      continue;
    }
    const short = Boolean(durationSec && durationSec > 600 && seconds < durationSec * 0.85);
    if (!best || seconds > best.seconds) {
      if (best) unlinkQuiet(best.tmp);
      best = { tmp, seconds, inputUrl, short };
    } else {
      unlinkQuiet(tmp);
    }
    if (!short) break; // full-length audio; no need to try the fallback source
  }

  if (!best) throw lastError || new MediaError("The audio could not be extracted from the video.");
  unlinkQuiet(outPath);
  fs.renameSync(best.tmp, outPath);
  return { outPath, seconds: best.seconds, inputUrl: best.inputUrl, short: best.short };
}

/** Media duration in seconds from ffmpeg's banner, or null. */
async function probeDurationSec(inputUrl, { headers = {}, signal } = {}) {
  const { stderrTail } = await runFfmpeg(
    ["-hide_banner", "-nostdin", ...headerArgs(headers), "-rw_timeout", "30000000", "-i", inputUrl],
    { signal }
  );
  const m = stderrTail.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  return m ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]) : null;
}

/** Split an MP3 into chunkSec-long parts without re-encoding. Resolves the part paths in order. */
async function splitAudio({ inputPath, chunkSec, outDir, signal }) {
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(inputPath, path.extname(inputPath));
  const pattern = path.join(outDir, `${base}.chunk-%03d.mp3`);
  const listParts = () =>
    fs
      .readdirSync(outDir)
      .filter((n) => n.startsWith(`${base}.chunk-`) && n.endsWith(".mp3"))
      .sort()
      .map((n) => path.join(outDir, n));
  let code;
  let stderrTail;
  try {
    ({ code, stderrTail } = await runFfmpeg(
      [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", inputPath,
        "-f", "segment", "-segment_time", String(chunkSec), "-reset_timestamps", "1",
        "-c", "copy",
        pattern,
      ],
      { signal }
    ));
  } catch (e) {
    listParts().forEach(unlinkQuiet); // cancelled mid-split
    throw e;
  }
  const parts = listParts();
  if (code !== 0 || !parts.length) {
    parts.forEach(unlinkQuiet);
    throw new MediaError(`The audio could not be split into parts (${(stderrTail || "").slice(-200)}).`);
  }
  return parts;
}

/** Delete leftover temp audio older than olderThanMs (from a crash or a forced quit). */
function cleanupTemp(dir, { olderThanMs = 24 * 3600 * 1000 } = {}) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && Date.now() - st.mtimeMs > olderThanMs) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        /* in use or gone */
      }
    }
  } catch {
    /* folder does not exist yet */
  }
  return removed;
}

module.exports = { ffmpegPath, extractAudio, probeDurationSec, splitAudio, cleanupTemp, runFfmpeg, unlinkQuiet };
