"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/swap", label: "Swap" },
  { href: "/lend", label: "Lend" },
  { href: "/methodology", label: "Methodology" },
] as const;

export function AppNav() {
  const pathname = usePathname();

  return (
    <header className="appNavHeader">
      <div className="appNavInner">
        <div className="appNavBrand">
          <Link href="/dashboard" className="appNavBrandLink">
            MonMon
          </Link>
        </div>
        <nav className="appNavLinks" aria-label="Primary">
          {links.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`navLink${active ? " navLinkActive" : ""}`}
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
