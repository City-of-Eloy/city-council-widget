/** The review workflow: pull new meetings from OpenPublica, keep each one's
 *  review status and edits on this computer, and publish the approved ones.
 *
 *  The published file on GitHub is the source of truth for what residents see.
 *  Each refresh reads it, so a second reviewer's computer stays in step. A local
 *  edit remembers the published version it started from ("base"); if another
 *  computer publishes a different version meanwhile, the meeting is marked as a
 *  conflict and nothing publishes until the reviewer picks a version.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { toDraft, reviewFlags, publishedRecord, buildPublishedFile } = require("./meetings");
const { getPublished, putPublished, PublishError } = require("./github");

const STATUSES = new Set(["review", "approved", "hidden"]);
const EDITABLE_FIELDS = ["title", "overview", "details", "durationMinutes", "recordingUrl"];

/** Same published content; two missing records also count as the same. */
function sameRecord(a, b) {
  if (!a || !b) return !a && !b;
  return JSON.stringify(publishedRecord(a)) === JSON.stringify(publishedRecord(b));
}

class ReviewStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "review-state.json");
    this.state = this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return { meetings: {}, published: null };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      return { meetings: saved.meetings || {}, published: saved.published || null };
    } catch (e) {
      // Keep the damaged file for IT rather than silently losing unpublished edits.
      fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      console.error("review-state.json was unreadable and has been set aside:", e.message);
      return { meetings: {}, published: null };
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
    fs.renameSync(tmp, this.file);
  }

  _entry(id) {
    const entry = this.state.meetings[id];
    if (!entry) throw new Error(`Unknown meeting ${id}`);
    return entry;
  }

  /** The records currently on the website, by meeting id. */
  _live() {
    const meetings = (this.state.published && this.state.published.data.meetings) || [];
    return new Map(meetings.map((m) => [m.id, m]));
  }

  /** Mark a local edit, remembering the published version it started from. */
  _markChanged(entry) {
    if (!entry.localChange) {
      entry.base = this._live().get(entry.draft.id) || null;
      entry.localChange = true;
    }
  }

  _clearChange(entry) {
    entry.localChange = false;
    delete entry.base;
    delete entry.conflict;
  }

  /** Read the published file and adopt anything another computer published. */
  _syncPublished(published) {
    this.state.published = { sha: published.sha, data: published.data, checkedAt: new Date().toISOString() };
    const live = this._live();
    for (const [id, record] of live) {
      if (!this.state.meetings[id]) {
        this.state.meetings[id] = { status: "approved", flags: [], draft: { ...record }, source: {}, localChange: false };
      }
    }
    for (const entry of Object.values(this.state.meetings)) {
      const record = live.get(entry.draft.id) || null;
      if (entry.localChange) {
        if (sameRecord(record, entry.base)) delete entry.conflict;
        else entry.conflict = { website: record };
      } else if (record) {
        entry.status = "approved";
        entry.draft = { ...entry.draft, ...record };
      } else if (entry.status === "approved") {
        entry.status = "review";
      }
    }
  }

  /** Forget what is on the website, e.g. after the repository is changed in Settings. */
  forgetPublished() {
    this.state.published = null;
    for (const entry of Object.values(this.state.meetings)) {
      if (entry.localChange) entry.base = null;
      delete entry.conflict;
    }
    this._save();
  }

  /** choice "mine": keep this computer's version; "website": take the published one. */
  resolveConflict(id, choice) {
    const entry = this._entry(id);
    const record = this._live().get(id) || null;
    if (choice === "mine") {
      entry.base = record;
      delete entry.conflict;
    } else {
      if (record) {
        entry.draft = { ...entry.draft, ...record };
        entry.status = "approved";
      } else if (entry.status === "approved") {
        entry.status = "review";
      }
      this._clearChange(entry);
    }
    this._save();
  }

  /** Pull new meetings and the published file. Returns { added, publishError }. */
  async refresh({ openPublica, settings, onProgress = () => {} }) {
    let publishError = null;
    if (settings.githubToken) {
      onProgress("Checking what is on the website…");
      try {
        this._syncPublished(await getPublished(settings));
      } catch (e) {
        if (!(e instanceof PublishError)) throw e;
        publishError = e.message;
      }
    }

    onProgress("Checking OpenPublica for new meetings…");
    const listing = await openPublica.listRecentMeetings({ limit: 25 });
    const fresh = listing.filter((m) => !this.state.meetings[m.meeting_id]);
    let added = 0;
    for (const meta of fresh) {
      added += 1;
      onProgress(`Loading new meeting ${added} of ${fresh.length}…`);
      const meeting = { ...meta, ...(await openPublica.getMeeting(meta.meeting_id, false)) };
      const flags = reviewFlags(meeting, listing);
      const { source, ...draft } = toDraft(meeting);
      const autoHidden = flags.some((f) => f.code === "low-content");
      this.state.meetings[meeting.meeting_id] = {
        status: autoHidden ? "hidden" : "review",
        autoHidden,
        flags,
        draft,
        source,
        localChange: false,
      };
      this._save(); // keep progress if the connection drops part way
    }
    // Duplicate-date warnings change as new recordings appear. The listing only
    // has summary previews, so use the full summaries already loaded.
    const known = listing.map((meta) => {
      const entry = this.state.meetings[meta.meeting_id];
      const summary = entry && entry.source && entry.source.summary;
      return summary === undefined ? meta : { ...meta, summary };
    });
    for (const meeting of known) {
      const entry = this.state.meetings[meeting.meeting_id];
      if (entry && meeting.summary !== undefined) entry.flags = reviewFlags(meeting, known);
    }
    this._save();
    return { added, publishError };
  }

  update(id, fields) {
    const entry = this._entry(id);
    const next = { ...entry.draft };
    for (const key of EDITABLE_FIELDS) {
      if (fields[key] !== undefined) next[key] = fields[key];
    }
    if (entry.status === "approved" && !String(next.overview || "").trim()) {
      throw new Error("An approved meeting needs an overview. Add one, or move the meeting back to review first.");
    }
    this._markChanged(entry);
    entry.draft = next;
    this._save();
  }

  setStatus(id, status) {
    if (!STATUSES.has(status)) throw new Error(`Unknown status ${status}`);
    const entry = this._entry(id);
    if (status === "approved" && !String(entry.draft.overview || "").trim()) {
      throw new Error("Add an overview before approving. It's the part residents see first.");
    }
    this._markChanged(entry);
    entry.status = status;
    entry.autoHidden = false;
    this._save();
  }

  /** What publishing would change on the website for one meeting. */
  _pendingChange(entry, live) {
    const record = live.get(entry.draft.id);
    if (entry.status === "approved") {
      if (!record) return "add";
      return sameRecord(entry.draft, record) ? null : "update";
    }
    return record ? "remove" : null;
  }

  view() {
    const live = this._live();
    const meetings = Object.values(this.state.meetings)
      .map((entry) => ({
        id: entry.draft.id,
        status: entry.status,
        autoHidden: Boolean(entry.autoHidden),
        flags: entry.flags || [],
        draft: entry.draft,
        source: entry.source || {},
        onWebsite: live.has(entry.draft.id),
        pending: this._pendingChange(entry, live),
        conflict: entry.conflict ? { website: entry.conflict.website } : null,
      }))
      .sort((a, b) => String(b.draft.date).localeCompare(String(a.draft.date)));
    return {
      meetings,
      pendingCount: meetings.filter((m) => m.pending).length,
      conflictCount: meetings.filter((m) => m.conflict).length,
      publishedCheckedAt: this.state.published ? this.state.published.checkedAt : null,
    };
  }

  /** Publish every approved meeting. Refuses if the website changed since the last refresh. */
  async publish(settings) {
    if (!this.state.published) {
      throw new PublishError("Click Check for new meetings first, so the app knows what is on the website now.");
    }
    const conflicts = Object.values(this.state.meetings).filter((e) => e.conflict);
    if (conflicts.length) {
      const dates = conflicts.map((e) => e.draft.date).sort().join(", ");
      throw new PublishError(
        `Another computer published a different version of ${dates}. Open ${conflicts.length === 1 ? "it" : "each one"} and choose which version to keep, then publish.`
      );
    }
    const current = await getPublished(settings);
    if (current.sha !== this.state.published.sha) {
      throw new PublishError("The website was updated from another computer since this list was loaded. Click Check for new meetings, then publish again.");
    }

    const { meetings } = this.view();
    const approved = meetings.filter((m) => m.status === "approved").map((m) => m.draft);
    const counts = { add: 0, update: 0, remove: 0 };
    for (const m of meetings) if (m.pending) counts[m.pending] += 1;
    const parts = [
      counts.add && `add ${counts.add}`,
      counts.update && `update ${counts.update}`,
      counts.remove && `remove ${counts.remove}`,
    ].filter(Boolean);
    const message = `Publish meeting summaries (${parts.join(", ") || "no changes"})`;

    const data = buildPublishedFile(approved);
    const result = await putPublished(settings, data, current.sha, message);
    this.state.published = { sha: result.sha, data, checkedAt: new Date().toISOString() };
    // Clear only the changes that went out. Anything edited while the upload
    // was running stays pending, measured against what is now on the website.
    const live = this._live();
    for (const entry of Object.values(this.state.meetings)) {
      if (!entry.localChange) continue;
      if (this._pendingChange(entry, live) === null) this._clearChange(entry);
      else entry.base = live.get(entry.draft.id) || null;
    }
    this._save();
    return { ...result, counts };
  }
}

module.exports = { ReviewStore };
