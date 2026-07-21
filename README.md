# benchgen-openclaw

Stream OpenClaw agent traces to **Benchgen** for observability and
training-data capture.

The plugin runs inside the OpenClaw Gateway process. It subscribes to the
diagnostics event stream and turns each conversation turn into one nested trace
— model calls, tool executions, and retrieval steps — grouped by session. Those
traces flow to your Benchgen project, where they can be viewed and exported for
analysis, SFT, and RL fine-tuning.

## What gets captured

- LLM request/response spans (with token usage and cost)
- Tool call spans (name, inputs, outputs, errors)
- Retrieval / search spans
- Run-level metadata, grouped by OpenClaw session

Prompt, response, and tool I/O text are recovered best-effort from the
per-session trajectory transcript, since message content is not delivered over
the public diagnostics bus.

## Install

Prerequisites:

- OpenClaw `>=2026.6.1`
- Node.js `>=22.12.0`

```bash
openclaw plugins install benchgen-openclaw
```

## Configure

### Option A — interactive (recommended)

```bash
openclaw benchgen configure
```

Paste your project's **public key** and **secret key** from the Benchgen
dashboard. The wizard verifies the keys and writes them into your OpenClaw
config — no manual JSON editing. Restart the gateway to apply.

Check status any time:

```bash
openclaw benchgen status
```

### Option B — environment variables (managed / pre-provisioned pods)

Set these before starting the gateway; they are used as fallbacks when no
config keys are present:

| Variable | Description | Default |
| --- | --- | --- |
| `BENCHGEN_PUBLIC_KEY` | Project public key | — (required) |
| `BENCHGEN_SECRET_KEY` | Project secret key | — (required) |
| `BENCHGEN_BASE_URL` | Ingest endpoint | `https://benchgen.com` |

Config precedence: `plugins.entries.benchgen.config` → environment variable →
built-in default.

## How it works

The plugin runs its trace pipeline on a dedicated, isolated OpenTelemetry
provider so it never interferes with OpenClaw's own telemetry. Traces are
buffered and flushed in the background, and an idle reaper closes any
observations orphaned by dropped events. On shutdown, in-flight traces are
flushed before the provider is torn down.

## License

MIT
