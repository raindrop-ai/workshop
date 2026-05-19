import { Fragment, type MouseEvent } from "react";
import { router } from "../router";
import { runPath } from "./navigation";

/**
 * Parse inline `span_id: <id>` and `trace_<id>` tokens and return a
 * ReactNode with the matches rendered as clickable links. The link click
 * dispatches a custom window event; views (SpanTree, RunsPage, etc.) listen
 * and handle navigation / scroll-into-view themselves.
 *
 * Supported token shapes:
 *   span_id: abc123        (canonical — colon + space + hex)
 *   span_id:abc123         (no space, still matched)
 *   trace_abc123def        (run id prefixed by "trace_")
 *
 * Ids are 8–64 hex characters; the upper bound keeps us from grabbing
 * unrelated runs of text. Matching is case-insensitive.
 */

const TOKEN_RE =
  /(span_id:\s*)([0-9a-f]{8,64})|(trace_)([0-9a-f]{8,64})/gi;

type DeepLinkPart =
  | { type: "text"; key: string; text: string }
  | { type: "link"; key: string; kind: "span" | "run"; id: string; label: string };

function parseDeepLinkParts(text: string): DeepLinkPart[] {
  const parts: DeepLinkPart[] = [];
  let cursor = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > cursor) {
      parts.push({ type: "text", key: `text-${cursor}`, text: text.slice(cursor, idx) });
    }
    if (m[2]) {
      parts.push({ type: "link", key: `span-${m[2]}-${idx}`, kind: "span", id: m[2], label: `${m[1]}${m[2]}` });
    } else if (m[4]) {
      parts.push({ type: "link", key: `run-${m[4]}-${idx}`, kind: "run", id: m[4], label: `${m[3]}${m[4]}` });
    }
    cursor = idx + m[0].length;
  }
  if (cursor < text.length) {
    parts.push({ type: "text", key: `text-${cursor}`, text: text.slice(cursor) });
  }
  return parts;
}

export function DeepLinkedText({ text }: { text: string }) {
  if (!text) return text;
  return (
    <>
      {parseDeepLinkParts(text).map((part) =>
        part.type === "text" ? (
          <Fragment key={part.key}>{part.text}</Fragment>
        ) : (
          <DeepLink key={part.key} kind={part.kind} id={part.id} label={part.label} />
        ),
      )}
    </>
  );
}

function DeepLink({ kind, id, label }: { kind: "span" | "run"; id: string; label: string }) {
  function openDeepLink(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (kind === "run") {
      void router.navigate(runPath(id));
      return;
    }
    // Dispatch once so RunDetail swaps tabs if needed, then again after a
    // frame so SpanTree's listener is mounted to catch it.
    window.dispatchEvent(new CustomEvent("workshop:deep-link-span", { detail: { spanId: id } }));
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("workshop:deep-link-span", { detail: { spanId: id } }));
    }, 80);
  }
  return (
    <button
      type="button"
      onClick={openDeepLink}
      style={{
        appearance: "none",
        border: 0,
        fontFamily: "'JetBrains Mono', Menlo, monospace",
        fontSize: "0.92em",
        lineHeight: "inherit",
        color: "#60a5fa",
        background: "rgba(37, 99, 235, 0.12)",
        padding: "0 4px",
        borderRadius: 3,
        textDecoration: "none",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
