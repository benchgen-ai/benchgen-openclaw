// benchgen-openclaw
//
// Streams OpenClaw's internal diagnostics bus to Benchgen. Registers a
// background service that subscribes to the diagnostics event stream and turns
// each conversation turn into one nested trace (model calls, tool executions,
// retrieval steps), grouped by session.
//
// Transport: the service is built on an OpenTelemetry-based tracing SDK and runs
// its SpanProcessor inside a dedicated, isolated TracerProvider so it never
// touches OpenClaw's own global OTel setup (the bundled `diagnostics-otel`
// service). Tracing helpers emit through our provider only.
//
// Subscription note: we subscribe via the public `onInternalDiagnosticEvent`
// SDK export rather than the privileged `ctx.internalDiagnostics.onEvent`
// capability (which is injected only for bundled diagnostics services). The
// public listener delivers the event bodies we map (minus private message
// content, which we recover best-effort from the session trajectory transcript).

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  onInternalDiagnosticEvent,
  isDiagnosticsEnabled,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import { createTraceEngine } from "./tracer.js";
import { makeContentResolver, makeToolIOResolver } from "./transcript.js";
import { registerBenchgenCli } from "./cli.js";

const DEFAULT_BASE_URL = "https://benchgen.com";

// How often the idle reaper ends dangling observations (orphaned by dropped
// start/complete events). Kept well under the engine's TTL.
const REAPER_INTERVAL_MS = 60_000;

/**
 * Resolve effective config from the plugin's scoped config block
 * (openclaw.json -> plugins.entries["benchgen"].config) with
 * environment-variable fallbacks.
 */
function resolveConfig(pluginConfig) {
  const cfg = pluginConfig ?? {};
  return {
    enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : true,
    publicKey: cfg.publicKey ?? process.env.BENCHGEN_PUBLIC_KEY,
    secretKey: cfg.secretKey ?? process.env.BENCHGEN_SECRET_KEY,
    baseUrl: cfg.baseUrl ?? process.env.BENCHGEN_BASE_URL ?? DEFAULT_BASE_URL,
  };
}

function createBenchgenService(getPluginConfig) {
  /** @type {import("@opentelemetry/sdk-trace-node").NodeTracerProvider | null} */
  let provider = null;
  /** @type {import("@langfuse/otel").LangfuseSpanProcessor | null} */
  let spanProcessor = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {ReturnType<typeof createTraceEngine> | null} */
  let engine = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let reaper = null;

  return {
    id: "benchgen",

    async start(ctx) {
      const { enabled, publicKey, secretKey, baseUrl } = resolveConfig(
        getPluginConfig(),
      );

      if (!enabled) {
        ctx.logger.info("benchgen: disabled via config (enabled === false); not starting");
        return;
      }

      if (!publicKey || !secretKey) {
        ctx.logger.warn(
          "benchgen: missing publicKey/secretKey (run `openclaw benchgen configure`, set plugin config, or BENCHGEN_PUBLIC_KEY/BENCHGEN_SECRET_KEY); not starting",
        );
        return;
      }

      if (!isDiagnosticsEnabled(ctx.config)) {
        ctx.logger.warn(
          "benchgen: diagnostics are disabled (config.diagnostics.enabled === false); no events will be emitted, not starting",
        );
        return;
      }

      // Isolated OTel pipeline: our SpanProcessor lives on a dedicated provider,
      // and we point the tracing helpers at it. This keeps us off the global
      // tracer provider that OpenClaw's diagnostics-otel may own.
      spanProcessor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
      provider = new NodeTracerProvider({ spanProcessors: [spanProcessor] });
      setLangfuseTracerProvider(provider);

      const tracing = { startObservation };

      // Prompt/response text and tool args/results are not delivered to
      // third-party plugins (they're private data given only to bundled
      // services), so we recover them best-effort from OpenClaw's per-session
      // trajectory transcript under ctx.stateDir to populate observation IO.
      const resolveContent = makeContentResolver(ctx.stateDir, ctx.logger);
      const resolveToolIO = makeToolIOResolver(ctx.stateDir, ctx.logger);

      engine = createTraceEngine(tracing, {
        logger: ctx.logger,
        resolveContent,
        resolveToolIO,
      });

      // `onInternalDiagnosticEvent` invokes the listener as
      // (event, metadata) => void. We only need the event body; the engine
      // ignores unrelated event types and catches its own errors, so it never
      // throws into the bus.
      unsubscribe = onInternalDiagnosticEvent((evt) => engine?.handle(evt));

      // Idle reaper: ends observations orphaned by dropped start/complete events
      // (these event types are async-queued and droppable under load). Unref'd
      // so it never keeps the process alive.
      reaper = setInterval(() => engine?.sweep(), REAPER_INTERVAL_MS);
      reaper.unref?.();

      ctx.logger.info(
        `benchgen: subscribed to diagnostics; streaming nested run traces to ${baseUrl}`,
      );
    },

    async stop() {
      try {
        unsubscribe?.();
      } finally {
        unsubscribe = null;
      }
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
      // End any still-open observations before the provider shuts down.
      try {
        engine?.flushAll();
      } catch {
        // best-effort flush of in-flight observations
      }
      engine = null;
      // Restore the default (global) provider for the tracing helpers.
      setLangfuseTracerProvider(null);
      if (spanProcessor) {
        try {
          await spanProcessor.forceFlush();
        } catch {
          // best-effort flush on shutdown
        }
      }
      if (provider) {
        try {
          await provider.shutdown();
        } catch {
          // best-effort shutdown
        }
      }
      spanProcessor = null;
      provider = null;
    },
  };
}

export default definePluginEntry({
  id: "benchgen",
  name: "Benchgen",
  description:
    "Stream OpenClaw agent traces to Benchgen for observability and training-data capture",
  register(api) {
    api.registerService(createBenchgenService(() => api.pluginConfig));

    // Opik-style interactive setup: `openclaw benchgen configure` / `status`.
    // No manual openclaw.json editing required. Guarded so the plugin still
    // loads on hosts/older SDKs that don't expose registerCli.
    if (typeof api.registerCli === "function" && api.runtime?.config) {
      api.registerCli(
        ({ program }) =>
          registerBenchgenCli({
            program,
            loadConfig: api.runtime.config.loadConfig,
            writeConfigFile: api.runtime.config.writeConfigFile,
          }),
        { commands: ["benchgen"] },
      );
    }
  },
});
