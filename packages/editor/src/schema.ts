/**
 * The shared BlockNote schema for the web/React editor — the default blocks plus
 * our custom `callout` block. Every `useCreateBlockNote` / `BlockNoteEditor.create`
 * call in this package must pass THIS schema so the live editor, the headless
 * importer/renderer, and the read-only preview all agree on the block set (and,
 * crucially, so the Yjs document round-trips a callout instead of dropping it).
 *
 * The mobile vanilla editor builds the equivalent schema from an identical block
 * config — see apps/mobile/src/editor/editorHtml.ts and callout.tsx CALLOUT_CONFIG.
 */
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { CalloutBlock } from "./callout";

/**
 * `createReactBlockSpec` returns a factory `(options?) => BlockSpec` in BlockNote
 * 0.54, so we invoke `CalloutBlock()` to get the concrete spec.
 */
export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: CalloutBlock(),
  },
});

export type SelfnoteSchema = typeof schema;
