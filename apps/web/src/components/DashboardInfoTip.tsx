"use client";

import { useCallback, useId, useRef, useState } from "react";

type Props = {
  /** Short label for screen readers, e.g. "Explain borrowed total" */
  label: string;
  /** Full layman explanation (also used as native title fallback). */
  text: string;
};

/**
 * Small "i" control: shows popover on hover and when focused; native title as fallback.
 */
export function DashboardInfoTip({ label, text }: Props) {
  const id = useId();
  const panelId = `${id}-panel`;
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLeave = useCallback(() => {
    if (leaveTimer.current != null) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearLeave();
    setOpen(true);
  }, [clearLeave]);

  const hideSoon = useCallback(() => {
    clearLeave();
    leaveTimer.current = setTimeout(() => setOpen(false), 120);
  }, [clearLeave]);

  return (
    <span
      style={{ position: "relative", display: "inline-flex", verticalAlign: "middle", marginLeft: 6 }}
      onMouseEnter={show}
      onMouseLeave={hideSoon}
    >
      <button
        type="button"
        aria-label={label}
        title={text}
        aria-expanded={open}
        aria-controls={panelId}
        onFocus={show}
        onBlur={() => {
          clearLeave();
          setOpen(false);
        }}
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: "1px solid rgba(0,0,0,0.2)",
          background: "rgba(0,0,0,0.04)",
          color: "rgba(0,0,0,0.55)",
          fontSize: 11,
          fontWeight: 700,
          fontStyle: "italic",
          lineHeight: 1,
          padding: 0,
          cursor: "help",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        i
      </button>
      {open ? (
        <span
          id={panelId}
          role="tooltip"
          onMouseEnter={show}
          onMouseLeave={hideSoon}
          style={{
            position: "absolute",
            left: 0,
            top: "calc(100% + 6px)",
            zIndex: 50,
            minWidth: 200,
            maxWidth: 300,
            padding: "10px 12px",
            fontSize: 12,
            fontWeight: 400,
            fontStyle: "normal",
            lineHeight: 1.45,
            color: "#222",
            background: "#fff",
            border: "1px solid rgba(0,0,0,0.12)",
            borderRadius: 8,
            boxShadow: "0 4px 14px rgba(0,0,0,0.08)",
            textAlign: "left",
          }}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
