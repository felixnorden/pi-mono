/**
 * Locks the house box look between the pi-free core scene and the themed
 * `BorderedBox` component.
 *
 * The core's `buildEditorBox` draws its frame from the same pure
 * `@ftrdotdev/pi-tui/box-frame` model that `BorderedBox` wraps, so the two
 * must render byte-identically once painted. This test assembles both paths
 * for representative editors and asserts the equal output — if either the
 * core wrapper or the component wrapper drifts from the shared frame, the
 * editor box and the tui/tracker/preview boxes diverge visually.
 */
import { assert, it } from "@effect/vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { makeBorderedBox } from "@ftrdotdev/pi-tui";
import { buildBoxFrame } from "@ftrdotdev/pi-tui/box-frame";
import type { EditorState } from "../core/editor.ts";
import { buildEditorBox, buildEditorRows } from "../core/scene.ts";
import { paintScene } from "./painter.ts";

const identityTheme = {
  fg: (_color: string, text: string): string => text,
  inverse: (text: string): string => text,
  bold: (text: string): string => text,
} as unknown as Theme;

const THEMED = [
  { text: "", cursor: 0 },
  { text: "ab", cursor: 1 },
  { text: "hello world", cursor: 5 },
  { text: "a\nb", cursor: 1 },
  { text: "one\ntwo", cursor: 7 },
  { text: "x".repeat(20), cursor: 20 },
] as const satisfies readonly EditorState[];

it("painted core editor box is byte-identical to BorderedBox for representative editors", () => {
  for (const editor of THEMED) {
    for (const width of [10, 24, 40]) {
      const boxWidth = Math.max(4, width);
      const painted = paintScene({ lines: buildEditorBox(editor, boxWidth) }, identityTheme);

      const frame = buildBoxFrame(boxWidth, { paddingX: 1 });
      assert.ok(frame, `frame should exist at width ${width}`);
      const rows = buildEditorRows(editor, frame!.contentWidth);
      const body: Component = {
        render: () => paintScene({ lines: rows }, identityTheme),
        invalidate: () => {},
      };
      const boxed = makeBorderedBox(body, identityTheme, { color: "border" }).render(boxWidth);

      assert.deepStrictEqual(painted, boxed, `editor ${JSON.stringify(editor)} at width ${width}`);
    }
  }
});

it("painted editor box matches BorderedBox output even when a label would fit", () => {
  const editor: EditorState = { text: "hi", cursor: 2 };
  const width = 40;
  const painted = paintScene({ lines: buildEditorBox(editor, width) }, identityTheme);

  const frame = buildBoxFrame(width, { paddingX: 1 });
  assert.ok(frame);
  const rows = buildEditorRows(editor, frame!.contentWidth);
  const body: Component = {
    render: () => paintScene({ lines: rows }, identityTheme),
    invalidate: () => {},
  };
  // A label must not leak into the editor box: BorderedBox with a label that
  // does not fit renders the same plain frame as the core.
  const boxed = makeBorderedBox(body, identityTheme, {
    color: "border",
    label: "x".repeat(100),
  }).render(width);

  assert.deepStrictEqual(painted, boxed);
});
