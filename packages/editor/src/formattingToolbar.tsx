/**
 * Custom formatting (text-selection) toolbar for the web editor.
 *
 * Keeps every BlockNote default (bold/italic/…, and the block-type dropdown —
 * which already offers Quote) and adds:
 *
 *  - Callout entries (one per kind) in the block-type dropdown, so a selection
 *    can be turned into a callout in place;
 *  - "Ask AI" — hands the selected text to the host (opens the Assist panel
 *    prefilled) when the host wires `onAskAi`;
 *  - "Copy as Markdown" — the selected blocks through the callout-aware
 *    Markdown exporter, onto the clipboard.
 */
import {
  blockTypeSelectItems,
  FormattingToolbar,
  getFormattingToolbarItems,
  useBlockNoteEditor,
  useComponentsContext,
  type BlockTypeSelectItem,
} from "@blocknote/react";
import { CALLOUT_ICON_PATHS, CALLOUT_KINDS, type CalloutKind } from "./callout";
import {
  blocksToMarkdownWithCallouts,
  type MarkdownEditor,
} from "./calloutMarkdown";

/** Feather-style icon component for a callout kind (matches the block icon). */
function calloutKindIcon(kind: CalloutKind) {
  return function CalloutKindIcon(props: { size?: string | number }) {
    return (
      <svg
        viewBox="0 0 24 24"
        width={props.size ?? 16}
        height={props.size ?? 16}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        dangerouslySetInnerHTML={{ __html: CALLOUT_ICON_PATHS[kind] }}
      />
    );
  };
}

function SparkIcon(props: { size?: string | number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3 13.9 8.1 19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
    </svg>
  );
}

function CopyIcon(props: { size?: string | number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Human label for a kind ("Callout: Warning"). */
function calloutItemName(kind: CalloutKind): string {
  return `Callout: ${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/** The default block-type dropdown items plus one entry per callout kind. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectItemsWithCallouts(dict: any): BlockTypeSelectItem[] {
  return [
    ...blockTypeSelectItems(dict),
    ...CALLOUT_KINDS.map((kind) => ({
      name: calloutItemName(kind),
      type: "callout",
      props: { kind },
      icon: calloutKindIcon(kind),
    })),
  ];
}

export function SelfnoteFormattingToolbar({
  onAskAi,
}: {
  /** When set, an "Ask AI" button sends the selected text to the host. */
  onAskAi?: (selection: string) => void;
}) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext();
  if (!Components) return null;

  const copyMarkdown = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyEditor = editor as any;
      const blocks: unknown[] =
        anyEditor.getSelection?.()?.blocks ?? [anyEditor.getTextCursorPosition().block];
      const md = await blocksToMarkdownWithCallouts(
        editor as unknown as MarkdownEditor,
        blocks,
      );
      await navigator.clipboard?.writeText(md.trim());
    } catch {
      /* clipboard unavailable — nothing sensible to do */
    }
  };

  const askAi = () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onAskAi?.(((editor as any).getSelectedText?.() as string) ?? "");
    } catch {
      onAskAi?.("");
    }
  };

  return (
    <FormattingToolbar>
      {...getFormattingToolbarItems(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selectItemsWithCallouts((editor as any).dictionary),
      )}
      {onAskAi ? (
        <Components.FormattingToolbar.Button
          key="askAiButton"
          label="Ask AI"
          mainTooltip="Ask AI about this selection"
          icon={<SparkIcon />}
          onClick={askAi}
        />
      ) : null}
      <Components.FormattingToolbar.Button
        key="copyMarkdownButton"
        label="MD"
        mainTooltip="Copy selection as Markdown"
        icon={<CopyIcon />}
        onClick={() => void copyMarkdown()}
      />
    </FormattingToolbar>
  );
}
