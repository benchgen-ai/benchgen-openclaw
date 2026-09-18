// Private data guard: keep tool calls away from locations that only some
// sessions may read. The case it exists for: one gateway serves both the public
// BenchGen platform chat and a team Telegram group, and the team's internal
// repos are mounted on the same disk. Platform users must not reach them, the
// team group must.
//
// Deny by default: a call that references a private path is blocked unless its
// session key contains one of the allowed fragments (a Telegram group id, the
// owner's id, "agent:main:main"). Matching is on substrings of the session key,
// so it does not depend on the exact key format of a channel.
//
// This is a guard rail, not a sandbox: it matches the literal path in the tool
// parameters, so a shell command that builds the path indirectly (globs,
// variables, encodings) is not caught. It stops ordinary requests and honest
// mistakes; real isolation of hostile users needs a separate gateway.

const list = (v) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);

/** Collapse `//` and `/./` so trivial spellings of a path still match. */
const normalizePathText = (s) => s.replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/");

/**
 * Resolve `plugins.entries.benchgen.config.privateData` with environment
 * fallbacks (BENCHGEN_PRIVATE_PATHS, BENCHGEN_PRIVATE_ALLOW_SESSIONS, both
 * comma separated). No paths means the guard is off.
 *
 * @returns {{ paths: string[], allowSessions: string[] }}
 */
export function resolvePrivateData(pluginConfig) {
  const cfg = pluginConfig?.privateData ?? {};
  const paths = list(cfg.paths).length ? list(cfg.paths) : list(process.env.BENCHGEN_PRIVATE_PATHS);
  const allowSessions = list(cfg.allowSessions).length
    ? list(cfg.allowSessions)
    : list(process.env.BENCHGEN_PRIVATE_ALLOW_SESSIONS);
  return {
    // Match "/data/repos" and "/data/repos/" alike.
    paths: paths.map((p) => normalizePathText(p).replace(/\/+$/, "")).filter(Boolean),
    allowSessions,
  };
}

/**
 * The private path a tool call touches from a session that may not, or null.
 *
 * @param {{ sessionKey?: string, params?: unknown }} call
 * @param {{ paths: string[], allowSessions: string[] }} guard
 */
export function privateAccessHit({ sessionKey, params }, guard) {
  if (!guard?.paths?.length) return null;
  const key = typeof sessionKey === "string" ? sessionKey : "";
  if (key && guard.allowSessions.some((fragment) => key.includes(fragment))) return null;
  let text;
  try {
    text = normalizePathText(typeof params === "string" ? params : JSON.stringify(params ?? ""));
  } catch {
    return null; // unserialisable params carry no path we could match
  }
  return guard.paths.find((p) => text.includes(p)) ?? null;
}

/** What the model is told when a call is blocked. */
export const PRIVATE_BLOCK_REASON =
  "This location holds internal data that is not available in this conversation. " +
  "Do not look for another way to read it. Tell the user this information is not available here.";
