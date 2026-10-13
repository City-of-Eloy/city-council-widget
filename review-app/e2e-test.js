/* End to end through the same pipeline the app uses:
 * Granicus listing -> audio download -> Deepgram transcript -> Claude summary.
 * Nothing is published.
 *
 * Run (PowerShell):
 *   $env:DEEPGRAM_API_KEY = "...";  $env:ANTHROPIC_API_KEY = "sk-ant-..."
 *   node e2e-test.js
 * Options:
 *   $env:ELOY_CLIP_ID = "288"        a specific Granicus clip (default: the newest council meeting)
 *   $env:E2E_STAGE = "transcript"    stop after the transcript (no Anthropic key or cost)
 *   $env:E2E_RETRANSCRIBE = "1"      ignore a saved transcript
 * The app's saved keys are encrypted for the app only, so the test takes them from the environment.
 * Transcripts go to Documents\Eloy Minutes\Transcripts, like the app.
 */
"use strict";

const os = require("os");
const path = require("path");

/** The same Documents folder the app uses (Windows may redirect it, e.g. to Work Folders or OneDrive). */
function documentsDir() {
  if (process.env.ELOY_DOCUMENTS) return process.env.ELOY_DOCUMENTS;
  if (process.platform === "win32") {
    const r = require("child_process").spawnSync(
      "powershell",
      ["-NoProfile", "-Command", "[Environment]::GetFolderPath('MyDocuments')"],
      { encoding: "utf-8" }
    );
    const dir = (r.stdout || "").trim();
    if (r.status === 0 && dir) return dir;
  }
  return path.join(os.homedir(), "Documents");
}

async function main() {
  const transcriptOnly = process.env.E2E_STAGE === "transcript";
  const keys = { deepgram: process.env.DEEPGRAM_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  const retranscribe = process.env.E2E_RETRANSCRIBE === "1";
  if (!transcriptOnly && !keys.anthropic) throw new Error("Set ANTHROPIC_API_KEY (or E2E_STAGE=transcript)");

  const granicus = require("./main/engine/granicus");
  const { summarizeClip, obtainTranscript } = require("./main/engine/pipeline");

  console.log("Listing Granicus meetings…");
  const listing = await granicus.listMeetings();
  const wanted = process.env.ELOY_CLIP_ID
    ? Number(process.env.ELOY_CLIP_ID)
    : listing.find((m) => m.kind === "council" && !m.lowContent).clipId;
  const clip = await granicus.resolveClip(wanted, { listing });
  console.log(`Selected: ${clip.date} — ${clip.title} (clip ${clip.clipId}, ${clip.durationLabel || "length unknown"})`);

  const dirs = {
    output: path.join(documentsDir(), "Eloy Minutes"),
    temp: path.join(os.tmpdir(), "eloy-minutes"),
    reference: path.join(__dirname, "resources"),
  };
  const started = Date.now();
  let lastTransient = 0;
  const onProgress = ({ text, transient }) => {
    // Print transient progress at most every 10 s so the console stays readable.
    if (transient && Date.now() - lastTransient < 10000) return;
    if (transient) lastTransient = Date.now();
    console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${text}`);
  };
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  const words = (s) => (String(s).match(/\S+/g) || []).length;

  if (transcriptOnly) {
    const t = await obtainTranscript({ clip, retranscribe, keys, dirs, report: (text, extra = {}) => onProgress({ text, ...extra }) });
    const turns = (t.body.match(/^\[\d{2}:\d{2}:\d{2}\] Speaker /gm) || []).length;
    console.log(`Transcript: ${t.txtPath}${t.reused ? " (reused)" : ""}`);
    console.log(`  ${turns} speaker turns, ${t.body.length.toLocaleString()} characters`);
    if (turns < 5) throw new Error("Transcript looks empty");
    console.log(`E2E TEST PASSED (transcript stage) in ${elapsed()}s`);
    return;
  }

  const result = await summarizeClip({ clip, draft: {}, retranscribe, keys, dirs, onProgress });
  console.log(`Transcript: ${result.transcriptPath}${result.transcriptReused ? " (reused)" : ""}`);
  console.log(`Agenda used: ${result.agendaUsed ? "yes" : "no"}`);
  console.log(`\nOVERVIEW (${words(result.overview)} words)\n${result.overview}\n`);
  console.log(`DETAILS (${words(result.details)} words)\n${result.details}\n`);
  if (!result.overview) throw new Error("Empty overview");
  console.log(`E2E TEST PASSED in ${elapsed()}s`);
}

main().catch((e) => {
  console.error("E2E TEST FAILED:", e.message || e);
  process.exit(1);
});
