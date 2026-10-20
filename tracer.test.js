// Tests for how the trace engine (tracer.js) groups OpenClaw's events into
// traces: one trace per run, even when runs share a W3C traceId.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTraceEngine } from "./tracer.js";

/** A @langfuse/tracing stand-in that records the observation tree. */
function fakeTracing() {
  const roots = [];
  const make = (name) => {
    const obs = {
      name,
      children: [],
      otelSpan: { setAttribute() {} },
      update() {},
      end() {},
      setTraceIO() {},
      startObservation(childName) {
        const child = make(childName);
        obs.children.push(child);
        return child;
      },
    };
    return obs;
  };
  const tracing = {
    startObservation(name) {
      const obs = make(name);
      roots.push(obs);
      return obs;
    },
  };
  return { roots, tracing };
}

const engineFor = (tracing) => createTraceEngine(tracing, { defer: () => {}, logger: { error() {} } });
const names = (obs) => obs.children.map((c) => c.name);

test("runs that share a traceId (cron, background completions) get a trace each", () => {
  const { roots, tracing } = fakeTracing();
  const engine = engineFor(tracing);
  const trace = { traceId: "gateway-wide" };
  const ops = { trace, channel: "cron", sessionKey: "agent:main:cron:ops", runId: "run-ops" };
  const planner = { trace, channel: "cron", sessionKey: "agent:main:cron:planner", runId: "run-planner" };

  engine.handle({ type: "run.started", ts: 1, ...ops });
  engine.handle({ type: "run.started", ts: 2, ...planner });
  engine.handle({ type: "tool.execution.started", ts: 3, ...ops, toolName: "exec", toolCallId: "t-ops" });
  engine.handle({ type: "tool.execution.started", ts: 4, ...planner, toolName: "read", toolCallId: "t-planner" });
  // model.usage carries no runId: it joins the run of its session.
  const { runId: _ops, ...opsNoRun } = ops;
  engine.handle({ type: "model.usage", ts: 5, ...opsNoRun, model: "sonnet", usage: { input: 10, output: 5 } });

  assert.equal(roots.length, 2);
  assert.deepEqual(names(roots[0]), ["exec", "sonnet"]);
  assert.deepEqual(names(roots[1]), ["read"]);
});

test("one run per traceId keys as before: every event of the turn under one root", () => {
  const { roots, tracing } = fakeTracing();
  const engine = engineFor(tracing);
  const turn = { trace: { traceId: "msg-1" }, channel: "telegram", sessionKey: "agent:main:telegram:group:1" };
  engine.handle({ type: "run.started", ts: 1, ...turn, runId: "r1" });
  engine.handle({ type: "context.assembled", ts: 2, ...turn, runId: "r1", messageCount: 3 });
  engine.handle({ type: "tool.execution.started", ts: 3, ...turn, runId: "r1", toolName: "exec", toolCallId: "t1" });
  engine.handle({ type: "model.usage", ts: 4, ...turn, model: "sonnet", usage: { input: 1 } });

  assert.equal(roots.length, 1);
  assert.deepEqual(names(roots[0]), ["context.assembled", "exec", "sonnet"]);
});

test("an event with neither a runId nor a known session joins the traceId's latest run", () => {
  const { roots, tracing } = fakeTracing();
  const engine = engineFor(tracing);
  const trace = { traceId: "t" };
  engine.handle({ type: "run.started", ts: 1, trace, runId: "a", sessionKey: "s-a" });
  engine.handle({ type: "run.started", ts: 2, trace, runId: "b", sessionKey: "s-b" });
  engine.handle({ type: "model.usage", ts: 3, trace, model: "m", usage: {} });
  assert.equal(roots.length, 2);
  assert.deepEqual(names(roots[0]), []);
  assert.deepEqual(names(roots[1]), ["m"]);
});
