/**
 * Shared types + budget for the "multi-note context" feature (mobile).
 *
 * A ContextNote is a note the user has picked to fold into an Assist turn as
 * extra grounding. It is resolved to an ExtraDoc (with Markdown body) at send
 * time. Mirrors web's ContextPicker/AssistPanel wiring for strict parity.
 */
import type { ExtraDocSource } from "../api";

export interface ContextNote {
  id: string;
  title: string;
  icon: string | null;
  source: ExtraDocSource;
}

/** Server-enforced budget (docs/features/multi-note-context.md §3.5). */
export const MAX_EXTRA_DOCS = 6;
export const MAX_CONTEXT_CHARS = 24_000;

/** Human label for a source tag on a context chip. */
export function sourceLabel(source: ExtraDocSource): string {
  return source === "linked" ? "Linked" : source === "recent" ? "Recent" : "Search";
}

/** Truncate a note body to the per-note budget before sending (server also caps). */
export function truncateBody(text: string): string {
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text;
}
