import { useEffect, useRef } from "react";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";

// Keep in sync with `.annotation-arriving` in index.css:
// 0.25s enter + 2 × 1.2s breathe ≈ 2.65s.
export const ANNOTATION_ARRIVAL_MS = 2700;

export const KIND_STYLES: Record<
  AnnotationKind,
  { icon: string; label: string; fg: string; bg: string; border: string }
> = {
  issue: { icon: "!", label: "issue", fg: "#f87171", bg: "rgba(220,38,38,0.12)", border: "rgba(220,38,38,0.35)" },
  good:  { icon: "✓", label: "good",  fg: "#34d399", bg: "rgba(5,150,105,0.12)",  border: "rgba(5,150,105,0.35)" },
  note:  { icon: "·", label: "note",  fg: "#60a5fa", bg: "rgba(37,99,235,0.12)",  border: "rgba(37,99,235,0.35)" },
};

export const SOURCE_GLYPH: Record<Annotation["source"], string> = {
  "claude-code": "◆",
  codex: "›",
  opencode: "OC",
  user: "·",
};

export function annotationSourceLabel(source: Annotation["source"]): string {
  if (source === "claude-code") return "Claude Code";
  if (source === "codex") return "Codex";
  if (source === "opencode") return "OpenCode";
  return "You";
}

/**
 * Icon-only chip (for span rows, runs-list badges, etc.).
 * When `arriving` is true, plays the arrival animation exactly once —
 * the parent is responsible for clearing that flag after it fires.
 */
export function AnnotationChip({
  annotation,
  arriving = false,
  onArrivalEnd,
  title,
  showLabel = false,
}: {
  annotation: Annotation;
  arriving?: boolean;
  onArrivalEnd?: () => void;
  title?: string;
  showLabel?: boolean;
}) {
  const style = KIND_STYLES[annotation.kind];
  const ref = useRef<HTMLSpanElement | null>(null);
  // Hold the latest callback in a ref so unstable arrow-function parents
  // don't reset the timer on every re-render (which would prevent the class
  // from ever being stripped while the surrounding tree is active).
  const endRef = useRef(onArrivalEnd);
  endRef.current = onArrivalEnd;

  useEffect(() => {
    if (!arriving) return;
    const handle = window.setTimeout(() => endRef.current?.(), ANNOTATION_ARRIVAL_MS);
    return () => window.clearTimeout(handle);
  }, [arriving]);

  return (
    <span
      ref={ref}
      className={arriving ? `annotation-arriving kind-${annotation.kind}` : undefined}
      title={title ?? annotation.note ?? style.label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: showLabel ? "0 7px" : "0 5px",
        height: 18,
        lineHeight: "18px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 500,
        fontFamily: "inherit",
        color: style.fg,
        background: style.bg,
        border: `1px solid ${style.border}`,
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 10 }}>{style.icon}</span>
      {showLabel ? style.label : null}
      <span style={{ fontSize: 8, opacity: 0.65, marginLeft: 1 }}>{SOURCE_GLYPH[annotation.source]}</span>
    </span>
  );
}
