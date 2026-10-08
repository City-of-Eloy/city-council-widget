/* Preview the widget locally.
 *
 *   node tools/preview-widget.js            serve widget/ with its real data file
 *   node tools/preview-widget.js --sample   serve it with samples/meetings.sample.json
 *   node tools/preview-widget.js --refresh-sample
 *        rebuild the sample from live OpenPublica meetings (unreviewed; never published)
 *
 * Then open http://localhost:5180/
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WIDGET_DIR = path.join(ROOT, "widget");
const SAMPLE_FILE = path.join(ROOT, "samples", "meetings.sample.json");
const PORT = Number(process.env.PORT) || 5180;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

async function refreshSample() {
  const { OpenPublicaClient } = require("../review-app/main/engine/openpublica");
  const { toDraft, reviewFlags, buildPublishedFile } = require("../review-app/main/engine/meetings");
  const client = new OpenPublicaClient();
  const listing = await client.listRecentMeetings({ limit: 25 });
  const drafts = [];
  const seenDates = new Set();
  for (const meta of listing) {
    if (seenDates.has(meta.date)) continue;
    const meeting = { ...meta, ...(await client.getMeeting(meta.meeting_id, false)) };
    const flags = reviewFlags(meeting, []);
    if (flags.length) {
      console.log(`  skip  ${meeting.date}  ${flags[0].message}`);
      continue;
    }
    seenDates.add(meeting.date);
    drafts.push(toDraft(meeting));
    console.log(`  keep  ${meeting.date}  ${meeting.title}`);
    if (drafts.length >= 6) break;
  }
  fs.mkdirSync(path.dirname(SAMPLE_FILE), { recursive: true });
  fs.writeFileSync(SAMPLE_FILE, JSON.stringify(buildPublishedFile(drafts), null, 2) + "\n");
  console.log(`Wrote ${drafts.length} meetings to ${path.relative(ROOT, SAMPLE_FILE)}`);
}

function serve(useSample) {
  http
    .createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      let file =
        useSample && urlPath === "/data/meetings.json"
          ? SAMPLE_FILE
          : path.join(WIDGET_DIR, urlPath === "/" ? "index.html" : urlPath);
      if (!file.startsWith(WIDGET_DIR) && file !== SAMPLE_FILE) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(file, (err, body) => {
        if (err) {
          res.writeHead(404).end("Not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(body);
      });
    })
    .listen(PORT, () => {
      console.log(`Widget preview${useSample ? " (sample data)" : ""}: http://localhost:${PORT}/`);
    });
}

const args = process.argv.slice(2);
if (args.includes("--refresh-sample")) {
  refreshSample().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
} else {
  serve(args.includes("--sample"));
}
