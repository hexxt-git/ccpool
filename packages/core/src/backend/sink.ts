import type { TickBatch, UsageSample } from "../types.js";

/** What a daemon needs at startup: the ledger's binding + reset-detection seed. */
export interface IngestBootstrap {
  /** The Claude account the ledger/group is bound to, or null when unbound. */
  accountId: string | null;
  /** Latest sample per cap — seeds reset detection across daemon restarts. */
  samples: UsageSample[];
}

/** Metadata accompanying every ingested tick. */
export interface IngestMeta {
  /** ISO 8601 tick time on the sender. */
  at: string;
  /** The sender's freshly resolved hydrated accountUuid, or null. */
  accountId: string | null;
}

/**
 * Where a daemon's observations go — ONE call per tick, whatever is behind it
 * (a storage adapter in self-host mode, `POST /v1/ingest` in shared mode).
 * Implementations reject a tick whose account doesn't match the ledger's
 * binding with {@link AccountConflictError} (§1.5) and write nothing.
 */
export interface IngestSink {
  bootstrap(): Promise<IngestBootstrap>;
  ingest(batch: TickBatch, meta: IngestMeta): Promise<void>;
  close(): Promise<void>;
}

/** The tick's account differs from the ledger's binding — nothing was written. */
export class AccountConflictError extends Error {
  constructor(public readonly boundAccountId: string | null) {
    super(
      `account mismatch: the ledger is bound to a different Claude account` +
        (boundAccountId ? ` (${boundAccountId})` : "")
    );
    this.name = "AccountConflictError";
  }
}
