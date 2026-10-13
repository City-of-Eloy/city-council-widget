/** Turn a saved transcript body into rows for the viewer. Plain ES module so
 *  the smoke test can run it outside the app.
 */

const TURN = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(Speaker [\d?]+):\s*([\s\S]*)$/;

/** Body -> [{ kind: "turn", sec, time, speaker, text } | { kind: "note", text }] */
export function parseTranscript(body) {
  return String(body || "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const m = block.match(TURN);
      if (!m) return { kind: "note", text: block };
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      const time = Number(m[1]) ? `${Number(m[1])}:${m[2]}:${m[3]}` : `${Number(m[2])}:${m[3]}`;
      return { kind: "turn", sec, time, speaker: m[4], text: m[5].replace(/\s+/g, " ") };
    });
}

/** A stable colour class per speaker label. */
export function speakerClass(speaker) {
  const digits = String(speaker).replace(/\D/g, "");
  return digits ? `sp-${Number(digits) % 8}` : "sp-x";
}
