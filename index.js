// benchgen-openclaw
//
// Two jobs, one plugin:
//
// 1. Traces — streams OpenClaw's internal diagnostics bus to Benchgen. Registers
//    a background service that subscribes to the diagnostics event stream and
//    turns each conversation turn into one nested trace (model calls, tool
//    executions, retrieval steps), grouped by session.
//
// 2. Chat — lets Benchgen talk to the agent. The same service keeps an outbound
//    WebSocket to Benchgen (relay) and serves `POST /benchgen/chat` on the
//    gateway; messages arriving either way run as ordinary agent turns and the
//    replies stream back. See chat.js. Chat turns run under channel "benchgen",
//    so job 1 traces them like any other turn — the two are correlated by the
//    session key.
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
import { compact, setTraceFields, setTraceTags } from "./mapping.js";
import { makeContentResolver, makeToolIOResolver } from "./transcript.js";
import { registerBenchgenCli } from "./cli.js";
import {
  CHAT_HTTP_PATH,
  createChatBridge,
  contextForSession,
  createChatHttpHandler,
  isAuthorizedChatRequest,
  missingRuntimeCapabilities,
  resolveChatConfig,
} from "./chat.js";
import { readFileSync } from "node:fs";

const DEFAULT_BASE_URL = "https://traces.benchgen.com";

// Reported to Benchgen in the chat handshake and the relay headers. Read from
// disk rather than imported with an attribute so the plugin loads under every
// loader OpenClaw has shipped.
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  } catch {
    return undefined;
  }
})();

// Name of the handshake trace sent once the exporter is live. Distinct from
// anything the engine emits (it names traces after the channel), so it is easy
// to spot in the list.
const STARTUP_TRACE_NAME = "benchgen.plugin.connected";

// Tagged as well as named, because these accumulate: the service starts on every
// gateway restart AND on every hot reload of the plugin's config, so a week of
// ordinary work leaves a stack of them among real traffic. The name alone is not
// enough — BenchGen's trace list filters by tag, and a tag is what lets somebody
// exclude setup noise (or go looking for exactly it).
const STARTUP_TRACE_TAGS = ["benchgen-setup"];

// How often the idle reaper ends dangling observations (orphaned by dropped
// start/complete events). Kept well under the engine's TTL.
const REAPER_INTERVAL_MS = 60_000;

/**
 * Bridge the CLI's config deps to whatever config runtime the host exposes.
 *
 * OpenClaw >=2026.7.x removed the ambient `api.runtime.config.loadConfig()` /
 * `writeConfigFile()` pair in favor of `current()` (read snapshot) and
 * `mutateConfigFile({ mutate, afterWrite })` (transactional write). We prefer
 * the new surface and fall back to the legacy one only if the host doesn't
 * expose `current`/`mutateConfigFile` (older OpenClaw versions).
 */
function resolveConfigDeps(api) {
  const configRuntime = api.runtime?.config ?? {};
  if (typeof configRuntime.current === "function" && typeof configRuntime.mutateConfigFile === "function") {
    return {
      getConfig: () => configRuntime.current(),
      mutateConfigFile: (opts) => configRuntime.mutateConfigFile(opts),
    };
  }
  // Legacy fallback (pre-2026.7 hosts).
  return {
    getConfig: () => configRuntime.loadConfig(),
    mutateConfigFile: async ({ mutate }) => {
      const draft = configRuntime.loadConfig();
      mutate(draft);
      await configRuntime.writeConfigFile(draft);
    },
  };
}

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
    // Defaults on: the first thing anyone wants after configuring this is
    // evidence that it worked. Off is for gateways that restart often enough
    // for the handshake to be noise.
    startupTrace:
      typeof cfg.startupTrace === "boolean" ? cfg.startupTrace : true,
    // Off by default. What OpenClaw actually puts on a diagnostic event is not
    // documented and differs by host version, so when a field we map turns up
    // empty the only reliable way to find out why is to look at one real event.
    // Config rather than an env var, because plugin config hot-reloads: this can
    // be switched on and off on a running gateway.
    debugEvents: cfg.debugEvents === true,
  };
}

/** Effective chat-bridge settings (see chat.js for the field list). */
function resolveChat(pluginConfig) {
  return resolveChatConfig(pluginConfig, { baseUrl: resolveConfig(pluginConfig).baseUrl });
}

/**
 * Emit one trace as soon as the exporter is live, to prove the gateway is wired
 * up.
 *
 * Until something arrives, a correctly configured gateway and one that never
 * loaded this plugin look identical from Benchgen's side — an empty trace list.
 * Every step in between is invisible from there: keys pasted, env set, config
 * applied, gateway restarted, plugin loaded, exporter constructed. This is the
 * one point in the whole chain that knows all of them succeeded, so it is the
 * only place that can honestly say so.
 *
 * Force-flushed instead of left to the batch processor, because the entire value
 * is landing while somebody is still watching the page they just configured.
 *
 * Never allowed to fail the service. A transient network fault at boot would
 * stop this handshake while leaving real streaming perfectly able to recover, and
 * refusing to start over a failed diagnostic trades a nicety for an outage.
 */
async function emitStartupTrace({ ctx, spanProcessor, baseUrl }) {
  try {
    const obs = startObservation(
      STARTUP_TRACE_NAME,
      compact({
        input: "Gateway startup handshake",
        output: `Plugin loaded and streaming to ${baseUrl}`,
        metadata: compact({
          source: "benchgen-openclaw",
          purpose: "setup verification",
          baseUrl,
        }),
      }),
      compact({ asType: "agent", startTime: new Date() }),
    );
    setTraceFields(obs, STARTUP_TRACE_NAME, undefined);
    setTraceTags(obs, STARTUP_TRACE_TAGS);
    obs.end(new Date());
    await spanProcessor.forceFlush();
    ctx.logger.info(
      `benchgen: sent startup trace "${STARTUP_TRACE_NAME}" to ${baseUrl}`,
    );
  } catch (err) {
    ctx.logger.warn(
      `benchgen: startup trace failed, streaming is still active: ${err?.message ?? err}`,
    );
  }
}

/**
 * Start the chat bridge for this service run, or explain (once, in the log) why
 * it cannot. Never throws: chat is additive, and a problem here must not stop
 * trace streaming.
 */
async function startChatBridge({ api, ctx, chat, publicKey, secretKey }) {
  if (!chat.enabled) {
    ctx.logger.info("benchgen chat: disabled via config (chat.enabled === false)");
    return null;
  }
  const missing = missingRuntimeCapabilities(api.runtime);
  if (missing.length > 0) {
    ctx.logger.warn(
      `benchgen chat: this OpenClaw does not expose ${missing.join(", ")}; chat bridge not started (traces unaffected)`,
    );
    return null;
  }
  const bridge = createChatBridge({
    runtime: api.runtime,
    // Live config: a hot reload of openclaw.json (new agent, new bindings) must
    // be seen by the next turn, and this is the snapshot the host itself uses.
    getConfig: () =>
      typeof api.runtime?.config?.current === "function"
        ? api.runtime.config.current()
        : (ctx.config ?? api.config),
    chatConfig: chat,
    publicKey,
    secretKey,
    pluginVersion: PLUGIN_VERSION,
    logger: ctx.logger,
  });
  try {
    await bridge.start();
  } catch (err) {
    ctx.logger.warn(`benchgen chat: relay failed to start: ${err?.message ?? err}`);
  }
  return bridge;
}

function createBenchgenService(api, chatState) {
  const getPluginConfig = () => api.pluginConfig;
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
      const { enabled, publicKey, secretKey, baseUrl, startupTrace, debugEvents } =
        resolveConfig(getPluginConfig());

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

      // Chat first: it needs the keys but not the diagnostics bus, so a gateway
      // with diagnostics switched off can still be chatted with from Benchgen.
      chatState.bridge = await startChatBridge({
        api,
        ctx,
        chat: resolveChat(getPluginConfig()),
        publicKey,
        secretKey,
      });

      if (!isDiagnosticsEnabled(ctx.config)) {
        ctx.logger.warn(
          "benchgen: diagnostics are disabled (config.diagnostics.enabled === false); no trace events will be emitted, tracing not started",
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
      // transcript (read via the storage-neutral session-transcript-runtime SDK
      // surface, with a legacy .trajectory.jsonl file fallback under
      // ctx.stateDir for older hosts) to populate observation IO.
      const resolveContent = makeContentResolver(ctx.stateDir, ctx.logger);
      const resolveToolIO = makeToolIOResolver(ctx.stateDir, ctx.logger);

      engine = createTraceEngine(tracing, {
        logger: ctx.logger,
        resolveContent,
        resolveToolIO,
        // Who is chatting, by session key (chat.js remembers it per turn).
        // Read through chatState so the bridge may start after the engine.
        resolveSender: (sessionKey) => chatState.bridge?.senderOf?.(sessionKey) ?? null,
      });

      // `onInternalDiagnosticEvent` invokes the listener as
      // (event, metadata) => void. We only need the event body; the engine
      // ignores unrelated event types and catches its own errors, so it never
      // throws into the bus.
      // One line per event type, first occurrence only: the point is the shape,
      // and an unfiltered dump of a busy gateway buries it. Values are printed
      // for the identity fields we map and nothing else, so this never puts
      // prompt or tool content in the logs.
      const shapesSeen = new Set();
      const logShape = (evt) => {
        const type = evt?.type || "(no type)";
        if (shapesSeen.has(type)) return;
        shapesSeen.add(type);
        ctx.logger.info(
          `benchgen[debug] ${type} keys=[${Object.keys(evt || {}).join(",")}] ` +
            `agentId=${JSON.stringify(evt?.agentId)} sessionId=${JSON.stringify(evt?.sessionId)} ` +
            `sessionKey=${JSON.stringify(evt?.sessionKey)}`,
        );
      };

      unsubscribe = onInternalDiagnosticEvent((evt) => {
        if (debugEvents) {
          try {
            logShape(evt);
          } catch {
            /* diagnostics must never break the pipeline */
          }
        }
        engine?.handle(evt);
      });

      // Idle reaper: ends observations orphaned by dropped start/complete events
      // (these event types are async-queued and droppable under load). Unref'd
      // so it never keeps the process alive.
      reaper = setInterval(() => engine?.sweep(), REAPER_INTERVAL_MS);
      reaper.unref?.();

      ctx.logger.info(
        `benchgen: subscribed to diagnostics; streaming nested run traces to ${baseUrl}`,
      );

      // After subscribing, and deliberately not awaited: the flush is a network
      // round trip, and `start` is awaited by the host. Holding gateway startup
      // open for a diagnostic would be the wrong trade — and events arriving
      // during the flush are already being captured by the subscription above.
      if (startupTrace) {
        void emitStartupTrace({ ctx, spanProcessor, baseUrl });
      }
    },

    async stop() {
      // Chat: stop taking new relay messages first. Turns already running keep
      // going until the host tears the process down; their remaining replies go
      // to the relay outbox and are dropped with it.
      const bridge = chatState.bridge;
      chatState.bridge = null;
      try {
        await bridge?.stop();
      } catch {
        // best-effort
      }
      try {
        unsubscribe?.();
      } finally {
        unsubscribe = null;
      }
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
      // End any still-open observations before the provider shuts down. Awaited:
      // finalization now reads the session transcript asynchronously.
      try {
        await engine?.flushAll();
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
    // Shared between the service (which owns the bridge's lifetime) and the HTTP
    // route (which OpenClaw wants registered at load time and which must keep
    // answering — with 503 — while the service is stopped or restarting).
    const chatState = { bridge: null };
    api.registerService(createBenchgenService(api, chatState));

    // Phase 4a: the platform's per-user context block (sent by the Benchgen
    // relay with each turn of a platform agent) goes into the system context of
    // that turn, not into the user message: it stays out of the session history
    // and out of the model router's routing text. Typed hook since 2026.7.2;
    // older hosts have no `api.on` and simply run without the block.
    // Read through the process-global store, NOT through chatState: this hook
    // runs in the agent runtime's plugin instance, whose chatState has no bridge
    // (OpenClaw calls register() once per instance in the same process).
    if (typeof api.on === "function") {
      api.on("before_prompt_build", (_event, ctx) => {
        const context = contextForSession(ctx?.sessionKey);
        return context ? { prependSystemContext: context } : undefined;
      });
    }

    // Direct chat endpoint on the gateway port: POST /benchgen/chat, authorized
    // with the Benchgen project keys (the gateway's own token is not involved —
    // `auth: "plugin"` hands auth to us). Registered whenever the config asks
    // for it; whether a bridge is live to serve it is the service's business.
    const chat = resolveChat(api.pluginConfig);
    if (chat.enabled && chat.httpEndpoint && typeof api.registerHttpRoute === "function") {
      api.registerHttpRoute({
        path: CHAT_HTTP_PATH,
        auth: "plugin",
        match: "exact",
        replaceExisting: true,
        handler: createChatHttpHandler({
          getBridge: () => chatState.bridge,
          // Keys resolved per request so a hot-reloaded key change applies at once.
          authorize: (header) => {
            const { publicKey, secretKey } = resolveConfig(api.pluginConfig);
            return isAuthorizedChatRequest(header, { publicKey, secretKey });
          },
          logger: api.logger,
        }),
      });
      api.logger?.info?.(`benchgen chat: registered ${CHAT_HTTP_PATH} on the gateway`);
    }

    // Opik-style interactive setup: `openclaw benchgen configure` / `status`.
    // No manual openclaw.json editing required. Guarded so the plugin still
    // loads on hosts/older SDKs that don't expose registerCli.
    // NOTE: do NOT guard on api.runtime?.config here — that check silently
    // prevents CLI registration, causing "No built-in command or plugin CLI
    // metadata owns 'benchgen'" on any SDK version where api.runtime is
    // populated lazily or restructured. The callback is only invoked at
    // command-execution time (not at registration), so runtime.config is
    // safely accessed inside without blocking route registration.
    if (typeof api.registerCli === "function") {
      api.registerCli(
        ({ program }) =>
          registerBenchgenCli({
            program,
            ...resolveConfigDeps(api),
          }),
        { commands: ["benchgen"] },
      );
    }
  },
});
