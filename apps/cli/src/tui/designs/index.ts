import type React from "react";
import type { DesignModel } from "../../lib/design-model.js";
import { M, P } from "./palette.js";
import { overview, overviewVisible } from "./overview.js";
import { split, splitVisible } from "./split.js";
import { mono, monoVisible } from "./mono.js";

export interface Design {
  name: string;
  /** How many member rows fit given the inner content dimensions. */
  visible: (cols: number, rows: number) => number;
  render: (model: DesignModel, cols: number, rows: number, off: number) => React.ReactElement;
  /** Bottom-bar colors so the footer matches each design's palette. */
  footer: { message: string; shortcuts: string };
}

export const DESIGNS: Design[] = [
  {
    name: "overview",
    visible: overviewVisible,
    render: overview,
    footer: { message: P.tan, shortcuts: P.dim },
  },
  {
    name: "split view",
    visible: splitVisible,
    render: split,
    footer: { message: P.tan, shortcuts: P.dim },
  },
  { name: "mono", visible: monoVisible, render: mono, footer: { message: M.mid, shortcuts: M.lo } },
];
