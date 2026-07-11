/** Project URLs and OSC 8 terminal hyperlinks (clickable in supporting terminals). */
export const GITHUB_URL = "https://github.com/hexxt-git/ccpool";
export const SITE_URL = "https://ccpool.hexxt.dev";

/**
 * The hosted ccpool server every init points at by default. Hardcoded on
 * purpose — members only ever type the two passwords. `CCPOOL_SERVER_URL`
 * overrides it for development and self-hosted servers.
 */
export const DEFAULT_SERVER_URL = "https://api.ccpool.hexxt.dev";

/**
 * Wrap `text` as a clickable OSC 8 hyperlink to `url`. When `enabled` is false
 * (e.g. piped/redirected output), returns the plain text — the visible label is
 * usually the URL itself, so it stays useful without the escape sequence.
 */
export function link(text: string, url: string, enabled = true): string {
  if (!enabled) return text;
  // OSC 8 ; ; <url> BEL <text> OSC 8 ; ; BEL
  return `]8;;${url}${text}]8;;`;
}
