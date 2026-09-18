// Trace mirror: a second Benchgen project that receives a copy of every trace
// this gateway emits. The case it exists for: a dev gateway whose traces must
// also land in the production project, so nothing is lost for later training
// and benchmark work, while the dev project keeps receiving them as before.
// Only tracing is mirrored; chat stays on the primary keys.
//
// Pure config resolution lives here so it can be unit tested without the OTel
// pipeline (index.js wires the resolved target into a second span processor).

const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const sameUrl = (a, b) => String(a ?? "").replace(/\/+$/, "") === String(b ?? "").replace(/\/+$/, "");

/**
 * Resolve `plugins.entries.benchgen.config.mirror` with BENCHGEN_MIRROR_*
 * environment fallbacks. `primary` is the already resolved primary target: the
 * mirror inherits its baseUrl when none is given, and is refused when it would
 * point at the very same project (that would only send every trace twice).
 *
 * `enabled: false` always comes with a `reason`; "not configured" is the quiet
 * one (no keys anywhere), everything else deserves a warning in the log.
 *
 * @param {object | undefined} pluginConfig
 * @param {{ primary?: { publicKey?: string, baseUrl?: string } }} [opts]
 * @returns {{ enabled: boolean, reason?: string, publicKey?: string, secretKey?: string, baseUrl?: string, environment?: string }}
 */
export function resolveMirrorConfig(pluginConfig, { primary } = {}) {
  const cfg = pluginConfig?.mirror ?? {};
  const publicKey = trimmed(cfg.publicKey) ?? trimmed(process.env.BENCHGEN_MIRROR_PUBLIC_KEY);
  const secretKey = trimmed(cfg.secretKey) ?? trimmed(process.env.BENCHGEN_MIRROR_SECRET_KEY);
  const baseUrl =
    trimmed(cfg.baseUrl) ?? trimmed(process.env.BENCHGEN_MIRROR_BASE_URL) ?? trimmed(primary?.baseUrl);
  const environment = trimmed(cfg.environment) ?? trimmed(process.env.BENCHGEN_MIRROR_ENVIRONMENT);
  const target = { publicKey, secretKey, baseUrl, environment };

  if (cfg.enabled === false) {
    return { enabled: false, reason: "disabled via config (mirror.enabled === false)", ...target };
  }
  if (!publicKey && !secretKey) {
    return { enabled: false, reason: "not configured", ...target };
  }
  if (!publicKey || !secretKey) {
    return { enabled: false, reason: "mirror needs both publicKey and secretKey", ...target };
  }
  if (!baseUrl) {
    return { enabled: false, reason: "mirror has no baseUrl", ...target };
  }
  if (primary && publicKey === primary.publicKey && sameUrl(baseUrl, primary.baseUrl)) {
    return {
      enabled: false,
      reason: "mirror points at the primary project; refusing to send every trace twice",
      ...target,
    };
  }
  return { enabled: true, ...target };
}

/** One-line human description for logs and `openclaw benchgen show`. */
export function describeMirror(mirror) {
  if (!mirror.enabled) return mirror.reason === "not configured" ? "off" : `off (${mirror.reason})`;
  const env = mirror.environment ? `, environment ${mirror.environment}` : "";
  return `${mirror.baseUrl} (${mirror.publicKey}${env})`;
}
