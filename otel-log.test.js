// Tests for otel-log.js: a span export that fails reaches the gateway log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { diag } from "@opentelemetry/api";

import { logOtelDiagnostics } from "./otel-log.js";

function recorder() {
  const lines = [];
  const at = (level) => (text) => lines.push([level, text]);
  return { lines, logger: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") } };
}

test("a failed export is logged with its message, not its stack", (t) => {
  t.after(() => diag.disable());
  const { lines, logger } = recorder();
  logOtelDiagnostics(logger);
  // What BatchSpanProcessor hands diag when an export times out.
  diag.error(JSON.stringify({ stack: "Error: Request timed out\n    at ClientRequest", message: "Request timed out", name: "Error" }));
  diag.warn("slow exporter", { queued: 3 });
  diag.info("not this");
  assert.deepEqual(lines, [
    ["error", "benchgen: OpenTelemetry error: Error: Request timed out"],
    ["warn", 'benchgen: OpenTelemetry warn: slow exporter {"queued":3}'],
  ]);
});
