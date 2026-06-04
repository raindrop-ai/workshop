import React, { useCallback, useMemo, useState } from "react";
import { C } from "../utils/colors";

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const SIZE = 11;
const LH = 1.4;
const ROW_GAP = 2;
const INDENT = 20;

const mono: React.CSSProperties = { fontFamily: MONO, fontSize: SIZE, lineHeight: LH };

const dc = {
  key: C.fg3,
  string: "#b5a078",
  number: "#7aaccc",
  boolean: "#6ab",
  null: C.fg0,
  brace: C.fg0,
  comma: C.fg0,
  guide: "rgba(255,255,255,0.06)",
  guideHover: "rgba(255,255,255,0.15)",
  count: C.fg0,
  arrow: C.fg1,
  copyFlash: "rgba(96,227,109,0.15)",
};

const Arrow: React.FC<{ open: boolean }> = ({ open }) => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={dc.arrow} strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round"
    style={{ display: "inline-block", verticalAlign: "middle", marginRight: 3,
      transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "" }}>
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const Key: React.FC<{ name: string; isIdx?: boolean }> = ({ name, isIdx }) => (
  <span style={{ color: dc.key, fontWeight: isIdx ? 400 : 600, fontFamily: MONO }}>{name}</span>
);

const ExpandableString: React.FC<{ value: string }> = ({ value }) => {
  const [expanded, setExpanded] = useState(false);
  const display = expanded ? value : value.slice(0, 300) + "\u2026";
  return (
    <>
      <span style={{ color: dc.string, fontFamily: MONO }}>&quot;{display}&quot;</span>
      <span onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        style={{ color: C.accent, cursor: "pointer", fontSize: SIZE - 1, marginLeft: 4, fontFamily: MONO, userSelect: "none" }}>
        {expanded ? "less" : "more"}
      </span>
    </>
  );
};

type NodeProps = { keyName?: string | number; value: unknown; depth: number; maxExpand: number; isLast: boolean };

const JsonNode: React.FC<NodeProps> = ({ keyName, value, depth, maxExpand, isLast }) => {
  const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
  const isArr = Array.isArray(value);
  const expandable = isObj || isArr;
  const [open, setOpen] = useState(depth < maxExpand);
  const trail = isLast ? "" : ",";

  const keyEl = keyName !== undefined ? (
    <>
      <Key name={String(keyName)} isIdx={typeof keyName === "number"} />
      <span style={{ color: dc.brace, fontFamily: MONO }}>: </span>
    </>
  ) : null;

  if (!expandable) {
    let color: string = C.fg2;
    let italic = false;
    let display: React.ReactNode;

    if (value === null) { color = dc.null; italic = true; display = "null"; }
    else if (value === undefined) { color = dc.null; italic = true; display = "undefined"; }
    else if (typeof value === "boolean") { color = dc.boolean; display = String(value); }
    else if (typeof value === "number") { color = dc.number; display = String(value); }
    else if (typeof value === "string") {
      color = dc.string;
      display = value.length > 300 ? <ExpandableString value={value} /> : <>&quot;{value}&quot;</>;
    } else { display = String(value); }

    return (
      <div style={{ ...mono, paddingLeft: depth * INDENT, wordBreak: "break-word", marginTop: ROW_GAP }}>
        {keyEl}
        <span style={{ color, fontStyle: italic ? "italic" : "normal", fontFamily: MONO }}>{display}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </div>
    );
  }

  const entries: [string | number, unknown][] = isArr
    ? value.map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const br = isArr ? ["[", "]"] : ["{", "}"];
  const n = entries.length;

  if (n === 0) {
    return (
      <div style={{ ...mono, paddingLeft: depth * INDENT }}>
        {keyEl}<span style={{ color: dc.brace, fontFamily: MONO }}>{br[0]}{br[1]}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </div>
    );
  }

  if (!open) {
    return (
      <div style={{ ...mono, paddingLeft: depth * INDENT, cursor: "pointer" }}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
        <Arrow open={false} />{keyEl}
        <span style={{ color: dc.brace, fontFamily: MONO }}>{br[0]}</span>
        <span style={{ color: dc.count, fontFamily: MONO, fontSize: SIZE - 1, margin: "0 4px" }}>
          {n} {isArr ? (n === 1 ? "item" : "items") : (n === 1 ? "key" : "keys")}
        </span>
        <span style={{ color: dc.brace, fontFamily: MONO }}>{br[1]}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </div>
    );
  }

  return (
    <div>
      <div style={{ ...mono, paddingLeft: depth * INDENT, cursor: "pointer" }}
        onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
        <Arrow open />{keyEl}<span style={{ color: dc.brace, fontFamily: MONO }}>{br[0]}</span>
      </div>
      <div style={{ position: "relative" }}>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: depth * INDENT + 5, width: 8, borderLeft: `1px solid ${dc.guide}`, cursor: "pointer", transition: "border-color 0.1s" }}
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
          onMouseEnter={(e) => { e.currentTarget.style.borderLeftColor = dc.guideHover; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderLeftColor = dc.guide; }} />
        {entries.map(([k, v], i) => (
          <JsonNode key={typeof k === "number" ? i : k} keyName={k} value={v} depth={depth + 1} maxExpand={maxExpand} isLast={i === n - 1} />
        ))}
      </div>
      <div style={{ ...mono, paddingLeft: depth * INDENT + 10 }}>
        <span style={{ color: dc.brace, fontFamily: MONO }}>{br[1]}</span>
        <span style={{ color: dc.comma, fontFamily: MONO }}>{trail}</span>
      </div>
    </div>
  );
};

export function JsonView({ data, maxExpand = 3 }: { data: unknown; maxExpand?: number }) {
  const parsed = useMemo(() => {
    if (typeof data === "string") { try { return JSON.parse(data); } catch { return data; } }
    return data;
  }, [data]);

  // Deep-parse stringified JSON values
  const deepParse = useCallback((v: unknown): unknown => {
    if (typeof v === "string") {
      const s = v.trim();
      if ((s[0] === "{" && s[s.length - 1] === "}") || (s[0] === "[" && s[s.length - 1] === "]")) {
        try { const p = JSON.parse(s); if (p && typeof p === "object") return deepParse(p); } catch {}
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(deepParse);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = deepParse(val);
      return o;
    }
    return v;
  }, []);

  const normalized = useMemo(() => deepParse(parsed), [parsed, deepParse]);

  if (parsed !== null && typeof parsed === "object") {
    return (
      <div style={{ fontFamily: MONO, fontSize: SIZE }} onClick={(e) => e.stopPropagation()}>
        <JsonNode value={normalized} depth={0} maxExpand={maxExpand} isLast />
      </div>
    );
  }

  return (
    <pre style={{ fontFamily: MONO, fontSize: SIZE, color: C.fg2, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
      {String(parsed)}
    </pre>
  );
}
