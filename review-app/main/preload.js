"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("review", {
  getState: () => ipcRenderer.invoke("state:get"),
  refresh: () => ipcRenderer.invoke("meetings:refresh"),
  save: (id, fields) => ipcRenderer.invoke("meeting:save", id, fields),
  setStatus: (id, status) => ipcRenderer.invoke("meeting:status", id, status),
  resolveConflict: (id, choice) => ipcRenderer.invoke("meeting:resolve", id, choice),
  /** options: { retranscribe } */
  summarize: (id, draft, options) => ipcRenderer.invoke("meeting:summarize", id, draft, options),
  cancel: () => ipcRenderer.invoke("meeting:cancel"),
  readTranscript: (id) => ipcRenderer.invoke("transcript:read", id),
  openTranscript: (id) => ipcRenderer.invoke("transcript:open", id),
  showTranscriptInFolder: (id) => ipcRenderer.invoke("transcript:showInFolder", id),
  publish: () => ipcRenderer.invoke("publish"),
  saveSettings: (update) => ipcRenderer.invoke("settings:save", update),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  onProgress: (callback) => {
    const listener = (_e, message) => callback(message);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },
});
