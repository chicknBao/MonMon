import type { Env } from "../config.js";

/**
 * Logs whether Neverland GraphQL exposes fields useful for health-factor style MVP.
 * Read-only; does not persist.
 */
export async function runNeverlandSchemaProbe(env: Env): Promise<void> {
  const url = env.NEVERLAND_LENDING_GRAPHQL_URL?.trim();
  if (!url) return;

  const query = `
    query IntrospectUser {
      __type(name: "User") { fields { name } }
    }
  `;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const secret = env.NEVERLAND_LENDING_GRAPHQL_SECRET?.trim();
    if (secret) headers["x-hasura-admin-secret"] = secret;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      console.log(`neverland-probe: HTTP ${res.status}`);
      return;
    }
    const json: any = await res.json();
    if (json.errors?.length) {
      console.log(`neverland-probe: errors ${JSON.stringify(json.errors)}`);
      return;
    }
    const fields = json.data?.__type?.fields;
    if (!fields) {
      console.log("neverland-probe: no User type in schema (or introspection disabled)");
      return;
    }
    const names = (fields as { name: string }[]).map((f) => f.name);
    const interesting = names.filter((n) => /health|liquidat|account|total|debt|collat/i.test(n));
    if (interesting.length) {
      console.log(`neverland-probe: User fields of interest: ${interesting.join(", ")}`);
    } else {
      console.log(
        `neverland-probe: no obvious HF/account fields on User type (${names.length} fields total). Extend indexer when schema supports it.`,
      );
    }
  } catch (e) {
    console.log("neverland-probe: failed", e);
  }
}
