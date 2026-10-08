/** Per-user settings stored in the app's userData folder. The Anthropic API key
 *  and GitHub token are encrypted with Electron safeStorage (Windows DPAPI), so
 *  a copied settings.json is useless on another account or computer.
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

const SECRET_FIELDS = ["anthropicApiKey", "githubToken"];

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

function loadSettings() {
  const raw = readRaw();
  const settings = {
    githubRepo: String(raw.githubRepo || DEFAULTS.githubRepo),
    githubBranch: String(raw.githubBranch || DEFAULTS.githubBranch),
    widgetUrl: String(raw.widgetUrl || DEFAULTS.widgetUrl),
  };
  for (const field of SECRET_FIELDS) settings[field] = decrypt(raw[`${field}Encrypted`]);
  return settings;
}

/** Fields left out of `update` are kept; a secret set to "" is removed. */
function saveSettings(update) {
  const raw = readRaw();
  for (const field of ["githubRepo", "githubBranch", "widgetUrl"]) {
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
    hasGithubToken: Boolean(settings.githubToken),
  };
}

module.exports = { loadSettings, saveSettings, publicSettings };
