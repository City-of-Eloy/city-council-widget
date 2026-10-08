/** Minimal OpenPublica MCP client (JSON-RPC over HTTP, no API key required).
 */
"use strict";

const DEFAULT_URL = "https://api.openpublica.com/mcp";
const ELOY_GOVERNMENT_ID = "eloy-arizona";

class OpenPublicaError extends Error {}

class OpenPublicaClient {
  constructor(url = DEFAULT_URL, timeoutMs = 120000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this._initialized = false;
  }

  async _post(payload) {
    let resp;
    try {
      resp = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new OpenPublicaError(`Network error talking to OpenPublica: ${e.message || e}`);
    }

    let raw = (await resp.text()).trim();
    if (!resp.ok) {
      throw new OpenPublicaError(`HTTP ${resp.status}: ${raw.slice(0, 500)}`);
    }
    if (!raw) return null;

    // Some MCP servers return SSE-style frames; handle both.
    const firstLine = raw.split("\n", 1)[0];
    if (raw.startsWith("event:") || firstLine.includes("data:")) {
      const chunks = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("data:")) chunks.push(line.slice(5).trim());
      }
      raw = chunks.join("\n").trim();
      if (!raw) return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new OpenPublicaError(`Invalid JSON from OpenPublica: ${raw.slice(0, 300)}`);
    }
  }

  async initialize() {
    if (this._initialized) return;
    const resp = await this._post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "eloy-council-review", version: "1.0.0" },
      },
    });
    if (!resp || !("result" in resp)) {
      throw new OpenPublicaError(`Initialize failed: ${JSON.stringify(resp)}`);
    }
    await this._post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this._initialized = true;
  }

  async callTool(name, args) {
    await this.initialize();
    const resp = await this._post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args || {} },
    });
    if (!resp) throw new OpenPublicaError(`Empty response calling ${name}`);
    if (resp.error) throw new OpenPublicaError(`Tool error (${name}): ${JSON.stringify(resp.error)}`);
    const result = resp.result || {};
    if (result.isError) {
      throw new OpenPublicaError(`Tool reported error (${name}): ${JSON.stringify(result)}`);
    }
    const content = result.content || [];
    const texts = content.filter((c) => c.type === "text").map((c) => c.text || "");
    const joined = texts.join("\n").trim();
    if (!joined) return result;
    try {
      return JSON.parse(joined);
    } catch {
      return joined;
    }
  }

  async listRecentMeetings({ governmentId = ELOY_GOVERNMENT_ID, limit = 15, startDate, endDate } = {}) {
    // OpenPublica rejects limits above 25.
    const args = { government_id: governmentId, limit: Math.min(25, limit) };
    if (startDate) args.start_date = startDate;
    if (endDate) args.end_date = endDate;
    const data = await this.callTool("list_recent_meetings", args);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return Array.from(data.meetings || []);
    }
    throw new OpenPublicaError(`Unexpected list_recent_meetings payload: ${typeof data}`);
  }

  async getMeeting(meetingId, includeTranscript = true) {
    const data = await this.callTool("get_meeting", {
      meeting_id: meetingId,
      include_transcript: includeTranscript,
    });
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    throw new OpenPublicaError(`Unexpected get_meeting payload: ${typeof data}`);
  }
}

module.exports = { OpenPublicaClient, OpenPublicaError, ELOY_GOVERNMENT_ID };
