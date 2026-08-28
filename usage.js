/**
 * Per-turn token accounting for the Benchgen relay (plugin 0.5.3).
 *
 * LiteLLM knows what the gateway spent but not for whom: every user's turn
 * goes out with the gateway's one key. The relay does know who is talking
 * (the sender of the turn), so the plugin adds up the `model.usage` events of
 * a turn and reports the sum back in a `turn.usage` frame after `turn.done`.
 * Benchgen stores one row per turn and answers "who used the agent, how much"
 * from that.
 *
 * The events are consumed by the tracer, which may live in another plugin
 * instance than the turn runner (OpenClaw registers the plugin once per
 * instance in one process), so the accumulator is process-global under a
 * `Symbol.for` key, like the context and credential stores in chat.js.
 */

const USAGE_STORE_KEY = Symbol.for("@benchgen/benchgen-openclaw/session-usage");
function usageStore() {
  return (globalThis[USAGE_STORE_KEY] ??= new Map());
}

/** How long after turn.done to wait for the last model.usage to land. */
export const USAGE_SETTLE_MS = 1500;

const MAX_SESSIONS = 5000;

function emptyUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, costUsd: null, model: null };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Start counting for a session: what came before belongs to the previous turn. */
export function beginTurnUsage(sessionKey) {
  if (!sessionKey) return;
  const store = usageStore();
  if (store.size >= MAX_SESSIONS && !store.has(sessionKey)) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.delete(sessionKey);
  store.set(sessionKey, emptyUsage());
}

/**
 * Fold one OpenClaw `model.usage` event into its session's running total.
 * Field names follow the diagnostics event: `usage.{input,output,total,
 * cacheRead}`, `costUsd`, `model`, `sessionKey`. Events for sessions no turn
 * runner started (other channels, heartbeats) are ignored.
 */
export function recordModelUsage(evt) {
  const sessionKey = evt?.sessionKey;
  if (!sessionKey) return;
  const store = usageStore();
  const acc = store.get(sessionKey);
  if (!acc) return;
  const u = evt.usage && typeof evt.usage === "object" ? evt.usage : {};
  const input = num(u.input);
  const output = num(u.output);
  acc.calls += 1;
  acc.inputTokens += input;
  acc.outputTokens += output;
  acc.totalTokens += num(u.total) || input + output;
  acc.cacheReadTokens += num(u.cacheRead);
  if (typeof evt.costUsd === "number" && Number.isFinite(evt.costUsd)) {
    acc.costUsd = (acc.costUsd ?? 0) + evt.costUsd;
  }
  if (typeof evt.model === "string" && evt.model) acc.model = evt.model;
}

/** The session's total since `beginTurnUsage`, and forget it. Null when never started. */
export function takeTurnUsage(sessionKey) {
  if (!sessionKey) return null;
  const store = usageStore();
  const acc = store.get(sessionKey) ?? null;
  store.delete(sessionKey);
  return acc;
}

/** Read without clearing (tests, diagnostics). */
export function peekTurnUsage(sessionKey) {
  return (sessionKey && usageStore().get(sessionKey)) || null;
}
