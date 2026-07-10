import type { HistoryPage, HistoryQuery, SharedView, TickBatch } from "../types.js";
import {
  AccountConflictError,
  type IngestBootstrap,
  type IngestMeta,
  type IngestSink,
} from "../backend/sink.js";
import type { ViewSource } from "../backend/view-source.js";
import type {
  ApiError,
  ApiErrorCode,
  AuthResponse,
  BootstrapResponse,
  CreateGroupRequest,
  GroupLookupResponse,
  IngestRequest,
  JoinGroupRequest,
  LoginRequest,
} from "./api.js";

/** A non-2xx server answer, with the ApiError code when the body carried one. */
export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | null,
    message: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * Per-request ceiling. A server that *refuses* a connection rejects `fetch`
 * promptly, but one that's unreachable in a way that *hangs* (packets dropped, a
 * wedged server that accepts the socket but never answers, a stalled DNS lookup)
 * would leave `fetch` pending forever. Without this, the reader's 2s poll stacks
 * hung requests and keeps painting the last-known view — never noticing the
 * server is down. The timeout turns that into a prompt rejection, so callers fall
 * back to `state.json` and surface "can't reach the server" exactly as they do
 * for a refused connection.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

interface HttpOptions {
  fetchImpl?: typeof fetch;
  /** Override the per-request timeout (ms). Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Merge an abort-on-timeout signal into a fetch init. `AbortSignal.timeout` is
 * available on both supported runtimes (Node ≥20, Bun); on firing it rejects the
 * fetch with a `TimeoutError` — not an `ApiRequestError`, so callers classify it
 * as unreachable (stale), never as logged-out.
 */
function withTimeout(init: RequestInit, timeoutMs: number): RequestInit {
  return { ...init, signal: AbortSignal.timeout(timeoutMs) };
}

async function throwApiError(res: Response): Promise<never> {
  let code: ApiErrorCode | null = null;
  let message = `server answered ${res.status}`;
  try {
    const body = (await res.json()) as ApiError;
    if (body.error) message = body.error;
    code = body.code ?? null;
  } catch {
    /* non-JSON error body — keep the status message */
  }
  throw new ApiRequestError(res.status, code, message);
}

/** Thin fetch wrapper for the auth endpoints (init/join/login flows). */
export class CcshareClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    opts: HttpOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(
      new URL(path, this.baseUrl),
      withTimeout(
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        this.timeoutMs
      )
    );
    if (!res.ok) await throwApiError(res);
    return (await res.json()) as T;
  }

  /** Does a group already exist for this account? (unauthenticated pre-check) */
  async lookupGroup(accountId: string, memberName?: string): Promise<GroupLookupResponse> {
    const url = new URL("/v1/groups/lookup", this.baseUrl);
    url.searchParams.set("accountId", accountId);
    if (memberName) {
      url.searchParams.set("memberName", memberName);
    }
    const res = await this.fetchImpl(url, withTimeout({ method: "GET" }, this.timeoutMs));
    if (!res.ok) await throwApiError(res);
    return (await res.json()) as GroupLookupResponse;
  }

  createGroup(r: CreateGroupRequest): Promise<AuthResponse> {
    return this.post("/v1/groups", r);
  }

  joinGroup(r: JoinGroupRequest): Promise<AuthResponse> {
    return this.post("/v1/groups/join", r);
  }

  login(r: LoginRequest): Promise<AuthResponse> {
    return this.post("/v1/login", r);
  }
}

/** The daemon's sink: one POST per tick, bearer-authenticated. */
export class HttpIngestSink implements IngestSink {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    opts: HttpOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async bootstrap(): Promise<IngestBootstrap> {
    const res = await this.fetchImpl(
      new URL("/v1/bootstrap", this.baseUrl),
      withTimeout({ headers: { authorization: `Bearer ${this.token}` } }, this.timeoutMs)
    );
    if (!res.ok) await throwApiError(res);
    const body = (await res.json()) as BootstrapResponse;
    return { accountId: body.accountId, samples: body.samples };
  }

  async ingest(batch: TickBatch, meta: IngestMeta): Promise<void> {
    const body: IngestRequest = { at: meta.at, accountId: meta.accountId, ...batch };
    const res = await this.fetchImpl(
      new URL("/v1/ingest", this.baseUrl),
      withTimeout(
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
          body: JSON.stringify(body),
        },
        this.timeoutMs
      )
    );
    if (res.ok) return;
    if (res.status === 409) {
      // The server knows the binding; it refused the tick outright (§1.5). We
      // don't learn the bound id — the daemon flags the conflict and drops the
      // batch, and recovery is automatic if the account signs back in.
      await res.body?.cancel().catch(() => {});
      throw new AccountConflictError(null);
    }
    await throwApiError(res);
  }

  async close(): Promise<void> {}
}

/**
 * The view reader. Sends `If-None-Match` with the last ETag so
 * the steady-state 2s poll is a bodyless 304; the server only recomputes (and
 * re-sends the few-KB view) when the ledger actually changed.
 */
export class HttpViewSource implements ViewSource {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cache: { etag: string; view: SharedView } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    opts: HttpOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchView(): Promise<SharedView> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (this.cache) headers["if-none-match"] = this.cache.etag;
    const res = await this.fetchImpl(
      new URL("/v1/view", this.baseUrl),
      withTimeout({ headers }, this.timeoutMs)
    );
    if (res.status === 304 && this.cache) {
      await res.body?.cancel().catch(() => {});
      return this.cache.view;
    }
    if (!res.ok) await throwApiError(res);
    const view = (await res.json()) as SharedView;
    const etag = res.headers.get("etag");
    this.cache = etag ? { etag, view } : null;
    return view;
  }

  async history(query: HistoryQuery): Promise<HistoryPage> {
    const url = new URL("/v1/history", this.baseUrl);
    url.searchParams.set("cap", query.cap);
    if (query.before) url.searchParams.set("before", query.before);
    if (query.limit) url.searchParams.set("limit", String(query.limit));
    const res = await this.fetchImpl(
      url,
      withTimeout({ headers: { authorization: `Bearer ${this.token}` } }, this.timeoutMs)
    );
    if (!res.ok) await throwApiError(res);
    return (await res.json()) as HistoryPage;
  }

  async close(): Promise<void> {}
}
