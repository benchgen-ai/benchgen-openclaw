<h1 align="center" style="border-bottom: none">
  <div>
    <a href="https://benchgen.com">
      <img alt="Benchgen logo" src="benchgen-screenshot.jpg" width="720" />
    </a>
    <br />
    🔭 OpenClaw Benchgen Observability Plugin
  </div>
</h1>

<p align="center">
  Stream <a href="https://github.com/openclaw/openclaw">OpenClaw</a> agent traces to <br/>
  <a href="https://benchgen.com">Benchgen</a> for observability and training-data capture,<br/>
  and let Benchgen chat with your agent.
</p>

<div align="center">

[![License](https://img.shields.io/github/license/benchgen-ai/benchgen-openclaw)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/%40benchgen%2Fbenchgen-openclaw)](https://www.npmjs.com/package/@benchgen/benchgen-openclaw)

</div>


## What is new in 0.8.1

The shell environment of a Benchgen chat turn now also carries who is asking:
`BENCHGEN_USER_ID` (the platform account, as the relay's headers name it) and
`BENCHGEN_USER_NAME`, next to `BENCHGEN_API_URL` and `BENCHGEN_API_TOKEN`. A
skill that reads data of several users (harness-improve over the agent's own
traces) scopes itself by them; they never pass through the model, so a prompt
cannot rename the caller.

## What is new in 0.8.0

Questions with options become buttons. When the agent calls OpenClaw's
`ask_user` tool in a Benchgen chat session, the plugin sends the question and
its options to Benchgen as a `choices` frame (`{questions: [{id, header,
question, options: [{label, description?}], multiSelect}]}`), and Benchgen's
chat draws them as buttons under the reply; a click sends the option's label as
the user's next message. The tool call itself is still blocked (the interactive
control would hang the turn), and the block reason now tells the model that the
options are on screen, so it ends its reply with a one-line question that names
the options and stops. A Benchgen without button support ignores the frame; the
model's one-line question still arrives. Frames of the `ask_user` call are not step frames.

## What is new in 0.7.2

Step frames on every OpenClaw version. Benchgen shows what the agent is doing
("Launching the benchmark run") from `tool.start` frames, but they relied on the
host's `onToolStart` reply option, which OpenClaw 2026.9 does not call, so no
step ever arrived. Tool starts are now reported from the `before_tool_call`
hook, which fires on every version; a host that also calls `onToolStart` is
de-duplicated. A step frame now carries only a shell tool's command, never the
whole parameter object: the exec tool's parameters get the user's API credential
injected as environment, and other tools' arguments have no reason to leave the
gateway.

## What is new in 0.7.1

Turn heartbeat. Benchgen drops a chat turn after 5 minutes without a frame
("The agent went quiet mid-turn"), and a healthy turn can be silent for longer:
one long tool call, or the model writing a large file, emits nothing until it
completes. The plugin now sends a `turn.progress` frame once a minute between
`turn.started` and `turn.done`. It carries no text and needs no change on the
Benchgen side. The relay's hard cap of 15 minutes per turn still applies.

## What is new in 0.7.0

Private data guard. One gateway can serve the public BenchGen platform chat
and a private team channel while internal files sit on the same disk. List the
private locations in `privateData.paths` (or `BENCHGEN_PRIVATE_PATHS`) and the
sessions that may read them in `privateData.allowSessions` (or
`BENCHGEN_PRIVATE_ALLOW_SESSIONS`): fragments of the session key, such as a
Telegram group id or `agent:main:main`. Every other session, platform chat
included, gets the tool call refused, and the log names the session key. It
is deny by default and it is a guard rail, not a sandbox: it matches the
literal path in the tool parameters, so it stops ordinary requests, not a
determined attacker. Hostile users need a separate gateway.

## What is new in 0.6.0

Trace mirror. A gateway can send a copy of every trace to a second Benchgen
project, on top of its own: set `mirror.publicKey` and `mirror.secretKey`
(or `BENCHGEN_MIRROR_PUBLIC_KEY` / `BENCHGEN_MIRROR_SECRET_KEY`). The mirror
inherits the primary endpoint unless `mirror.baseUrl` says otherwise, and
`mirror.environment` (for example `dev`) is stamped on the mirrored copy
only, so those traces stay recognisable inside the mirror project. Chat is
not mirrored. A mirror that points at the primary project is refused, and
`openclaw benchgen show` prints the effective mirror.

## What is new in 0.5.3

- Per-turn usage for Benchgen's accounting. LiteLLM knows what the gateway spent but not
  for whom (one key for every user), so the plugin now sums the `model.usage` events of a
  turn (`usage.js`, fed by the tracer) and sends a `turn.usage` frame on the relay a moment
  after `turn.done` (`usageSettleMs`, 1500 ms, so the last usage event of the turn is
  counted): `{conversationId, messageId, sessionKey, agentId, status, sender, usage:
  {calls, inputTokens, outputTokens, totalTokens, cacheReadTokens, costUsd, model},
  toolCalls, durationMs}`. Benchgen stores one row per turn and shows turns and tokens per
  platform user on Administration > Usage. The HTTP endpoint (SSE) does not get the frame,
  its response is over by then. Token numbers need the model entry to report usage
  (`compat.supportsUsageInStreaming: true` for a hand-declared LiteLLM model, see 0.5.0).

- The user's platform API credential for the agent's skills. Benchgen's relay may send
  `auth: { token, apiBase }` with a `message` frame (platform agents only): the token of
  the user behind the turn and the API root it is good for. The chat bridge keeps it per
  session key (`authOf`) and a `before_tool_call` hook adds it to every `exec`/`bash` tool
  call of that session as environment variables, `BENCHGEN_API_URL` and
  `BENCHGEN_API_TOKEN`, so a skill does `curl -H "Authorization: Token $BENCHGEN_API_TOKEN"
  "$BENCHGEN_API_URL/submissions/?mine=true"`. It is never prompt text: no session
  transcript, trace or model request carries it, and a value the model itself puts into
  `env` is overridden. A turn without the field clears the previous credential; hosts
  without `api.on` run without it. Needs the same `hooks.allowConversationAccess` entry as
  the context block (0.5.0 below).

- Fix: the context block never reached the prompt. OpenClaw 2026.7.2 registers a
  plugin once per instance in the same gateway process (gateway + pre-warmed agent
  runtime), and `before_prompt_build` fires in the runtime instance, which has no chat
  bridge. The per-session blocks now live in a process-global store (`Symbol.for` key)
  written by the turn runner and read by the hook through `contextForSession`.

## What is new in 0.5.0

- The platform's per-user context block. Benchgen's relay may send `context` with a
  `message` frame (platform agents only): a short text block with the user's name,
  credits and their recent datasets, benchmark runs, training jobs and agents. The
  chat bridge keeps it per session key (`contextOf`) and a `before_prompt_build` hook
  puts it into the system context of that turn as `prependSystemContext`, so it never
  lands in the session history or in the user message the model router routes on.
  Hosts without `api.on` (before 2026.7.2) run without the block. Capped at 8000
  characters; a turn without the field clears the previous block.
  Operators: OpenClaw builds that gate typed hooks (the npm `2026.7.2-beta.*` and
  `2026.8.*` lines) block `before_prompt_build` for a non-bundled plugin and log
  `typed hook "before_prompt_build" blocked` unless the plugin entry allows it:

  ```json
  "plugins": { "entries": { "benchgen": {
    "hooks": { "allowConversationAccess": true, "allowPromptInjection": true }
  } } }
  ```

- Token usage on generations comes from OpenClaw's `model.usage` event, which the host
  emits only when the provider returned usage. For a model declared by hand under an
  OpenAI-compatible provider (LiteLLM, a router) set
  `compat.supportsUsageInStreaming: true` on the entry, otherwise OpenClaw sends no
  `stream_options.include_usage`, the stream carries no usage, and the trace shows a
  generation with `usageReported: false` and zero tokens.

## What is new in 0.4.0

Chat turns that arrive through the BenchGen relay now carry the person on the
trace: Langfuse `userId` is the BenchGen account (the relay sends the platform
email as the sender id), `sessionId` is the BenchGen chat, and the display name
sits in the trace metadata as `user_name`. Runs without a person (cron, heartbeat,
CLI) keep the OpenClaw agent id in `userId`, as before. Nothing to configure.

## Why This Plugin

The plugin runs inside the OpenClaw Gateway process. It subscribes to the
diagnostics event stream and turns each conversation turn into one nested trace
(model calls, tool executions, and retrieval steps) grouped by session. Those
traces flow to your Benchgen project, where they can be viewed and exported for
analysis, SFT, and RL fine-tuning.

`@benchgen/benchgen-openclaw` adds native Benchgen tracing for OpenClaw runs:

- LLM request/response spans (with token usage and cost)
- Tool call spans with inputs, outputs, and errors
- Retrieval / search spans
- Run-level metadata, grouped by OpenClaw session

Prompt, response, and tool I/O text are recovered best-effort from the
per-session trajectory transcript, since message content is not delivered over
the public diagnostics bus.

The same plugin also connects the agent to Benchgen for **chat**: Benchgen can
send messages to the agent and receive its replies (streamed), through an
outbound WebSocket the plugin keeps open (works behind NAT) or through a direct
`POST /benchgen/chat` on the gateway. Chat turns are ordinary agent turns, so
they are traced like everything else. See [Chat with Benchgen](#chat-with-benchgen).

If your gateway is remote, install and configure the plugin on that host.

## Install and first run

Prerequisites:

- OpenClaw `>=2026.6.1` for traces; `>=2026.7.2` for chat (the chat bridge needs
  `api.runtime.channel.inbound.dispatch`, which `2026.7.1` does not expose; the
  plugin logs this and keeps streaming traces)
- Node.js `>=22.12.0`

### 1. Install the plugin in OpenClaw

```bash
openclaw plugins install @benchgen/benchgen-openclaw
```

If the Gateway is already running, restart it after install.

### 2. Configure the plugin

```bash
openclaw benchgen configure
```

Paste the agent's **public key** and **secret key** from the Observability card
on its Benchgen page. The wizard verifies the keys against the ingest endpoint,
asks whether Benchgen may chat with the agent (default: yes) and for the chat
relay URL (the card's `BENCHGEN_CHAT_URL`; Enter keeps the built-in default,
which is the production relay), and writes it all into your OpenClaw config, no
manual JSON editing. Restart the gateway to apply.

### 3. Check effective settings

```bash
openclaw benchgen status
```

### 4. Send a test message

```bash
openclaw gateway run
openclaw message send "hello from openclaw"
```

Then confirm traces in your Benchgen project.

## Configuration

### Recommended config shape

```json
{
  "plugins": {
    "entries": {
      "benchgen": {
        "enabled": true,
        "config": {
          "enabled": true,
          "publicKey": "pk-your-public-key",
          "secretKey": "sk-your-secret-key",
          "baseUrl": "https://traces.benchgen.com",
          "chat": {
            "enabled": true,
            "sessionScope": "conversation"
          },
          "mirror": {
            "publicKey": "pk-second-project",
            "secretKey": "sk-second-project",
            "environment": "dev"
          }
        }
      }
    }
  }
}
```

`mirror` is optional: leave it out and traces go to the primary project only.

Chat keys (all optional, under `config.chat`):

| Key | Description | Default |
| --- | --- | --- |
| `enabled` | Chat bridge on/off (relay + gateway endpoint) | `true` |
| `relay` | Keep an outbound WebSocket to Benchgen so it can reach this gateway behind NAT | `true` |
| `url` | Relay WebSocket URL; the agent page's Observability card shows the one for your BenchGen environment (`BENCHGEN_CHAT_URL`); `configure` asks for it | `wss://benchgen.com/api/public/openclaw/chat` |
| `httpEndpoint` | Serve `POST /benchgen/chat` on the gateway port | `true` |
| `sessionScope` | `"conversation"`: one agent session per Benchgen conversation; `"main"`: the agent's main session | `"conversation"` |
| `agentId` | Agent that answers when the message names none | routed/default agent |

Mirror keys (all optional, under `config.mirror`):

| Key | Description | Default |
| --- | --- | --- |
| `enabled` | Mirror on/off | `true` when both keys are set |
| `publicKey` | Public key of the second project (`BENCHGEN_MIRROR_PUBLIC_KEY`) | none (no mirror) |
| `secretKey` | Secret key of the second project (`BENCHGEN_MIRROR_SECRET_KEY`) | none (no mirror) |
| `baseUrl` | Ingest endpoint of the second project (`BENCHGEN_MIRROR_BASE_URL`) | the primary `baseUrl` |
| `environment` | Label stamped on the mirrored copy only (`BENCHGEN_MIRROR_ENVIRONMENT`) | none |

Private data keys (all optional, under `config.privateData`):

| Key | Description | Default |
| --- | --- | --- |
| `paths` | Path prefixes only allowed sessions may touch (`BENCHGEN_PRIVATE_PATHS`, comma separated) | none (guard off) |
| `allowSessions` | Session key fragments that may touch them (`BENCHGEN_PRIVATE_ALLOW_SESSIONS`, comma separated) | none (everyone refused) |

### Environment fallbacks

Set these before starting the gateway; they are used as fallbacks when no
config keys are present:

| Variable | Description | Default |
| --- | --- | --- |
| `BENCHGEN_PUBLIC_KEY` | Project public key | none (required) |
| `BENCHGEN_SECRET_KEY` | Project secret key | none (required) |
| `BENCHGEN_BASE_URL` | Ingest endpoint | `https://traces.benchgen.com` |
| `BENCHGEN_CHAT_URL` | Chat relay WebSocket URL | `wss://benchgen.com/api/public/openclaw/chat` |
| `BENCHGEN_CHAT_ENABLED` | `false` turns the chat bridge off | `true` |
| `BENCHGEN_MIRROR_PUBLIC_KEY` | Mirror project public key | none (no mirror) |
| `BENCHGEN_MIRROR_SECRET_KEY` | Mirror project secret key | none (no mirror) |
| `BENCHGEN_MIRROR_BASE_URL` | Mirror ingest endpoint | the primary endpoint |
| `BENCHGEN_MIRROR_ENVIRONMENT` | Environment label on mirrored traces | none |
| `BENCHGEN_PRIVATE_PATHS` | Comma separated private path prefixes | none (guard off) |
| `BENCHGEN_PRIVATE_ALLOW_SESSIONS` | Comma separated session key fragments allowed to read them | none |


Config precedence: `plugins.entries.benchgen.config` → environment variable →
built-in default.

## Event mapping

| OpenClaw event | Benchgen entity | Notes |
| --- | --- | --- |
| `run.started` | trace start | starts the nested run trace for a session |
| `context.assembled` | span | records assembled context for the turn |
| `model.usage` | generation span | writes model output, usage, and cost |
| `model.call.error` | generation span (error) | closes the span with error details |
| `tool.execution.started` | tool/retriever span start | captures tool name + input |
| `tool.execution.completed` | tool/retriever span end | captures output + duration |
| `tool.execution.error` | tool/retriever span end (error) | captures error + duration |
| `tool.execution.blocked` | tool/retriever span end (blocked) | captures blocked reason |
| `run.completed` | trace finalize | closes pending spans and the trace |

## Chat with Benchgen

### What it does

Benchgen sends a message → the plugin runs it as a normal turn of your OpenClaw
agent (same system prompt, tools, session store and permissions as any channel)
→ the reply streams back to Benchgen. Two transports, same behavior:

| Transport | Direction | When to use |
| --- | --- | --- |
| **Relay** (default on) | plugin → Benchgen, outbound WebSocket, kept alive with reconnect + pings | Always works: the gateway connects out, so it can sit behind NAT / docker / a firewall. |
| **HTTP endpoint** (default on) | Benchgen → gateway, `POST /benchgen/chat` on the gateway port | When Benchgen can reach the gateway directly; also handy for local testing with `curl`. |

Chat turns run under channel `benchgen`. With `sessionScope: "conversation"`
each Benchgen conversation gets its own agent session,
`agent:<agentId>:benchgen:direct:<conversationId>`, so parallel chats never
share context and every turn is traced with that session key and the tag
`benchgen-chat`; Benchgen matches a chat to its trace by session key.

The keys that authorize trace ingest are also what authorize chat: the plugin
authenticates to the relay with `Authorization: Basic base64(publicKey:secretKey)`,
and the HTTP endpoint accepts the same header (or `Bearer <secretKey>`). Anyone
holding the project keys can talk to the agent; set `chat.enabled: false` if
that is not wanted.

### Quick check with curl (HTTP endpoint)

```bash
curl -sS http://127.0.0.1:18789/benchgen/chat \
  -u "pk-your-public-key:sk-your-secret-key" \
  -H 'Content-Type: application/json' \
  -d '{"conversationId":"demo-1","text":"hello from benchgen"}'
```

```json
{
  "ok": true,
  "conversationId": "demo-1",
  "messageId": "…",
  "status": "ok",
  "sessionKey": "agent:main:benchgen:direct:demo-1",
  "agentId": "main",
  "text": "Hi! …",
  "replies": [{ "text": "Hi! …", "kind": "final" }]
}
```

Add `-H 'Accept: text/event-stream'` (or `"stream": true` in the body) to get
the reply as it is produced; the SSE events are the frames described below.
`GET /benchgen/chat` (same auth) returns the bridge status, including whether
the relay is currently connected.

### Chat protocol (relay), version 1

The plugin opens `chat.url` with headers `Authorization: Basic …`,
`x-benchgen-plugin: benchgen-openclaw/<version>` and `x-benchgen-protocol: 1`,
and repeats the keys inside the first frame (`hello.auth`); relays that cannot
read upgrade headers authenticate from there; a relay ignores every other frame
until a valid `hello` has arrived. All frames are JSON text; every
plugin→Benchgen frame carries `ts` (epoch ms).

**Plugin → Benchgen**

| `type` | Fields | Meaning |
| --- | --- | --- |
| `hello` | `protocol`, `auth{publicKey,secretKey}`, `plugin{name,version}`, `host{openclawVersion}`, `agents[{id,default}]`, `capabilities[]` | Sent first on every (re)connect; nothing else is sent before it. |
| `turn.started` | `conversationId`, `messageId`, `sessionKey`, `agentId` | The message was accepted and the agent is running. |
| `reply.partial` | `conversationId`, `messageId`, `text`, `delta?`, `replace?` | Streaming: `text` is the reply-in-progress so far. |
| `tool.start` | `conversationId`, `messageId`, `name`, `args?` | The agent started a tool call. |
| `choices` | `conversationId`, `messageId`, `questions[{id, header, question, options[{label, description?}], multiSelect}]` | The agent asked a question with options (`ask_user`); draw them as buttons and send the picked label as the next user message. |
| `reply` | `conversationId`, `messageId`, `text`, `kind` (`block` \| `final` \| `tool`), `mediaUrls?` | A delivered reply message. A turn may deliver several. |
| `turn.done` | `conversationId`, `messageId`, `status` (`ok` \| `error` \| `dropped`), `error?`, `reason?`, `sessionKey`, `agentId`, `replies{tool,block,final}` | Always the last frame of a turn. |
| `pong` | none | Answer to a `ping`. |

**Benchgen → plugin**

| `type` | Fields | Meaning |
| --- | --- | --- |
| `message` | `conversationId` (recommended), `messageId?`, `text` (required), `sender?{id,name}`, `agentId?`, `timestamp?` | Run one turn. Missing ids are generated and echoed back. |
| `ping` | none | Liveness; the plugin answers `pong`. The plugin also sends WebSocket ping frames itself. |
| `hello.ack` | `protocol`, `agentId` (BenchGen agent id), `chat{connected,disabled}` | Informational answer to `hello`. |
| `chat.status` | `connected`, `skipped?`, `error?` | Informational: whether BenchGen (auto-)connected this agent for chat after the hello. |

The relay closes with `4401` for unknown keys, `4403` for revoked keys, `4408`
when no valid `hello` arrives, and `4409` when a newer socket with the same
keys supersedes this one (the plugin reconnects with backoff in every case).

Unknown frame types are ignored. An invalid `message` gets a `turn.done` with
`status: "error"` and the reason. Turns are serialized per `conversationId` and
run in parallel across conversations. Frames produced while the relay is
disconnected are queued (bounded) and flushed on reconnect.

## How it works

The plugin runs its trace pipeline on a dedicated, isolated OpenTelemetry
provider so it never interferes with OpenClaw's own telemetry. Traces are
buffered and flushed in the background, and an idle reaper closes any
observations orphaned by dropped events. On shutdown, in-flight traces are
flushed before the provider is torn down.

Chat uses the host's public plugin runtime (`api.runtime.channel.inbound.dispatch`
and friends, the same entry point OpenClaw's bundled channels use), so no
OpenClaw core changes are needed and the turn is indistinguishable from one
that arrived over Telegram or WebChat. On hosts whose SDK lacks that surface
the plugin logs which piece is missing and keeps streaming traces.

## Known limitations

No OpenClaw core changes are included in this repository and relies on native
hooks within the OpenClaw ecosystem.

Chat: `benchgen` is not a registered OpenClaw channel plugin: it dispatches
turns through the runtime but has no outbound adapter. So the agent answers
Benchgen inside a turn, but cannot message Benchgen on its own (heartbeats,
cron, the `message` tool), and `openclaw channels status` does not list it.
Slash commands sent from Benchgen run without operator authority.

## License

[MIT](./LICENSE)
