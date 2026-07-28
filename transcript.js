// Best-effort capture of prompt/response content for a model.usage event.
//
// OpenClaw does not deliver prompt/completion text to third-party plugins (the
// `model.usage` diagnostic carries usage/cost only; message content is private
// data handed exclusively to bundled diagnostics services). To still populate
// the Langfuse generation's input/output, we read OpenClaw's per-session
// transcript, which records each turn's `model.completed` entry with
// `finalPromptText` (input) and `assistantTexts` (output).
//
// Storage backend note: OpenClaw >=2026.7 stores sessions in a canonical
// SQLite store (agents/<agentId>/agent/openclaw-agent.sqlite) instead of the
// old flat `agents/<agentId>/sessions/<sessionId>.trajectory.jsonl` file,
// which no longer exists there (that directory now holds only session
// locks). We read transcripts through the supported, storage-neutral plugin
// SDK surface (`openclaw/plugin-sdk/session-transcript-runtime`), which
// resolves the correct backend (SQLite or legacy file) by session identity.
// A direct on-disk `.trajectory.jsonl` read remains as a fallback for older
// hosts (<2026.7) where that SDK subpath does not exist.
//
// This is intentionally best-effort: any failure (session not found, not yet
// flushed, format change) returns null and never blocks usage forwarding.

import { openSync, readSync, readFileSync, statSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Cap how much of a (potentially long-lived) legacy transcript file we read;
// we only need the tail (most recent turns). Only used by the legacy
// file-based fallback.
const MAX_READ_BYTES = 2_000_000;

/** Resolve OpenClaw's state dir: ctx.stateDir, then env, then ~/.openclaw. */
export function resolveStateDir(stateDir) {
  if (typeof stateDir === "string" && stateDir.length > 0) return stateDir;
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  return path.join(homedir(), ".openclaw");
}

/** Path to a session's legacy trajectory transcript (pre-2026.7 hosts only). */
export function trajectoryPath(stateDir, agentId, sessionId) {
  return path.join(
    resolveStateDir(stateDir),
    "agents",
    agentId || "main",
    "sessions",
    `${sessionId}.trajectory.jsonl`,
  );
}

/** Read a byte window of a file as UTF-8 text. `from: "head" | "tail"`. */
function readWindow(file, maxBytes, from) {
  const { size } = statSync(file);
  if (size <= maxBytes) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const start = from === "tail" ? size - maxBytes : 0;
    const bytes = readSync(fd, buf, 0, maxBytes, start);
    return buf.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Extract a prompt/response from a single parsed transcript event. */
function entryIO(obj) {
  // Transcript schema v3 (OpenClaw >=2026.7.2): message content lives on
  // `message` events (`{ type: "message", message: { role, content[] } }`)
  // instead of `model.completed` entries with finalPromptText/assistantTexts.
  if (obj?.type === "message" && obj.message) {
    const m = obj.message;
    const text = contentToText(m.content);
    if (text === undefined) return {};
    if (m.role === "user") return { input: text };
    if (m.role === "assistant") return { output: text };
    return {};
  }

  const data = obj?.data;
  if (!data) return {};
  if (obj.type === "model.completed") {
    const io = {};
    if (typeof data.finalPromptText === "string") io.input = data.finalPromptText;
    if (Array.isArray(data.assistantTexts) && data.assistantTexts.length > 0) {
      io.output = data.assistantTexts.join("\n");
    }
    return io;
  }
  if (obj.type === "prompt.submitted" && typeof data.prompt === "string") {
    return { input: data.prompt };
  }
  return {};
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null; // tolerate a truncated boundary line from a windowed read
  }
}

/** Flatten a tool-result `content` value (string | array of text blocks) to text. */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block.text === "string") parts.push(block.text);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/**
 * Pure: extract per-tool input/output from an array of parsed transcript
 * events, keyed by the tool call id (which matches the `toolCallId` on
 * `tool.execution.*` diagnostic events). We read the LAST `model.completed`
 * event's `messagesSnapshot`, which is the cumulative conversation and
 * therefore holds every tool call + result of the run by the time the run ends.
 *
 * In the snapshot, tool inputs live on assistant `toolCall` blocks
 * ({ id, name, arguments }) and tool outputs live on `toolResult` messages
 * ({ toolCallId, toolName, content, isError }). Returns a plain object
 * { [toolCallId]: { name, input, output, isError } } or null when none found.
 */
export function extractToolIO(events) {
  let snapshot;
  // Walk forward; keep the latest snapshot (cumulative, so last wins).
  for (const obj of events) {
    if (obj?.type === "model.completed" && Array.isArray(obj?.data?.messagesSnapshot)) {
      snapshot = obj.data.messagesSnapshot;
    }
  }
  if (!snapshot) return null;

  const byId = {};
  const ensure = (id) => (byId[id] ??= {});
  for (const msg of snapshot) {
    if (!msg || typeof msg !== "object") continue;
    // Tool outputs: dedicated toolResult messages.
    if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
      const entry = ensure(msg.toolCallId);
      const out = contentToText(msg.content);
      if (out !== undefined) entry.output = out;
      if (typeof msg.toolName === "string") entry.name ??= msg.toolName;
      if (typeof msg.isError === "boolean") entry.isError = msg.isError;
      continue;
    }
    // Tool inputs: assistant toolCall content blocks.
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
      const entry = ensure(block.id);
      if (typeof block.name === "string") entry.name = block.name;
      if (block.arguments !== undefined) {
        entry.input =
          typeof block.arguments === "string"
            ? block.arguments
            : JSON.stringify(block.arguments);
      }
    }
  }
  return Object.keys(byId).length > 0 ? byId : null;
}

/**
 * Pure: extract turn content from an array of parsed transcript events.
 * Returns { input, output, sessionInput } where `input`/`output` are the
 * latest turn (for the generation) and `sessionInput` is the first prompt in
 * the events (for trace-level aggregation). Returns null when nothing usable
 * is found.
 *
 * When `runId` is given, `input`/`output` are taken ONLY from the entry
 * matching that run — a session's trajectory file accumulates every turn, and
 * without this a still-in-flight write for turn N could silently return turn
 * N-1's (stale) content instead of null (which is what should trigger a
 * retry). `sessionInput` always looks at the whole session regardless of
 * `runId`, since it means "the first-ever prompt", not this turn's prompt.
 */
export function extractContent(events, runId) {
  let input;
  let output;
  let sessionInput;
  for (const obj of events) {
    if (!obj) continue;
    const io = entryIO(obj);
    if (io.input !== undefined && sessionInput === undefined) sessionInput = io.input;
    if (runId !== undefined && obj.runId !== runId) continue;
    if (io.input !== undefined) input = io.input;
    if (io.output !== undefined) output = io.output;
  }
  if (input === undefined && output === undefined) return null;
  const out = {};
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (sessionInput !== undefined) out.sessionInput = sessionInput;
  return out;
}

// ---------------------------------------------------------------------------
// Transcript event sourcing: prefer the supported plugin SDK surface (works
// against whatever backend OpenClaw actually uses — SQLite or file), and fall
// back to a direct legacy .trajectory.jsonl read for older hosts.
// ---------------------------------------------------------------------------

// Lazily & safely import the modern session-transcript-runtime SDK surface.
// Hosts on OpenClaw <2026.7 may not expose this subpath at all; import
// failure just means "use the legacy file fallback below".
let sdkModulePromise;
function loadSdkTranscriptModule() {
  sdkModulePromise ??= import("openclaw/plugin-sdk/session-transcript-runtime").catch(
    () => null,
  );
  return sdkModulePromise;
}

/** Read + parse a legacy per-session .trajectory.jsonl file into events.
 * Returns an array of parsed events, or null. Never throws. */
function readLegacyTrajectoryEvents(stateDir, evt, logger) {
  try {
    const sessionId = evt?.sessionId ?? evt?.sessionKey;
    if (!sessionId) return null;
    const file = trajectoryPath(stateDir, evt?.agentId, sessionId);
    const { size } = statSync(file);
    const text =
      size <= MAX_READ_BYTES ? readFileSync(file, "utf8") : readWindow(file, MAX_READ_BYTES, "tail");
    return text
      .split("\n")
      .map(parseLine)
      .filter((obj) => obj !== null);
  } catch (err) {
    // File may not exist (expected on 2026.7+ SQLite-backed hosts) or be
    // mid-write; this is best-effort.
    logger?.debug?.(
      `benchgen: legacy transcript read failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }
}

/**
 * Read all transcript events for an event's session. Tries the storage-
 * neutral SDK surface first (`readSessionTranscriptEvents`), which resolves
 * whichever backend OpenClaw actually uses (SQLite-backed sessions on
 * >=2026.7, or a flat file on older hosts). Falls back to a direct legacy
 * `.trajectory.jsonl` read when the SDK subpath is unavailable or the read
 * comes back empty. Returns an array of parsed events, or null. Never throws.
 */
async function readTranscriptEvents(stateDir, evt, logger) {
  const sessionId = evt?.sessionId ?? evt?.sessionKey;
  if (!sessionId) return null;

  const sdk = await loadSdkTranscriptModule();
  if (sdk && typeof sdk.readSessionTranscriptEvents === "function") {
    try {
      const events = await sdk.readSessionTranscriptEvents({
        agentId: evt.agentId || "main",
        sessionKey: evt.sessionKey,
        sessionId,
      });
      if (Array.isArray(events) && events.length > 0) return events;
    } catch (err) {
      logger?.debug?.(
        `benchgen: session-transcript-runtime read failed (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  return readLegacyTrajectoryEvents(stateDir, evt, logger);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The trajectory file for the CURRENT turn is not guaranteed to be fully
// flushed to disk yet at the moment run.completed/model.usage fire — writes
// lag the diagnostic event by an unbounded amount (observed up to ~2-3s on
// some hosts, likely while the runtime finishes compaction/summary bookkeeping
// for the turn). Retry with a generous total budget rather than accepting a
// one-shot empty read; this only delays when the (background) Langfuse trace
// is finalized, it never blocks the user-facing chat response.
const RESOLVE_RETRY_ATTEMPTS = 12;
const RESOLVE_RETRY_DELAY_MS = 500;

/**
 * Build a content resolver bound to a state dir. Returns an async function
 * that, given a model.usage event, reads the session transcript and returns
 * { input, output, sessionInput } or null. Never throws.
 */
export function makeContentResolver(stateDir, logger) {
  return async (evt) => {
    for (let attempt = 0; attempt < RESOLVE_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RESOLVE_RETRY_DELAY_MS);
      const events = await readTranscriptEvents(stateDir, evt, logger);
      if (events) {
        const content = extractContent(events, evt?.runId);
        if (content) return content;
      }
    }
    return null;
  };
}

/**
 * Build a tool-I/O resolver bound to a state dir. Returns an async function
 * that, given an event with a session id, reads the session transcript and
 * returns the per-tool I/O map { [toolCallId]: { name, input, output, isError } }
 * or null. Never throws.
 */
export function makeToolIOResolver(stateDir, logger) {
  return async (evt) => {
    for (let attempt = 0; attempt < RESOLVE_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RESOLVE_RETRY_DELAY_MS);
      const events = await readTranscriptEvents(stateDir, evt, logger);
      if (events) {
        const io = extractToolIO(events);
        if (io) return io;
      }
    }
    return null;
  };
}
