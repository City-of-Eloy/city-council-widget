/** Read and publish the widget's data file in the GitHub repository through the
 *  GitHub REST API, so the reviewer's computer needs no git install. Committing
 *  the file triggers the Pages workflow, which updates the live widget.
 */
"use strict";

const DATA_PATH = "widget/data/meetings.json";
const API = "https://api.github.com";

class PublishError extends Error {
  /** needsToken: the screen should send the reviewer to Settings. */
  constructor(message, { needsToken = false } = {}) {
    super(message);
    this.needsToken = needsToken;
  }
}

function repoUrl(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || ""))) {
    throw new PublishError(`"${repo}" is not a GitHub repository name like owner/repo. Check Settings.`, { needsToken: true });
  }
  return `${API}/repos/${repo}`;
}

function contentsUrl(repo) {
  return `${repoUrl(repo)}/contents/${DATA_PATH}`;
}

async function request(url, token, options = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      method: options.method,
      body: options.body,
      headers: {
        Accept: options.accept || "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "eloy-council-review",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new PublishError(`Could not reach GitHub. Check the internet connection, then try again. (${e.message || e})`);
  }
  if (resp.status === 401) {
    throw new PublishError("GitHub rejected the saved token. It may have expired. Paste a new one in Settings.", { needsToken: true });
  }
  if (resp.status === 403 || (resp.status === 404 && options.method === "PUT")) {
    throw new PublishError(
      "The GitHub token can't change the widget repository. It needs Contents: Read and write access to that repository.",
      { needsToken: true }
    );
  }
  return resp;
}

/** The published file and its version id (sha). Missing file -> empty list. */
async function getPublished({ githubRepo, githubBranch, githubToken }) {
  if (!githubToken) throw new PublishError("Add a GitHub token in Settings to publish.", { needsToken: true });
  const ref = `?ref=${encodeURIComponent(githubBranch)}`;
  const resp = await request(contentsUrl(githubRepo) + ref, githubToken);
  if (resp.status === 404) {
    // A 404 also means a wrong repository or branch, or a token that can't see
    // the repository. Only treat the file as missing if the branch is there.
    const branch = await request(`${repoUrl(githubRepo)}/branches/${encodeURIComponent(githubBranch)}`, githubToken);
    if (!branch.ok) {
      throw new PublishError(
        `GitHub can't find branch "${githubBranch}" of ${githubRepo}, or the token can't see that repository. Check Settings.`,
        { needsToken: true }
      );
    }
    return { sha: null, data: { version: 1, updated: null, meetings: [] } };
  }
  if (!resp.ok) throw new PublishError(`GitHub error ${resp.status} reading the published summaries.`);
  const body = await resp.json();
  try {
    let text = Buffer.from(body.content || "", "base64").toString("utf-8");
    if (!text && body.size > 0) {
      // GitHub leaves `content` empty for files over 1 MB; fetch the raw file instead.
      const raw = await request(contentsUrl(githubRepo) + ref, githubToken, { accept: "application/vnd.github.raw+json" });
      if (!raw.ok) throw new PublishError(`GitHub error ${raw.status} reading the published summaries.`);
      text = await raw.text();
    }
    return { sha: body.sha, data: JSON.parse(text) };
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError("The published summaries file on GitHub is not valid JSON. Contact IT before publishing.");
  }
}

/** Replace the published file. `sha` must be the version we last read. */
async function putPublished({ githubRepo, githubBranch, githubToken }, data, sha, message) {
  const resp = await request(contentsUrl(githubRepo), githubToken, {
    method: "PUT",
    body: JSON.stringify({
      message,
      branch: githubBranch,
      content: Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf-8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  if (resp.status === 409) {
    throw new PublishError("The website was updated from another computer since this list was loaded. Click Check for new meetings, then publish again.");
  }
  if (resp.status === 422) {
    throw new PublishError(`GitHub refused the update. Check that branch "${githubBranch}" exists in ${githubRepo}.`, { needsToken: true });
  }
  if (!resp.ok) throw new PublishError(`GitHub error ${resp.status} while publishing.`);
  const body = await resp.json();
  return { sha: body.content && body.content.sha, commitUrl: body.commit && body.commit.html_url };
}

module.exports = { getPublished, putPublished, PublishError, DATA_PATH };
