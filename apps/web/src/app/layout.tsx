import type { ReactNode } from "react";
import { AppNav } from "../components/AppNav";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "ui-sans-serif, system-ui" }}>
        <AppNav />
        {children}
      </body>
    </html>
  );
}

