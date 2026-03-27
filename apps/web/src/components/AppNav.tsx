"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/swap", label: "Swap" },
  { href: "/lend", label: "Lend" },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <header
      style={{
        borderBottom: "1px solid #e5e5e5",
        background: "#fafafa",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 4,
          padding: "0 20px",
          maxWidth: 1200,
          margin: "0 auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginRight: 12, padding: "12px 0" }}>
          <Link
            href="/swap"
            style={{
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: "#111",
              textDecoration: "none",
            }}
          >
            MonMon
          </Link>
        </div>
        <nav style={{ display: "flex", alignItems: "stretch" }}>
          {links.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "0 14px",
                  textDecoration: "none",
                  color: active ? "#111" : "#555",
                  fontWeight: active ? 600 : 500,
                  fontSize: 15,
                  borderBottom: active ? "2px solid #111" : "2px solid transparent",
                  marginBottom: -1,
                }}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
