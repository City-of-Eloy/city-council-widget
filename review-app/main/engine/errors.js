/** Error types whose messages are written for the reviewer and can be shown as-is. */
"use strict";

class FriendlyError extends Error {
  /**
   * needsKey: the screen should send the reviewer to Settings.
   * keyKind:  "anthropic" | "deepgram" | "github", which key or token to ask for.
   * cancelled: the reviewer pressed Cancel; not an error to display.
   */
  constructor(message, { needsKey = false, keyKind = null, cancelled = false } = {}) {
    super(message);
    this.name = new.target.name;
    this.needsKey = needsKey;
    this.keyKind = keyKind;
    this.cancelled = cancelled;
  }
}

class GranicusError extends FriendlyError {}
class MediaError extends FriendlyError {}
class TranscribeError extends FriendlyError {}
class SummaryError extends FriendlyError {}

class CancelledError extends FriendlyError {
  constructor(message = "Cancelled.") {
    super(message, { cancelled: true });
  }
}

/** Throw CancelledError if the job's AbortSignal has fired. */
function throwIfCancelled(signal) {
  if (signal && signal.aborted) throw new CancelledError();
}

/** True for the errors fetch / the Anthropic SDK raise when an AbortSignal fires. */
function isAbortError(e) {
  return Boolean(e) && (e.name === "AbortError" || e.name === "APIUserAbortError" || e instanceof CancelledError);
}

module.exports = {
  FriendlyError,
  GranicusError,
  MediaError,
  TranscribeError,
  SummaryError,
  CancelledError,
  throwIfCancelled,
  isAbortError,
};
