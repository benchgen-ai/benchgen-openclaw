// OpenTelemetry export plumbing the plugin tunes: how long one export may take,
// and where a failed export is reported.

import { diag, DiagLogLevel } from "@opentelemetry/api";

// Seconds one export request to Langfuse may take before its batch is dropped.
// The SDK's default is 5: a batch that closes a long run (its tools with their
// input and output, its generation, its root) can need longer on a slow night,
// and a dropped batch leaves the trace with only the spans exported before it.
export const EXPORT_TIMEOUT_SECONDS = 30;

/**
 * Send OpenTelemetry's warnings and errors to the gateway log. A span export
 * that fails or times out is reported only there, through `diag`, which nothing
 * reads by default: the batch is dropped and its traces lose those spans without
 * a word. `diag` is process-wide, so this also carries other OpenTelemetry users'
 * warnings, which is why the line names OpenTelemetry rather than us.
 */
export function logOtelDiagnostics(logger) {
  // A failed export arrives as a stringified exception ({"stack", "message",
  // "name"}); its message is the line worth keeping, not the stack.
  const readable = (a) => {
    if (a instanceof Error) return a.message;
    if (typeof a !== "string") return JSON.stringify(a);
    try {
      const parsed = JSON.parse(a);
      if (parsed?.message) return parsed.name ? `${parsed.name}: ${parsed.message}` : parsed.message;
    } catch {
      /* not JSON: keep as is */
    }
    return a;
  };
  const line = (level) => (message, ...args) => {
    try {
      const text = [message, ...args].map(readable).join(" ");
      logger?.[level]?.(`benchgen: OpenTelemetry ${level}: ${text.slice(0, 500)}`);
    } catch {
      /* logging must never break the exporter */
    }
  };
  diag.setLogger(
    { error: line("error"), warn: line("warn"), info() {}, debug() {}, verbose() {} },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  );
}
