import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, latestHtml } from "../../../widget/render.js";
import widgetCss from "../../../widget/widget.css?raw";
import seal from "../../../widget/eloy_seal.jpeg";

const api = window.review;

const TABS = [
  { status: "review", label: "To review" },
  { status: "approved", label: "Approved" },
  { status: "hidden", label: "Hidden" },
];

const PENDING_LABELS = {
  add: "Approved, not yet on the website",
  update: "Edited since it was published",
  remove: "Will be removed from the website",
};

const STATUS_LABELS = { review: "Needs review", approved: "Approved", hidden: "Hidden" };

function fieldsOf(draft) {
  return {
    title: draft.title || "",
    overview: draft.overview || "",
    details: draft.details || "",
    recordingUrl: draft.recordingUrl || "",
  };
}

function Preview({ draft }) {
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><style>${widgetCss}</style></head>
    <body><main class="ecw">${latestHtml(draft, { open: true })}</main></body></html>`;
  return (
    <iframe
      className="preview-frame"
      title="Website preview"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
    />
  );
}

function Settings({ settings, onClose, onSaved }) {
  const [form, setForm] = useState({
    githubRepo: settings.githubRepo,
    githubBranch: settings.githubBranch,
    widgetUrl: settings.widgetUrl,
    githubToken: "",
    anthropicApiKey: "",
  });
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function save() {
    const update = { githubRepo: form.githubRepo, githubBranch: form.githubBranch, widgetUrl: form.widgetUrl };
    if (form.githubToken.trim()) update.githubToken = form.githubToken;
    if (form.anthropicApiKey.trim()) update.anthropicApiKey = form.anthropicApiKey;
    const result = await api.saveSettings(update);
    if (!result.ok) return setError(result.error);
    onSaved(result.state);
  }

  async function remove(key) {
    const result = await api.saveSettings({ [key]: "" });
    if (result.ok) onSaved(result.state, true);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal">
        <h2 id="settings-title">Settings</h2>

        <h3>Publishing to the website</h3>
        <label>
          GitHub repository
          <input value={form.githubRepo} onChange={set("githubRepo")} placeholder="owner/repo" />
        </label>
        <label>
          Branch
          <input value={form.githubBranch} onChange={set("githubBranch")} />
        </label>
        <label>
          GitHub token {settings.hasGithubToken && <span className="saved">saved</span>}
          <input
            type="password"
            value={form.githubToken}
            onChange={set("githubToken")}
            placeholder={settings.hasGithubToken ? "Leave blank to keep the saved token" : "github_pat_…"}
          />
        </label>
        <p className="hint">
          Use a fine-grained token limited to this one repository with <strong>Contents: Read and write</strong>. IT can
          provide it.
          {settings.hasGithubToken && (
            <>
              {" "}
              <button className="link-button" onClick={() => remove("githubToken")}>
                Remove saved token
              </button>
            </>
          )}
        </p>
        <label>
          Widget web address
          <input value={form.widgetUrl} onChange={set("widgetUrl")} />
        </label>

        <h3>Plain-language rewrite (optional)</h3>
        <label>
          Anthropic API key {settings.hasAnthropicApiKey && <span className="saved">saved</span>}
          <input
            type="password"
            value={form.anthropicApiKey}
            onChange={set("anthropicApiKey")}
            placeholder={settings.hasAnthropicApiKey ? "Leave blank to keep the saved key" : "sk-ant-…"}
          />
        </label>
        <p className="hint">
          Only needed for the "Rewrite in plain language" button.
          {settings.hasAnthropicApiKey && (
            <>
              {" "}
              <button className="link-button" onClick={() => remove("anthropicApiKey")}>
                Remove saved key
              </button>
            </>
          )}
        </p>
        <p className="hint">Keys are encrypted for your Windows account and stay on this computer.</p>

        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Editor({ meeting, onState, setNotice, busy, setBusy, onDirty }) {
  const [fields, setFields] = useState(() => fieldsOf(meeting.draft));
  const [beforeRewrite, setBeforeRewrite] = useState(null);
  const saved = useMemo(() => fieldsOf(meeting.draft), [meeting.draft]);
  const dirty = JSON.stringify(fields) !== JSON.stringify(saved);
  const draft = { ...meeting.draft, ...fields };
  const set = (key) => (e) => {
    const value = e.target.value;
    setFields((f) => ({ ...f, [key]: value }));
  };

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // When the saved draft changes underneath (e.g. "Check for new meetings" adopted
  // another computer's published edit), follow it, unless the reviewer has edits.
  const savedJson = JSON.stringify(saved);
  const lastSaved = useRef(savedJson);
  useEffect(() => {
    const previous = lastSaved.current;
    lastSaved.current = savedJson;
    setFields((f) => (JSON.stringify(f) === previous ? saved : f));
  }, [savedJson]); // eslint-disable-line react-hooks/exhaustive-deps

  async function persist() {
    const result = await api.save(meeting.id, fields);
    if (!result.ok) {
      setNotice({ kind: "error", text: result.error });
      return false;
    }
    onState(result.state);
    return true;
  }

  async function save() {
    if (!(await persist())) return;
    setBeforeRewrite(null);
    setNotice({ kind: "ok", text: "Changes saved." });
  }

  async function resolve(choice) {
    if (choice === "mine" && dirty && !(await persist())) return;
    const result = await api.resolveConflict(meeting.id, choice);
    if (!result.ok) return setNotice({ kind: "error", text: result.error });
    if (choice === "website") setFields(fieldsOf({ ...meeting.draft, ...(meeting.conflict.website || {}) }));
    onState(result.state);
    setNotice({
      kind: "ok",
      text: choice === "mine" ? "Keeping your version. Publish when you're ready." : "Switched to the version on the website.",
    });
  }

  async function setStatus(status) {
    // Approving checks the saved overview, so save first. Moving away from
    // Approved changes the status first, so an empty overview can still be saved.
    if (status === "approved" && dirty && !(await persist())) return;
    const result = await api.setStatus(meeting.id, status);
    if (!result.ok) return setNotice({ kind: "error", text: result.error });
    onState(result.state);
    if (status !== "approved" && dirty && !(await persist())) return;
    setBeforeRewrite(null);
    const done = {
      approved: "Approved. Click Publish to website when you're ready.",
      hidden: "Hidden. It won't appear on the website.",
      review: "Moved back to To review.",
    };
    setNotice({ kind: "ok", text: done[status] });
  }

  async function rewrite() {
    setBusy(true);
    const result = await api.rewrite(meeting.id, draft);
    setBusy(false);
    if (!result.ok) return setNotice({ kind: "error", text: result.error, settings: result.needsSettings });
    // The fields are locked while Claude works, so `fields` is still current here.
    setBeforeRewrite(fields);
    setFields({ ...fields, overview: result.suggestion.overview, details: result.suggestion.details });
    setNotice({
      kind: "ok",
      text: "Claude's suggestion is in the overview and details. Check it against the original, edit as needed, then save.",
    });
  }

  return (
    <section className="editor" aria-label="Edit summary">
      <header className="editor-head">
        <div>
          <h2>{formatDate(meeting.draft.date)}</h2>
          <p className="muted">{meeting.source.title || meeting.draft.title}</p>
        </div>
        <div className="head-right">
          <span className={`pill pill-${meeting.status}`}>{STATUS_LABELS[meeting.status]}</span>
          {meeting.onWebsite && <span className="pill pill-live">On the website</span>}
        </div>
      </header>

      {meeting.flags.length > 0 && (
        <ul className="flags">
          {meeting.flags.map((f) => (
            <li key={f.code}>{f.message}</li>
          ))}
        </ul>
      )}

      {meeting.conflict && (
        <div className="conflict" role="alert">
          <p>
            <strong>Another computer published a different version of this meeting</strong>
            {meeting.conflict.website ? "." : ": it was removed from the website."} Choose which one to keep. Nothing
            publishes until you do.
          </p>
          {meeting.conflict.website && (
            <details>
              <summary>See the version on the website</summary>
              <pre>{[meeting.conflict.website.overview, meeting.conflict.website.details].join("\n\n")}</pre>
            </details>
          )}
          <div className="conflict-actions">
            <button onClick={() => resolve("website")} disabled={busy}>
              {meeting.conflict.website ? "Use the website version" : "Accept the removal"}
            </button>
            <button className="primary" onClick={() => resolve("mine")} disabled={busy}>
              Keep my version
            </button>
          </div>
        </div>
      )}

      <div className="editor-grid">
        <fieldset className="fields" disabled={busy}>
          <label>
            Meeting type
            <input value={fields.title} onChange={set("title")} />
          </label>
          <label>
            Overview <span className="muted">(always visible; two or three sentences)</span>
            <textarea rows={5} value={fields.overview} onChange={set("overview")} />
          </label>
          <label>
            Full summary <span className="muted">(shown under "Read the full summary")</span>
            <textarea className="tall" rows={16} value={fields.details} onChange={set("details")} />
          </label>
          <p className="hint">
            Formatting: <code>### Heading</code>, <code>- bullet</code>, <code>1. numbered</code>, <code>**bold**</code>
          </p>
          <label>
            Video link
            <input value={fields.recordingUrl} onChange={set("recordingUrl")} placeholder="https://…" />
          </label>

          {meeting.source.summary && (
            <details className="original">
              <summary>Original OpenPublica summary</summary>
              <pre>{meeting.source.summary}</pre>
            </details>
          )}
        </fieldset>

        <div className="preview">
          <p className="preview-label">How it will look on the website</p>
          <Preview draft={draft} />
        </div>
      </div>

      <footer className="editor-actions">
        <button onClick={rewrite} disabled={busy}>
          Rewrite in plain language with Claude
        </button>
        {beforeRewrite && (
          <button
            onClick={() => {
              setFields(beforeRewrite);
              setBeforeRewrite(null);
            }}
          >
            Undo rewrite
          </button>
        )}
        <span className="spacer" />
        <button onClick={save} disabled={!dirty || busy}>
          Save changes
        </button>
        {meeting.status !== "review" && (
          <button onClick={() => setStatus("review")} disabled={busy}>
            Move back to review
          </button>
        )}
        {meeting.status !== "hidden" && (
          <button onClick={() => setStatus("hidden")} disabled={busy}>
            Hide
          </button>
        )}
        {(meeting.status !== "approved" || dirty) && (
          <button className="primary" onClick={() => setStatus("approved")} disabled={busy}>
            {meeting.status === "approved" ? "Save and keep approved" : "Approve"}
          </button>
        )}
      </footer>
    </section>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("review");
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const dirtyRef = useRef(false);
  const onDirty = useRef((value) => {
    dirtyRef.current = value;
  }).current;

  useEffect(() => {
    api.getState().then(setState);
    return api.onProgress(setProgress);
  }, []);

  if (!state) return null;

  const byTab = (status) => state.meetings.filter((m) => m.status === status);
  const list = byTab(tab);
  const selected = state.meetings.find((m) => m.id === selectedId) || null;
  const canPublish = state.settings.hasGithubToken && state.pendingCount > 0 && !busy;

  async function refresh() {
    setBusy(true);
    setNotice(null);
    const result = await api.refresh();
    setBusy(false);
    if (!result.ok) return setNotice({ kind: "error", text: result.error, settings: result.needsSettings });
    setState(result.state);
    if (result.publishError) return setNotice({ kind: "error", text: result.publishError, settings: true });
    setNotice({
      kind: "ok",
      text: result.added ? `Loaded ${result.added} new meeting${result.added === 1 ? "" : "s"}.` : "No new meetings.",
    });
  }

  async function publish() {
    const changes = state.meetings.filter((m) => m.pending);
    const lines = changes.map((m) => `• ${formatDate(m.draft.date, "short")}: ${PENDING_LABELS[m.pending]}`);
    if (!window.confirm(`Publish these changes to the City website?\n\n${lines.join("\n")}`)) return;
    setBusy(true);
    const result = await api.publish();
    setBusy(false);
    if (!result.ok) return setNotice({ kind: "error", text: result.error, settings: result.needsSettings });
    setState(result.state);
    setNotice({
      kind: "ok",
      text: "Published. The website updates within a few minutes.",
      link: state.settings.widgetUrl,
    });
  }

  function select(id) {
    if (id === selectedId || busy) return;
    if (dirtyRef.current && !window.confirm("You have unsaved changes to this summary. Discard them?")) return;
    dirtyRef.current = false;
    setSelectedId(id);
    setNotice(null);
  }

  return (
    <div className="app">
      <header className="topbar">
        <img src={seal} alt="" width="36" height="36" />
        <h1>Council Summaries</h1>
        <span className="progress" aria-live="polite">
          {progress}
        </span>
        <button onClick={refresh} disabled={busy}>
          Check for new meetings
        </button>
        <button className="primary" onClick={publish} disabled={!canPublish}>
          Publish to website{state.pendingCount ? ` (${state.pendingCount})` : ""}
        </button>
        <button onClick={() => setShowSettings(true)}>Settings</button>
      </header>

      {!state.settings.hasGithubToken && (
        <p className="banner">
          Publishing isn't set up on this computer yet.{" "}
          <button className="link-button" onClick={() => setShowSettings(true)}>
            Add the GitHub token in Settings
          </button>
        </p>
      )}
      {notice && (
        <p className={`banner banner-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}{" "}
          {notice.settings && (
            <button className="link-button" onClick={() => setShowSettings(true)}>
              Open Settings
            </button>
          )}
          {notice.link && (
            <button className="link-button" onClick={() => api.openExternal(notice.link)}>
              View the widget
            </button>
          )}
        </p>
      )}

      <div className="main">
        <nav className="sidebar" aria-label="Meetings">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.status}
                role="tab"
                aria-selected={tab === t.status}
                className={tab === t.status ? "tab active" : "tab"}
                onClick={() => setTab(t.status)}
              >
                {t.label} <span className="count">{byTab(t.status).length}</span>
              </button>
            ))}
          </div>
          {list.length === 0 && (
            <p className="empty">
              {state.meetings.length === 0
                ? "Click Check for new meetings to load meetings from OpenPublica."
                : "Nothing here."}
            </p>
          )}
          <ul className="meeting-list">
            {list.map((m) => (
              <li key={m.id}>
                <button className={m.id === selectedId ? "meeting active" : "meeting"} onClick={() => select(m.id)}>
                  <span className="meeting-date">{formatDate(m.draft.date, "short")}</span>
                  <span className="meeting-title">{m.source.title || m.draft.title}</span>
                  <span className="meeting-badges">
                    {m.conflict && <span className="badge badge-conflict">Choose a version</span>}
                    {m.flags.length > 0 && !m.autoHidden && <span className="badge badge-warn">Check</span>}
                    {m.pending && <span className="badge badge-pending">{PENDING_LABELS[m.pending]}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {selected ? (
          <Editor
            key={selected.id}
            meeting={selected}
            onState={setState}
            setNotice={setNotice}
            busy={busy}
            setBusy={setBusy}
            onDirty={onDirty}
          />
        ) : (
          <section className="editor editor-empty">
            <p>Choose a meeting on the left to review its summary.</p>
          </section>
        )}
      </div>

      {showSettings && (
        <Settings
          settings={state.settings}
          onClose={() => setShowSettings(false)}
          onSaved={(next, stayOpen) => {
            setState(next);
            if (!stayOpen) {
              setShowSettings(false);
              setNotice({ kind: "ok", text: "Settings saved." });
            }
          }}
        />
      )}
    </div>
  );
}
