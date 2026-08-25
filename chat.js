// benchgen-openclaw chat bridge
//
// Lets Benchgen talk to the OpenClaw agent through this plugin, in both network
// directions:
//
//   relay  — the plugin opens an outbound WebSocket to Benchgen and keeps it
//            alive. Benchgen pushes chat messages down that socket, the plugin
//            runs each one as a normal agent turn and streams the reply back up.
//            Works when the gateway sits behind NAT / a private network, which is
//            the common case (a laptop, a docker container, a VPS with no
//            inbound ports), because the gateway is the one that connects out.
//
//   http   — the plugin registers `POST /benchgen/chat` on the gateway's own
//            HTTP port. When Benchgen (or curl) can reach the gateway directly,
//            a message can be sent as one request and the reply comes back as
//            JSON or as an SSE stream. Same turn runner, same event shapes.
//
// Both directions run the turn through OpenClaw's own channel machinery
// (`api.runtime.channel.inbound.dispatch`, the same entry point bundled channels
// such as qa-channel and nostr use), so the agent gets its normal system prompt,
// tools, session store and permissions, and the turn shows up on the diagnostics
// bus like any other — which means the tracer in this plugin streams it to
// Benchgen as a trace with `channel: "benchgen"` and the conversation id in the
// session key. Chat and trace are correlated for free.
//
// Everything Benchgen-facing is JSON. The wire protocol is documented in the
// README ("Chat protocol"); `CHAT_PROTOCOL_VERSION` is bumped when a message
// shape changes incompatibly.

import { randomUUID, timingSafeEqual } from "node:crypto";

export const CHAT_PROTOCOL_VERSION = 1;

/** Channel id the chat turns run under. Shows up as the trace name and inside the session key. */
export const CHAT_CHANNEL_ID = "benchgen";
export const CHAT_CHANNEL_LABEL = "Benchgen";

/** Gateway HTTP path served when `chat.httpEndpoint` is on. */
export const CHAT_HTTP_PATH = "/benchgen/chat";

/** Path the Benchgen relay listens on. */
export const CHAT_RELAY_PATH = "/api/public/openclaw/chat";

/**
 * Where the relay lives when nothing overrides it: the public BenchGen site
 * (same host as the default `baseUrl`), which proxies this one path to the
 * platform's relay. A constant, not derived from `baseUrl`: an operator who
 * pointed traces at a dedicated ingest host has not thereby moved the relay.
 * `chat.url` / `BENCHGEN_CHAT_URL` override it — the BenchGen agent page shows
 * the exact value for its environment (dev/UAT are on other hostnames).
 */
export const DEFAULT_RELAY_URL = "wss://benchgen.com" + CHAT_RELAY_PATH;

const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_SENDER_ID = "benchgen";
const DEFAULT_SENDER_NAME = "Benchgen";

// Reconnect backoff for the relay. Starts fast (a gateway restart usually beats
// the server-side reconnect window) and caps low enough that a Benchgen outage
// is noticed within a minute of it ending.
const RELAY_MIN_BACKOFF_MS = 1_000;
const RELAY_MAX_BACKOFF_MS = 60_000;
// Ping cadence + how long to wait for the pong before declaring the socket dead.
// Half-open TCP connections (laptop sleep, NAT table expiry) otherwise look
// connected forever from this side.
const RELAY_PING_INTERVAL_MS = 30_000;
const RELAY_PONG_TIMEOUT_MS = 10_000;
// Replies produced while the relay is down are held for the reconnect. Bounded
// so a long outage cannot grow memory without limit; the oldest are dropped.
const RELAY_OUTBOX_MAX = 500;

// Inbound message text cap. The agent's own context limits apply after this,
// but a runaway client should not be able to hand the gateway megabytes.
const MAX_MESSAGE_CHARS = 200_000;
// HTTP request body cap for the gateway endpoint.
const MAX_HTTP_BODY_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function envBool(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

/**
 * Relay URL on the same host as a Benchgen base URL: ws(s) scheme,
 * `CHAT_RELAY_PATH`. Not the default any more (see DEFAULT_RELAY_URL) — kept
 * for deployments that colocate relay and ingest and want `chat.url` to follow
 * `baseUrl`. Returns undefined when the base URL is unusable.
 */
export function defaultRelayUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  try {
    const u = new URL(baseUrl.trim());
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    else if (u.protocol !== "ws:" && u.protocol !== "wss:") return undefined;
    u.pathname = CHAT_RELAY_PATH;
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the `chat` block of the plugin config with env fallbacks.
 *
 *   plugins.entries.benchgen.config.chat = {
 *     enabled:      boolean   default true
 *     relay:        boolean   default true   — keep an outbound socket to Benchgen
 *     url:          string    default DEFAULT_RELAY_URL (BENCHGEN_CHAT_URL)
 *     httpEndpoint: boolean   default true   — serve POST /benchgen/chat on the gateway
 *     sessionScope: "conversation" | "main"  default "conversation"
 *     agentId:      string    optional default agent for inbound messages
 *   }
 */
export function resolveChatConfig(pluginConfig, { baseUrl } = {}) {
  const cfg = pluginConfig?.chat ?? {};
  const url =
    (typeof cfg.url === "string" && cfg.url.trim()) ||
    (typeof process.env.BENCHGEN_CHAT_URL === "string" && process.env.BENCHGEN_CHAT_URL.trim()) ||
    DEFAULT_RELAY_URL;
  const sessionScope = cfg.sessionScope === "main" ? "main" : "conversation";
  return {
    enabled: boolOr(cfg.enabled, envBool("BENCHGEN_CHAT_ENABLED") ?? true),
    relay: boolOr(cfg.relay, true),
    url,
    httpEndpoint: boolOr(cfg.httpEndpoint, true),
    sessionScope,
    agentId: typeof cfg.agentId === "string" && cfg.agentId.trim() ? cfg.agentId.trim() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Inbound message normalization
// ---------------------------------------------------------------------------

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Validate + normalize a chat message from Benchgen (relay frame body or HTTP
 * body). Returns `{ ok: true, message }` or `{ ok: false, error }` — never
 * throws, because the input is untrusted network data.
 */
export function normalizeInboundMessage(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "message must be an object" };
  const text = typeof raw.text === "string" ? raw.text : undefined;
  if (text === undefined || !text.trim()) return { ok: false, error: "text is required" };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `text exceeds ${MAX_MESSAGE_CHARS} characters` };
  }
  const conversationId = optionalString(raw.conversationId) ?? randomUUID();
  const messageId = optionalString(raw.messageId) ?? randomUUID();
  const sender = raw.sender && typeof raw.sender === "object" ? raw.sender : {};
  const timestamp =
    typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : undefined;
  return {
    ok: true,
    message: {
      conversationId,
      messageId,
      text,
      sender: {
        id: optionalString(sender.id) ?? DEFAULT_SENDER_ID,
        name: optionalString(sender.name) ?? DEFAULT_SENDER_NAME,
      },
      agentId: optionalString(raw.agentId),
      timestamp,
    },
  };
}

// ---------------------------------------------------------------------------
// Agent turn runner
// ---------------------------------------------------------------------------

/**
 * Agent ids configured on this gateway. OpenClaw has used both an `entries`
 * record and a `list` array over time; read whichever is present. Empty when the
 * config names none, which means the host's default agent ("main") is the only
 * one and we let the router pick it.
 */
export function listAgentIds(cfg) {
  const agents = cfg?.agents;
  const ids = [];
  const entries = agents?.entries;
  if (entries && typeof entries === "object") {
    if (Array.isArray(entries)) {
      for (const e of entries) if (e && typeof e.id === "string") ids.push(e.id);
    } else {
      for (const [key, e] of Object.entries(entries)) {
        ids.push(e && typeof e.id === "string" ? e.id : key);
      }
    }
  }
  const list = agents?.list;
  if (Array.isArray(list)) {
    for (const e of list) if (e && typeof e.id === "string" && !ids.includes(e.id)) ids.push(e.id);
  }
  return ids;
}

/**
 * Whether the host runtime exposes what the turn runner needs. Missing pieces
 * are named so the log line says exactly which SDK surface an older OpenClaw
 * lacks, instead of failing on the first message.
 */
export function missingRuntimeCapabilities(runtime) {
  const missing = [];
  const ch = runtime?.channel;
  if (typeof ch?.routing?.resolveAgentRoute !== "function") missing.push("channel.routing.resolveAgentRoute");
  if (typeof ch?.routing?.buildAgentSessionKey !== "function") missing.push("channel.routing.buildAgentSessionKey");
  if (typeof ch?.inbound?.buildContext !== "function") missing.push("channel.inbound.buildContext");
  if (typeof ch?.inbound?.dispatch !== "function") missing.push("channel.inbound.dispatch");
  if (typeof ch?.reply?.formatAgentEnvelope !== "function") missing.push("channel.reply.formatAgentEnvelope");
  return missing;
}

/**
 * Build the turn runner: `runTurn(message, sink)` runs one Benchgen message as
 * an agent turn and reports everything through `sink`:
 *
 *   sink.started({ sessionKey, agentId })
 *   sink.partial({ text, delta, replace })      streaming, cumulative text of the reply in progress
 *   sink.reply({ text, kind, mediaUrls })       a delivered reply message ("block" | "final" | "tool")
 *   sink.tool({ name, args })                   a tool call began
 *   sink.done({ status, error?, sessionKey, agentId, replies })
 *
 * Turns are serialized per conversation (so two quick messages in one chat run
 * in order against the same session) and parallel across conversations. Every
 * callback is best-effort: a sink that throws never breaks the turn.
 */
export function createTurnRunner({
  runtime,
  getConfig,
  logger,
  sessionScope = "conversation",
  defaultAgentId,
  now = () => Date.now(),
}) {
  const queues = new Map(); // conversationId -> tail promise
  // sessionKey -> { id, name, conversationId } of the Benchgen user behind the
  // session. The tracer reads it (`senderOf`) to put the user on the trace:
  // runtime events carry the session key but not the sender, and the session
  // key is the one thing both sides see. Bounded: a gateway that serves many
  // users would otherwise grow this forever.
  const senders = new Map();
  const MAX_SENDERS = 5000;
  function rememberSender(sessionKey, message) {
    if (!sessionKey) return;
    if (senders.size >= MAX_SENDERS) {
      const oldest = senders.keys().next().value;
      if (oldest !== undefined) senders.delete(oldest);
    }
    senders.delete(sessionKey); // re-insert so the map stays in recency order
    senders.set(sessionKey, {
      id: message.sender.id,
      name: message.sender.name,
      conversationId: message.conversationId,
    });
  }

  const safe = (fn, ...args) => {
    try {
      const r = fn?.(...args);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* sink errors never break the turn */
    }
  };

  async function executeTurn(message, sink) {
    const cfg = getConfig();
    const channel = runtime.channel;
    const peer = { kind: "direct", id: message.conversationId };
    const dmScope = sessionScope === "main" ? undefined : "per-channel-peer";

    // Route through the host's binding rules first (which agent owns this
    // channel/account), then honor an explicit agent choice on top.
    const route = channel.routing.resolveAgentRoute({
      cfg,
      channel: CHAT_CHANNEL_ID,
      accountId: DEFAULT_ACCOUNT_ID,
      peer,
      ...(dmScope ? { dmScope } : {}),
    });
    let agentId = route.agentId;
    const requested = message.agentId ?? defaultAgentId;
    if (requested && requested !== route.agentId) {
      const known = listAgentIds(cfg);
      if (known.length > 0 && !known.includes(requested)) {
        throw new Error(`unknown agent "${requested}" (configured: ${known.join(", ")})`);
      }
      agentId = requested;
    }
    const sessionKey =
      agentId === route.agentId
        ? route.sessionKey
        : channel.routing.buildAgentSessionKey({
            agentId,
            channel: CHAT_CHANNEL_ID,
            accountId: DEFAULT_ACCOUNT_ID,
            peer,
            ...(dmScope ? { dmScope } : {}),
          });
    const accountId = route.accountId ?? DEFAULT_ACCOUNT_ID;

    const timestamp = message.timestamp ?? now();
    const envelopeOptions =
      typeof channel.reply.resolveEnvelopeFormatOptions === "function"
        ? channel.reply.resolveEnvelopeFormatOptions(cfg)
        : undefined;
    const body = channel.reply.formatAgentEnvelope({
      channel: CHAT_CHANNEL_LABEL,
      from: message.sender.name,
      timestamp,
      body: message.text,
      ...(envelopeOptions ? { envelope: envelopeOptions } : {}),
    });

    const ctxPayload = channel.inbound.buildContext({
      channel: CHAT_CHANNEL_ID,
      accountId,
      messageId: message.messageId,
      messageIdFull: message.messageId,
      timestamp,
      from: `${CHAT_CHANNEL_ID}:${message.sender.id}`,
      sender: { id: message.sender.id, name: message.sender.name },
      conversation: {
        kind: "direct",
        id: message.conversationId,
        label: message.sender.name,
      },
      route: {
        agentId,
        dmScope: route.dmScope ?? dmScope,
        accountId,
        routeSessionKey: sessionKey,
        dispatchSessionKey: sessionKey,
      },
      reply: {
        to: `${CHAT_CHANNEL_ID}:${message.conversationId}`,
        originatingTo: `${CHAT_CHANNEL_ID}:${message.conversationId}`,
      },
      message: {
        body,
        bodyForAgent: message.text,
        rawBody: message.text,
        commandBody: message.text,
      },
      // Benchgen users are not gateway operators: no slash-command authority.
      access: { commands: { authorized: false } },
      extra: {
        NativeDirectUserId: message.sender.id,
        OriginatingChannel: CHAT_CHANNEL_ID,
      },
    });

    rememberSender(sessionKey, message);
    safe(sink.started, { sessionKey, agentId });

    const replies = { tool: 0, block: 0, final: 0 };
    const result = await channel.inbound.dispatch({
      cfg,
      channel: CHAT_CHANNEL_ID,
      accountId,
      route: { agentId, dmScope: route.dmScope ?? dmScope, sessionKey },
      ctxPayload,
      delivery: {
        deliver: async (payload, info) => {
          const text = typeof payload?.text === "string" ? payload.text : "";
          const mediaUrls = Array.isArray(payload?.mediaUrls) && payload.mediaUrls.length > 0
            ? payload.mediaUrls
            : undefined;
          if (!text.trim() && !mediaUrls) return;
          const kind = info?.kind ?? "final";
          if (kind in replies) replies[kind] += 1;
          safe(sink.reply, { text, kind, mediaUrls });
        },
        onError: (err) => {
          logger?.warn?.(`benchgen chat: reply delivery failed: ${err?.message ?? err}`);
        },
      },
      replyOptions: {
        onPartialReply: (payload) => {
          safe(sink.partial, {
            text: typeof payload?.text === "string" ? payload.text : "",
            delta: typeof payload?.delta === "string" ? payload.delta : undefined,
            replace: payload?.replace === true ? true : undefined,
          });
        },
        onToolStart: (payload) => {
          if (payload?.phase && payload.phase !== "start") return;
          const name = typeof payload?.name === "string" ? payload.name.trim() : "";
          if (!name) return;
          safe(sink.tool, { name, args: payload?.args });
        },
      },
      replyPipeline: {},
      record: {
        onRecordError: (err) => {
          throw err instanceof Error ? err : new Error(`benchgen chat session record failed: ${err}`);
        },
      },
    });

    const dispatched = result?.dispatched !== false;
    safe(sink.done, {
      status: dispatched ? "ok" : "dropped",
      reason: dispatched ? undefined : result?.admission?.reason,
      sessionKey,
      agentId,
      replies,
    });
    return { sessionKey, agentId, replies, dispatched };
  }

  function runTurn(message, sink) {
    const key = message.conversationId;
    const prev = queues.get(key) ?? Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(async () => {
        try {
          return await executeTurn(message, sink);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`benchgen chat: turn failed (conversation ${key}): ${error}`);
          safe(sink.done, { status: "error", error });
          return { error };
        }
      });
    queues.set(key, run);
    run.finally(() => {
      if (queues.get(key) === run) queues.delete(key);
    });
    return run;
  }

  return {
    runTurn,
    activeConversations: () => queues.size,
    /** Benchgen user behind a session key, if this runner dispatched it. */
    senderOf: (sessionKey) => senders.get(sessionKey) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Wire protocol helpers (plugin -> Benchgen frames)
// ---------------------------------------------------------------------------

function frame(type, fields) {
  const out = { type, ts: Date.now() };
  for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Bind a message to a frame emitter, producing the sink `runTurn` expects. Both
 * transports (relay socket, HTTP SSE) speak the same frames, so this is the one
 * place the shapes live.
 */
export function createFrameSink(message, emit) {
  const ref = { conversationId: message.conversationId, messageId: message.messageId };
  return {
    started: (info) => emit(frame("turn.started", { ...ref, ...info })),
    partial: (p) => emit(frame("reply.partial", { ...ref, ...p })),
    reply: (r) => emit(frame("reply", { ...ref, ...r })),
    tool: (t) => emit(frame("tool.start", { ...ref, ...t })),
    done: (d) => emit(frame("turn.done", { ...ref, ...d })),
  };
}

export function helloFrame({
  pluginVersion,
  openclawVersion,
  agents,
  defaultAgentId,
  capabilities,
  publicKey,
  secretKey,
}) {
  return frame("hello", {
    protocol: CHAT_PROTOCOL_VERSION,
    // The keys ride in the first frame as well as in the upgrade's Basic
    // header: some relay hosts (Node-RED's websocket listener among them) never
    // see upgrade headers from application code, and this is the only place a
    // relay is guaranteed to be able to read them. Same secrecy as the header —
    // TLS end to end.
    auth: publicKey && secretKey ? { publicKey, secretKey } : undefined,
    plugin: { name: "@benchgen/benchgen-openclaw", version: pluginVersion },
    host: openclawVersion ? { openclawVersion } : undefined,
    agents: (agents ?? []).map((id) => ({ id, default: id === defaultAgentId })),
    capabilities: capabilities ?? ["partial", "tools", "sessions"],
  });
}

// ---------------------------------------------------------------------------
// Relay client (outbound WebSocket to Benchgen)
// ---------------------------------------------------------------------------

/**
 * Persistent outbound WebSocket with reconnect + liveness pings and a bounded
 * outbox for frames produced while disconnected.
 *
 * `WebSocketImpl` is the `ws` class (injected so tests can pass a fake). It is
 * loaded lazily by the bridge so a host where the dependency is missing loses
 * the relay, not the plugin.
 */
export function createRelayClient({
  url,
  headers,
  WebSocketImpl,
  onMessage,
  onOpen,
  logger,
  minBackoffMs = RELAY_MIN_BACKOFF_MS,
  maxBackoffMs = RELAY_MAX_BACKOFF_MS,
  pingIntervalMs = RELAY_PING_INTERVAL_MS,
  pongTimeoutMs = RELAY_PONG_TIMEOUT_MS,
  outboxMax = RELAY_OUTBOX_MAX,
  random = Math.random,
}) {
  let ws = null;
  let stopped = true;
  let attempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let pongTimer = null;
  let connected = false;
  let warnedDown = false;
  let everConnected = false;
  const outbox = [];

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);
    reconnectTimer = pingTimer = pongTimer = null;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const base = Math.min(maxBackoffMs, minBackoffMs * 2 ** attempt);
    const delay = Math.round(base * (0.5 + random() * 0.5)); // jitter: 50–100% of base
    attempt = Math.min(attempt + 1, 30);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function flushOutbox() {
    while (outbox.length > 0 && connected) {
      const data = outbox.shift();
      try {
        ws.send(data);
      } catch {
        outbox.unshift(data);
        break;
      }
    }
  }

  function startPings() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (!connected || !ws) return;
      try {
        ws.ping();
      } catch {
        return;
      }
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = setTimeout(() => {
        pongTimer = null;
        logger?.warn?.("benchgen chat: relay ping timed out; reconnecting");
        try {
          ws?.terminate?.();
        } catch {
          /* ignore */
        }
      }, pongTimeoutMs);
      pongTimer.unref?.();
    }, pingIntervalMs);
    pingTimer.unref?.();
  }

  function handleClose(reasonText) {
    const wasConnected = connected;
    connected = false;
    if (pingTimer) clearInterval(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);
    pingTimer = pongTimer = null;
    ws = null;
    if (stopped) return;
    if (wasConnected || !warnedDown) {
      // One line when it goes down; the retries stay at debug so a long
      // Benchgen outage does not fill the gateway log.
      logger?.warn?.(`benchgen chat: relay disconnected (${reasonText}); reconnecting with backoff`);
      warnedDown = true;
    } else {
      logger?.debug?.(`benchgen chat: relay connect failed (${reasonText})`);
    }
    scheduleReconnect();
  }

  function connect() {
    if (stopped || ws) return;
    let socket;
    try {
      socket = new WebSocketImpl(url, { headers, handshakeTimeout: 15_000 });
    } catch (err) {
      handleClose(`constructor failed: ${err?.message ?? err}`);
      return;
    }
    ws = socket;
    socket.on("open", () => {
      if (ws !== socket) return;
      connected = true;
      attempt = 0;
      warnedDown = false;
      logger?.info?.(
        `benchgen chat: relay ${everConnected ? "reconnected" : "connected"} to ${url}`,
      );
      everConnected = true;
      try {
        onOpen?.();
      } catch {
        /* best-effort */
      }
      flushOutbox();
      startPings();
    });
    socket.on("pong", () => {
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = null;
    });
    socket.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
      } catch {
        logger?.debug?.("benchgen chat: relay sent a non-JSON frame; ignored");
        return;
      }
      try {
        const r = onMessage?.(parsed);
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch {
        /* handler errors never tear the socket down */
      }
    });
    socket.on("error", (err) => {
      // 'close' follows an 'error' on ws; the reason lands in the close log.
      socket._lastError = err?.message ?? String(err);
    });
    socket.on("close", (code, reason) => {
      if (ws !== socket) return;
      const why = socket._lastError
        ? socket._lastError
        : `code ${code}${reason?.length ? ` ${reason.toString()}` : ""}`;
      handleClose(why);
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    async stop() {
      stopped = true;
      clearTimers();
      const socket = ws;
      ws = null;
      connected = false;
      if (socket) {
        try {
          socket.close(1000, "plugin stopping");
        } catch {
          /* ignore */
        }
      }
    },
    /** Send a frame now, or queue it (bounded) if the relay is down. Returns whether it went out. */
    send(obj) {
      const data = JSON.stringify(obj);
      if (connected && ws) {
        try {
          ws.send(data);
          return true;
        } catch {
          /* fall through to queue */
        }
      }
      outbox.push(data);
      if (outbox.length > outboxMax) outbox.splice(0, outbox.length - outboxMax);
      return false;
    },
    isConnected: () => connected,
    queued: () => outbox.length,
    /** Force a reconnect (test hook / future config reload). */
    reconnect() {
      try {
        ws?.terminate?.();
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Auth for the gateway HTTP endpoint
// ---------------------------------------------------------------------------

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Accepts `Authorization: Basic base64(publicKey:secretKey)` (the same pair the
 * traces are sent with) or `Authorization: Bearer <secretKey>`. Nothing else.
 */
export function isAuthorizedChatRequest(headerValue, { publicKey, secretKey }) {
  if (!secretKey || typeof headerValue !== "string") return false;
  const [scheme, ...rest] = headerValue.trim().split(/\s+/);
  const token = rest.join(" ");
  if (!scheme || !token) return false;
  if (scheme.toLowerCase() === "bearer") return safeEqual(token, secretKey);
  if (scheme.toLowerCase() === "basic") {
    let decoded;
    try {
      decoded = Buffer.from(token, "base64").toString("utf8");
    } catch {
      return false;
    }
    const idx = decoded.indexOf(":");
    if (idx < 0) return false;
    return safeEqual(decoded.slice(0, idx), publicKey ?? "") && safeEqual(decoded.slice(idx + 1), secretKey);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gateway HTTP endpoint
// ---------------------------------------------------------------------------

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("body must be JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function wantsSse(req, body) {
  const accept = String(req.headers?.accept ?? "");
  return body?.stream === true || /text\/event-stream/i.test(accept);
}

/**
 * Handler for `POST /benchgen/chat` (and `GET` for a status probe). `getBridge`
 * returns the live bridge (or null while the service is stopped) so the route,
 * which OpenClaw wants registered at plugin load, can outlive service restarts.
 */
export function createChatHttpHandler({ getBridge, authorize, logger }) {
  return async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST" && method !== "GET") {
      res.setHeader("allow", "GET, POST");
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    if (!authorize(req.headers?.authorization)) {
      res.setHeader("www-authenticate", 'Basic realm="benchgen"');
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }
    const bridge = getBridge();
    if (!bridge) {
      sendJson(res, 503, { ok: false, error: "benchgen chat is not running on this gateway" });
      return true;
    }
    if (method === "GET") {
      sendJson(res, 200, { ok: true, ...bridge.status() });
      return true;
    }

    let body;
    try {
      body = await readJsonBody(req, MAX_HTTP_BODY_BYTES);
    } catch (err) {
      sendJson(res, err?.status ?? 400, { ok: false, error: err?.message ?? "bad request" });
      return true;
    }
    const norm = normalizeInboundMessage(body);
    if (!norm.ok) {
      sendJson(res, 400, { ok: false, error: norm.error });
      return true;
    }
    const message = norm.message;

    if (wantsSse(req, body)) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.flushHeaders?.();
      const emit = (f) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`);
      };
      await bridge.runTurn(message, createFrameSink(message, emit));
      if (!res.writableEnded) res.end();
      return true;
    }

    // Plain JSON: collect the frames, answer once the turn is done.
    const replies = [];
    let done;
    await bridge.runTurn(
      message,
      createFrameSink(message, (f) => {
        if (f.type === "reply") replies.push({ text: f.text, kind: f.kind, mediaUrls: f.mediaUrls });
        else if (f.type === "turn.done") done = f;
      }),
    );
    const finals = replies.filter((r) => r.kind !== "tool").map((r) => r.text).filter(Boolean);
    sendJson(res, done?.status === "error" ? 500 : 200, {
      ok: done?.status === "ok",
      conversationId: message.conversationId,
      messageId: message.messageId,
      status: done?.status ?? "unknown",
      error: done?.error,
      sessionKey: done?.sessionKey,
      agentId: done?.agentId,
      text: finals.join("\n\n"),
      replies,
    });
    logger?.debug?.(`benchgen chat: http turn ${message.conversationId}/${message.messageId} -> ${done?.status}`);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Bridge: wires the runner to the transports
// ---------------------------------------------------------------------------

async function loadWebSocketImpl() {
  const mod = await import("ws");
  return mod.default ?? mod.WebSocket ?? mod;
}

/**
 * The live chat bridge for one service run. `start()` brings up the relay,
 * `stop()` tears it down; `runTurn` is shared with the HTTP handler.
 */
export function createChatBridge({
  runtime,
  getConfig,
  chatConfig,
  publicKey,
  secretKey,
  pluginVersion,
  logger,
  WebSocketImpl, // test injection; loaded from `ws` when absent
}) {
  const runner = createTurnRunner({
    runtime,
    getConfig,
    logger,
    sessionScope: chatConfig.sessionScope,
    defaultAgentId: chatConfig.agentId,
  });
  let relay = null;
  let relayUrl = chatConfig.url;

  function defaultAgentIdOf(cfg) {
    const ids = listAgentIds(cfg);
    const entries = cfg?.agents?.entries;
    if (entries && !Array.isArray(entries)) {
      for (const [key, e] of Object.entries(entries)) if (e?.default === true) return e.id ?? key;
    }
    if (Array.isArray(entries)) for (const e of entries) if (e?.default === true) return e.id;
    return ids[0] ?? "main";
  }

  function sendHello() {
    const cfg = getConfig();
    const ids = listAgentIds(cfg);
    relay?.send(
      helloFrame({
        pluginVersion,
        publicKey,
        secretKey,
        openclawVersion: runtime?.version,
        agents: ids.length > 0 ? ids : ["main"],
        defaultAgentId: chatConfig.agentId ?? defaultAgentIdOf(cfg),
        capabilities: ["partial", "tools", "sessions", ...(chatConfig.httpEndpoint ? ["http"] : [])],
      }),
    );
  }

  async function handleRelayFrame(msg) {
    const type = msg?.type;
    if (type === "ping") {
      relay?.send({ type: "pong", ts: Date.now() });
      return;
    }
    if (type === "message") {
      const norm = normalizeInboundMessage(msg);
      if (!norm.ok) {
        relay?.send(
          frame("turn.done", {
            conversationId: optionalString(msg?.conversationId),
            messageId: optionalString(msg?.messageId),
            status: "error",
            error: norm.error,
          }),
        );
        return;
      }
      const message = norm.message;
      // Not awaited: the socket must keep reading while the agent thinks.
      void runner.runTurn(message, createFrameSink(message, (f) => relay?.send(f)));
      return;
    }
    if (type === "hello.ack" || type === "pong") return;
    logger?.debug?.(`benchgen chat: ignoring relay frame of type ${JSON.stringify(type)}`);
  }

  return {
    runTurn: (message, sink) => runner.runTurn(message, sink),
    senderOf: (sessionKey) => runner.senderOf(sessionKey),

    async start() {
      if (!chatConfig.relay) {
        logger?.info?.("benchgen chat: relay disabled (chat.relay === false); HTTP endpoint only");
        return;
      }
      if (!relayUrl) {
        logger?.warn?.(
          "benchgen chat: no relay URL (set chat.url or BENCHGEN_CHAT_URL, or a valid baseUrl); relay not started",
        );
        return;
      }
      let Impl = WebSocketImpl;
      if (!Impl) {
        try {
          Impl = await loadWebSocketImpl();
        } catch (err) {
          logger?.warn?.(
            `benchgen chat: relay unavailable — cannot load the "ws" package (${err?.message ?? err}); HTTP endpoint only`,
          );
          return;
        }
      }
      const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
      relay = createRelayClient({
        url: relayUrl,
        headers: {
          authorization: `Basic ${auth}`,
          "x-benchgen-plugin": `benchgen-openclaw/${pluginVersion ?? "unknown"}`,
          "x-benchgen-protocol": String(CHAT_PROTOCOL_VERSION),
        },
        WebSocketImpl: Impl,
        onOpen: sendHello,
        onMessage: handleRelayFrame,
        logger,
      });
      relay.start();
      logger?.info?.(`benchgen chat: relay connecting to ${relayUrl}`);
    },

    async stop() {
      const r = relay;
      relay = null;
      if (r) await r.stop();
    },

    status() {
      return {
        protocol: CHAT_PROTOCOL_VERSION,
        relay: {
          enabled: chatConfig.relay,
          url: relayUrl,
          connected: relay?.isConnected() ?? false,
          queuedFrames: relay?.queued() ?? 0,
        },
        httpEndpoint: chatConfig.httpEndpoint ? CHAT_HTTP_PATH : null,
        sessionScope: chatConfig.sessionScope,
        activeConversations: runner.activeConversations(),
      };
    },
  };
}
