import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, latestHtml } from "../../../widget/render.js";
import widgetCss from "../../../widget/widget.css?raw";
import seal from "./assets/eloy_seal.jpeg";
import { parseTranscript, speakerClass } from "./transcript.js";

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

// Length targets, matching what Claude is asked for.
const OVERVIEW_WORDS = 45;
const DETAILS_WORDS = 200;

function WordCount({ text, limit }) {
  const words = (String(text).replace(/[#*_\-[\]()]/g, " ").match(/\S+/g) || []).length;
  return (
    <span className={words > limit ? "word-count over" : "word-count"}>
      {words} / {limit} words
    </span>
  );
}

function fieldsOf(draft) {
  return {
    date: draft.date || "",
    title: draft.title || "",
    overview: draft.overview || "",
    details: draft.details || "",
    recordingUrl: draft.recordingUrl || "",
  };
}

function hasSummary(fields) {
  return Boolean(String(fields.overview).trim() || String(fields.details).trim());
}

function shortDate(iso) {
  return formatDate(iso, "short") || "Date needed";
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
    deepgramApiKey: "",
  });
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function save() {
    const update = { githubRepo: form.githubRepo, githubBranch: form.githubBranch, widgetUrl: form.widgetUrl };
    for (const key of ["anthropicApiKey", "deepgramApiKey", "githubToken"]) {
      if (form[key].trim()) update[key] = form[key];
    }
    const result = await api.saveSettings(update);
    if (!result.ok) return setError(result.error);
    onSaved(result.state);
  }

  async function remove(key) {
    const result = await api.saveSettings({ [key]: "" });
    if (result.ok) onSaved(result.state, true);
  }

  const secret = (label, key, saved, placeholder) => (
    <label>
      {label} {saved && <span className="saved">saved</span>}
      <input
        type="password"
        value={form[key]}
        onChange={set(key)}
        placeholder={saved ? "Leave blank to keep the saved one" : placeholder}
      />
    </label>
  );
  const removeButton = (key, saved, text) =>
    saved && (
      <>
        {" "}
        <button className="link-button" onClick={() => remove(key)}>
          {text}
        </button>
      </>
    );

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="modal">
        <h2 id="settings-title">Settings</h2>

        <h3>Writing summaries</h3>
        {secret("Anthropic API key", "anthropicApiKey", settings.hasAnthropicApiKey, "sk-ant-…")}
        <p className="hint">
          Claude writes each summary from the meeting transcript and the posted agenda. Use a dedicated Console
          workspace with a monthly spend limit.
          {removeButton("anthropicApiKey", settings.hasAnthropicApiKey, "Remove saved key")}
        </p>
        {secret("Deepgram API key", "deepgramApiKey", settings.hasDeepgramApiKey, "Deepgram key")}
        <p className="hint">
          Deepgram turns the Granicus recording into a transcript, about $0.40 for a 90-minute meeting. Each
          meeting's transcript is saved and reused.
          {removeButton("deepgramApiKey", settings.hasDeepgramApiKey, "Remove saved key")}
        </p>

        <h3>Publishing to the website</h3>
        <label>
          GitHub repository
          <input value={form.githubRepo} onChange={set("githubRepo")} placeholder="owner/repo" />
        </label>
        <label>
          Branch
          <input value={form.githubBranch} onChange={set("githubBranch")} />
        </label>
        {secret("GitHub token", "githubToken", settings.hasGithubToken, "github_pat_…")}
        <p className="hint">
          Use a fine-grained token limited to this one repository with <strong>Contents: Read and write</strong>. IT can
          provide it.
          {removeButton("githubToken", settings.hasGithubToken, "Remove saved token")}
        </p>
        <label>
          Widget web address
          <input value={form.widgetUrl} onChange={set("widgetUrl")} />
        </label>
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

function Highlight({ text, query }) {
  if (!query) return text;
  const parts = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, i)) {
    if (at > i) parts.push(text.slice(i, at));
    parts.push(<mark key={at}>{text.slice(at, at + query.length)}</mark>);
    i = at + query.length;
  }
  parts.push(text.slice(i));
  return parts;
}

/** The saved transcript for a meeting, with search. Each timestamp opens the Granicus player at that moment. */
function TranscriptModal({ meeting, onClose }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(true);

  useEffect(() => {
    let live = true;
    api.readTranscript(meeting.id).then((res) => {
      if (!live) return;
      if (res.ok) setDoc({ ...res, items: parseTranscript(res.body) });
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [meeting.id]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const matches = (it) => it.text.toLowerCase().includes(q);
  const count = doc && q ? doc.items.filter(matches).length : 0;
  const shown = doc ? (q && onlyMatches ? doc.items.filter(matches) : doc.items) : [];
  const watchAt = (sec) => {
    if (doc && doc.playerUrl) api.openExternal(sec ? `${doc.playerUrl}&entrytime=${Math.max(0, sec - 3)}` : doc.playerUrl);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="transcript-title">
      <div className="modal transcript">
        <header className="transcript-head">
          <div>
            <h2 id="transcript-title">Transcript</h2>
            <p className="muted">{doc ? doc.name : meeting.transcript ? meeting.transcript.name : ""}</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>
        <p className="hint">
          "Speaker" numbers are automatic and do not identify people. Click a time to watch that moment on Granicus.
        </p>
        {error && <p className="error">{error}</p>}
        {!doc && !error && <p className="muted">Loading…</p>}
        {doc && (
          <>
            <div className="transcript-toolbar">
              <input
                className="search"
                type="search"
                placeholder="Search this transcript…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {q && (
                <label className="inline">
                  <input type="checkbox" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} />
                  Only matching ({count})
                </label>
              )}
              <span className="spacer" />
              {doc.playerUrl && <button onClick={() => watchAt(0)}>Watch on Granicus</button>}
              <button onClick={() => api.openTranscript(meeting.id)}>Open in Notepad</button>
              <button onClick={() => api.showTranscriptInFolder(meeting.id)}>Show in folder</button>
            </div>
            <details className="transcript-details">
              <summary>About this transcript</summary>
              <div className="transcript-header">
                {doc.header.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            </details>
            <div className="transcript-body">
              {shown.length === 0 && <p className="muted">No lines match “{query.trim()}”.</p>}
              {shown.map((it, i) =>
                it.kind === "turn" ? (
                  <div key={i} className="turn">
                    <button
                      className="turn-time"
                      title={doc.playerUrl ? "Watch from here on Granicus" : ""}
                      onClick={() => watchAt(it.sec)}
                      disabled={!doc.playerUrl}
                    >
                      {it.time}
                    </button>
                    <div className="turn-body">
                      <span className={`turn-speaker ${speakerClass(it.speaker)}`}>{it.speaker}</span>
                      <p>
                        <Highlight text={it.text} query={q} />
                      </p>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="turn-note">
                    <Highlight text={it.text} query={q} />
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** What Granicus knows about the recording, and whether a transcript is on file. */
function SourceInfo({ meeting, onViewTranscript }) {
  const s = meeting.source || {};
  const link = (url, text) => (
    <button className="link-button" onClick={() => api.openExternal(url)}>
      {text}
    </button>
  );
  const savedAt =
    meeting.transcript && meeting.transcript.savedAt
      ? new Date(meeting.transcript.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "";
  return (
    <div className="source">
      <p>From Granicus</p>
      <ul>
        <li>
          {[s.title || "Recording", s.time, s.durationLabel].filter(Boolean).join(" · ")}
          {s.clipId ? ` (clip ${s.clipId})` : ""}
        </li>
        <li>
          {s.playerUrl ? link(s.playerUrl, "Watch the video") : "No video link"}
          {" · "}
          {s.agendaUrl ? link(s.agendaUrl, "Posted agenda") : "No agenda posted"}
          {s.minutesUrl && (
            <>
              {" · "}
              {link(s.minutesUrl, "Official minutes")}
            </>
          )}
        </li>
        <li>
          {meeting.transcript ? (
            <>
              Transcript on file{savedAt ? ` (saved ${savedAt})` : ""}.{" "}
              <button className="link-button" onClick={onViewTranscript}>
                View transcript
              </button>
            </>
          ) : (
            "No transcript yet. One is saved the first time a summary is written, and reused after that."
          )}
        </li>
      </ul>
    </div>
  );
}

function Editor({ meeting, onState, setNotice, busy, setBusy, onDirty, progress }) {
  const [fields, setFields] = useState(() => fieldsOf(meeting.draft));
  const [beforeRewrite, setBeforeRewrite] = useState(null);
  const [retranscribe, setRetranscribe] = useState(false);
  const [job, setJob] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const saved = useMemo(() => fieldsOf(meeting.draft), [meeting.draft]);
  const dirty = JSON.stringify(fields) !== JSON.stringify(saved);
  const draft = { ...meeting.draft, ...fields };
  const needsSummary = !hasSummary(fields);
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
    // Approving checks the saved overview and date, so save first. Moving away
    // from Approved changes the status first, so an empty overview can still be saved.
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

  async function summarize() {
    if (meeting.flags.some((f) => f.code === "low-content")) {
      if (!window.confirm("This looks like a test or an empty recording.\n\nWrite a summary anyway?")) return;
    }
    setBusy(true);
    setJob(true);
    setCancelling(false);
    setNotice(null);
    const result = await api.summarize(meeting.id, draft, { retranscribe });
    setBusy(false);
    setJob(false);
    setCancelling(false);
    setRetranscribe(false);
    // The transcript on file may have changed even when the job stopped part way.
    onState(result.state || (await api.getState()));
    if (!result.ok) {
      if (result.cancelled) return setNotice({ kind: "ok", text: "Cancelled." });
      return setNotice({ kind: "error", text: result.error, settings: result.needsSettings });
    }
    // The fields are locked while Claude works, so `fields` is still current here.
    if (!needsSummary) setBeforeRewrite(fields);
    setFields({ ...fields, overview: result.suggestion.overview, details: result.suggestion.details });
    setNotice({
      kind: "ok",
      text:
        "Claude's summary is in the overview and full summary. Check it against the video and agenda, edit as needed, then save or approve." +
        (result.agendaUsed ? "" : " Granicus had no posted agenda, so item numbers and amounts come from the recording alone."),
    });
  }

  async function cancel() {
    setCancelling(true);
    await api.cancel();
  }

  return (
    <section className="editor" aria-label="Edit summary">
      <header className="editor-head">
        <div>
          <h2>{formatDate(meeting.draft.date) || "Date needed"}</h2>
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

      {needsSummary && !job && (
        <p className="callout">
          No summary yet. Click <strong>Write summary with Claude</strong> below. The first time takes about 5 to 15
          minutes: the app downloads the recording from Granicus, transcribes it, then writes the summary. Leave the
          window open.
        </p>
      )}

      {job && (
        <div className="working" role="status">
          <span className="spinner" aria-hidden="true" />
          <span className="text">{cancelling ? "Cancelling…" : progress || "Starting…"}</span>
          <button onClick={cancel} disabled={cancelling}>
            Cancel
          </button>
        </div>
      )}

      <div className="editor-grid">
        <fieldset className="fields" disabled={busy}>
          <label>
            Meeting date
            <input type="date" value={fields.date} onChange={set("date")} />
          </label>
          <label>
            Meeting type
            <input value={fields.title} onChange={set("title")} />
          </label>
          <label>
            Overview <span className="muted">(always visible; one or two short sentences)</span>
            <WordCount text={fields.overview} limit={OVERVIEW_WORDS} />
            <textarea rows={5} value={fields.overview} onChange={set("overview")} />
          </label>
          <label>
            Full summary <span className="muted">(shown under "Read the full summary")</span>
            <WordCount text={fields.details} limit={DETAILS_WORDS} />
            <textarea className="tall" rows={16} value={fields.details} onChange={set("details")} />
          </label>
          <p className="hint">
            Formatting: <code>### Heading</code>, <code>- bullet</code>, <code>1. numbered</code>, <code>**bold**</code>
          </p>
          <label>
            Video link
            <input value={fields.recordingUrl} onChange={set("recordingUrl")} placeholder="https://…" />
          </label>

          <SourceInfo meeting={meeting} onViewTranscript={() => setShowTranscript(true)} />
        </fieldset>

        <div className="preview">
          <p className="preview-label">How it will look on the website</p>
          <Preview draft={draft} />
        </div>
      </div>

      <footer className="editor-actions">
        <button className={needsSummary ? "primary" : ""} onClick={summarize} disabled={busy}>
          {needsSummary ? "Write summary with Claude" : "Rewrite with Claude"}
        </button>
        {meeting.transcript && (
          <label className="inline">
            <input
              type="checkbox"
              checked={retranscribe}
              onChange={(e) => setRetranscribe(e.target.checked)}
              disabled={busy}
            />
            Transcribe again
          </label>
        )}
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
          <button className={needsSummary ? "" : "primary"} onClick={() => setStatus("approved")} disabled={busy}>
            {meeting.status === "approved" ? "Save and keep approved" : "Approve"}
          </button>
        )}
      </footer>

      {showTranscript && <TranscriptModal meeting={meeting} onClose={() => setShowTranscript(false)} />}
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
  const settings = state.settings;
  const missing = [
    !settings.hasAnthropicApiKey && "the Anthropic API key",
    !settings.hasDeepgramApiKey && "the Deepgram API key",
    !settings.hasGithubToken && "the GitHub token",
  ].filter(Boolean);
  const canPublish = settings.hasGithubToken && state.pendingCount > 0 && !busy;

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
      text: result.added
        ? `Loaded ${result.added} new recording${result.added === 1 ? "" : "s"} from Granicus.`
        : "No new recordings on Granicus.",
    });
  }

  async function publish() {
    const changes = state.meetings.filter((m) => m.pending);
    const lines = changes.map((m) => `• ${shortDate(m.draft.date)}: ${PENDING_LABELS[m.pending]}`);
    if (!window.confirm(`Publish these changes to the City website?\n\n${lines.join("\n")}`)) return;
    setBusy(true);
    const result = await api.publish();
    setBusy(false);
    if (!result.ok) return setNotice({ kind: "error", text: result.error, settings: result.needsSettings });
    setState(result.state);
    setNotice({
      kind: "ok",
      text: "Published. The website updates within a few minutes.",
      link: settings.widgetUrl,
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

      {missing.length > 0 && (
        <p className="banner">
          Setup isn't finished on this computer. Add {missing.join(", ")} in Settings.{" "}
          <button className="link-button" onClick={() => setShowSettings(true)}>
            Open Settings
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
                ? "Click Check for new meetings to load recordings from Granicus."
                : "Nothing here."}
            </p>
          )}
          <ul className="meeting-list">
            {list.map((m) => (
              <li key={m.id}>
                <button className={m.id === selectedId ? "meeting active" : "meeting"} onClick={() => select(m.id)}>
                  <span className="meeting-date">{shortDate(m.draft.date)}</span>
                  <span className="meeting-title">{m.source.title || m.draft.title}</span>
                  <span className="meeting-badges">
                    {m.conflict && <span className="badge badge-conflict">Choose a version</span>}
                    {m.status === "review" && !m.draft.overview && <span className="badge badge-muted">No summary yet</span>}
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
            progress={progress}
          />
        ) : (
          <section className="editor editor-empty">
            <p>Choose a meeting on the left to review its summary.</p>
          </section>
        )}
      </div>

      {showSettings && (
        <Settings
          settings={settings}
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
