import { serve } from "@hono/node-server";
import { makeApp } from "./app.js";
import { makeServerDeps, resolveServerBackend, type ServerBackendConfig } from "./backend.js";

/**
 * The hosted entry point. Runs on Postgres or libSQL (one shared database, one
 * relational `group_id` per group). TLS terminates in front of this process (the
 * CLI refuses plain http for non-localhost servers).
 */
let backend: ServerBackendConfig;
try {
  backend = resolveServerBackend();
} catch (err) {
  console.error(`${(err as Error).message}. For local dev, run \`make db-up\` and \`pnpm dev\`.`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8787);

const deps = makeServerDeps(backend);

/**
 * Bring the schema up (ledger + registry tables, one idempotent init). In dev we
 * keep retrying so the server survives the DB not being up yet (and recovers the
 * moment it comes online); in prod a failure is fatal (fail fast behind the
 * process manager).
 */
async function ensureDatabase(): Promise<void> {
  for (;;) {
    try {
      await deps.db.init();
      return;
    } catch {
      console.warn(`waiting for the ${backend.driver} database at ${backend.url} (retrying in 3s)`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
await ensureDatabase();

const app = makeApp(deps);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ccshare server (${backend.driver}) listening on :${info.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`received ${sig}, shutting down`);
    server.close(() => {
      void Promise.all([deps.tenants.close(), deps.db.close()]).then(() => process.exit(0));
    });
  });
}
