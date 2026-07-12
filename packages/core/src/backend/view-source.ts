import type { HistoryPage, HistoryQuery, SharedView } from "../types.js";

/**
 * Where a view reader gets the shared picture. `fetchView` is safe to call every
 * couple of seconds: implementations cache the computed view and only do heavy
 * work when the underlying data actually changed (change token on the server,
 * ETag/304 over HTTP). Throws when the backend is unreachable —
 * callers fall back to `state.json` exactly as before.
 */
export interface ViewSource {
  fetchView(now?: number): Promise<SharedView>;
  /**
   * A page of frozen history windows for one cap, newest first. Cold
   * path — read on demand by `ccpool history` and the TUI history mode, never on
   * the 2s refresh.
   */
  history(query: HistoryQuery): Promise<HistoryPage>;
  close(): Promise<void>;
}
