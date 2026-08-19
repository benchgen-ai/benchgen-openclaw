// Tests for the Benchgen chat bridge (chat.js).
//
// The OpenClaw runtime is faked: what matters here is that the bridge builds the
// turn the way the host's channel kernel expects (route, session key, context,
// delivery callbacks) and that both transports speak the documented frames. The
// relay tests run against a real `ws` server on an ephemeral port.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";

import {
  CHAT_CHANNEL_ID,
  CHAT_HTTP_PATH,
  CHAT_PROTOCOL_VERSION,
  createChatBridge,
  createChatHttpHandler,
  createFrameSink,
  createRelayClient,
  createTurnRunner,
  defaultRelayUrl,
  DEFAULT_RELAY_URL,
  isAuthorizedChatRequest,
  listAgentIds,
  missingRuntimeCapabilities,
  normalizeInboundMessage,
  resolveChatConfig,
} from "./chat.js";
import { createTraceEngine } from "./tracer.js";
import { CHAT_TRACE_TAG, TRACE_TAGS } from "./mapping.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const quietLogger = { info() {}, warn() {}, debug() {}, error() {} };

async function defaultDispatch(plan) {
  await plan.replyOptions.onPartialReply({ text: "Hel", delta: "Hel" });
  await plan.replyOptions.onPartialReply({ text: "Hello", delta: "lo" });
  await plan.replyOptions.onToolStart({ name: "web_search", phase: "start", args: { q: "x" } });
  await plan.replyOptions.onToolStart({ name: "web_search", phase: "end" }); // ignored (not start)
  await plan.delivery.deliver({ text: "" }, { kind: "block" }); // empty → ignored
  await plan.delivery.deliver({ text: `echo: ${plan.ctxPayload.message.rawBody}` }, { kind: "final" });
  return {
    dispatched: true,
    admission: { kind: "dispatch" },
    routeSessionKey: plan.route.sessionKey,
    dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
  };
}

function fakeRuntime({ onDispatch, cfg } = {}) {
  const calls = { dispatch: [], buildContext: [] };
  const sessionKeyOf = ({ agentId, channel, peer, dmScope }) =>
    dmScope === "per-channel-peer"
      ? `agent:${agentId}:${channel}:direct:${peer.id}`
      : `agent:${agentId}:main`;
  return {
    version: "2026.7.2-test",
    calls,
    config: { current: () => cfg ?? { agents: { entries: { main: { default: true } } } } },
    channel: {
      routing: {
        resolveAgentRoute: (p) => {
          const agentId = "main";
          return {
            agentId,
            channel: p.channel,
            accountId: p.accountId ?? "default",
            dmScope: p.dmScope,
            sessionKey: sessionKeyOf({ agentId, ...p }),
            mainSessionKey: `agent:${agentId}:main`,
            lastRoutePolicy: "session",
            matchedBy: "default",
          };
        },
        buildAgentSessionKey: (p) => sessionKeyOf(p),
      },
      reply: {
        formatAgentEnvelope: ({ channel, from, body }) => `[${channel}] ${from}: ${body}`,
        resolveEnvelopeFormatOptions: () => ({ includeTimestamp: false }),
      },
      inbound: {
        buildContext: (params) => {
          calls.buildContext.push(params);
          return { ...params, Body: params.message.body, SessionKey: params.route.routeSessionKey };
        },
        dispatch: async (plan) => {
          calls.dispatch.push(plan);
          return onDispatch ? onDispatch(plan) : defaultDispatch(plan);
        },
      },
    },
  };
}

function collectSink() {
  const events = [];
  const sink = {
    started: (e) => events.push({ type: "started", ...e }),
    partial: (e) => events.push({ type: "partial", ...e }),
    reply: (e) => events.push({ type: "reply", ...e }),
    tool: (e) => events.push({ type: "tool", ...e }),
    done: (e) => events.push({ type: "done", ...e }),
  };
  return { events, sink };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(stepMs);
  }
  throw new Error("waitFor: condition not met in time");
}

async function startWsServer() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const port = wss.address().port;
  return { wss, url: `ws://127.0.0.1:${port}/api/public/openclaw/chat`, port };
}

// ---------------------------------------------------------------------------
// config + validation
// ---------------------------------------------------------------------------

test("resolveChatConfig: defaults on, relay URL is the Benchgen relay (not derived from baseUrl)", () => {
  const c = resolveChatConfig({}, { baseUrl: "https://traces.benchgen.com" });
  assert.equal(c.enabled, true);
  assert.equal(c.relay, true);
  assert.equal(c.httpEndpoint, true);
  assert.equal(c.sessionScope, "conversation");
  assert.equal(c.url, DEFAULT_RELAY_URL);
  assert.equal(c.url, "wss://benchgen.com/api/public/openclaw/chat");
  assert.equal(c.agentId, undefined);
});

test("resolveChatConfig: BENCHGEN_CHAT_URL overrides the default relay", () => {
  const prev = process.env.BENCHGEN_CHAT_URL;
  process.env.BENCHGEN_CHAT_URL = "wss://relay-dev.example/api/public/openclaw/chat";
  try {
    const c = resolveChatConfig({}, { baseUrl: "https://traces.benchgen.com" });
    assert.equal(c.url, "wss://relay-dev.example/api/public/openclaw/chat");
  } finally {
    if (prev === undefined) delete process.env.BENCHGEN_CHAT_URL;
    else process.env.BENCHGEN_CHAT_URL = prev;
  }
});

test("resolveChatConfig: explicit values win; http base derives ws", () => {
  const c = resolveChatConfig(
    {
      chat: {
        enabled: false,
        relay: false,
        url: "wss://relay.example/x",
        httpEndpoint: false,
        sessionScope: "main",
        agentId: " research ",
      },
    },
    { baseUrl: "http://localhost:3000/some/path?x=1" },
  );
  assert.equal(c.enabled, false);
  assert.equal(c.relay, false);
  assert.equal(c.url, "wss://relay.example/x");
  assert.equal(c.httpEndpoint, false);
  assert.equal(c.sessionScope, "main");
  assert.equal(c.agentId, "research");
  assert.equal(defaultRelayUrl("http://localhost:3000/some/path?x=1"), "ws://localhost:3000/api/public/openclaw/chat");
  assert.equal(defaultRelayUrl("not a url"), undefined);
  assert.equal(defaultRelayUrl(""), undefined);
});

test("normalizeInboundMessage: fills ids and sender, rejects bad input", () => {
  assert.equal(normalizeInboundMessage(null).ok, false);
  assert.equal(normalizeInboundMessage({}).ok, false);
  assert.equal(normalizeInboundMessage({ text: "   " }).ok, false);
  const r = normalizeInboundMessage({ text: "hi" });
  assert.equal(r.ok, true);
  assert.ok(r.message.conversationId.length > 0);
  assert.ok(r.message.messageId.length > 0);
  assert.deepEqual(r.message.sender, { id: "benchgen", name: "Benchgen" });
  const r2 = normalizeInboundMessage({
    text: "hi",
    conversationId: " c1 ",
    messageId: "m1",
    sender: { id: "u1", name: "Ann" },
    agentId: "research",
    timestamp: 123,
  });
  assert.deepEqual(r2.message, {
    conversationId: "c1",
    messageId: "m1",
    text: "hi",
    sender: { id: "u1", name: "Ann" },
    agentId: "research",
    timestamp: 123,
  });
});

test("isAuthorizedChatRequest: basic pk:sk or bearer sk only", () => {
  const keys = { publicKey: "pk-1", secretKey: "sk-1" };
  const basic = (s) => `Basic ${Buffer.from(s).toString("base64")}`;
  assert.equal(isAuthorizedChatRequest(basic("pk-1:sk-1"), keys), true);
  assert.equal(isAuthorizedChatRequest(basic("pk-1:sk-2"), keys), false);
  assert.equal(isAuthorizedChatRequest(basic("pk-2:sk-1"), keys), false);
  assert.equal(isAuthorizedChatRequest(basic("nope"), keys), false);
  assert.equal(isAuthorizedChatRequest("Bearer sk-1", keys), true);
  assert.equal(isAuthorizedChatRequest("bearer sk-1", keys), true);
  assert.equal(isAuthorizedChatRequest("Bearer sk-2", keys), false);
  assert.equal(isAuthorizedChatRequest(undefined, keys), false);
  assert.equal(isAuthorizedChatRequest("Bearer sk-1", { publicKey: "pk", secretKey: "" }), false);
});

test("listAgentIds + missingRuntimeCapabilities", () => {
  assert.deepEqual(listAgentIds({ agents: { entries: { main: {}, research: { id: "research" } } } }), ["main", "research"]);
  assert.deepEqual(listAgentIds({ agents: { entries: [{ id: "a" }], list: [{ id: "b" }, { id: "a" }] } }), ["a", "b"]);
  assert.deepEqual(listAgentIds({}), []);
  assert.deepEqual(missingRuntimeCapabilities(fakeRuntime()), []);
  assert.deepEqual(missingRuntimeCapabilities({ channel: { routing: {}, inbound: {}, reply: {} } }), [
    "channel.routing.resolveAgentRoute",
    "channel.routing.buildAgentSessionKey",
    "channel.inbound.buildContext",
    "channel.inbound.dispatch",
    "channel.reply.formatAgentEnvelope",
  ]);
});

// ---------------------------------------------------------------------------
// turn runner
// ---------------------------------------------------------------------------

test("turn runner: builds a per-conversation session and pipes the turn to the sink", async () => {
  const runtime = fakeRuntime();
  const runner = createTurnRunner({
    runtime,
    getConfig: () => runtime.config.current(),
    logger: quietLogger,
  });
  const { events, sink } = collectSink();
  const message = normalizeInboundMessage({
    text: "hello agent",
    conversationId: "conv-1",
    messageId: "msg-1",
    sender: { id: "u1", name: "Ann" },
  }).message;
  const result = await runner.runTurn(message, sink);

  assert.equal(result.sessionKey, "agent:main:benchgen:direct:conv-1");
  assert.equal(result.agentId, "main");
  assert.equal(result.dispatched, true);

  const plan = runtime.calls.dispatch[0];
  assert.equal(plan.channel, CHAT_CHANNEL_ID);
  assert.equal(plan.accountId, "default");
  assert.deepEqual(plan.route, { agentId: "main", dmScope: "per-channel-peer", sessionKey: "agent:main:benchgen:direct:conv-1" });
  assert.equal(typeof plan.record.onRecordError, "function");
  assert.throws(() => plan.record.onRecordError(new Error("boom")), /boom/);

  const ctx = runtime.calls.buildContext[0];
  assert.equal(ctx.channel, CHAT_CHANNEL_ID);
  assert.equal(ctx.messageId, "msg-1");
  assert.equal(ctx.from, "benchgen:u1");
  assert.deepEqual(ctx.sender, { id: "u1", name: "Ann" });
  assert.deepEqual(ctx.conversation, { kind: "direct", id: "conv-1", label: "Ann" });
  assert.equal(ctx.route.routeSessionKey, "agent:main:benchgen:direct:conv-1");
  assert.equal(ctx.route.dispatchSessionKey, "agent:main:benchgen:direct:conv-1");
  assert.equal(ctx.reply.to, "benchgen:conv-1");
  assert.equal(ctx.message.rawBody, "hello agent");
  assert.equal(ctx.message.bodyForAgent, "hello agent");
  assert.equal(ctx.message.body, "[Benchgen] Ann: hello agent");
  assert.deepEqual(ctx.access, { commands: { authorized: false } });

  assert.deepEqual(
    events.map((e) => e.type),
    ["started", "partial", "partial", "tool", "reply", "done"],
  );
  assert.deepEqual(events[0], { type: "started", sessionKey: "agent:main:benchgen:direct:conv-1", agentId: "main" });
  assert.deepEqual(events[1], { type: "partial", text: "Hel", delta: "Hel", replace: undefined });
  assert.deepEqual(events[3], { type: "tool", name: "web_search", args: { q: "x" } });
  assert.deepEqual(events[4], { type: "reply", text: "echo: hello agent", kind: "final", mediaUrls: undefined });
  assert.deepEqual(events[5], {
    type: "done",
    status: "ok",
    reason: undefined,
    sessionKey: "agent:main:benchgen:direct:conv-1",
    agentId: "main",
    replies: { tool: 0, block: 0, final: 1 },
  });
});

test("turn runner: sessionScope=main collapses into the agent main session", async () => {
  const runtime = fakeRuntime();
  const runner = createTurnRunner({
    runtime,
    getConfig: () => runtime.config.current(),
    logger: quietLogger,
    sessionScope: "main",
  });
  const { sink } = collectSink();
  const r = await runner.runTurn(normalizeInboundMessage({ text: "x", conversationId: "c" }).message, sink);
  assert.equal(r.sessionKey, "agent:main:main");
  assert.equal(runtime.calls.dispatch[0].route.dmScope, undefined);
});

test("turn runner: explicit agentId is validated and changes the session key", async () => {
  const cfg = { agents: { entries: { main: { default: true }, research: {} } } };
  const runtime = fakeRuntime({ cfg });
  const runner = createTurnRunner({ runtime, getConfig: () => cfg, logger: quietLogger });

  const ok = collectSink();
  const r = await runner.runTurn(
    normalizeInboundMessage({ text: "x", conversationId: "c", agentId: "research" }).message,
    ok.sink,
  );
  assert.equal(r.agentId, "research");
  assert.equal(r.sessionKey, "agent:research:benchgen:direct:c");
  assert.equal(runtime.calls.buildContext[0].route.agentId, "research");

  const bad = collectSink();
  const r2 = await runner.runTurn(
    normalizeInboundMessage({ text: "x", conversationId: "c2", agentId: "nope" }).message,
    bad.sink,
  );
  assert.match(r2.error, /unknown agent "nope"/);
  assert.equal(bad.events.at(-1).type, "done");
  assert.equal(bad.events.at(-1).status, "error");
  assert.equal(runtime.calls.dispatch.length, 1, "no dispatch for an unknown agent");
});

test("turn runner: dispatch failure surfaces as done{status:error}, sink errors are swallowed", async () => {
  const runtime = fakeRuntime({
    onDispatch: async () => {
      throw new Error("agent exploded");
    },
  });
  const runner = createTurnRunner({ runtime, getConfig: () => ({}), logger: quietLogger });
  const events = [];
  const r = await runner.runTurn(normalizeInboundMessage({ text: "x" }).message, {
    started: () => {
      throw new Error("sink bug");
    },
    done: (e) => events.push(e),
  });
  assert.equal(r.error, "agent exploded");
  assert.deepEqual(events, [{ status: "error", error: "agent exploded" }]);
});

test("turn runner: not-dispatched admission is reported as dropped", async () => {
  const runtime = fakeRuntime({
    onDispatch: async () => ({ dispatched: false, admission: { kind: "drop", reason: "botLoopProtection" } }),
  });
  const runner = createTurnRunner({ runtime, getConfig: () => ({}), logger: quietLogger });
  const { events, sink } = collectSink();
  await runner.runTurn(normalizeInboundMessage({ text: "x" }).message, sink);
  const done = events.at(-1);
  assert.equal(done.status, "dropped");
  assert.equal(done.reason, "botLoopProtection");
});

test("turn runner: serializes per conversation, runs conversations in parallel", async () => {
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const runtime = fakeRuntime({
    onDispatch: async (plan) => {
      const id = plan.ctxPayload.message.rawBody;
      order.push(`start ${id}`);
      if (id === "a1") await gate;
      order.push(`end ${id}`);
      return { dispatched: true };
    },
  });
  const runner = createTurnRunner({ runtime, getConfig: () => ({}), logger: quietLogger });
  const msg = (conversationId, text) => normalizeInboundMessage({ text, conversationId }).message;
  const { sink } = collectSink();
  const pA1 = runner.runTurn(msg("A", "a1"), sink);
  const pA2 = runner.runTurn(msg("A", "a2"), sink);
  const pB1 = runner.runTurn(msg("B", "b1"), sink);
  await waitFor(() => order.includes("end b1"));
  assert.deepEqual(order, ["start a1", "start b1", "end b1"], "a2 waits for a1; b1 does not");
  await sleep(0); // B's queue entry is released on a microtask after b1 settles
  assert.equal(runner.activeConversations(), 1, "only A (a1 running, a2 queued) is live");
  release();
  await Promise.all([pA1, pA2, pB1]);
  assert.deepEqual(order, ["start a1", "start b1", "end b1", "end a1", "start a2", "end a2"]);
  await sleep(0);
  assert.equal(runner.activeConversations(), 0);
});

// ---------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------

test("createFrameSink stamps conversation/message ids and a timestamp on every frame", () => {
  const out = [];
  const sink = createFrameSink({ conversationId: "c", messageId: "m" }, (f) => out.push(f));
  sink.started({ sessionKey: "s", agentId: "main" });
  sink.partial({ text: "He" });
  sink.reply({ text: "Hello", kind: "final" });
  sink.tool({ name: "t" });
  sink.done({ status: "ok" });
  assert.deepEqual(
    out.map((f) => f.type),
    ["turn.started", "reply.partial", "reply", "tool.start", "turn.done"],
  );
  for (const f of out) {
    assert.equal(f.conversationId, "c");
    assert.equal(f.messageId, "m");
    assert.equal(typeof f.ts, "number");
  }
  assert.equal(out[2].text, "Hello");
  assert.equal(out[2].kind, "final");
});

// ---------------------------------------------------------------------------
// relay client against a real ws server
// ---------------------------------------------------------------------------

test("relay client: connects with headers, sends, receives, answers ping, flushes outbox after reconnect", async () => {
  const { wss, url } = await startWsServer();
  const serverSockets = [];
  const serverReceived = [];
  const headersSeen = [];
  wss.on("connection", (socket, req) => {
    serverSockets.push(socket);
    headersSeen.push(req.headers);
    socket.on("message", (d) => serverReceived.push(JSON.parse(d.toString())));
  });

  const clientReceived = [];
  let opens = 0;
  const client = createRelayClient({
    url,
    headers: { authorization: "Basic abc", "x-benchgen-protocol": "1" },
    WebSocketImpl: WebSocket,
    onOpen: () => {
      opens += 1;
      client.send({ type: "hello", n: opens });
    },
    onMessage: (m) => clientReceived.push(m),
    logger: quietLogger,
    minBackoffMs: 20,
    maxBackoffMs: 50,
    pingIntervalMs: 60_000,
  });
  try {
    client.start();
    await waitFor(() => serverReceived.length >= 1);
    assert.equal(client.isConnected(), true);
    assert.equal(headersSeen[0].authorization, "Basic abc");
    assert.equal(headersSeen[0]["x-benchgen-protocol"], "1");
    assert.deepEqual(serverReceived[0], { type: "hello", n: 1 });

    serverSockets[0].send(JSON.stringify({ type: "message", text: "hi" }));
    serverSockets[0].send("not json"); // ignored
    await waitFor(() => clientReceived.length >= 1);
    assert.deepEqual(clientReceived, [{ type: "message", text: "hi" }]);

    // Server drops the socket: client goes down, queues, reconnects, flushes.
    serverSockets[0].close(1012, "restart");
    await waitFor(() => !client.isConnected());
    assert.equal(client.send({ type: "reply", text: "queued while down" }), false);
    assert.equal(client.queued(), 1);
    await waitFor(() => serverSockets.length >= 2 && serverReceived.length >= 3);
    assert.equal(opens, 2);
    assert.equal(client.queued(), 0);
    // hello (from onOpen) then the flushed frame — hello wins because onOpen runs before the flush.
    assert.deepEqual(serverReceived.slice(1), [
      { type: "hello", n: 2 },
      { type: "reply", text: "queued while down" },
    ]);
  } finally {
    await client.stop();
    wss.close();
  }
});

test("relay client: keeps retrying while the server is unreachable, stop() ends it", async () => {
  const { wss, url, port } = await startWsServer();
  wss.close(); // free the port so connects fail
  await sleep(20);
  let attempts = 0;
  class CountingWs extends WebSocket {
    constructor(...args) {
      attempts += 1;
      super(...args);
    }
  }
  const client = createRelayClient({
    url,
    WebSocketImpl: CountingWs,
    logger: quietLogger,
    minBackoffMs: 5,
    maxBackoffMs: 10,
    pingIntervalMs: 60_000,
  });
  client.start();
  await waitFor(() => attempts >= 3, { timeoutMs: 4000 });
  assert.equal(client.isConnected(), false);
  await client.stop();
  const after = attempts;
  await sleep(60);
  assert.equal(attempts, after, "no reconnects after stop()");
  assert.ok(port > 0);
});

// ---------------------------------------------------------------------------
// bridge end-to-end over the relay
// ---------------------------------------------------------------------------

test("bridge: hello on connect, message → turn frames, ping → pong, bad message → turn.done error", async () => {
  const { wss, url } = await startWsServer();
  const frames = [];
  let serverSocket;
  wss.on("connection", (socket) => {
    serverSocket = socket;
    socket.on("message", (d) => frames.push(JSON.parse(d.toString())));
  });
  const runtime = fakeRuntime();
  const bridge = createChatBridge({
    runtime,
    getConfig: () => runtime.config.current(),
    chatConfig: { enabled: true, relay: true, url, httpEndpoint: true, sessionScope: "conversation" },
    publicKey: "pk-1",
    secretKey: "sk-1",
    pluginVersion: "0.3.0-test",
    logger: quietLogger,
    WebSocketImpl: WebSocket,
  });
  try {
    await bridge.start();
    await waitFor(() => frames.length >= 1);
    const hello = frames[0];
    assert.equal(hello.type, "hello");
    assert.equal(hello.protocol, CHAT_PROTOCOL_VERSION);
    assert.deepEqual(hello.plugin, { name: "@benchgen/benchgen-openclaw", version: "0.3.0-test" });
    assert.deepEqual(hello.host, { openclawVersion: "2026.7.2-test" });
    assert.deepEqual(hello.agents, [{ id: "main", default: true }]);
    assert.ok(hello.capabilities.includes("partial"));
    // Keys in the first frame: relays that cannot read upgrade headers rely on this.
    assert.deepEqual(hello.auth, { publicKey: "pk-1", secretKey: "sk-1" });

    serverSocket.send(JSON.stringify({ type: "ping" }));
    await waitFor(() => frames.some((f) => f.type === "pong"));

    serverSocket.send(
      JSON.stringify({
        type: "message",
        conversationId: "conv-9",
        messageId: "m-9",
        text: "what's up",
        sender: { id: "u", name: "Ann" },
      }),
    );
    await waitFor(() => frames.some((f) => f.type === "turn.done" && f.messageId === "m-9"));
    const turn = frames.filter((f) => f.conversationId === "conv-9");
    assert.deepEqual(
      turn.map((f) => f.type),
      ["turn.started", "reply.partial", "reply.partial", "tool.start", "reply", "turn.done"],
    );
    assert.equal(turn[0].sessionKey, "agent:main:benchgen:direct:conv-9");
    assert.equal(turn[4].text, "echo: what's up");
    assert.equal(turn[4].kind, "final");
    assert.equal(turn[5].status, "ok");
    assert.deepEqual(turn[5].replies, { tool: 0, block: 0, final: 1 });

    serverSocket.send(JSON.stringify({ type: "message", conversationId: "conv-x", messageId: "m-x" }));
    await waitFor(() => frames.some((f) => f.type === "turn.done" && f.messageId === "m-x"));
    const bad = frames.find((f) => f.type === "turn.done" && f.messageId === "m-x");
    assert.equal(bad.status, "error");
    assert.match(bad.error, /text is required/);

    const status = bridge.status();
    assert.equal(status.relay.connected, true);
    assert.equal(status.relay.url, url);
    assert.equal(status.httpEndpoint, CHAT_HTTP_PATH);
  } finally {
    await bridge.stop();
    wss.close();
  }
  assert.equal(bridge.status().relay.connected, false);
});

test("bridge: relay disabled or without URL does not connect, runTurn still works for HTTP", async () => {
  const runtime = fakeRuntime();
  const bridge = createChatBridge({
    runtime,
    getConfig: () => ({}),
    chatConfig: { enabled: true, relay: false, url: undefined, httpEndpoint: true, sessionScope: "conversation" },
    publicKey: "pk",
    secretKey: "sk",
    logger: quietLogger,
    WebSocketImpl: class {
      constructor() {
        throw new Error("must not construct");
      }
    },
  });
  await bridge.start();
  assert.equal(bridge.status().relay.connected, false);
  const { events, sink } = collectSink();
  await bridge.runTurn(normalizeInboundMessage({ text: "hi" }).message, sink);
  assert.equal(events.at(-1).status, "ok");
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// gateway HTTP endpoint
// ---------------------------------------------------------------------------

async function startHttp(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, headers: res.headers, body };
}

test("http handler: auth, method, 503 without bridge, JSON turn, SSE turn", async () => {
  const runtime = fakeRuntime();
  let bridge = null;
  const handler = createChatHttpHandler({
    getBridge: () => bridge,
    authorize: (h) => isAuthorizedChatRequest(h, { publicKey: "pk", secretKey: "sk" }),
    logger: quietLogger,
  });
  const { server, base } = await startHttp(handler);
  const auth = `Basic ${Buffer.from("pk:sk").toString("base64")}`;
  const url = `${base}${CHAT_HTTP_PATH}`;
  try {
    let r = await fetchJson(url, { method: "POST", body: "{}" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /Basic/);

    r = await fetchJson(url, { method: "DELETE", headers: { authorization: auth } });
    assert.equal(r.status, 405);

    r = await fetchJson(url, { method: "POST", headers: { authorization: auth }, body: '{"text":"x"}' });
    assert.equal(r.status, 503);

    bridge = createChatBridge({
      runtime,
      getConfig: () => runtime.config.current(),
      chatConfig: { enabled: true, relay: false, httpEndpoint: true, sessionScope: "conversation" },
      publicKey: "pk",
      secretKey: "sk",
      logger: quietLogger,
    });
    await bridge.start();

    r = await fetchJson(url, { method: "GET", headers: { authorization: auth } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.protocol, CHAT_PROTOCOL_VERSION);
    assert.equal(r.body.relay.enabled, false);

    r = await fetchJson(url, { method: "POST", headers: { authorization: auth }, body: "not json" });
    assert.equal(r.status, 400);

    r = await fetchJson(url, { method: "POST", headers: { authorization: auth }, body: '{"text":""}' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /text is required/);

    r = await fetchJson(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "c-http", messageId: "m-http", text: "hello there" }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.status, "ok");
    assert.equal(r.body.conversationId, "c-http");
    assert.equal(r.body.messageId, "m-http");
    assert.equal(r.body.sessionKey, "agent:main:benchgen:direct:c-http");
    assert.equal(r.body.agentId, "main");
    assert.equal(r.body.text, "echo: hello there");
    assert.deepEqual(r.body.replies, [{ text: "echo: hello there", kind: "final" }]);

    // SSE
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: auth, accept: "text/event-stream" },
      body: JSON.stringify({ conversationId: "c-sse", text: "stream me" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const raw = await res.text();
    const events = raw
      .split("\n\n")
      .filter((chunk) => chunk.trim())
      .map((chunk) => {
        const lines = chunk.split("\n");
        const ev = lines.find((l) => l.startsWith("event: ")).slice(7);
        const data = JSON.parse(lines.find((l) => l.startsWith("data: ")).slice(6));
        return { ev, data };
      });
    assert.deepEqual(
      events.map((e) => e.ev),
      ["turn.started", "reply.partial", "reply.partial", "tool.start", "reply", "turn.done"],
    );
    for (const e of events) assert.equal(e.data.type, e.ev);
    assert.equal(events.at(-1).data.status, "ok");
    assert.equal(events[4].data.text, "echo: stream me");

    // stream:true in the body also selects SSE
    const res2 = await fetch(url, {
      method: "POST",
      headers: { authorization: auth },
      body: JSON.stringify({ text: "again", stream: true }),
    });
    assert.match(res2.headers.get("content-type"), /text\/event-stream/);
    await res2.text();
  } finally {
    await bridge?.stop();
    server.close();
  }
});

test("http handler: turn error maps to 500 with the message", async () => {
  const runtime = fakeRuntime({
    onDispatch: async () => {
      throw new Error("no model");
    },
  });
  const bridge = createChatBridge({
    runtime,
    getConfig: () => ({}),
    chatConfig: { enabled: true, relay: false, httpEndpoint: true, sessionScope: "conversation" },
    publicKey: "pk",
    secretKey: "sk",
    logger: quietLogger,
  });
  const handler = createChatHttpHandler({ getBridge: () => bridge, authorize: () => true, logger: quietLogger });
  const { server, base } = await startHttp(handler);
  try {
    const r = await fetchJson(`${base}${CHAT_HTTP_PATH}`, { method: "POST", body: '{"text":"x"}' });
    assert.equal(r.status, 500);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.status, "error");
    assert.equal(r.body.error, "no model");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// tracer: chat turns are tagged
// ---------------------------------------------------------------------------

test("tracer: a turn on channel benchgen carries the benchgen-chat tag next to the agent tag", () => {
  const spans = [];
  const fakeObs = () => {
    const attrs = {};
    const obs = {
      otelSpan: { setAttribute: (k, v) => (attrs[k] = v) },
      attrs,
      update() {},
      end() {},
      startObservation: () => fakeObs(),
    };
    spans.push(obs);
    return obs;
  };
  const engine = createTraceEngine({ startObservation: () => fakeObs() }, { logger: quietLogger, defer: () => {} });
  engine.handle({
    type: "run.started",
    ts: 1,
    trace: { traceId: "t1" },
    channel: "benchgen",
    sessionKey: "agent:main:benchgen:direct:conv-1",
    runId: "r1",
  });
  assert.deepEqual(spans[0].attrs[TRACE_TAGS], ["agent:main", CHAT_TRACE_TAG]);

  // Channel arriving late (root created from an event without it) still tags.
  engine.handle({ type: "run.started", ts: 1, trace: { traceId: "t2" }, sessionKey: "agent:main:benchgen:direct:c" });
  assert.deepEqual(spans[1].attrs[TRACE_TAGS], ["agent:main"]);
  engine.handle({ type: "model.call.started", ts: 2, trace: { traceId: "t2" }, channel: "benchgen" });
  assert.deepEqual(spans[1].attrs[TRACE_TAGS], ["agent:main", CHAT_TRACE_TAG]);

  // Other channels: agent tag only.
  engine.handle({ type: "run.started", ts: 1, trace: { traceId: "t3" }, channel: "telegram", sessionKey: "agent:main:main" });
  assert.deepEqual(spans[2].attrs[TRACE_TAGS], ["agent:main"]);
});
