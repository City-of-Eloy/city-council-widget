"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");

const { OpenPublicaClient, OpenPublicaError } = require("./engine/openpublica");
const { ReviewStore } = require("./engine/review");
const { PublishError } = require("./engine/github");
const { rewriteSummary, RewriteError } = require("./engine/rewrite");
const { loadSettings, saveSettings, publicSettings } = require("./engine/settings");

let mainWindow = null;
let store = null;
let busy = false;

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
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.ELOY_SCREENSHOT, image.toPNG());
      app.quit();
    });
  }
}

function progress(message) {
  if (mainWindow) mainWindow.webContents.send("progress", message);
}

/** Run a long action once at a time, and turn known errors into messages for the screen. */
async function run(action) {
  if (busy) return { ok: false, error: "Another action is still running. Wait for it to finish." };
  busy = true;
  try {
    return { ok: true, ...(await action()) };
  } catch (e) {
    const known = e instanceof OpenPublicaError || e instanceof PublishError || e instanceof RewriteError;
    if (!known) console.error(e);
    return {
      ok: false,
      error: e instanceof OpenPublicaError ? `OpenPublica: ${e.message}` : e.message || String(e),
      needsSettings: Boolean(e.needsToken || e.needsKey),
    };
  } finally {
    busy = false;
    progress("");
  }
}

function snapshot() {
  return { ...store.view(), settings: publicSettings() };
}

ipcMain.handle("state:get", () => snapshot());

ipcMain.handle("meetings:refresh", () =>
  run(async () => {
    const result = await store.refresh({
      openPublica: new OpenPublicaClient(),
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

ipcMain.handle("meeting:rewrite", (_e, id, draft) =>
  run(async () => {
    progress("Loading the meeting transcript…");
    const meeting = await new OpenPublicaClient().getMeeting(id, true);
    progress("Claude is rewriting the summary. This can take a minute or two…");
    const suggestion = await rewriteSummary(meeting, draft, {
      apiKey: loadSettings().anthropicApiKey,
      onProgress: progress,
    });
    return { suggestion };
  })
);

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
  createWindow();
});

app.on("window-all-closed", () => app.quit());
