// benchgen-openclaw configure wizard
//
// Interactive setup that stores Benchgen keys in openclaw.json under
// plugins.entries.benchgen.config. No manual JSON editing required.
//
// Benchgen has a single ingest backend, so setup is intentionally short:
//   1. Public key
//   2. Secret key
//   3. Endpoint (optional, defaults to Benchgen cloud)
// Keys are validated against the ingest health endpoint before saving.

import * as p from "@clack/prompts";

const BENCHGEN_PLUGIN_ID = "benchgen";
const DEFAULT_BASE_URL = "https://benchgen.com";
const BENCHGEN_DASHBOARD_URL = "https://app.benchgen.com";

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value;
}

/** Read the current benchgen plugin entry from an OpenClaw config object. */
export function getBenchgenPluginEntry(cfg) {
  const root = asObject(cfg);
  const plugins = asObject(root.plugins);
  const entries = asObject(plugins.entries);
  const entry = asObject(entries[BENCHGEN_PLUGIN_ID]);
  const config = asObject(entry.config);
  return {
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
    config,
  };
}

/** Merge a config patch into plugins.entries.benchgen, returning a new config. */
export function setBenchgenPluginEntry(cfg, config, enabled = true) {
  const root = asObject(cfg);
  const plugins = asObject(root.plugins);
  const entries = asObject(plugins.entries);
  const existingEntry = asObject(entries[BENCHGEN_PLUGIN_ID]);
  const nextEntries = {
    ...entries,
    [BENCHGEN_PLUGIN_ID]: {
      ...existingEntry,
      enabled,
      config: {
        ...asObject(existingEntry.config),
        ...config,
      },
    },
  };
  return {
    ...root,
    plugins: {
      ...plugins,
      entries: nextEntries,
    },
  };
}

function normalizeUrl(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Verify keys work by calling the ingest health endpoint.
 * Accepts 2xx-4xx (server reachable + auth recognised). Best-effort: any
 * network failure returns false so we can warn but still let the user save.
 */
async function isBenchgenAccessible(baseUrl, publicKey, secretKey, timeoutMs = 5_000) {
  try {
    const healthUrl = `${normalizeUrl(baseUrl)}/api/public/health`;
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const res = await fetch(healthUrl, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Run the interactive Benchgen setup wizard.
 * @param {{ loadConfig: () => any, writeConfigFile: (cfg: any) => Promise<void> }} deps
 */
export async function runBenchgenConfigure(deps) {
  p.intro("Benchgen setup");
  p.log.info(`Grab your project keys from the Benchgen dashboard:\n${BENCHGEN_DASHBOARD_URL}`);

  const existing = getBenchgenPluginEntry(deps.loadConfig()).config;

  const publicKeyInput = await p.text({
    message: "Enter your Benchgen public key:",
    placeholder: "pk-...",
    initialValue: typeof existing.publicKey === "string" ? existing.publicKey : undefined,
    validate(value) {
      if (!value || !value.trim()) return "Public key is required";
    },
  });
  if (p.isCancel(publicKeyInput)) {
    p.cancel("Setup cancelled.");
    return;
  }
  const publicKey = publicKeyInput.trim();

  const secretKeyInput = await p.password({
    message: "Enter your Benchgen secret key:",
    validate(value) {
      if (!value || !value.trim()) return "Secret key is required";
    },
  });
  if (p.isCancel(secretKeyInput)) {
    p.cancel("Setup cancelled.");
    return;
  }
  const secretKey = secretKeyInput.trim();

  const baseUrlInput = await p.text({
    message: "Benchgen endpoint (press Enter for default):",
    placeholder: DEFAULT_BASE_URL,
    initialValue:
      typeof existing.baseUrl === "string" && existing.baseUrl ? existing.baseUrl : DEFAULT_BASE_URL,
    validate(value) {
      if (!value || !value.trim()) return undefined;
      try {
        new URL(value.trim());
      } catch {
        return "Invalid URL format (e.g. https://benchgen.com)";
      }
    },
  });
  if (p.isCancel(baseUrlInput)) {
    p.cancel("Setup cancelled.");
    return;
  }
  const baseUrl = normalizeUrl((baseUrlInput || DEFAULT_BASE_URL).trim());

  // Validate connectivity + keys (best-effort — allow saving on failure).
  const spinner = p.spinner();
  spinner.start("Verifying keys...");
  const accessible = await isBenchgenAccessible(baseUrl, publicKey, secretKey);
  spinner.stop(accessible ? "Keys verified." : "Could not verify keys.");

  if (!accessible) {
    const proceed = await p.confirm({
      message: `Couldn't reach Benchgen at ${baseUrl} with these keys. Save anyway?`,
      initialValue: true,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Setup cancelled.");
      return;
    }
  }

  const cfg = deps.loadConfig();
  const nextCfg = setBenchgenPluginEntry(
    cfg,
    { enabled: true, publicKey, secretKey, baseUrl },
    true,
  );
  await deps.writeConfigFile(nextCfg);

  p.note(
    [
      `Endpoint:    ${baseUrl}`,
      `Public key:  ${publicKey}`,
      `Secret key:  ***`,
      "",
      `Dashboard:   ${BENCHGEN_DASHBOARD_URL}`,
    ].join("\n"),
    "Benchgen configuration saved",
  );
  p.outro("Restart the gateway to apply changes.");
}

/**
 * Print the current Benchgen configuration (config file + env fallbacks).
 * @param {{ loadConfig: () => any }} deps
 */
export function showBenchgenStatus(deps) {
  const entry = getBenchgenPluginEntry(deps.loadConfig());
  const cfg = entry.config;

  const publicKey = cfg.publicKey ?? process.env.BENCHGEN_PUBLIC_KEY;
  const secretKey = cfg.secretKey ?? process.env.BENCHGEN_SECRET_KEY;
  const baseUrl = cfg.baseUrl ?? process.env.BENCHGEN_BASE_URL ?? DEFAULT_BASE_URL;

  if (entry.enabled === undefined && !publicKey && !secretKey) {
    console.log("Benchgen is not configured. Run: openclaw benchgen configure");
    return;
  }

  const enabled = entry.enabled !== false && cfg.enabled !== false;
  const source = (fromConfig) => (fromConfig ? "config" : "env");

  const lines = [
    "Benchgen configuration:",
    `  Enabled:     ${enabled ? "yes" : "no"}`,
    `  Endpoint:    ${baseUrl}`,
    `  Public key:  ${publicKey ? `${publicKey} (${source(cfg.publicKey != null)})` : "(not set)"}`,
    `  Secret key:  ${secretKey ? `*** (${source(cfg.secretKey != null)})` : "(not set)"}`,
  ];
  console.log(lines.join("\n"));
}
