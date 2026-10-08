/* Engine smoke test: no Electron, API keys, or network needed.
 * OpenPublica and GitHub are replaced with in-memory fakes.
 * Run: npm test   (or: node smoke-test.js)
 */
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const { toDraft, reviewFlags } = require("./main/engine/meetings");
const { ReviewStore } = require("./main/engine/review");
const { PublishError } = require("./main/engine/github");

const SETTINGS = { githubRepo: "city/widget", githubBranch: "main", githubToken: "test-token" };

// ---- Fakes -----------------------------------------------------------------

const MEETINGS = [
  {
    meeting_id: "m1",
    date: "2026-09-14",
    title: "Eloy City Council Meeting: September 14, 2026",
    topics: ["Engineering And Infrastructure (30%)", "Procedural (22%)", "Miscellaneous (5%)"],
    duration_minutes: 58,
    source_url: "https://eloyaz.granicus.com/DownloadFile.php?view_id=1&clip_id=287",
    video_url: "https://archive.org/download/x/x.mp4",
    summary:
      "# Eloy City Council Meeting: September 14, 2026\n\nThe Council approved the consent agenda.\n\n### Discussion Items\n1. **Police vehicle**\n   - Approved 7-0.\n\n2. **Ordinance 26-1006**\n   - Adopted.",
  },
  {
    meeting_id: "m2",
    date: "2026-08-07",
    title: "System Test City Council Meeting - August 7, 2026",
    duration_minutes: 3,
    summary: "# System Test\n\nThis meeting was a scheduled system test.",
  },
  {
    meeting_id: "m3",
    date: "2026-07-15",
    title: "Eloy Planning & Zoning Commission Meeting - July 15, 2026",
    duration_minutes: 40,
    summary: "# P&Z\n\nThe Commission met.",
  },
  {
    meeting_id: "m4",
    date: "2026-09-14",
    title: "Eloy City Council Meeting - September 14, 2026 (part 2)",
    duration_minutes: 20,
    summary: "# Part 2\n\nThe Council continued.",
  },
];

const fakeOpenPublica = {
  async listRecentMeetings() {
    return MEETINGS.map(({ summary, ...meta }) => ({ ...meta, summary_preview: summary.slice(0, 200) }));
  },
  async getMeeting(id) {
    return { ...MEETINGS.find((m) => m.meeting_id === id) };
  },
};

/** GitHub contents API for one file, in memory. */
const github = { content: null, sha: null, puts: [] };
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
  github.sha = crypto.createHash("sha1").update(github.content).digest("hex");
  github.puts.push(body.message);
  return reply(200, { content: { sha: github.sha }, commit: { html_url: "https://github.com/commit" } });
};

const published = () => JSON.parse(github.content);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "eloy-review-"));
const byId = (store, id) => store.view().meetings.find((m) => m.id === id);

// ---- Tests -----------------------------------------------------------------

async function main() {
  // Markdown renderer shared with the widget
  const { renderMarkdown } = await import(pathToFileURL(path.join(__dirname, "..", "widget", "markdown.js")).href);
  const html = renderMarkdown("Hi <script>alert(1)</script> **bold**\n\n1. One\n   - nested\n\n2. Two\n\n[x](javascript:alert(1))");
  assert.ok(!html.includes("<script>"), "markdown must escape HTML");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.equal((html.match(/<ol>/g) || []).length, 1, "a blank line must not restart a numbered list");
  assert.ok(html.includes("<ul><li>nested</li></ul>"), "nested bullets");
  assert.ok(!html.includes('href="javascript'), "only https links become links");
  assert.ok(!renderMarkdown("[x](http://a.example)").includes("<a "), "plain http links are not linked");
  assert.ok(
    renderMarkdown("x *[a](https://u.example/*) y").includes('href="https://u.example/*"'),
    "emphasis markers never end up inside an href"
  );
  console.log("ok  markdown renderer");

  // Draft conversion
  const draft = toDraft(MEETINGS[0]);
  assert.equal(draft.title, "Regular Meeting");
  assert.equal(draft.overview, "The Council approved the consent agenda.");
  assert.ok(draft.details.startsWith("### Discussion Items"));
  assert.equal(draft.recordingUrl, "https://eloyaz.granicus.com/MediaPlayer.php?view_id=1&clip_id=287");
  console.log("ok  draft conversion");

  // Review flags
  const codes = (m) => reviewFlags(m, MEETINGS).map((f) => f.code);
  assert.deepEqual(codes(MEETINGS[1]), ["low-content", "short"]);
  assert.deepEqual(codes(MEETINGS[2]), ["not-council"]);
  assert.deepEqual(codes(MEETINGS[0]), ["same-date"]);
  console.log("ok  review flags");

  // First computer: load, approve, publish
  const a = new ReviewStore(tempDir());
  const first = await a.refresh({ openPublica: fakeOpenPublica, settings: SETTINGS });
  assert.equal(first.added, 4);
  assert.equal(byId(a, "m2").status, "hidden", "test meetings are hidden automatically");
  assert.equal(byId(a, "m1").status, "review");

  a.update("m3", { overview: "" });
  assert.throws(() => a.setStatus("m3", "approved"), /overview/);

  a.setStatus("m1", "approved");
  assert.equal(byId(a, "m1").pending, "add");
  assert.equal(a.view().pendingCount, 1);
  await a.publish(SETTINGS);
  assert.equal(published().meetings.length, 1);
  assert.deepEqual(Object.keys(published().meetings[0]).sort(), [
    "date", "details", "durationMinutes", "id", "overview", "recordingUrl", "title",
  ]);
  assert.equal(a.view().pendingCount, 0);
  console.log("ok  approve and publish");

  // Edits and hiding show as pending changes
  a.update("m1", { overview: "Edited overview." });
  assert.equal(byId(a, "m1").pending, "update");
  a.setStatus("m1", "hidden");
  assert.equal(byId(a, "m1").pending, "remove");
  a.setStatus("m1", "approved");
  await a.publish(SETTINGS);
  assert.equal(published().meetings[0].overview, "Edited overview.");
  console.log("ok  edit, hide, republish");

  // Second computer picks up what is published, then publishes a change
  const b = new ReviewStore(tempDir());
  await b.refresh({ openPublica: fakeOpenPublica, settings: SETTINGS });
  assert.equal(byId(b, "m1").status, "approved");
  assert.equal(byId(b, "m1").draft.overview, "Edited overview.");
  assert.equal(b.view().pendingCount, 0);
  b.update("m4", { overview: "Part two." });
  b.setStatus("m4", "approved");
  await b.publish(SETTINGS);
  assert.equal(published().meetings.length, 2);

  // The first computer must not overwrite that without refreshing first
  a.update("m1", { overview: "Stale edit." });
  await assert.rejects(a.publish(SETTINGS), (e) => e instanceof PublishError && /another computer/.test(e.message));
  await a.refresh({ openPublica: fakeOpenPublica, settings: SETTINGS });
  assert.equal(byId(a, "m4").status, "approved", "adopts the other computer's approval");
  assert.equal(byId(a, "m1").draft.overview, "Stale edit.", "keeps its own unpublished edit");
  await a.publish(SETTINGS);
  assert.equal(published().meetings.length, 2);
  console.log("ok  two computers stay in step");

  // Both computers edit the same meeting: the second to publish must choose
  await b.refresh({ openPublica: fakeOpenPublica, settings: SETTINGS });
  b.update("m1", { overview: "B's version." });
  a.update("m1", { overview: "A's version." });
  await b.publish(SETTINGS);
  await a.refresh({ openPublica: fakeOpenPublica, settings: SETTINGS });
  assert.equal(byId(a, "m1").conflict.website.overview, "B's version.");
  assert.equal(byId(a, "m1").draft.overview, "A's version.", "a conflict never discards local edits");
  await assert.rejects(a.publish(SETTINGS), (e) => e instanceof PublishError && /different version/.test(e.message));
  a.resolveConflict("m1", "website");
  assert.equal(byId(a, "m1").draft.overview, "B's version.");
  assert.equal(byId(a, "m1").pending, null);

  a.update("m1", { overview: "A again." });
  b.setStatus("m1", "hidden");
  await b.publish(SETTINGS);
  await a.refresh({ openPublica: fakeOpenPublica, settings: SETTINGS });
  assert.equal(byId(a, "m1").conflict.website, null, "the other computer removed it");
  a.resolveConflict("m1", "mine");
  await a.publish(SETTINGS);
  assert.equal(published().meetings.find((m) => m.id === "m1").overview, "A again.");
  console.log("ok  conflicting edits are caught");

  // Guard rails
  assert.throws(() => a.update("m1", { overview: " " }), /needs an overview/);
  const wrongBranch = await new ReviewStore(tempDir()).refresh({
    openPublica: fakeOpenPublica,
    settings: { ...SETTINGS, githubBranch: "nope" },
  });
  assert.match(wrongBranch.publishError, /can't find branch "nope"/);
  await assert.rejects(new ReviewStore(tempDir()).publish(SETTINGS), /Check for new meetings first/);
  const corruptDir = tempDir();
  fs.writeFileSync(path.join(corruptDir, "review-state.json"), "{not json");
  new ReviewStore(corruptDir);
  assert.ok(fs.readdirSync(corruptDir).some((f) => f.startsWith("review-state.json.corrupt-")), "damaged state is kept");
  console.log("ok  guard rails");

  console.log(`\nSMOKE TEST PASSED (${github.puts.length} publishes: ${github.puts.join(" | ")})`);
}

main().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
