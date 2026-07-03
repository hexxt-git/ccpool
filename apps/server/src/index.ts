import { serve } from "@hono/node-server";
import { makeApp } from "./app.js";
import { PgRegistry } from "./registry-pg.js";
import { PgTenantProvider } from "./tenants-pg.js";

/**
 * The hosted entry point. Postgres-only by design: one DATABASE_URL, registry
 * tables in the default schema, one schema per group. TLS terminates in front
 * of this process (the CLI refuses plain http for non-localhost servers).
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is required (postgres://…). For local dev, run `make db-up` and `pnpm dev`."
  );
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);

const registry = new PgRegistry(url);
const tenants = new PgTenantProvider(url);

/**
 * Bring the registry schema up. In dev we keep retrying so the server survives
 * the DB not being up yet (and recovers the moment `make db-up` finishes);
 * in prod a failure is fatal (fail fast behind the process manager).
 */
async function ensureRegistry(): Promise<void> {
  for (;;) {
    try {
      await registry.ensure();
      return;
    } catch (err) {
      console.warn(`waiting for Postgres at ${url} — run \`make db-up\` (retrying in 3s)`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
await ensureRegistry();

const app = makeApp({ registry, tenants });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ccshare server listening on :${info.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    server.close(() => {
      void Promise.all([registry.close(), tenants.close()]).then(() => process.exit(0));
    });
  });
}
