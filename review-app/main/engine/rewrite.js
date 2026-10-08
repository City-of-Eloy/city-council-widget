/** Optional: ask Claude to rewrite a meeting summary in plain language for
 *  residents, checking it against the meeting transcript. The result is a
 *  suggestion only; the reviewer still edits and approves it.
 */
"use strict";

const MODEL = "claude-opus-5-5";
const MAX_TRANSCRIPT_CHARS = 2000000; // ~500k tokens, well inside the 1M context

class RewriteError extends Error {
  /** needsKey: the screen should send the reviewer to Settings. */
  constructor(message, { needsKey = false } = {}) {
    super(message);
    this.needsKey = needsKey;
  }
}

const SYSTEM_PROMPT = `You write plain-language summaries of City of Eloy, Arizona public meetings for residents. They appear on the City website next to a link to the meeting video.

Write for a general audience at about an eighth-grade reading level: short sentences, everyday words, and acronyms spelled out the first time (for example, "Arizona Department of Transportation (ADOT)").

Accuracy matters more than style. These summaries are published by the City.
- Use only facts supported by the transcript or the current summary. When they disagree, trust the transcript.
- Keep dollar amounts, vote counts, and ordinance, resolution, and contract numbers exactly as stated. If one is unclear, leave it out rather than guess.
- Stay neutral. Report what was presented, discussed, and decided without judging it.
- Name the Mayor, Councilmembers, and City staff by title. Do not name members of the public; describe them instead (for example, "a resident" or "a local business owner").
- Do not mention transcripts, recordings, recording quality, or how the summary was written.

Return two fields:
- overview: two or three sentences on what the meeting was and what the Council decided. No Markdown.
- details: Markdown using "### " headings and "- " bullets. Use only the sections that apply, in this order: "What the Council decided", "Discussion", "Public comments", "Reports and announcements". Put each vote's result (for example, "approved 7-0") with its item.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    overview: { type: "string" },
    details: { type: "string" },
  },
  required: ["overview", "details"],
  additionalProperties: false,
};

/** Turn an SDK error into a message the reviewer can act on. */
function friendlyApiError(e, Anthropic) {
  // Order matters: specific subclasses before their parents.
  if (e instanceof Anthropic.AuthenticationError) {
    return new RewriteError("Anthropic rejected the saved API key. Paste the City's current key in Settings.", { needsKey: true });
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new RewriteError("This API key isn't allowed to make this request. Ask IT to check it in the Anthropic Console.");
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new RewriteError(`The model "${MODEL}" isn't available to the City's Anthropic account. Contact IT.`);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new RewriteError("Anthropic is limiting how fast the City's account can send requests. Wait a minute, then try again.");
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new RewriteError("Anthropic took too long to respond. Try again.");
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new RewriteError("Could not reach Anthropic. Check the internet connection, then try again.");
  }
  if (e instanceof Anthropic.InternalServerError || (e instanceof Anthropic.APIError && e.type === "overloaded_error")) {
    return new RewriteError("Anthropic's service is busy or having a problem right now. Wait a few minutes, then try again.");
  }
  if (e instanceof Anthropic.APIError && e.status === 402) {
    return new RewriteError("The City's Anthropic account has a billing problem (for example, out of credit). Contact IT.");
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new RewriteError(`Anthropic couldn't process this request: ${e.message}`);
  }
  return new RewriteError(`Anthropic API error: ${e.message || e}`);
}

function buildUserPrompt(meeting, draft) {
  const transcript = String(meeting.transcript || "");
  return [
    `Meeting: ${meeting.title || draft.title}`,
    `Date: ${meeting.date || draft.date}`,
    "",
    "<current_summary>",
    draft.overview || "",
    "",
    draft.details || "",
    "</current_summary>",
    "",
    transcript ? `<transcript>\n${transcript}\n</transcript>` : "No transcript is available. Rewrite the current summary only.",
  ].join("\n");
}

/** Returns { overview, details } suggested by Claude. */
async function rewriteSummary(meeting, draft, { apiKey, onProgress } = {}) {
  if (!apiKey) throw new RewriteError("Add the City's Anthropic API key in Settings to use this.", { needsKey: true });
  if (String(meeting.transcript || "").length > MAX_TRANSCRIPT_CHARS) {
    throw new RewriteError("This meeting's transcript is too long to send in one request. Edit the summary by hand instead.");
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: 600000 });

  let resp;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(meeting, draft) }],
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: OUTPUT_SCHEMA },
      },
      // If a safety check wrongly declines a transcript, the API retries on
      // Anthropic's recommended backup model within the same request.
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
    let chars = 0;
    stream.on("text", (delta) => {
      chars += delta.length;
      if (onProgress) onProgress(`Writing… ${chars.toLocaleString()} characters`);
    });
    resp = await stream.finalMessage();
  } catch (e) {
    throw friendlyApiError(e, Anthropic);
  }

  if (resp.stop_reason === "refusal") {
    const category = (resp.stop_details && resp.stop_details.category) || "unspecified";
    throw new RewriteError(`Claude declined to rewrite this meeting (automated safety check: ${category}). Edit the summary by hand instead.`);
  }
  if (resp.stop_reason === "max_tokens") {
    throw new RewriteError("Claude ran out of room before finishing. Try again.");
  }

  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const parsed = JSON.parse(text);
    return { overview: String(parsed.overview || "").trim(), details: String(parsed.details || "").trim() };
  } catch {
    throw new RewriteError("Claude's reply wasn't in the expected format. Try again.");
  }
}

module.exports = { rewriteSummary, RewriteError, MODEL };
