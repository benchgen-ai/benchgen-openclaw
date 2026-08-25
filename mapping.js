// Pure mapping helpers: translate OpenClaw diagnostic events into the shapes the
// Langfuse v5 (OpenTelemetry) SDK expects. These functions hold no state and do
// no I/O, so they can be unit-tested in isolation. The stateful nesting of
// observations into per-run traces lives in `tracer.js`.

// Langfuse OTel attribute keys (from @langfuse/core LangfuseOtelSpanAttributes).
export const TRACE_NAME = "langfuse.trace.name";
export const TRACE_SESSION_ID = "session.id";
export const TRACE_TAGS = "langfuse.trace.tags";
export const TRACE_USER_ID = "user.id";

/**
 * Tag prefix carrying OpenClaw's agent id.
 *
 * A bare id in a tag list reads as noise; prefixed, it is obvious what it names.
 * The same id also goes to `user.id` (filterable) and into trace metadata
 * (readable) — three placements because one Langfuse project can receive traffic
 * from several OpenClaw agents, and until now nothing on the trace said which
 * one produced it.
 */
export const AGENT_TAG_PREFIX = "agent:";

/**
 * OpenClaw's agent id for this event.
 *
 * `agentId` is only on *some* event types. Verified against OpenClaw 2026.7.2:
 * `session.turn.created` and `tool.execution.*` carry it; `run.started`,
 * `run.completed`, `context.assembled`, `model.usage` and `harness.run.*` do
 * not. Reading the field alone therefore identifies a turn that happened to call
 * a tool and leaves a plain question-and-answer turn anonymous — and the root
 * observation, which is built from `run.started`, never gets it at all.
 *
 * `sessionKey` is on all of them and embeds the id:
 * `agent:<agentId>:<surface>:<uuid>`. Parsing it makes identity available at the
 * moment the trace is created rather than whenever a tool happens to run.
 */
export function agentIdOf(evt) {
  if (evt?.agentId) return evt.agentId;
  const key = evt?.sessionKey;
  if (typeof key !== "string") return undefined;
  const parts = key.split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : undefined;
}

/** Drop undefined/null values so we never send empty fields to Langfuse. */
export function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Write trace-level name/sessionId onto an observation's root OTel span. We set
 * these straight on the span (rather than via `propagateAttributes`, which needs
 * a global OTel context manager we deliberately don't register) so Langfuse
 * promotes them to the trace. Only meaningful on a trace's root observation.
 */
export function setTraceFields(obs, name, sessionId) {
  const span = obs?.otelSpan;
  if (!span || typeof span.setAttribute !== "function") return;
  if (name !== undefined && name !== null) span.setAttribute(TRACE_NAME, name);
  if (sessionId !== undefined && sessionId !== null) {
    span.setAttribute(TRACE_SESSION_ID, sessionId);
  }
}

/**
 * Tag a trace, via its root observation's span.
 *
 * Set on the span for the same reason `setTraceFields` is: Langfuse promotes
 * these attributes to the trace, and we deliberately register no global OTel
 * context manager. `string[]` is a native OTel attribute type, so the array goes
 * over the wire as-is.
 */
/**
 * Put OpenClaw's agent id on the trace three ways, from one call.
 *
 * `user.id` because that is what BenchGen's trace list already filters on, so
 * per-agent filtering costs no UI work. A prefixed tag so the id is greppable in
 * the tag filter too. Metadata is added by `runAttributes`, not here — it rides
 * along with the rest of the run's fields.
 *
 * Only meaningful on a trace's root observation, like the helpers above.
 */
export function setTraceAgent(obs, agentId, extraTags = []) {
  const span = obs?.otelSpan;
  if (!span || typeof span.setAttribute !== "function") return;
  if (agentId === undefined || agentId === null || agentId === "") {
    setTraceTags(obs, extraTags);
    return;
  }
  span.setAttribute(TRACE_USER_ID, String(agentId));
  setTraceTags(obs, [`${AGENT_TAG_PREFIX}${agentId}`, ...extraTags]);
}

/**
 * Tag put on every trace whose turn came in through the Benchgen chat bridge
 * (channel "benchgen"), so chat traffic can be told apart from — or narrowed
 * to — the agent's other channels in the trace list. Chat and trace share the
 * conversation id through the session key.
 */
export const CHAT_TRACE_TAG = "benchgen-chat";

/** Extra trace tags implied by the event's channel (currently only chat). */
export function channelTags(evt) {
  return evt?.channel === "benchgen" ? [CHAT_TRACE_TAG] : [];
}

/**
 * Put the Benchgen user behind a chat turn on the trace: Langfuse's `user.id`
 * (its own per-user filter, which BenchGen forwards as `userId`) plus the
 * display name in metadata. Only chat turns have a user; runs from cron,
 * heartbeat or the CLI keep the agent id in `user.id` as before.
 */
export function setTraceUser(obs, sender) {
  const span = obs?.otelSpan;
  if (!span || typeof span.setAttribute !== "function") return;
  if (!sender || !sender.id) return;
  span.setAttribute(TRACE_USER_ID, String(sender.id));
  if (sender.name) span.setAttribute("langfuse.trace.metadata.user_name", String(sender.name));
}

export function setTraceTags(obs, tags) {
  const span = obs?.otelSpan;
  if (!span || typeof span.setAttribute !== "function") return;
  if (!Array.isArray(tags) || tags.length === 0) return;
  span.setAttribute(TRACE_TAGS, tags);
}

// Tool names whose work is retrieval/search — these become Langfuse `retriever`
// observations so RAG steps render distinctly from ordinary tool calls. Matched
// case-insensitively as a substring of the tool name.
const RETRIEVER_NAME_RE =
  /(search|retriev|rag\b|vector|embed|semantic|lookup|recall|knowledge|grep|memory|index|web[_-]?fetch|fetch[_-]?url|find)/i;

/**
 * Classify a tool by name into a Langfuse observation type: "retriever" for
 * retrieval/search/RAG tools, "tool" otherwise. The toolSource ("mcp", "core",
 * etc.) is not used for classification but is carried in metadata.
 */
export function classifyToolType(toolName) {
  return typeof toolName === "string" && RETRIEVER_NAME_RE.test(toolName)
    ? "retriever"
    : "tool";
}

/** Map an OpenClaw usage object to Langfuse usageDetails (snake_case keys). */
export function usageDetails(usage = {}) {
  return compact({
    input: usage.input,
    output: usage.output,
    cache_read: usage.cacheRead,
    cache_write: usage.cacheWrite,
    total: usage.total,
  });
}

/** Convert an epoch-ms timestamp to a Date, or undefined. */
export function toDate(ms) {
  return typeof ms === "number" ? new Date(ms) : undefined;
}

/** Attributes for a `generation` observation built from a model.call event. */
export function generationAttributes(evt) {
  return compact({
    model: evt.model,
    metadata: compact({
      provider: evt.provider,
      api: evt.api,
      transport: evt.transport,
      callId: evt.callId,
      runId: evt.runId,
      contextTokenBudget: evt.contextTokenBudget,
      contextWindowSource: evt.contextWindowSource,
    }),
  });
}

/** Attributes for a `tool`/`retriever` observation from a tool.execution event. */
export function toolAttributes(evt) {
  return compact({
    metadata: compact({
      toolSource: evt.toolSource,
      toolOwner: evt.toolOwner,
      toolCallId: evt.toolCallId,
      runId: evt.runId,
      paramsSummary: evt.paramsSummary,
    }),
  });
}

/** Attributes for the per-run root observation. */
export function runAttributes(evt) {
  return compact({
    metadata: compact({
      // Also on the trace as `user.id` and as an `agent:` tag — this copy is the
      // one you read when a trace is open, without decoding a tag. Resolved via
      // `agentIdOf` because `run.started`, which builds the root, has no
      // `agentId` field of its own.
      agentId: agentIdOf(evt),
      runId: evt.runId,
      provider: evt.provider,
      model: evt.model,
      trigger: evt.trigger,
      channel: evt.channel,
    }),
  });
}

/** Attributes for a `context.assembled` observation. */
export function contextAttributes(evt) {
  return compact({
    metadata: compact({
      runId: evt.runId,
      messageCount: evt.messageCount,
      historyTextChars: evt.historyTextChars,
      systemPromptChars: evt.systemPromptChars,
      promptChars: evt.promptChars,
      promptImages: evt.promptImages,
      contextTokenBudget: evt.contextTokenBudget,
    }),
  });
}

/**
 * Human-readable one-line summary of a `context.assembled` event's sizes, used
 * as the observation's `output` so the row isn't blank. The event carries only
 * counts (no text), so this surfaces the numbers that are otherwise buried in
 * metadata. Returns undefined when there's nothing to summarize.
 */
export function contextSummary(evt) {
  const parts = [];
  const add = (label, v) => {
    if (typeof v === "number") parts.push(`${label}=${v}`);
  };
  add("messages", evt.messageCount);
  add("promptChars", evt.promptChars);
  add("systemPromptChars", evt.systemPromptChars);
  add("historyTextChars", evt.historyTextChars);
  add("promptImages", evt.promptImages);
  add("historyImageBlocks", evt.historyImageBlocks);
  add("tokenBudget", evt.contextTokenBudget);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Attributes for an ERROR observation (model.call.error / tool.execution.error). */
export function errorAttributes(evt) {
  return compact({
    level: "ERROR",
    statusMessage: evt.errorCategory ?? evt.failureKind ?? evt.deniedReason,
    metadata: compact({
      provider: evt.provider,
      model: evt.model,
      errorCategory: evt.errorCategory,
      errorCode: evt.errorCode,
      failureKind: evt.failureKind,
      callId: evt.callId,
      runId: evt.runId,
      toolCallId: evt.toolCallId,
    }),
  });
}
