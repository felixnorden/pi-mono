// Pure scripted-event activity state machine for the footer timer.
//
// Every wall-clock instant of an open run is charged to exactly one of four
// exclusive buckets — inference, tool, waiting, or implicit overhead — and
// the tracker exposes a deterministic breakdown at any injected `now`.
// The class mirrors TurnTelemetryTracker (telemetry.ts): the constructor
// takes no clock, every method takes `now`, and handle() dispatches typed
// descriptors. Date.now() lives only in the pi event wiring (index.ts).

export type MessageRole = "user" | "assistant" | "toolResult";

export type ActivityEvent =
  | { type: "run_start" | "run_end"; now: number }
  | { type: "message_start" | "message_end"; role: MessageRole; now: number }
  | { type: "tool_start" | "tool_end"; callId: string; now: number }
  | { type: "wait_start" | "wait_end"; now: number };

export interface TimeBreakdown {
  inference: number;
  tool: number;
  wait: number;
  total: number;
}

/** One of the four exclusive activities; overhead is the residual bucket. */
type Activity = "inference" | "tool" | "wait" | "overhead";

const ZERO_BREAKDOWN: TimeBreakdown = { inference: 0, tool: 0, wait: 0, total: 0 };

export class ActivityTracker {
  private runOpen = false;
  private runStart: number | undefined;
  private openMessage = false;
  private readonly openTools = new Set<string>();
  private waitOpen = false;
  private activity: Activity | undefined;
  private openSince: number | undefined;
  private inferenceMs = 0;
  private toolMs = 0;
  private waitMs = 0;
  private frozen: TimeBreakdown | undefined;

  /** Dispatches a scripted event, charging the outgoing activity's interval. */
  handle(event: ActivityEvent): void {
    switch (event.type) {
      case "run_start":
        this.startRun(event.now);
        return;
      case "run_end":
        this.closeRun(event.now);
        return;
      case "message_start":
        this.startMessage(event.role, event.now);
        return;
      case "message_end":
        this.endMessage(event.role, event.now);
        return;
      case "tool_start":
        this.startTool(event.callId, event.now);
        return;
      case "tool_end":
        this.endTool(event.callId, event.now);
        return;
      case "wait_start":
        this.startWait(event.now);
        return;
      case "wait_end":
        this.endWait(event.now);
        return;
    }
  }

  /** True while an agent run is open. */
  isRunOpen(): boolean {
    return this.runOpen;
  }

  /** True while a blocking user-facing prompt is open. */
  isWaiting(): boolean {
    return this.waitOpen;
  }

  /**
   * Milliseconds of the open user-wait at `now`, or 0 when no prompt is
   * open (parity with the previous waitingMs helper).
   */
  waitingMs(now: number): number {
    if (!this.waitOpen || this.activity !== "wait" || this.openSince === undefined) return 0;
    return Math.max(0, now - this.openSince);
  }

  /**
   * The bucket totals at `now`: accumulated charged intervals plus the
   * open activity's span. While no run is open this returns the frozen
   * breakdown from the last closeRun (all zeros before any run).
   */
  breakdown(now: number): TimeBreakdown {
    if (!this.runOpen) return this.frozen ?? ZERO_BREAKDOWN;
    const total = Math.max(0, now - (this.runStart ?? now));
    return { ...this.snapshots(now), total };
  }

  /**
   * Folds every open span into its accumulator and freezes the run's
   * breakdown, so the idle render can show the split next to the done
   * total. Returns the frozen breakdown.
   */
  closeRun(now: number): TimeBreakdown {
    this.charge(now);
    if (!this.runOpen) return this.frozen ?? ZERO_BREAKDOWN;

    // charge() already folded the open span into the accumulators; reading
    // the accumulators directly avoids double-counting it via snapshots().
    const total = Math.max(0, now - (this.runStart ?? now));
    this.frozen = { inference: this.inferenceMs, tool: this.toolMs, wait: this.waitMs, total };
    this.runOpen = false;
    this.runStart = undefined;
    this.activity = undefined;
    this.openSince = undefined;
    this.openMessage = false;
    this.openTools.clear();
    this.waitOpen = false;
    return this.frozen;
  }

  private startRun(now: number): void {
    // A run start opens a fresh machine. agent_start overwrites a previous
    // run in the old wiring, so an unconditional reset matches that.
    this.runOpen = true;
    this.runStart = now;
    this.openMessage = false;
    this.openTools.clear();
    this.waitOpen = false;
    this.inferenceMs = 0;
    this.toolMs = 0;
    this.waitMs = 0;
    this.frozen = undefined;
    this.setActivity(now);
  }

  private startMessage(role: MessageRole, now: number): void {
    if (!this.runOpen || role !== "assistant") return;
    if (this.openMessage) return; // defensive: already open
    this.charge(now);
    this.openMessage = true;
    this.setActivity(now);
  }

  private endMessage(role: MessageRole, now: number): void {
    if (!this.runOpen || role !== "assistant") return;
    if (!this.openMessage) return; // defensive: not open
    this.charge(now);
    this.openMessage = false;
    this.setActivity(now);
  }

  private startTool(callId: string, now: number): void {
    if (!this.runOpen) return;
    if (this.openTools.has(callId)) return; // defensive: already running
    this.charge(now);
    this.openTools.add(callId);
    this.setActivity(now);
  }

  private endTool(callId: string, now: number): void {
    if (!this.runOpen) return;
    if (!this.openTools.has(callId)) return; // defensive: not running
    this.charge(now);
    this.openTools.delete(callId);
    this.setActivity(now);
  }

  private startWait(now: number): void {
    if (!this.runOpen || this.waitOpen) return; // defensive: nested prompts
    this.charge(now);
    this.waitOpen = true;
    this.setActivity(now);
  }

  private endWait(now: number): void {
    if (!this.runOpen || !this.waitOpen) return;
    this.charge(now);
    this.waitOpen = false;
    this.setActivity(now);
  }

  /** Charge the outgoing activity's open interval into its accumulator. */
  private charge(now: number): void {
    if (this.activity === undefined || this.openSince === undefined) return;
    const delta = Math.max(0, now - this.openSince);
    switch (this.activity) {
      case "inference":
        this.inferenceMs += delta;
        break;
      case "tool":
        this.toolMs += delta;
        break;
      case "wait":
        this.waitMs += delta;
        break;
      case "overhead":
        break; // implicit residual; no accumulator
    }
  }

  /**
   * The next activity is a pure function of the open counts; priority is
   * waiting > tool > inference, with overhead as the residual.
   */
  private setActivity(now: number): void {
    let next: Activity;
    if (!this.runOpen) next = "overhead";
    else if (this.waitOpen) next = "wait";
    else if (this.openTools.size > 0) next = "tool";
    else if (this.openMessage) next = "inference";
    else next = "overhead";
    this.activity = next;
    this.openSince = now;
  }

  /** Accumulators plus the open activity's span at `now`. */
  private snapshots(now: number): { inference: number; tool: number; wait: number } {
    let inference = this.inferenceMs;
    let tool = this.toolMs;
    let wait = this.waitMs;
    if (this.activity === "inference" && this.openSince !== undefined) {
      inference += Math.max(0, now - this.openSince);
    } else if (this.activity === "tool" && this.openSince !== undefined) {
      tool += Math.max(0, now - this.openSince);
    } else if (this.activity === "wait" && this.openSince !== undefined) {
      wait += Math.max(0, now - this.openSince);
    }
    return { inference, tool, wait };
  }
}