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
  <a href="https://benchgen.com">Benchgen</a> for observability and training-data capture.
</p>

<div align="center">

[![License](https://img.shields.io/github/license/benchgen-ai/benchgen-openclaw)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/%40benchgen%2Fbenchgen-openclaw)](https://www.npmjs.com/package/@benchgen/benchgen-openclaw)

</div>

## Why This Plugin

The plugin runs inside the OpenClaw Gateway process. It subscribes to the
diagnostics event stream and turns each conversation turn into one nested trace
— model calls, tool executions, and retrieval steps — grouped by session. Those
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

If your gateway is remote, install and configure the plugin on that host.

## Install and first run

Prerequisites:

- OpenClaw `>=2026.6.1`
- Node.js `>=22.12.0`

### 1. Install the plugin in OpenClaw

```bash
openclaw plugins install benchgen-openclaw
```

If the Gateway is already running, restart it after install.

### 2. Configure the plugin

```bash
openclaw benchgen configure
```

Paste your project's **public key** and **secret key** from the Benchgen
dashboard. The wizard verifies the keys against the ingest endpoint and writes
them into your OpenClaw config — no manual JSON editing. Restart the gateway
to apply.

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
          "baseUrl": "https://traces.benchgen.com"
        }
      }
    }
  }
}
```

### Environment fallbacks

Set these before starting the gateway; they are used as fallbacks when no
config keys are present:

| Variable | Description | Default |
| --- | --- | --- |
| `BENCHGEN_PUBLIC_KEY` | Project public key | — (required) |
| `BENCHGEN_SECRET_KEY` | Project secret key | — (required) |
| `BENCHGEN_BASE_URL` | Ingest endpoint | `https://traces.benchgen.com` |


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

## How it works

The plugin runs its trace pipeline on a dedicated, isolated OpenTelemetry
provider so it never interferes with OpenClaw's own telemetry. Traces are
buffered and flushed in the background, and an idle reaper closes any
observations orphaned by dropped events. On shutdown, in-flight traces are
flushed before the provider is torn down.

## Known limitation

No OpenClaw core changes are included in this repository and relies on native
hooks within the OpenClaw ecosystem.

## License

[MIT](./LICENSE)
