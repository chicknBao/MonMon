"use client";

import type { ReactNode } from "react";
import { useId, useState } from "react";

type Props = {
  /** Stable id fragment for aria-controls */
  id: string;
  title: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * Progressive disclosure: button toggles panel; use for dense dashboard blocks.
 */
export function CollapsibleSection({ id, title, defaultOpen = false, children }: Props) {
  const uid = useId();
  const panelId = `${id}-${uid}-panel`;
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="collapsibleSection">
      <button
        type="button"
        className="collapsibleTrigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="collapsibleChevron" aria-hidden>
          {open ? "▼" : "▶"}
        </span>
        <span>{title}</span>
      </button>
      {open ? (
        <div id={panelId} className="collapsiblePanel">
          {children}
        </div>
      ) : null}
    </div>
  );
}
