/** City of Eloy City Council meeting summaries widget.
 *  Reads the approved summaries in data/meetings.json (written by the staff
 *  review app) and renders the latest meeting plus a list of earlier ones.
 *  Optional query string: ?count=N (meetings shown, 1–25, default 6).
 */
import { contentHtml, errorHtml } from "./render.js";

const DATA_URL = "data/meetings.json";

const params = new URLSearchParams(location.search);
const COUNT = Math.min(25, Math.max(1, parseInt(params.get("count"), 10) || 6));

const widget = document.getElementById("ecw");
const content = document.getElementById("ecw-content");

// When the host page includes embed.js, it resizes the iframe to fit the widget.
// Measure the widget itself, not the document, which never reports less than
// the iframe's current height and so could never shrink.
let lastHeight = 0;
function reportHeight() {
  if (window.parent === window) return;
  const height = Math.ceil(widget.getBoundingClientRect().height);
  if (height === lastHeight) return;
  lastHeight = height;
  window.parent.postMessage({ type: "eloy-council-widget:height", height }, "*");
}

new ResizeObserver(reportHeight).observe(widget);
document.addEventListener("toggle", reportHeight, true);

fetch(DATA_URL, { cache: "no-cache" })
  .then((resp) => {
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  })
  .then((data) => {
    content.innerHTML = contentHtml(data, COUNT);
  })
  .catch(() => {
    content.innerHTML = errorHtml();
  })
  .finally(reportHeight);
