/* Engine smoke test: no Electron, API keys, or network needed.
 * Granicus pages come from saved fixtures and a fake listing; GitHub is an in-memory fake.
 * Run: npm test   (or: node smoke-test.js)
 * Add live Granicus checks (listing, video access, agenda, roster): $env:SMOKE_LIVE = "1"; node smoke-test.js
 */
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");

const granicus = require("./main/engine/granicus");
const { toDraft, reviewFlags, clipKey, clipIdFromUrl, normalizeRecord } = require("./main/engine/meetings");
const { ReviewStore } = require("./main/engine/review");
const { PublishError } = require("./main/engine/github");

const SETTINGS = { githubRepo: "city/widget", githubBranch: "main", githubToken: "test-token" };
const fixture = (name) => fs.readFileSync(path.join(__dirname, "test-fixtures", name), "utf-8");

// ---- Fakes -----------------------------------------------------------------

/** A listing entry as parseListingHtml builds it. */
function clip(clipId, title, date, durationSec, { agenda = true, minutes = false } = {}) {
  const kind = granicus.classifyMeeting(title);
  return {
    clipId,
    title,
    date,
    time: "6:00 PM",
    durationSec,
    durationLabel: granicus.durationLabel(durationSec),
    kind,
    kindLabel: granicus.KIND_LABELS[kind],
    agendaUrl: agenda ? `${granicus.SITE}/AgendaViewer.php?view_id=1&clip_id=${clipId}` : null,
    minutesUrl: minutes ? `${granicus.SITE}/MinutesViewer.php?view_id=1&clip_id=${clipId}` : null,
    playerUrl: `${granicus.SITE}/player/clip/${clipId}?view_id=1`,
    lowContent: kind === "test" || durationSec < 300,
  };
}

const LISTING = [
  clip(288, "City Council Meeting", "2026-09-14", 1200), // a second recording of the same night
  clip(287, "City Council Meeting", "2026-09-14", 3480, { minutes: true }),
  clip(286, "System Test", "2026-09-10", 180, { agenda: false }),
  clip(284, "Planning & Zoning Commission", "2026-08-20", 2400),
];
const [M4, M1, M2, M3] = LISTING.map((c) => clipKey(c.clipId));
const fakeGranicus = {
  async listMeetings() {
    return LISTING;
  },
};

/** GitHub contents API for one file, in memory. */
const github = { content: null, sha: null, puts: [] };
const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
  if (String(url).includes("/branches/")) return reply(String(url).endsWith("/branches/main") ? 200 : 404, {});
  assert.ok(String(url).includes("/repos/city/widget/contents/widget/data/meetings.json"), url);
  if (!options.method) {
    if (!String(url).endsWith("?ref=main")) return reply(404, {});
    if (!github.content) return reply(404, {});
    return reply(200, { sha: github.sha, content: Buffer.from(github.content).toString("base64") });
  }
  const body = JSON.parse(options.body);
  if (body.branch !== "main") return reply(422, {});
  if ((body.sha || null) !== github.sha) return reply(409, {});
  github.content = Buffer.from(body.content, "base64").toString("utf-8");
  github.sha = sha1(github.content);
  github.puts.push(body.message);
  return reply(200, { content: { sha: github.sha }, commit: { html_url: "https://github.com/commit" } });
};
function seedGithub(data) {
  github.content = JSON.stringify(data, null, 2) + "\n";
  github.sha = sha1(github.content);
}

const published = () => JSON.parse(github.content);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "eloy-review-"));
const byId = (store, id) => store.view().meetings.find((m) => m.id === id);
const refresh = (store, settings = SETTINGS) => store.refresh({ granicus: fakeGranicus, settings });

// ---- Tests -----------------------------------------------------------------

async function main() {
  // Markdown renderer and date formatting shared with the widget
  const { renderMarkdown } = await import(pathToFileURL(path.join(__dirname, "..", "widget", "markdown.js")).href);
  const html = renderMarkdown("Hi <script>alert(1)</script> **bold**\n\n1. One\n   - nested\n\n2. Two\n\n[x](javascript:alert(1))");
  assert.ok(!html.includes("<script>"), "markdown must escape HTML");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.equal((html.match(/<ol>/g) || []).length, 1, "a blank line must not restart a numbered list");
  assert.ok(html.includes("<ul><li>nested</li></ul>"), "nested bullets");
  assert.ok(!html.includes('href="javascript'), "only https links become links");
  assert.ok(!renderMarkdown("[x](http://a.example)").includes("<a "), "plain http links are not linked");
  const { formatDate } = await import(pathToFileURL(path.join(__dirname, "..", "widget", "render.js")).href);
  assert.equal(formatDate("2026-09-14", "short"), "Sep 14, 2026");
  assert.equal(formatDate(""), "", "a missing date renders as nothing, not Invalid Date");
  console.log("ok  markdown renderer");

  // Transcript viewer rows
  const { parseTranscript, speakerClass } = await import(
    pathToFileURL(path.join(__dirname, "renderer", "src", "transcript.js")).href
  );
  const rows = parseTranscript(
    "[00:00:01] Speaker 1: I'll call the meeting\nto order.\n\n[01:02:03] Speaker 2: Second.\n\n--- Part 2 of 2 (starts at 01:00:00) ---"
  );
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].time, rows[0].sec, rows[0].speaker, rows[0].text], ["0:01", 1, "Speaker 1", "I'll call the meeting to order."]);
  assert.deepEqual([rows[1].time, rows[1].sec], ["1:02:03", 3723], "hour-long times keep the hour");
  assert.equal(rows[2].kind, "note", "part markers are notes, not turns");
  assert.equal(speakerClass("Speaker 9"), "sp-1");
  assert.equal(speakerClass("Speaker ?"), "sp-x");
  console.log("ok  transcript viewer");

  // Granicus pages (fixtures)
  const listing = granicus.parseListingHtml(fixture("granicus-listing.html"));
  const first = listing[0];
  assert.ok(listing.length >= 10, `parsed ${listing.length} archived meetings`);
  assert.ok(!listing.some((m) => /Work Session/.test(m.title) && m.date === "2026-10-19"), "skips the Upcoming Events table");
  assert.equal(first.clipId, 288);
  assert.equal(first.date, "2026-10-12");
  assert.equal(first.time, "5:56 PM");
  assert.equal(first.durationSec, 5340);
  assert.equal(first.kind, "council");
  assert.ok(first.agendaUrl.includes("clip_id=288"));
  const test286 = listing.find((m) => m.clipId === 286);
  assert.ok(test286 && test286.kind === "test" && test286.lowContent && !test286.agendaUrl, "clip 286 is a test with no agenda");
  assert.ok(listing.some((m) => m.minutesUrl), "older rows keep their Granicus minutes link");
  assert.equal(granicus.classifyMeeting("February 9, 2026, City Council Work Session"), "work-session");
  assert.equal(granicus.classifyMeeting("THE ELOY CITY COUNCIL"), "council");
  const player = granicus.parsePlayerHtml(fixture("granicus-player-288.html"));
  assert.ok(player.hlsUrl.endsWith("/playlist.m3u8"), "finds the HLS stream");
  assert.equal(player.mp4Url, "https://archive-video.granicus.com/eloyaz/eloyaz_b42825cd-7f39-4e02-94f3-79a44d5749a0.mp4");
  const agenda = granicus.parseAgendaHtml(fixture("granicus-agenda-288.html"));
  assert.equal(agenda.date, "2026-10-12");
  assert.match(agenda.agendaText, /^VII\. Consent Agenda$/m);
  assert.match(agenda.agendaText, /\(Presenter: Sergio Banales\)/, "presenter names are split out of item titles");
  assert.equal(granicus.parseVtt("WEBVTT\n\n"), "");
  console.log("ok  granicus pages");

  // Draft conversion
  const draft = toDraft(LISTING[1]);
  assert.equal(draft.id, "granicus-287");
  assert.equal(draft.title, "Regular Meeting");
  assert.equal(draft.overview, "", "summaries start empty; Claude or the reviewer writes them");
  assert.equal(draft.durationMinutes, 58);
  assert.equal(draft.recordingUrl, "https://eloyaz.granicus.com/player/clip/287?view_id=1");
  assert.ok(draft.source.minutesUrl && draft.source.agendaUrl && draft.source.clipId === 287);
  assert.equal(toDraft(LISTING[3]).title, "Planning & Zoning Commission Meeting");
  console.log("ok  draft conversion");

  // Review flags
  const codes = (c) => reviewFlags(c, LISTING).map((f) => f.code);
  assert.deepEqual(codes(LISTING[2]), ["low-content"]);
  assert.deepEqual(codes(LISTING[3]), ["not-council"]);
  assert.deepEqual(codes(LISTING[1]), ["same-date"]);
  assert.deepEqual(codes(LISTING[0]), ["same-date"]);
  assert.deepEqual(codes(clip(290, "City Council Meeting", null, 300)), ["short", "no-date"]);
  console.log("ok  review flags");

  // Meetings published before the move to Granicus are matched to their clip
  assert.equal(clipIdFromUrl("https://eloyaz.granicus.com/MediaPlayer.php?view_id=1&clip_id=287"), 287);
  assert.equal(clipIdFromUrl("https://eloyaz.granicus.com/player/clip/288?view_id=1"), 288);
  assert.equal(clipIdFromUrl("https://archive.org/download/x/x.mp4"), null);
  const legacy = {
    id: "6aa8b9499ea41e8f4db6cf2f",
    date: "2026-09-14",
    title: "Regular Meeting",
    overview: "Old overview.",
    details: "### What the Council decided\n- Something (approved 7-0).",
    durationMinutes: 58,
    recordingUrl: "https://eloyaz.granicus.com/MediaPlayer.php?view_id=1&clip_id=287",
  };
  assert.equal(normalizeRecord(legacy).id, "granicus-287");
  const foreign = {
    id: "abc",
    date: "2026-01-05",
    title: "Regular Meeting",
    overview: "x",
    details: "",
    durationMinutes: null,
    recordingUrl: "https://archive.org/x.mp4",
  };
  assert.equal(normalizeRecord(foreign), foreign, "records without a Granicus link are left alone");
  console.log("ok  legacy ids");

  // First computer: load, write, approve, publish
  const a = new ReviewStore(tempDir());
  const firstRun = await refresh(a);
  assert.equal(firstRun.added, 4);
  assert.equal(byId(a, M2).status, "hidden", "test recordings are hidden automatically");
  assert.equal(byId(a, M1).status, "review");
  assert.equal(byId(a, M1).clipId, 287);
  assert.throws(() => a.setStatus(M1, "approved"), /overview/, "an empty summary can't be approved");
  assert.equal((await refresh(a)).added, 0, "a second refresh adds nothing");

  a.update(M1, { overview: "The Council approved the consent agenda.", details: "### What the Council decided\n- Routine items (approved 7-0)." });
  a.setStatus(M1, "approved");
  assert.equal(byId(a, M1).pending, "add");
  assert.equal(a.view().pendingCount, 1);
  await a.publish(SETTINGS);
  assert.equal(published().meetings.length, 1);
  assert.deepEqual(Object.keys(published().meetings[0]).sort(), [
    "date", "details", "durationMinutes", "id", "overview", "recordingUrl", "title",
  ]);
  assert.equal(published().meetings[0].id, "granicus-287");
  assert.equal(a.view().pendingCount, 0);
  console.log("ok  approve and publish");

  // Edits and hiding show as pending changes
  a.update(M1, { overview: "Edited overview." });
  assert.equal(byId(a, M1).pending, "update");
  a.setStatus(M1, "hidden");
  assert.equal(byId(a, M1).pending, "remove");
  a.setStatus(M1, "approved");
  await a.publish(SETTINGS);
  assert.equal(published().meetings[0].overview, "Edited overview.");
  console.log("ok  edit, hide, republish");

  // Second computer picks up what is published, then publishes a change
  const b = new ReviewStore(tempDir());
  await refresh(b);
  assert.equal(byId(b, M1).status, "approved");
  assert.equal(byId(b, M1).draft.overview, "Edited overview.");
  assert.equal(b.view().pendingCount, 0);
  b.update(M4, { overview: "Part two." });
  b.setStatus(M4, "approved");
  await b.publish(SETTINGS);
  assert.equal(published().meetings.length, 2);

  // The first computer must not overwrite that without refreshing first
  a.update(M1, { overview: "Stale edit." });
  await assert.rejects(a.publish(SETTINGS), (e) => e instanceof PublishError && /another computer/.test(e.message));
  await refresh(a);
  assert.equal(byId(a, M4).status, "approved", "adopts the other computer's approval");
  assert.equal(byId(a, M1).draft.overview, "Stale edit.", "keeps its own unpublished edit");
  await a.publish(SETTINGS);
  assert.equal(published().meetings.length, 2);
  console.log("ok  two computers stay in step");

  // Both computers edit the same meeting: the second to publish must choose
  await refresh(b);
  b.update(M1, { overview: "B's version." });
  a.update(M1, { overview: "A's version." });
  await b.publish(SETTINGS);
  await refresh(a);
  assert.equal(byId(a, M1).conflict.website.overview, "B's version.");
  assert.equal(byId(a, M1).draft.overview, "A's version.", "a conflict never discards local edits");
  await assert.rejects(a.publish(SETTINGS), (e) => e instanceof PublishError && /different version/.test(e.message));
  a.resolveConflict(M1, "website");
  assert.equal(byId(a, M1).draft.overview, "B's version.");
  assert.equal(byId(a, M1).pending, null);

  a.update(M1, { overview: "A again." });
  b.setStatus(M1, "hidden");
  await b.publish(SETTINGS);
  await refresh(a);
  assert.equal(byId(a, M1).conflict.website, null, "the other computer removed it");
  a.resolveConflict(M1, "mine");
  await a.publish(SETTINGS);
  assert.equal(published().meetings.find((m) => m.id === M1).overview, "A again.");
  console.log("ok  conflicting edits are caught");

  // Guard rails
  assert.throws(() => a.update(M1, { overview: " " }), /needs an overview/);
  assert.throws(() => a.update(M1, { date: "Sept 14" }), /date/);
  a.update(M3, { overview: "The Commission met.", date: "" });
  assert.throws(() => a.setStatus(M3, "approved"), /date/, "a meeting without a date can't be approved");
  a.update(M3, { date: "2026-08-20" });
  a.setStatus(M3, "approved");
  const wrongBranch = await refresh(new ReviewStore(tempDir()), { ...SETTINGS, githubBranch: "nope" });
  assert.match(wrongBranch.publishError, /can't find branch "nope"/);
  await assert.rejects(new ReviewStore(tempDir()).publish(SETTINGS), /Check for new meetings first/);
  const corruptDir = tempDir();
  fs.writeFileSync(path.join(corruptDir, "review-state.json"), "{not json");
  new ReviewStore(corruptDir);
  assert.ok(fs.readdirSync(corruptDir).some((f) => f.startsWith("review-state.json.corrupt-")), "damaged state is kept");
  console.log("ok  guard rails");

  // Meetings published before the move to Granicus keep their place
  seedGithub({ version: 1, updated: "2026-10-08T22:33:19.885Z", meetings: [legacy, foreign] });
  const c = new ReviewStore(tempDir());
  await refresh(c);
  assert.equal(byId(c, "6aa8b9499ea41e8f4db6cf2f"), undefined, "the old id is gone");
  const migrated = byId(c, M1);
  assert.equal(migrated.status, "approved");
  assert.equal(migrated.draft.overview, "Old overview.");
  assert.equal(migrated.pending, null, "nothing to publish until something changes");
  assert.equal(migrated.source.clipId, 287, "picks up the Granicus details");
  assert.equal(byId(c, "abc").status, "approved", "a record with no Granicus link is kept as-is");
  assert.equal(c.view().meetings.length, 5, "4 recordings + 1 legacy record, no duplicates");
  c.update(M4, { overview: "Part two." });
  c.setStatus(M4, "approved");
  await c.publish(SETTINGS);
  assert.deepEqual(published().meetings.map((m) => m.id).sort(), ["abc", "granicus-287", "granicus-288"]);
  // ...and so does a review state saved by the old app
  const oldDir = tempDir();
  fs.writeFileSync(
    path.join(oldDir, "review-state.json"),
    JSON.stringify({
      meetings: {
        [legacy.id]: {
          status: "approved",
          flags: [],
          localChange: false,
          source: { title: "Eloy City Council Meeting", summary: "…" },
          draft: legacy,
        },
      },
      published: null,
    })
  );
  const d = new ReviewStore(oldDir);
  assert.equal(byId(d, M1).draft.overview, "Old overview.");
  assert.equal(byId(d, M1).clipId, 287, "the clip comes from the video link until the next refresh");
  assert.equal(byId(d, legacy.id), undefined);
  console.log("ok  meetings from before the move to Granicus");

  // Transcripts: Deepgram formatting, files, keyterms
  const { formatTranscript, buildUrl, loadKeyterms } = require("./main/engine/transcribe");
  const sample = JSON.parse(fixture("deepgram-sample.json"));
  const text = formatTranscript(sample);
  assert.ok(text.startsWith("[00:00:01] Speaker 1: I'll call the meeting to order"), "first turn is timestamped and labelled");
  assert.match(text, /\[01:01:05\] Speaker 1: All in favor\?/, "hour-long timestamps format as HH:MM:SS");
  assert.match(formatTranscript(sample, { offsetSec: 3599 }), /\[01:00:00\] Speaker 1/, "part offsets shift timestamps");
  const terms = loadKeyterms(path.join(__dirname, "resources"));
  assert.ok(terms.includes("Eloy") && terms.length <= 50, `loads ${terms.length} keyterms`);
  assert.match(buildUrl(terms), /model=nova-3/);
  assert.match(buildUrl(terms), /keyterm=Andrew\+Sutton/);
  const transcripts = require("./main/engine/transcripts");
  const tmpOut = tempDir();
  const tdir = transcripts.transcriptsDir(tmpOut);
  const clip288 = { clipId: 288, title: "City Council Meeting", date: "2026-10-12", time: "5:56 PM", durationSec: 5340 };
  assert.equal(
    transcripts.transcriptStem(clip288),
    "October 12 2026 City Council Regular Meeting Transcript (clip 288)",
    "same file names as the Eloy Minutes app"
  );
  const savedT = transcripts.saveTranscript(tdir, clip288, text, {
    raws: [{ offsetSec: 0, response: sample }],
    meta: { source: "automatic transcription", speakers: 4, seconds: 5366 },
  });
  assert.equal(transcripts.findTranscript(tdir, 288), savedT.txtPath, "finds the saved transcript by clip number");
  assert.equal(transcripts.findTranscript(tdir, 287), null);
  assert.equal(transcripts.readTranscriptBody(savedT.txtPath), text.trim(), "reads back the body without the header");
  assert.ok(fs.existsSync(savedT.jsonPath), "keeps the raw Deepgram JSON");
  assert.equal(transcripts.indexTranscripts(tdir).get(288), savedT.txtPath);
  fs.rmSync(tmpOut, { recursive: true, force: true });
  console.log("ok  transcripts");

  // Summary prompt and key checks (no network)
  const { buildUserPrompt, writeSummary } = require("./main/engine/summarize");
  const { summarizeClip } = require("./main/engine/pipeline");
  const roster = { text: "Mayor Andrew Sutton", source: "built-in list" };
  const prompt = buildUserPrompt({
    clip: LISTING[1],
    draft: { date: "2026-09-14", overview: "Current.", details: "" },
    transcript: "[00:00:01] Speaker 1: Hello.",
    agendaText: "VII. Consent Agenda",
    roster,
  });
  for (const tag of ["<council_roster", "<posted_agenda>", "<current_summary>", "<transcript>"]) assert.ok(prompt.includes(tag), tag);
  assert.ok(buildUserPrompt({ clip: LISTING[1], draft: {}, transcript: "x", agendaText: "", roster }).includes("no current summary"));
  await assert.rejects(
    writeSummary({ clip: LISTING[1], draft: {}, transcript: "x", agendaText: "", roster }, { apiKey: "" }),
    (e) => e.needsKey && e.keyKind === "anthropic"
  );
  const dirs = { output: tempDir(), temp: os.tmpdir(), reference: path.join(__dirname, "resources") };
  await assert.rejects(
    summarizeClip({ clip: LISTING[1], keys: { deepgram: "x" }, dirs }),
    (e) => e.needsKey && e.keyKind === "anthropic",
    "the Anthropic key is checked before any transcription is paid for"
  );
  console.log("ok  summary prompt");

  // ffmpeg
  const { ffmpegPath } = require("./main/engine/media");
  const ff = spawnSync(ffmpegPath(), ["-hide_banner", "-encoders"], { encoding: "utf-8" });
  assert.equal(ff.status, 0, "ffmpeg runs");
  assert.match(ff.stdout, /libmp3lame/, "ffmpeg can encode MP3");
  console.log(`ok  ffmpeg (${ffmpegPath()})`);

  // Council roster read from the City Council page (offline sample of its markup)
  const { rosterSection, pageText } = require("./main/engine/roster");
  const page = pageText(`<nav>Home Contact Us</nav><h2>2025 City Council</h2>
    <p>Top (left to right): Vice-Mayor Michelle McKinley-Tarango, Mayor Andrew Sutton, Councilmember Daniel Snyder.</p>
    <p>Bottom: Councilmember Michael Vodrazka, Councilmember Josephine &quot;JoAnne&quot; Galindo, Councilmember Sara Curtis</p>
    <h2>Mission Statement</h2><p>Operating under the Council-Manager form of government...</p>`);
  const section = rosterSection(page);
  assert.ok(section.startsWith("2025 City Council"), "keeps the heading, drops the menu");
  assert.ok(section.includes('Josephine "JoAnne" Galindo') && !section.includes("Mission"));
  assert.equal(rosterSection(pageText("<p>Page moved</p>")), "", "unrecognized page -> built-in list");
  console.log("ok  council roster");

  // Optional live checks
  if (process.env.SMOKE_LIVE === "1") {
    global.fetch = realFetch;
    const live = await granicus.listMeetings();
    assert.ok(live.length >= 100, `live listing has ${live.length} meetings`);
    const latest = live.find((m) => m.kind === "council" && !m.lowContent);
    console.log(`    newest council meeting: ${latest.date} ${latest.title} (clip ${latest.clipId}, ${latest.durationLabel})`);
    const resolved = await granicus.resolveClip(latest.clipId, { listing: live });
    assert.ok(resolved.hlsUrl && resolved.mp4Url, "resolves the video addresses");
    const resp = await fetch(resolved.hlsUrl, { headers: granicus.MEDIA_HEADERS });
    assert.ok(resp.ok && (await resp.text()).startsWith("#EXTM3U"), "Granicus serves the stream with browser headers");
    const liveAgenda = await granicus.fetchAgenda(latest.clipId);
    assert.ok(liveAgenda.agendaText.length > 200, "live agenda text is readable");
    const { loadCouncilRoster } = require("./main/engine/roster");
    const liveRoster = await loadCouncilRoster();
    assert.equal(liveRoster.source, "https://eloyaz.gov/141/City-Council", "roster read from eloyaz.gov");
    console.log("ok  live Granicus and roster");
  }

  console.log(`\nSMOKE TEST PASSED (${github.puts.length} publishes: ${github.puts.join(" | ")})`);
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
