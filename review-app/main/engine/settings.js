/** Per-user settings stored in the app's userData folder. The API keys and the
 *  GitHub token are encrypted with Electron safeStorage (Windows DPAPI), so a
 *  copied settings.json is useless on another account or computer.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

const DEFAULTS = {
  githubRepo: "City-of-Eloy/city-council-widget",
  githubBranch: "main",
  widgetUrl: "https://city-of-eloy.github.io/city-council-widget/",
};

const TEXT_FIELDS = ["githubRepo", "githubBranch", "widgetUrl"];
const SECRET_FIELDS = ["anthropicApiKey", "deepgramApiKey", "githubToken"];

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeRaw(data) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), "utf-8");
}

function encrypt(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows could not protect the key on this computer, so it was not saved.");
  }
  return safeStorage.encryptString(value).toString("base64");
}

function decrypt(value) {
  if (!value) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return ""; // encrypted under another Windows account; ask for it again
  }
}

/** A message when a pasted key is clearly the wrong one, else null. An empty value removes the key. */
function validateSecret(field, value) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (field === "anthropicApiKey" && !v.startsWith("sk-ant-")) {
    return "That doesn't look like an Anthropic API key. It should start with sk-ant-.";
  }
  if (field === "deepgramApiKey") {
    if (v.startsWith("sk-ant-")) return "That is the Anthropic key. The Deepgram key goes in the Deepgram box.";
    if (v.length < 20 || /\s/.test(v)) return "That doesn't look like a Deepgram API key. Check that the whole key was copied.";
  }
  return null;
}

function loadSettings() {
  const raw = readRaw();
  const settings = {};
  for (const field of TEXT_FIELDS) settings[field] = String(raw[field] || DEFAULTS[field]);
  for (const field of SECRET_FIELDS) settings[field] = decrypt(raw[`${field}Encrypted`]);
  return settings;
}

/** Fields left out of `update` are kept; a secret set to "" is removed. */
function saveSettings(update) {
  for (const field of SECRET_FIELDS) {
    if (update[field] === undefined) continue;
    const problem = validateSecret(field, update[field]);
    if (problem) throw new Error(problem);
  }
  const raw = readRaw();
  for (const field of TEXT_FIELDS) {
    if (update[field] !== undefined) raw[field] = String(update[field]).trim();
  }
  for (const field of SECRET_FIELDS) {
    if (update[field] !== undefined) raw[`${field}Encrypted`] = encrypt(String(update[field]).trim());
  }
  writeRaw(raw);
  return loadSettings();
}

/** What the screens may see: never the secrets themselves. */
function publicSettings(settings = loadSettings()) {
  return {
    githubRepo: settings.githubRepo,
    githubBranch: settings.githubBranch,
    widgetUrl: settings.widgetUrl,
    hasAnthropicApiKey: Boolean(settings.anthropicApiKey),
    hasDeepgramApiKey: Boolean(settings.deepgramApiKey),
    hasGithubToken: Boolean(settings.githubToken),
  };
}

module.exports = { loadSettings, saveSettings, publicSettings, validateSecret };
