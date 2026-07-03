import type { SharedView, TickBatch } from "../types.js";
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

interface HttpOptions {
  fetchImpl?: typeof fetch;
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

  constructor(
    private readonly baseUrl: string,
    opts: HttpOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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
    const res = await this.fetchImpl(url, { method: "GET" });
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

/** The daemon's sink in shared mode: one POST per tick, bearer-authenticated. */
export class HttpIngestSink implements IngestSink {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    opts: HttpOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async bootstrap(): Promise<IngestBootstrap> {
    const res = await this.fetchImpl(new URL("/v1/bootstrap", this.baseUrl), {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) await throwApiError(res);
    const body = (await res.json()) as BootstrapResponse;
    return { accountId: body.accountId, samples: body.samples };
  }

  async ingest(batch: TickBatch, meta: IngestMeta): Promise<void> {
    const body: IngestRequest = { at: meta.at, accountId: meta.accountId, ...batch };
    const res = await this.fetchImpl(new URL("/v1/ingest", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
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
 * The view reader in shared mode. Sends `If-None-Match` with the last ETag so
 * the steady-state 2s poll is a bodyless 304; the server only recomputes (and
 * re-sends the few-KB view) when the ledger actually changed.
 */
export class HttpViewSource implements ViewSource {
  private readonly fetchImpl: typeof fetch;
  private cache: { etag: string; view: SharedView } | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    opts: HttpOptions = {}
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchView(): Promise<SharedView> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (this.cache) headers["if-none-match"] = this.cache.etag;
    const res = await this.fetchImpl(new URL("/v1/view", this.baseUrl), { headers });
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

  async close(): Promise<void> {}
}
