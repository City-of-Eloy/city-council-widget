"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");

const granicus = require("./engine/granicus");
const { cleanupTemp } = require("./engine/media");
const transcripts = require("./engine/transcripts");
const { summarizeClip } = require("./engine/pipeline");
const { ReviewStore } = require("./engine/review");
const { FriendlyError, CancelledError, isAbortError } = require("./engine/errors");
const { loadSettings, saveSettings, publicSettings } = require("./engine/settings");

let mainWindow = null;
let store = null;
let busy = false;
let currentJob = null; // { controller, id } while a summary is being written
let listingCache = null; // { at, meetings }
const LISTING_TTL_MS = 10 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Bundled files (keyterms.txt): next to app.asar when packaged, review-app/resources in development. */
function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
}

/** Transcripts go to Documents\Eloy Minutes\Transcripts, the folder the City
 *  Clerk's Eloy Minutes app uses, so a meeting is transcribed (and paid for) once. */
function outputDir() {
  return path.join(app.getPath("documents"), "Eloy Minutes");
}

function tempDir() {
  return path.join(app.getPath("temp"), "eloy-minutes");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: "Eloy Council Summaries",
    autoHideMenuBar: true,
    backgroundColor: "#f4f2ec",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));

  // Links (including ones inside the preview) open in the browser, never in the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Dev helper: ELOY_SCREENSHOT=<file.png> captures the window and exits.
  if (process.env.ELOY_SCREENSHOT) {
    mainWindow.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.ELOY_SCREENSHOT_DELAY) || 2500));
      // ELOY_SCREENSHOT_CLICK="<css selector>|<css selector>…" clicks those in order first
      // (for example the first meeting, then its View transcript link).
      for (const selector of (process.env.ELOY_SCREENSHOT_CLICK || "").split("|").filter(Boolean)) {
        await mainWindow.webContents.executeJavaScript(
          `[...document.querySelectorAll(${JSON.stringify(selector.replace(/:text\(.*\)$/, ""))})]` +
            `.find((el) => ${JSON.stringify((selector.match(/:text\((.*)\)$/) || [])[1] || "")} === "" || el.textContent.trim() === ${JSON.stringify((selector.match(/:text\((.*)\)$/) || [])[1] || "")})?.click()`
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.ELOY_SCREENSHOT, image.toPNG());
      app.quit();
    });
  }
}

function progress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("progress", message);
}

async function getListing({ force = false, signal } = {}) {
  if (!force && listingCache && Date.now() - listingCache.at < LISTING_TTL_MS) return listingCache.meetings;
  const meetings = await granicus.listMeetings({ signal });
  listingCache = { at: Date.now(), meetings };
  return meetings;
}

/** "Transcript on file" details for the editor, or null. */
function transcriptInfo(index, clipId) {
  const file = clipId ? index.get(clipId) : null;
  if (!file) return null;
  let savedAt = null;
  try {
    savedAt = new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    /* removed between listing and stat */
  }
  return { name: path.basename(file), savedAt };
}

function snapshot() {
  const view = store.view();
  const index = transcripts.indexTranscripts(path.join(outputDir(), "Transcripts"));
  return {
    ...view,
    meetings: view.meetings.map((m) => ({ ...m, transcript: transcriptInfo(index, m.clipId) })),
    settings: publicSettings(),
    job: currentJob ? { id: currentJob.id } : null,
  };
}

/** Turn an error into what the screen shows. */
function failure(e) {
  if (e instanceof FriendlyError) {
    return { ok: false, error: e.message, cancelled: e.cancelled, needsSettings: e.needsKey, keyKind: e.keyKind };
  }
  console.error(e);
  return { ok: false, error: e.message || String(e) };
}

/** Run a long action once at a time. */
async function run(action) {
  if (busy) return { ok: false, error: "Another action is still running. Wait for it to finish." };
  busy = true;
  try {
    return { ok: true, ...(await action()) };
  } catch (e) {
    return failure(e);
  } finally {
    busy = false;
    progress("");
  }
}

ipcMain.handle("state:get", () => snapshot());

ipcMain.handle("meetings:refresh", () =>
  run(async () => {
    const result = await store.refresh({
      granicus: { listMeetings: () => getListing({ force: true }) },
      settings: loadSettings(),
      onProgress: progress,
    });
    return { ...result, state: snapshot() };
  })
);

/** Quick edits to the review state. Refused while a publish is uploading, so
 *  nothing changes between what was sent and what is marked as published. */
function edit(change) {
  if (busy) return { ok: false, error: "Wait for the current action to finish, then try again." };
  try {
    change();
    return { ok: true, state: snapshot() };
  } catch (e) {
    console.error(e);
    return { ok: false, error: e.message };
  }
}

ipcMain.handle("meeting:save", (_e, id, fields) => edit(() => store.update(id, fields)));
ipcMain.handle("meeting:status", (_e, id, status) => edit(() => store.setStatus(id, status)));
ipcMain.handle("meeting:resolve", (_e, id, choice) => edit(() => store.resolveConflict(id, choice)));

/** Write (or rewrite) one meeting's summary: Granicus audio -> transcript -> Claude. */
ipcMain.handle("meeting:summarize", (_e, id, draft, options) =>
  run(async () => {
    const meeting = store.view().meetings.find((m) => m.id === id);
    if (!meeting) throw new FriendlyError("That meeting is no longer in the list. Click Check for new meetings.");
    if (!meeting.clipId) throw new FriendlyError("This meeting has no Granicus recording to summarize.");

    const controller = new AbortController();
    currentJob = { controller, id };
    try {
      progress("Looking up the recording on Granicus…");
      let listing = null;
      try {
        listing = await getListing({ signal: controller.signal });
      } catch {
        listing = null; // the player page alone is enough
      }
      const clip = await granicus.resolveClip(meeting.clipId, { listing, signal: controller.signal });
      const fields = draft && typeof draft === "object" ? draft : meeting.draft;
      if (DATE.test(String(fields.date || ""))) clip.date = fields.date; // the reviewer's date wins

      const settings = loadSettings();
      const result = await summarizeClip({
        clip,
        draft: fields,
        retranscribe: Boolean(options && options.retranscribe),
        keys: { anthropic: settings.anthropicApiKey, deepgram: settings.deepgramApiKey },
        dirs: { output: outputDir(), temp: tempDir(), reference: resourcesDir() },
        onProgress: (p) => progress(p.text),
        signal: controller.signal,
      });
      currentJob = null;
      return {
        suggestion: { overview: result.overview, details: result.details },
        transcriptReused: result.transcriptReused,
        agendaUsed: result.agendaUsed,
        state: snapshot(),
      };
    } catch (e) {
      // A cancel can surface as a raw AbortError from a body read; report it as a cancel.
      if (controller.signal.aborted || isAbortError(e)) throw new CancelledError();
      throw e;
    } finally {
      currentJob = null;
    }
  })
);

ipcMain.handle("meeting:cancel", () => {
  if (!currentJob) return { ok: false };
  currentJob.controller.abort();
  return { ok: true };
});

/** The saved transcript file for a meeting, or null. Only files in the app's own Transcripts folder. */
function transcriptFor(id) {
  const meeting = store.view().meetings.find((m) => m.id === id);
  const dir = path.join(outputDir(), "Transcripts");
  return meeting && meeting.clipId ? transcripts.findTranscript(dir, meeting.clipId) : null;
}

/** The transcript for the in-app viewer: header lines, body, and the Granicus player link. */
ipcMain.handle("transcript:read", (_e, id) => {
  const file = transcriptFor(id);
  if (!file) return { ok: false, error: "No transcript is saved for this meeting yet." };
  try {
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    const rule = lines.indexOf("----");
    const header = rule >= 0 ? lines.slice(0, rule).filter(Boolean) : [];
    const body = (rule >= 0 ? lines.slice(rule + 1) : lines).join("\n").trim();
    const clipM = path.basename(file).match(/\(clip (\d+)\)\.txt$/i);
    const clipId = clipM ? Number(clipM[1]) : null;
    return {
      ok: true,
      name: path.basename(file),
      header,
      body,
      clipId,
      playerUrl: clipId ? `${granicus.SITE}/player/clip/${clipId}?view_id=1` : null,
    };
  } catch (e) {
    return { ok: false, error: `The transcript could not be read (${e.message || e}).` };
  }
});

ipcMain.handle("transcript:open", async (_e, id) => {
  const file = transcriptFor(id);
  if (!file) return { ok: false, error: "No transcript is saved for this meeting yet." };
  const err = await shell.openPath(file);
  return { ok: !err, error: err || undefined };
});

ipcMain.handle("transcript:showInFolder", (_e, id) => {
  const file = transcriptFor(id);
  if (!file) return { ok: false };
  shell.showItemInFolder(file);
  return { ok: true };
});

ipcMain.handle("publish", () =>
  run(async () => {
    progress("Publishing to the website…");
    const result = await store.publish(loadSettings());
    return { result, state: snapshot() };
  })
);

ipcMain.handle("settings:save", (_e, update) =>
  edit(() => {
    const before = loadSettings();
    const after = saveSettings(update);
    // A different repository or branch is a different website file.
    if (after.githubRepo !== before.githubRepo || after.githubBranch !== before.githubBranch) store.forgetPublished();
  })
);

ipcMain.handle("open:external", (_e, url) => {
  if (/^https:\/\//i.test(String(url))) shell.openExternal(url);
});

// Dev helper: ELOY_USER_DATA=<folder> keeps test runs away from the real review state and keys.
if (process.env.ELOY_USER_DATA) app.setPath("userData", process.env.ELOY_USER_DATA);

app.whenReady().then(() => {
  store = new ReviewStore(app.getPath("userData"));
  cleanupTemp(tempDir());
  createWindow();
});

app.on("before-quit", () => {
  // Stop a running download so ffmpeg does not keep going after the window closes.
  if (currentJob) currentJob.controller.abort();
});

app.on("window-all-closed", () => app.quit());
