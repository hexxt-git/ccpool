/**
 * Value → colour for usage bars: a continuous green → yellow → orange → red ramp
 * so a bar's single solid colour shifts smoothly with its percentage.
 *
 * Calculated, not table-driven: the hue is interpolated from 120° (green) down to
 * 0° (red) at a fixed saturation/lightness, which sweeps through yellow (60°) and
 * orange (~30°) on its own — every percentage gets its own distinct colour.
 */

const HUE_GREEN = 120; // 0% → green
const HUE_RED = 0; // 100% → red
const SAT = 0.6;
const LIGHT = 0.48;

/** HSL → "#rrggbb". h in degrees, s/l in 0..1. */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

/** Colour for a 0..100 percentage along the green→red ramp. */
export function heat(pct: number): string {
  const t = Math.min(1, Math.max(0, pct / 100));
  return hslToHex(HUE_GREEN + (HUE_RED - HUE_GREEN) * t, SAT, LIGHT);
}
