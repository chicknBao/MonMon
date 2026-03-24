#!/usr/bin/env node
/**
 * Node ESM requires explicit ".js" in relative imports. tsc emits extensionless
 * paths; rewrite dist JS outputs so `node apps/indexer` can load @monmon/shared.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist");

function fix(content) {
  return content
    .replace(/from\s+(["'])(\.\/[^"']+)\1/g, (m, q, rel) => {
      if (rel.endsWith(".js")) return m;
      return `from ${q}${rel}.js${q}`;
    })
    .replace(/export\s+\*\s+from\s+(["'])(\.\/[^"']+)\1/g, (m, q, rel) => {
      if (rel.endsWith(".js")) return m;
      return `export * from ${q}${rel}.js${q}`;
    });
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".js")) {
      const s = fs.readFileSync(p, "utf8");
      const next = fix(s);
      if (next !== s) fs.writeFileSync(p, next);
    }
  }
}

walk(dist);
