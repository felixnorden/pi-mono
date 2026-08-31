import { assert, it } from "@effect/vitest";
import {
  ActivityTracker,
  toTrackerEvent,
  type ActivityEvent,
  type TimeBreakdown,
  type TrackerEventSource,
} from "./activity.ts";

// ---------------------------------------------------------------------------
// ActivityTracker — pure scripted-event activity state machine. Every event
// carries its own timestamp; the wall clock never lives inside the tracker,
// so each script yields exact, deterministic bucket totals.
// ---------------------------------------------------------------------------

function trackerWith(events: ActivityEvent[]): ActivityTracker {
  const tracker = new ActivityTracker();
  for (const event of events) tracker.handle(event);
  return tracker;
}

it("charges the open run's inference span to the inference bucket when a run is open", () => {
  // Arrange
  const tracker = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "message_start", role: "assistant", now: 1000 },
    { type: "message_end", role: "assistant", now: 3000 },
  ]);

  // Act
  const breakdown = tracker.breakdown(4000);

  // Assert
  assert.deepStrictEqual(breakdown, { inference: 2000, tool: 0, wait: 0, total: 3000 });
});

it("charges tool spans to the tool bucket, never to inference", () => {
  // Arrange
  const tracker = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "tool_start", callId: "a", now: 1000 },
    { type: "tool_end", callId: "a", now: 2500 },
    { type: "message_start", role: "assistant", now: 2500 },
    { type: "message_end", role: "assistant", now: 4500 },
  ]);

  // Act
  const breakdown = tracker.breakdown(4500);

  // Assert
  assert.deepStrictEqual(breakdown, { inference: 2000, tool: 1500, wait: 0, total: 3500 });
});

it("charges one shared interval when tool executions overlap (parallel union)", () => {
  // Arrange
  const tracker = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "tool_start", callId: "a", now: 1000 },
    { type: "tool_start", callId: "b", now: 1500 },
    { type: "tool_end", callId: "b", now: 2500 },
    { type: "tool_end", callId: "a", now: 3000 },
  ]);

  // Act
  const breakdown = tracker.breakdown(3000);

  // Assert — the union is t=1000..3000, not the per-call sum 2500.
  assert.strictEqual(breakdown.tool, 2000);
  assert.strictEqual(breakdown.total, 2000);
  assert.strictEqual(breakdown.inference, 0);
  assert.strictEqual(breakdown.wait, 0);
});

it("pauses both work buckets while a user prompt is open and resumes the prior state after", () => {
  // Arrange
  const tracker = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "tool_start", callId: "a", now: 1000 },
    { type: "wait_start", now: 1500 },
    { type: "wait_end", now: 2500 },
    { type: "tool_end", callId: "a", now: 3000 },
  ]);

  // Act
  const breakdown = tracker.breakdown(3000);

  // Assert — the mid-tool prompt pauses the tool bucket: 500ms before the
  // wait plus 500ms after it, never the full 1000..3000 span.
  assert.deepStrictEqual(breakdown, { inference: 0, tool: 1000, wait: 1000, total: 2000 });
});

it("excludes user and toolResult messages from inference", () => {
  // Arrange
  const tracker = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "message_start", role: "user", now: 1000 },
    { type: "message_end", role: "user", now: 2000 },
    { type: "message_start", role: "toolResult", now: 2000 },
    { type: "message_end", role: "toolResult", now: 2500 },
    { type: "message_start", role: "assistant", now: 2500 },
  ]);

  // Act
  const breakdown = tracker.breakdown(3000);

  // Assert — only the assistant span 2500..3000 counts as inference.
  assert.deepStrictEqual(breakdown, { inference: 500, tool: 0, wait: 0, total: 2000 });
});

it("keeps inference plus tool plus wait at or below total active time at every instant", () => {
  // Arrange — interleaved parallel tools and a mid-tool user prompt.
  const script: ActivityEvent[] = [
    { type: "run_start", now: 1000 },
    { type: "message_start", role: "assistant", now: 1000 },
    { type: "tool_start", callId: "a", now: 1300 },
    { type: "tool_start", callId: "b", now: 1700 },
    { type: "wait_start", now: 1800 },
    { type: "wait_end", now: 2100 },
    { type: "tool_end", callId: "b", now: 2400 },
    { type: "tool_end", callId: "a", now: 2600 },
    { type: "message_end", role: "assistant", now: 3000 },
  ];

  // Act — query the machine as it stands at each instant: the events up to
  // that instant, then the breakdown read at it.
  const at = (now: number): TimeBreakdown => {
    const partial = new ActivityTracker();
    for (const event of script) {
      if (event.now > now) break;
      partial.handle(event);
    }
    return partial.breakdown(now);
  };
  const observed: TimeBreakdown[] = [1500, 2000, 2700, 3200].map(at);

  // Assert — buckets are mutually exclusive, so the sum never exceeds the
  // run's wall clock; the difference is the implicit overhead.
  const expected: TimeBreakdown[] = [
    { inference: 300, tool: 200, wait: 0, total: 500 },
    { inference: 300, tool: 500, wait: 200, total: 1000 },
    { inference: 400, tool: 1000, wait: 300, total: 1700 },
    { inference: 700, tool: 1000, wait: 300, total: 2200 },
  ];
  assert.deepStrictEqual(observed, expected);
  for (const b of observed) {
    assert.ok(b.inference + b.tool + b.wait <= b.total);
    assert.strictEqual(b.inference + b.tool + b.wait, b.total - (b.total - b.inference - b.tool - b.wait));
  }
});

it("folds open spans at run end and reports the frozen split", () => {
  // Arrange — tool still open and message subsumed when the run closes.
  const tracker = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "message_start", role: "assistant", now: 1000 },
    { type: "tool_start", callId: "a", now: 2000 },
  ]);

  // Act
  const frozen = tracker.closeRun(4000);

  // Assert
  assert.deepStrictEqual(frozen, { inference: 1000, tool: 2000, wait: 0, total: 3000 });
  assert.strictEqual(tracker.isRunOpen(), false);
  // The frozen breakdown persists for the idle render.
  assert.deepStrictEqual(tracker.breakdown(9999), frozen);
});

// ---------------------------------------------------------------------------
// Wait parity — the tracker reproduces the numbers behind the previous
// activeWorkingMs/waitingMs helpers exactly, including the clamp when waits
// consume the whole runtime.
// ---------------------------------------------------------------------------

it("parity: the tracker reproduces the wait-aware active-work totals", () => {
  // Active work = run wall clock minus waits, matching activeWorkingMs.

  // No waits: old helper returned 4000 for a run from t=1s at t=5s.
  const noWait = trackerWith([{ type: "run_start", now: 1000 }]);
  assert.strictEqual(noWait.breakdown(5000).total - noWait.breakdown(5000).wait, 4000);

  // A completed 2s wait: old helper returned 2000.
  const completedWait = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "wait_start", now: 2000 },
    { type: "wait_end", now: 4000 },
  ]);
  const completed = completedWait.breakdown(5000);
  assert.strictEqual(completed.total - completed.wait, 2000);

  // A completed 2s wait plus an in-flight 1s wait: old helper returned 1000.
  const inFlightWait = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "wait_start", now: 2000 },
    { type: "wait_end", now: 4000 },
    { type: "wait_start", now: 4000 },
  ]);
  const inFlight = inFlightWait.breakdown(5000);
  assert.strictEqual(inFlight.total - inFlight.wait, 1000);
});

it("parity: active work clamps to zero when waits consume the runtime", () => {
  // A wait open for the whole run: active work is 0 at any instant, never
  // negative (the old helper clamped `elapsed - waitingAccum` to zero).
  const tracker = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "wait_start", now: 1000 },
  ]);

  const mid = tracker.breakdown(3000);
  assert.strictEqual(mid.total - mid.wait, 0);

  // The run closes folding the open wait; the frozen split is all wait.
  const frozen = tracker.closeRun(5000);
  assert.deepStrictEqual(frozen, { inference: 0, tool: 0, wait: 4000, total: 4000 });
});

it("parity: waitingMs reports the open wait span and 0 when no prompt is open", () => {
  const idle = trackerWith([{ type: "run_start", now: 1000 }]);
  assert.strictEqual(idle.waitingMs(5000), 0);

  const waiting = trackerWith([
    { type: "run_start", now: 1000 },
    { type: "wait_start", now: 4000 },
  ]);
  assert.strictEqual(waiting.waitingMs(5000), 1000);
  assert.strictEqual(waiting.isWaiting(), true);
});

// ---------------------------------------------------------------------------
// toTrackerEvent — maps pi-shaped event fields onto tracker descriptors at
// the wire boundary. The tracker never imports pi types; index.ts reads the
// pi event fields and passes a plain object here.
// ---------------------------------------------------------------------------

it("toTrackerEvent maps pi message roles and tool calls onto tracker descriptors", () => {
  // Assistant message_start opens an inference span.
  assert.deepStrictEqual(
    toTrackerEvent({ kind: "message_start", role: "assistant", now: 1000 }),
    { type: "message_start", role: "assistant", now: 1000 },
  );
  // toolResult message_end never maps to an assistant span.
  assert.strictEqual(
    toTrackerEvent({ kind: "message_end", role: "toolResult", now: 2000 }),
    undefined,
  );
  // User messages never map either.
  assert.strictEqual(
    toTrackerEvent({ kind: "message_start", role: "user", now: 2000 }),
    undefined,
  );
  // Tool executions carry their call id through.
  assert.deepStrictEqual(
    toTrackerEvent({ kind: "tool_execution_start", toolCallId: "call_1", now: 3000 }),
    { type: "tool_start", callId: "call_1", now: 3000 },
  );
  assert.deepStrictEqual(
    toTrackerEvent({ kind: "tool_execution_end", toolCallId: "call_1", now: 4000 }),
    { type: "tool_end", callId: "call_1", now: 4000 },
  );
});

it("toTrackerEvent feeds the tracker a live inference/tool script", () => {
  // The full boundary: the wiring opens the run directly (agent_start) and
  // routes message/tool events through the mapper; deterministic buckets out.
  const tracker = new ActivityTracker();
  tracker.handle({ type: "run_start", now: 1000 });
  const script: TrackerEventSource[] = [
    { kind: "message_start", role: "assistant", now: 1000 },
    { kind: "tool_execution_start", toolCallId: "call_1", now: 2000 },
    { kind: "tool_execution_end", toolCallId: "call_1", now: 4000 },
    { kind: "message_end", role: "assistant", now: 5000 },
  ];
  for (const event of script) {
    const mapped = toTrackerEvent(event);
    if (mapped) tracker.handle(mapped);
  }
  const breakdown = tracker.breakdown(6000);
  // tool 2000..4000 = 2s; inference 1000..2000 + 4000..5000 = 2s.
  assert.deepStrictEqual(breakdown, { inference: 2000, tool: 2000, wait: 0, total: 5000 });
});