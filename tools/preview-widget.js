/* Preview the widget locally.
 *
 *   node tools/preview-widget.js            serve widget/ with its real data file
 *   node tools/preview-widget.js --sample   serve it with samples/meetings.sample.json
 *        (any file in the published format, for example a copy of widget/data/meetings.json
 *         with extra meetings; samples/ is kept out of git)
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

function serve(useSample) {
  if (useSample && !fs.existsSync(SAMPLE_FILE)) {
    console.error(`No sample file at ${path.relative(ROOT, SAMPLE_FILE)}. Copy widget/data/meetings.json there and edit it.`);
    process.exit(1);
  }
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

serve(process.argv.slice(2).includes("--sample"));
