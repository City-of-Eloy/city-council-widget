/** HTML for the meeting summaries widget. Shared by the website widget and the
 *  staff review app's preview, so reviewers see exactly what residents will see.
 */
import { escapeHtml, renderMarkdown } from "./markdown.js";

export const ARCHIVE_URL = "https://eloyaz.granicus.com/ViewPublisher.php?view_id=1";

function parseDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function formatDate(iso, style = "long") {
  const options =
    style === "long"
      ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return parseDate(iso).toLocaleDateString("en-US", options);
}

function safeUrl(url) {
  return /^https:\/\//i.test(String(url || "")) ? escapeHtml(url) : "";
}

function durationHtml(m) {
  return m.durationMinutes ? `${Number(m.durationMinutes)} minutes` : "";
}

function topicsHtml(m) {
  const topics = Array.isArray(m.topics) ? m.topics.filter(Boolean) : [];
  if (!topics.length) return "";
  return `<ul class="ecw-topics" aria-label="Topics">${topics
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("")}</ul>`;
}

function actionsHtml(m) {
  const watch = safeUrl(m.recordingUrl);
  if (!watch) return "";
  return `<p class="ecw-actions"><a class="ecw-link" href="${watch}" target="_blank" rel="noopener noreferrer">Watch the meeting<span class="ecw-sr"> (opens in a new tab)</span></a></p>`;
}

function detailsHtml(m, open = false) {
  if (!String(m.details || "").trim()) return "";
  return `<details class="ecw-full"${open ? " open" : ""}><summary>Read the full summary</summary><div class="ecw-md">${renderMarkdown(
    m.details
  )}</div></details>`;
}

/** The featured card for the most recent meeting. */
export function latestHtml(m, { open = false } = {}) {
  const meta = [escapeHtml(m.title || "City Council Meeting"), durationHtml(m)].filter(Boolean).join(" · ");
  return `<article class="ecw-latest" aria-labelledby="ecw-latest-date">
    <p class="ecw-eyebrow">Latest meeting</p>
    <h2 class="ecw-date" id="ecw-latest-date">${formatDate(m.date)}</h2>
    <p class="ecw-meta">${meta}</p>
    <div class="ecw-md ecw-overview">${renderMarkdown(m.overview)}</div>
    ${topicsHtml(m)}
    ${detailsHtml(m, open)}
    ${actionsHtml(m)}
  </article>`;
}

/** One expandable row in the "Earlier meetings" list. */
export function rowHtml(m) {
  const duration = durationHtml(m);
  return `<li><details class="ecw-row">
    <summary>
      <span class="ecw-row-date">${formatDate(m.date, "short")}</span>
      <span class="ecw-row-title">${escapeHtml(m.title || "City Council Meeting")}</span>
    </summary>
    <div class="ecw-row-body">
      ${duration ? `<p class="ecw-meta">${duration}</p>` : ""}
      <div class="ecw-md ecw-overview">${renderMarkdown(m.overview)}</div>
      ${topicsHtml(m)}
      ${detailsHtml(m)}
      ${actionsHtml(m)}
    </div>
  </details></li>`;
}

export function footerHtml(updated) {
  const when = updated ? ` Updated ${formatDate(String(updated).slice(0, 10), "short")}.` : "";
  return `<footer class="ecw-footer">
    <p>These summaries are provided for convenience and are not the official minutes.
    Official minutes are approved by the City Council.${when}</p>
    <p><a class="ecw-link" href="${ARCHIVE_URL}" target="_blank" rel="noopener noreferrer">Agendas, minutes, and video archive<span class="ecw-sr"> (opens in a new tab)</span></a></p>
  </footer>`;
}

/** Meetings the widget will show, newest first. */
export function visibleMeetings(data, count) {
  return (Array.isArray(data && data.meetings) ? data.meetings : [])
    .filter((m) => m && m.date && m.overview)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, count);
}

/** Everything below the widget header. */
export function contentHtml(data, count) {
  const meetings = visibleMeetings(data, count);
  if (!meetings.length) {
    return `<p class="ecw-status">No meeting summaries have been posted yet.</p>${footerHtml(data && data.updated)}`;
  }
  const [latest, ...earlier] = meetings;
  return (
    latestHtml(latest) +
    (earlier.length
      ? `<section class="ecw-recent" aria-labelledby="ecw-recent-title">
          <h2 class="ecw-section-title" id="ecw-recent-title">Earlier meetings</h2>
          <ul class="ecw-list">${earlier.map(rowHtml).join("")}</ul>
        </section>`
      : "") +
    footerHtml(data.updated)
  );
}

export function errorHtml() {
  return `<p class="ecw-status">Meeting summaries can't be loaded right now.</p>${footerHtml()}`;
}
