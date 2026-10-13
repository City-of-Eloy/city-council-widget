/** Ask Claude to write, or rewrite, a plain-language summary of a meeting for
 *  residents from the transcript of the Granicus recording and the posted
 *  agenda. The result is a suggestion only; the reviewer edits and approves it.
 */
"use strict";

const { SummaryError, CancelledError } = require("./errors");

const MODEL = "claude-opus-5-5";
const MAX_TRANSCRIPT_CHARS = 2000000; // ~500k tokens, well inside the 1M context

const SYSTEM_PROMPT = `You write short, plain-language summaries of City of Eloy, Arizona public meetings for residents. They appear on the City website next to a link to the meeting video, so most readers skim them in under a minute. Anyone who wants every detail can watch the video.

What you are given:
- The transcript of the meeting recording. It is automatic speech-to-text with [HH:MM:SS] timestamps and "Speaker N" labels from automatic speaker separation. Speaker numbers are not identities and can drift. Speech-to-text also mishears names, numbers, and amounts.
- The posted agenda, when the City published one. It is the authority for item titles, ordinance and resolution numbers, and dollar amounts.
- The current Council roster from the City's website, for spelling names and titles.
- The current summary, when a reviewer has already written or edited one. Keep its facts and corrections unless the transcript clearly contradicts them, and improve the wording.

Keep it short and easy to read:
- Write at about a sixth-grade reading level. Use short sentences (under 20 words), everyday words, and active voice.
- Replace government terms with plain ones. For example, say "routine items approved together" instead of "consent agenda", and "rules change" or "City law" instead of "ordinance" (keep the ordinance number in parentheses).
- Spell out an acronym the first time, or avoid it.
- Focus on what changes for residents: decisions, money, projects, services, and upcoming events. Leave out routine procedure such as roll call, the Pledge of Allegiance, approving past minutes, and motions to adjourn.
- When an item didn't affect residents, leave it out instead of summarizing it.

Accuracy matters more than style. These summaries are published by the City.
- Use only facts supported by the transcript, the agenda, or the current summary. When the transcript and the agenda disagree on a name, number, or amount, use the agenda's.
- Keep dollar amounts, vote counts, and ordinance, resolution, and contract numbers exactly as stated. If one is unclear, leave it out rather than guess.
- Stay neutral. Report what was presented, discussed, and decided without judging it.
- Name the Mayor, Councilmembers, and City staff by title. Do not name members of the public; describe them instead (for example, "a resident" or "a local business owner").
- Spell the Mayor's, Vice Mayor's, Councilmembers', and City Clerk's names exactly as in the council roster. The transcript often misspells names, so when a name in it sounds like someone on the roster, use the roster spelling and title. Use the name a member goes by when the roster shows one in quotes (for example, JoAnne). Give the title and full name the first time (for example, "Vice Mayor Michelle McKinley-Tarango"), then the title and last name.
- Attribute a statement, motion, or vote to a named person only when the transcript makes it clear (roll call, the chair recognizing someone by name, a self-introduction). Otherwise write "a Councilmember".
- For a board or commission meeting, use the body's name in place of "the Council" (for example, "What the Commission decided").
- If the recording is a system test or contains no real meeting business, say so in one sentence in the overview and leave details empty.
- Do not mention transcripts, recordings, recording quality, speaker labels, or how the summary was written.

Return two fields:
- overview: at most 2 sentences and 45 words, naming the one to three decisions that matter most to residents. No vote counts, item numbers, or Markdown here.
- details: Markdown, at most 200 words in total. Use "### " headings and "- " bullets, only for the sections that apply, in this order: "What the Council decided", "Public comments", "Announcements". Each bullet is one sentence. Put a vote's result in parentheses at the end of its bullet, for example "(approved 7-0)". At most 6 bullets under "What the Council decided" and 3 under each other heading; group or drop minor items to stay within the limits.`;

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
    return new SummaryError("Anthropic rejected the saved API key. Paste the City's current key in Settings.", {
      needsKey: true,
      keyKind: "anthropic",
    });
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new SummaryError("This API key isn't allowed to make this request. Ask IT to check it in the Anthropic Console.");
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new SummaryError(`The model "${MODEL}" isn't available to the City's Anthropic account. Contact IT.`);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new SummaryError("Anthropic is limiting how fast the City's account can send requests. Wait a minute, then try again.");
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new SummaryError("Anthropic took too long to respond. Try again.");
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new SummaryError("Could not reach Anthropic. Check the internet connection, then try again.");
  }
  if (e instanceof Anthropic.InternalServerError || (e instanceof Anthropic.APIError && e.type === "overloaded_error")) {
    return new SummaryError("Anthropic's service is busy or having a problem right now. Wait a few minutes, then try again.");
  }
  if (e instanceof Anthropic.APIError && e.status === 402) {
    return new SummaryError("The City's Anthropic account has a billing problem (for example, out of credit). Contact IT.");
  }
  if (e instanceof Anthropic.BadRequestError) {
    return new SummaryError(`Anthropic couldn't process this request: ${e.message}`);
  }
  return new SummaryError(`Anthropic API error: ${e.message || e}`);
}

function buildUserPrompt({ clip, draft = {}, transcript, agendaText = "", roster }) {
  const current = [draft.overview, draft.details]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join("\n\n");
  return [
    `Meeting: ${clip.title || draft.title || "City Council Meeting"}`,
    `Date: ${draft.date || clip.date || "unknown"}`,
    clip.durationLabel ? `Recording length: ${clip.durationLabel}` : null,
    "",
    `<council_roster source="${roster.source}">`,
    roster.text,
    "</council_roster>",
    "",
    agendaText ? `<posted_agenda>\n${agendaText}\n</posted_agenda>` : "No posted agenda is available for this meeting.",
    "",
    current ? `<current_summary>\n${current}\n</current_summary>` : "There is no current summary. Write a new one from the transcript.",
    "",
    `<transcript>\n${transcript}\n</transcript>`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Returns { overview, details } suggested by Claude. */
async function writeSummary({ clip, draft, transcript, agendaText, roster }, { apiKey, onProgress, signal } = {}) {
  if (!apiKey) {
    throw new SummaryError("Add the City's Anthropic API key in Settings to write summaries.", { needsKey: true, keyKind: "anthropic" });
  }
  const text = String(transcript || "");
  if (!text.trim()) throw new SummaryError("There is no transcript to summarize.");
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    throw new SummaryError("This meeting's transcript is too long to send in one request. Write the summary by hand instead.");
  }

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey, timeout: 600000 });

  let resp;
  try {
    if (signal && signal.aborted) throw new CancelledError();
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt({ clip, draft, transcript: text, agendaText, roster }) }],
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        // If a safety check wrongly declines a transcript, the API retries on
        // Anthropic's recommended backup model within the same request.
        fallbacks: "default",
        betas: ["server-side-fallback-2026-07-01"],
      },
      { signal }
    );
    let chars = 0;
    stream.on("text", (delta) => {
      chars += delta.length;
      if (onProgress) onProgress(`Writing… ${chars.toLocaleString()} characters`);
    });
    resp = await stream.finalMessage();
  } catch (e) {
    if (e instanceof CancelledError || (signal && signal.aborted)) throw new CancelledError();
    throw friendlyApiError(e, Anthropic);
  }

  if (resp.stop_reason === "refusal") {
    const category = (resp.stop_details && resp.stop_details.category) || "unspecified";
    throw new SummaryError(`Claude declined to summarize this meeting (automated safety check: ${category}). Write the summary by hand instead.`);
  }
  if (resp.stop_reason === "max_tokens") {
    throw new SummaryError("Claude ran out of room before finishing. Try again.");
  }

  const reply = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const parsed = JSON.parse(reply);
    return { overview: String(parsed.overview || "").trim(), details: String(parsed.details || "").trim() };
  } catch {
    throw new SummaryError("Claude's reply wasn't in the expected format. Try again.");
  }
}

module.exports = { writeSummary, buildUserPrompt, SYSTEM_PROMPT, MODEL, MAX_TRANSCRIPT_CHARS };
