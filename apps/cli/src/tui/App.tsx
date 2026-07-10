import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { CAP_KINDS, type Config, type ViewSource } from "@ccshare/core";
import { gatherView, type LastRoster } from "../lib/view.js";
import { toDesignModel, type DesignModel } from "../lib/design-model.js";
import { loadConfig } from "../lib/config.js";
import { DESIGNS } from "./designs/index.js";
import { renderHistory, type HistoryState } from "./history.js";
import { P } from "./designs/palette.js";
import { useTermSize } from "./use-term-size.js";
import { GITHUB_URL, SITE_URL, link } from "../lib/links.js";

/**
 * Cycling promo line shown bottom-left; some link out (clickable in the terminal).
 * Kept roughly the same length so the footer doesn't flip between one and two rows
 * as the messages rotate.
 */
const MESSAGES: { label: string; url?: string }[] = [
  { label: "★ star ccshare on GitHub", url: GITHUB_URL },
  { label: "⚲ visit ccshare.hexxt.dev", url: SITE_URL },
  { label: "♥ sponsor ccshare's work", url: GITHUB_URL },
  { label: "↻ share access, don't lose it" },
  { label: "✎ open an issue on GitHub", url: GITHUB_URL },
];
const SHORTCUTS = "⇥ switch · ↑↓ scroll · h history · q quit";
const SHORTCUTS_CONFIG = "⇥ switch · ↑↓ scroll · h history · r re-init · q quit";
const SHORTCUTS_HISTORY = "⇥ cap · ↑↓ windows · ⏎ expand · h live · q quit";

/**
 * Live shared view. Polls the DB / state.json every 2s and re-renders the clock
 * every 1s so reset countdowns tick. Builds the same DesignModel the `status`
 * command uses, then hands it to one of three swappable designs (tab / shift+tab).
 */
export function App({
  cfg,
  viewSource,
  onConfigure,
  onLoggedOut,
}: {
  cfg: Config;
  viewSource: ViewSource;
  /** When set, `r` opens the re-init screen and the footer advertises it. */
  onConfigure?: () => void;
  /** The server rejected our bearer (revoked/rotated) — hand back to re-init (§13). */
  onLoggedOut?: () => void;
}): React.ReactElement {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { cols, rows } = useTermSize();
  const [model, setModel] = useState<DesignModel | null>(null);
  const [, setTick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [msg, setMsg] = useState(0);
  const [mode, setMode] = useState<"live" | "history">("live");
  const [hist, setHist] = useState<HistoryState>({
    capIdx: 0,
    windows: null,
    error: null,
    cursor: 0,
    expanded: false,
    memberOff: 0,
  });

  // History is cold/immutable — fetched on entering the mode and on cap change,
  // never on the 2s live refresh. A stale response for an old cap is discarded.
  const fetchHistory = useCallback(
    async (capIdx: number) => {
      setHist((h) => ({
        ...h,
        capIdx,
        windows: null,
        error: null,
        cursor: 0,
        expanded: false,
        memberOff: 0,
      }));
      try {
        const page = await viewSource.history({ cap: CAP_KINDS[capIdx]!, limit: 200 });
        setHist((h) => (h.capIdx === capIdx ? { ...h, windows: page.windows } : h));
      } catch (e) {
        setHist((h) => (h.capIdx === capIdx ? { ...h, error: (e as Error).message } : h));
      }
    },
    [viewSource]
  );

  // The last *clean* view's roster, reused when a poll can't reach the backend so
  // the members table keeps showing everyone instead of blanking (view.ts).
  const lastRoster = useRef<LastRoster | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [vm, freshCfg] = await Promise.all([
        gatherView(cfg, viewSource, lastRoster.current),
        loadConfig(),
      ]);
      // A rejected bearer isn't a view we can render — bail to re-init before we
      // paint a misleading all-`unknown` screen. Root logs out and swaps screens.
      if (vm.loggedOut && onLoggedOut) {
        onLoggedOut();
        return;
      }
      // Remember only clean reads, so a stale tick falls back to the last good
      // roster rather than chaining off an already-degraded one.
      if (!vm.stale)
        lastRoster.current = { shares: vm.shares, members: vm.members, users: vm.users };
      setModel(toDesignModel(vm, freshCfg?.name ?? cfg.name));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [cfg, viewSource, onLoggedOut]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 2000);
    const clock = setInterval(() => setTick((t) => t + 1), 1000);
    const promo = setInterval(() => setMsg((m) => (m + 1) % MESSAGES.length), 10000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      clearInterval(promo);
    };
  }, [refresh]);

  const innerCols = cols - 2;
  const n = DESIGNS.length;

  // bottom bar: one row when wide, two stacked when the message+shortcuts won't fit
  const current = MESSAGES[msg]!;
  const shortcutsText =
    mode === "history" ? SHORTCUTS_HISTORY : onConfigure ? SHORTCUTS_CONFIG : SHORTCUTS;
  const wide = innerCols >= current.label.length + shortcutsText.length + 4;
  const footerH = wide ? 1 : 2;
  // Leave the last terminal row unused so the rendered output stays strictly
  // shorter than the terminal. At full height Ink falls back to clearing the
  // whole screen every frame (ink.js: outputHeight >= stdout.rows), which
  // flickers on iTerm and most terminals; one row of slack keeps it on the
  // flicker-free incremental path.
  const appRows = Math.max(1, rows - 1);
  const bodyRows = Math.max(4, appRows - footerH);

  const visible = DESIGNS[idx]!.visible(innerCols, bodyRows);
  const total = model?.members.length ?? 0;
  const maxScroll = Math.max(0, total - visible);
  const off = Math.min(scroll, maxScroll);

  useInput(
    (input, key) => {
      if (input === "q") return void exit(); // q always quits, in any mode
      if (input === "h") {
        // toggle history ⇄ live; entering history kicks off a fetch
        if (mode === "live") {
          setMode("history");
          void fetchHistory(hist.capIdx);
        } else setMode("live");
        return;
      }

      if (mode === "history") {
        const wins = hist.windows;
        if (hist.expanded) {
          if (key.escape || key.return) setHist((h) => ({ ...h, expanded: false }));
          else if (key.downArrow || input === "j")
            setHist((h) => ({ ...h, memberOff: h.memberOff + 1 }));
          else if (key.upArrow || input === "k")
            setHist((h) => ({ ...h, memberOff: Math.max(0, h.memberOff - 1) }));
          return;
        }
        if (key.escape) return void setMode("live");
        if (key.tab) {
          const next = (hist.capIdx + (key.shift ? CAP_KINDS.length - 1 : 1)) % CAP_KINDS.length;
          void fetchHistory(next);
        } else if (key.return) {
          if (wins && wins.length) setHist((h) => ({ ...h, expanded: true, memberOff: 0 }));
        } else if (key.downArrow || input === "j")
          setHist((h) => ({ ...h, cursor: Math.min((wins?.length ?? 1) - 1, h.cursor + 1) }));
        else if (key.upArrow || input === "k")
          setHist((h) => ({ ...h, cursor: Math.max(0, h.cursor - 1) }));
        else if (input === "g") setHist((h) => ({ ...h, cursor: 0 }));
        else if (input === "G") setHist((h) => ({ ...h, cursor: (wins?.length ?? 1) - 1 }));
        return;
      }

      // live mode
      if (key.escape) return void exit();
      if (input === "r" && onConfigure) onConfigure();
      else if (key.tab) {
        // tab cycles designs forward; shift+tab reverses
        setIdx((i) => (i + (key.shift ? n - 1 : 1)) % n);
        setScroll(0);
      } else if (key.downArrow || input === "j") setScroll((s) => Math.min(maxScroll, s + 1));
      else if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
      else if (key.pageDown) setScroll((s) => Math.min(maxScroll, s + Math.max(1, visible - 1)));
      else if (key.pageUp) setScroll((s) => Math.max(0, s - Math.max(1, visible - 1)));
      else if (input === "g") setScroll(0);
      else if (input === "G") setScroll(maxScroll);
    },
    { isActive: !!isRawModeSupported }
  );

  const footer = DESIGNS[idx]!.footer;
  const message = (
    <Text color={footer.message}>
      {current.url ? link(current.label, current.url) : current.label}
    </Text>
  );
  const shortcuts = <Text color={footer.shortcuts}>{shortcutsText}</Text>;

  return (
    <Box flexDirection="column" width={cols} height={appRows} paddingX={1}>
      {mode === "history" ? (
        renderHistory(CAP_KINDS[hist.capIdx]!, hist, innerCols, bodyRows)
      ) : model ? (
        DESIGNS[idx]!.render(model, innerCols, bodyRows, off)
      ) : (
        <Box flexGrow={1}>
          <Text color={P.dim}>loading…</Text>
        </Box>
      )}
      {err ? <Text color={P.red}>error: {err}</Text> : null}
      {wide ? (
        <Box justifyContent="space-between">
          {message}
          {shortcuts}
        </Box>
      ) : (
        <Box flexDirection="column" alignItems="flex-end">
          {message}
          {shortcuts}
        </Box>
      )}
    </Box>
  );
}
