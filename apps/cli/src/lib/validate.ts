import type { StorageDriver } from "@ccshare/core";

export function validateUrl(driver: StorageDriver, url: string): string | null {
  const isRemote = url.startsWith("libsql://");
  const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");
  const isFile = !isRemote && !isPostgres && url !== ":memory:";

  if (driver === "sqlite" && isRemote) {
    return 'Remote libsql:// URLs require the "libsql" driver — re-run and choose libsql.';
  }
  if (driver !== "postgres" && isPostgres) {
    return "That looks like a PostgreSQL URL — re-run and choose the postgres driver.";
  }
  if (driver === "postgres" && !isPostgres) {
    return "PostgreSQL driver requires a postgres:// or postgresql:// URL.";
  }
  if (isFile && !url.startsWith("file:") && !url.startsWith("/") && !url.startsWith("~")) {
    return (
      `"${url}" is a relative path, which depends on the working directory and will break ` +
      `when the daemon runs as a background process. Use an absolute path (/path/to/db), ` +
      `~/path/to/db, or file:/path/to/db.`
    );
  }
  return null;
}
