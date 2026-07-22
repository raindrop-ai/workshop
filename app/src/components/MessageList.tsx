import { useState } from "react";
import { Chevron } from "./Icons";
import { parseMessages, messagesFromSpan } from "../utils/messageParsing";
import type { Message } from "../utils/messageParsing";

export { parseMessages, messagesFromSpan };

const ROLE_STYLES: Record<string, { bg: string; border: string; text: string; label: string }> = {
  system:    { bg: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.13)", text: "#b0bcc2", label: "#7d8a90" },
  user:      { bg: "rgba(255,255,255,0.03)", border: "rgba(255,255,255,0.07)", text: "#c8d5dc", label: "#9aa5ab" },
  assistant: { bg: "rgba(255,255,255,0.025)", border: "rgba(255,255,255,0.06)", text: "#c8d5dc", label: "#9aa5ab" },
  tool:      { bg: "rgba(165,124,245,0.03)",  border: "rgba(165,124,245,0.08)", text: "#b0bcc2", label: "#A57CF5" },
};

export function MessageImages({ images, border }: { images: string[]; border?: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((src, i) => (
        <a key={i} href={src} target="_blank" rel="noreferrer" className="block">
          <img
            src={src}
            alt="attached image"
            loading="lazy"
            className="rounded-md max-h-64 max-w-full object-contain"
            style={border ? { border: `1px solid ${border}` } : undefined}
          />
        </a>
      ))}
    </div>
  );
}

function MessageBubble({ msg, defaultExpanded }: { msg: Message; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const style = ROLE_STYLES[msg.role] ?? ROLE_STYLES.system;
  const imageCount = msg.images?.length ?? 0;
  const previewText = msg.content || (imageCount > 0 ? `${imageCount} image${imageCount > 1 ? "s" : ""}` : "");
  const preview = previewText.slice(0, 100).replace(/\n/g, " ") + (previewText.length > 100 ? "\u2026" : "");

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: style.bg, border: `1px solid ${style.border}` }}>
      <button
        className="flex items-center gap-2 px-3 py-1.5 w-full text-left"
        style={{ borderBottom: expanded ? `1px solid ${style.border}` : "none" }}
        onClick={() => setExpanded(!expanded)}
      >
        <Chevron open={expanded} size={8} />
        <span className="text-[11px] font-mono font-medium uppercase tracking-wide" style={{ color: style.label }}>
          {msg.role}
        </span>
        {!expanded && (
          <span className="text-[11px] truncate flex-1" style={{ color: "#b0bcc2" }}>{preview}</span>
        )}
        {msg.content.length > 100 && (
          <span className="text-[10px] ml-auto flex-shrink-0" style={{ color: "#7d8a90" }}>
            {(msg.content.length / 1000).toFixed(1)}k
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 select-text cursor-text space-y-2">
          {msg.content && (
            <pre className="text-[13px] leading-relaxed font-sans whitespace-pre-wrap select-text" style={{ color: style.text, userSelect: "text" }}>
              {msg.content}
            </pre>
          )}
          {imageCount > 0 && <MessageImages images={msg.images!} border={style.border} />}
        </div>
      )}
    </div>
  );
}

export function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-1.5">
      {messages.map((msg, i) => (
        <MessageBubble key={i} msg={msg} defaultExpanded={msg.content.length < 500} />
      ))}
    </div>
  );
}
