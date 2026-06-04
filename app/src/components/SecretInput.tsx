import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { C } from "../utils/colors";

export function SecretInput({
  label,
  description,
  placeholder,
  value,
  onChange,
  onSave,
  onClear,
  saved,
  saving,
  getKeyUrl,
  getKeyLabel,
}: {
  label: string;
  description?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSave?: (value: string) => void;
  onClear?: () => void | Promise<void>;
  saved: boolean;
  saving?: boolean;
  /** External console where the user can generate this key. Renders a small link next to the description. */
  getKeyUrl?: string;
  /** Override link label. Defaults to "Get a key →". */
  getKeyLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);
  const canReveal = value.length > 0;
  const canSave = value.trim().length > 0 && !!onSave;
  const canClear = saved && value.trim().length === 0 && !!onClear;
  const showSave = canSave;
  const displayPlaceholder = saved && value.length === 0
    ? focused ? "" : "********"
    : placeholder;
  useEffect(() => {
    if (value.length === 0) setShow(false);
  }, [value]);
  const saveAndExitEditMode = () => {
    if (!canSave) return;
    setFocused(false);
    inputRef.current?.blur();
    onSave?.(value);
  };
  const clearSavedKey = () => {
    if (!canClear || saving) return;
    setFocused(false);
    inputRef.current?.blur();
    onClear?.();
  };
  return (
    <div className="py-1">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12px]" style={{ color: C.fg3 }}>{label}</span>
        {saved && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color: C.green, background: "rgba(96,227,109,0.08)" }}>
            saved
          </span>
        )}
      </div>
      <div className="flex gap-1.5">
        <input
          ref={inputRef}
          className={`flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-[12px] font-mono outline-none transition-colors focus:ring-1 focus:ring-white/20 ${saved ? "secret-input-saved" : ""}`}
          style={{ background: "rgba(255,255,255,0.05)", color: C.fg3, border: `1px solid ${C.border}` }}
          type={show ? "text" : "password"}
          placeholder={displayPlaceholder}
          value={value}
          onPointerDown={() => {
            if (saved && value.length === 0) setFocused(true);
          }}
          onFocus={() => setFocused(true)}
          onChange={e => onChange(e.target.value)}
          onBlur={() => {
            setFocused(false);
          }}
          onKeyDown={e => {
            if (e.key === "Enter") {
              if (canSave) saveAndExitEditMode();
              else if (canClear) clearSavedKey();
              else e.currentTarget.blur();
            }
          }}
        />
        {canReveal && (
          <button
            type="button"
            className="px-2 py-1.5 rounded-md transition-colors hover:bg-white/10 flex-shrink-0"
            style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${C.border}`, color: C.fg1 }}
            onMouseDown={e => e.preventDefault()}
            onClick={() => setShow(!show)}
            title={show ? "Hide typed key" : "Show typed key"}
          >
            {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        )}
        {canClear && (
          <button
            type="button"
            className="px-2 py-1.5 rounded-md transition-colors hover:bg-white/10 flex-shrink-0"
            style={{
              background: "rgba(255,255,255,0.04)",
              border: `1px solid ${C.border}`,
              color: saving ? C.fg0 : C.red,
              cursor: saving ? "default" : "pointer",
            }}
            onMouseDown={e => e.preventDefault()}
            onClick={clearSavedKey}
            disabled={saving}
            title="Clear saved key"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {(description || getKeyUrl || showSave) && (
        <div className="flex items-baseline justify-between gap-3 mt-1.5">
          <div className="flex min-w-0 items-center gap-2">
            {description && <div className="text-[11px]" style={{ color: C.fg0 }}>{description}</div>}
          </div>
          <div className="flex items-center gap-2">
            {showSave ? (
              <button
                type="button"
                className="text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap flex-shrink-0 transition-colors hover:bg-white/10"
                style={{
                  color: saving || !canSave ? C.fg0 : C.green,
                  background: saving || !canSave ? "rgba(255,255,255,0.04)" : "rgba(96,227,109,0.08)",
                  border: `1px solid ${saving || !canSave ? C.border : "rgba(96,227,109,0.16)"}`,
                  cursor: saving || !canSave ? "default" : "pointer",
                }}
                onClick={saveAndExitEditMode}
                disabled={saving || !canSave}
              >
                {saving ? "saving..." : "Save"}
              </button>
            ) : getKeyUrl && (
              <a
                href={getKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium whitespace-nowrap hover:underline flex-shrink-0"
                style={{ color: C.fg3 }}
              >
                {getKeyLabel ?? "Get a key \u2192"}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
