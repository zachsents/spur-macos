// The vitals widget's page, one HTML document with its script bundled in (an MCP App view loads
// nothing from outside): this Mac's picture between its meters, on the cell's own background, in
// Switch's inks and type, which a host's theme variables of the same names replace. Everything is
// in hundredths of its width, so it scales with its cell.
import path from "node:path"
import { view } from "switch-ext-kit"

import type { Look } from "./look.ts"
import { picture } from "./picture.ts"

/** Its cell's shape: width over height. */
export const RATIO = 2.5

const STYLE = `
:root{color-scheme:light dark;
--ink:var(--color-ink,light-dark(#0a0a0a,#ededed));--ink2:var(--color-ink2,light-dark(#555555,#a1a1a1));
--off:var(--color-line-1,light-dark(#c8c8c8,#2c2c2c));--red:var(--color-red,#d42a1f);
--sans:var(--font-sans,-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif);
--sign:var(--font-sign,"DIN Condensed","DINCondensed-Bold","Barlow Condensed",sans-serif);
--u:min(1vw,${RATIO}vh);--shadow:.28;--rim:light-dark(rgb(0 0 0/.16),transparent)}
:root[data-theme=dark]{--shadow:.8}
html,body{margin:0;height:100%;overflow:hidden;background:transparent}
body{visibility:hidden;font-family:var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;cursor:default}
.vitals{box-sizing:border-box;height:100%;display:grid;grid-template-columns:28fr 44fr 28fr;padding:calc(2.6*var(--u)) calc(3*var(--u))}
.side{display:flex;flex-direction:column;justify-content:center;gap:calc(2.4*var(--u));min-width:0}
.mac{position:relative;margin:0;min-width:0;min-height:0}
.mac svg{position:absolute;inset:0;width:100%;height:100%}
.cap{stroke:var(--rim);stroke-width:1px;vector-effect:non-scaling-stroke}
.plate{align-self:flex-start;background:#000;color:#fff;font:700 calc(2.9*var(--u))/1 var(--sign);text-transform:uppercase;letter-spacing:.03em;padding:calc(.9*var(--u)) calc(1.2*var(--u)) calc(.6*var(--u));max-width:100%;box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meter[hidden]{display:none}
.head{display:flex;align-items:baseline;gap:calc(.8*var(--u));white-space:nowrap}
.name{font:700 calc(2.9*var(--u))/1 var(--sign);text-transform:uppercase;letter-spacing:.03em;color:var(--ink2);min-width:0;overflow:hidden;text-overflow:ellipsis}
.figure{margin-left:auto;font:600 calc(3.7*var(--u))/1 var(--sans);font-variant-numeric:tabular-nums}
.unit{margin-left:.2em;font-size:.72em;font-weight:500;color:var(--ink2)}
.bar{display:grid;gap:calc(.36*var(--u));height:calc(1.2*var(--u));margin-top:calc(1.1*var(--u))}
.cell{background:var(--off)}
.lit{background:var(--ink)}
.alert .lit{background:var(--red)}
.warn{display:none;align-self:center;width:calc(2.6*var(--u));height:calc(2.6*var(--u))}
.warn svg{display:block;width:100%;height:100%}
.alert .warn{display:block}
`

const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** The page for a Mac that looks like `look`, `machine` on its plate. */
export const vitalsPage = (machine: string, look: Look) =>
  view(path.join(import.meta.dir, "vitals-view.ts"), {
    head: '<meta name="color-scheme" content="light dark">',
    style: STYLE,
    body: `<main class="vitals"><section class="side" id="left"><span class="plate">${escape(machine)}</span></section><figure class="mac">${picture(look)}</figure><section class="side" id="right"></section></main>`,
  })
