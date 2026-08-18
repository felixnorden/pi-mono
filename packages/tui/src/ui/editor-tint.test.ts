import { afterEach, assert, it } from "@effect/vitest";
import { Effect } from "effect";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  EditorTintService,
  type EditorTintServiceHandle,
  upsertBorderTintProvider,
} from "./editor-tint.ts";

const resolveTint = (): EditorTintServiceHandle =>
  Effect.runSync(Effect.service(EditorTintService).pipe(Effect.provide(EditorTintService.layer)));

// ---------------------------------------------------------------------------
// EditorTintService (configure / getTint)
// ---------------------------------------------------------------------------

it("returns undefined with no providers registered", () => {
  assert.strictEqual(resolveTint().getTint(), undefined);
});

it("returns the registered provider's tint", () => {
  const tint = resolveTint();
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "a", getTint: () => "success" }));
  assert.strictEqual(tint.getTint(), "success");
});

it("the last provider with a defined tint wins (later .configure overrides)", () => {
  const tint = resolveTint();
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "a", getTint: () => "success" }));
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "b", getTint: () => "error" }));
  assert.strictEqual(tint.getTint(), "error");
});

it("providers whose tint is undefined fall through to earlier ones", () => {
  const tint = resolveTint();
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "base", getTint: () => "success" }));
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "pass", getTint: () => undefined }));
  // "pass" is last but undefined → falls through to "base"
  assert.strictEqual(tint.getTint(), "success");
});

it("upserting the same id replaces it in place", () => {
  const tint = resolveTint();
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "x", getTint: () => "success" }));
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "x", getTint: () => "error" }));
  assert.strictEqual(tint.getTint(), "error");
});

it("a provider's tint is read live on every getTint (dynamic)", () => {
  const tint = resolveTint();
  let current: ThemeColor | undefined = "success";
  tint.configure((cur) => upsertBorderTintProvider(cur, { id: "dyn", getTint: () => current }));
  assert.strictEqual(tint.getTint(), "success");
  current = "warning";
  assert.strictEqual(tint.getTint(), "warning");
  current = undefined;
  assert.strictEqual(tint.getTint(), undefined);
});
