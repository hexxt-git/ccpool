import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

/**
 * Normalize a storage URL before passing it to libsql:
 * - Bare paths (no scheme) are treated as `file:` URLs.
 * - Leading `~` is expanded to the home directory in `file:` URLs.
 */
export function normalizeUrl(url: string): string {
  if (url === ":memory:") return url;
  if (!url.includes("://") && !url.startsWith("file:")) {
    url = "file:" + url;
  }
  if (url.startsWith("file:")) {
    let path = url.slice("file:".length);
    if (path.startsWith("//")) path = path.slice(2);
    if (path.startsWith("~")) path = homedir() + path.slice(1);
    return "file:" + path;
  }
  return url;
}

/** For a `file:` URL, make sure the parent directory exists before opening it. */
export function ensureFileDir(url: string): void {
  if (!url.startsWith("file:")) return;
  let path = url.slice("file:".length);
  if (path.startsWith("//")) path = path.slice(2);
  if (path.length === 0 || path === ":memory:") return;
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
}
