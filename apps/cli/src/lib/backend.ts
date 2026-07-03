import {
  HttpIngestSink,
  HttpViewSource,
  StorageIngestSink,
  StorageViewSource,
  type Config,
  type IngestSink,
  type ViewSource,
} from "@ccshare/core";
import { makeStorage } from "./storage.js";
import { DEFAULT_SERVER_URL } from "./links.js";

/**
 * The composition seam above `makeStorage`: commands never touch raw Storage for
 * reading/writing the ledger — the daemon writes through an {@link IngestSink},
 * views read through a {@link ViewSource}. Selfhost wraps the local adapter;
 * shared mode talks to the ccshare server. Constructors don't connect, so these
 * are safe to call eagerly.
 */

/** env override (dev / self-hosted server) → saved config → the hardcoded host. */
export function resolveServerUrl(cfg?: Config | null, env = process.env): string {
  return env.CCSHARE_SERVER_URL?.trim() || cfg?.server?.url || DEFAULT_SERVER_URL;
}

/**
 * A bearer token rides on every request, so refuse to send it in the clear:
 * only https, or plain http to this machine (dev servers). Returns a problem
 * string, or null when the URL is fine.
 */
export function validateServerUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `invalid server URL: ${url}`;
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
    return "refusing plain http to a remote server (the bearer token would travel unencrypted) — use https";
  }
  return `server URL must be http(s), got ${parsed.protocol}`;
}

function sharedCreds(cfg: Config): { url: string; token: string } {
  const token = cfg.server?.token;
  if (!token) {
    throw new Error("shared-hosting setup is incomplete (no token) — re-run `ccshare init`");
  }
  return { url: resolveServerUrl(cfg), token };
}

export function makeIngestSink(cfg: Config): IngestSink {
  if (cfg.mode === "shared") {
    const { url, token } = sharedCreds(cfg);
    return new HttpIngestSink(url, token);
  }
  return new StorageIngestSink(makeStorage(cfg));
}

export function makeViewSource(cfg: Config): ViewSource {
  if (cfg.mode === "shared") {
    const { url, token } = sharedCreds(cfg);
    return new HttpViewSource(url, token);
  }
  return new StorageViewSource(makeStorage(cfg));
}
