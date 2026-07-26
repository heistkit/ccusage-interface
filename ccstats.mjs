#!/usr/bin/env node
// ccstats — a local usage dashboard for Claude Code.
//
// Reads the JSONL transcripts Claude Code already writes on this machine (the same files
// ccusage reads) and generates a single self-contained HTML page. No dependencies, no build
// step, no network: everything it needs — fonts included — is inlined into the output.
//
//   node ccstats.mjs            build ccstats.html next to this script
//   node ccstats.mjs --serve    live dashboard on http://127.0.0.1:8743
//   node ccstats.mjs --help     all options
//
// PRIVACY: this reads only usage metadata — timestamps, model names, token counts, and a
// hashed session id. It never reads, stores, or transmits the content of your messages, your
// prompts, your file paths, or your project names. See collect() below; that loop is the
// entire surface. Nothing is uploaded anywhere, by anything, ever.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// where the transcripts live
// ---------------------------------------------------------------------------
// Claude Code honours CLAUDE_CONFIG_DIR (comma-separated for multiple installs) and otherwise
// keeps everything under ~/.claude. ~/.config/claude is the XDG-style layout some setups use.
// We probe all of them and keep whichever actually exist, so a user who has never touched an
// env var and a user with three installs both get the right answer with no configuration.
function defaultRoots() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const bases = env
    ? env.split(",").map((s) => s.trim()).filter(Boolean)
    : [join(homedir(), ".claude"), join(homedir(), ".config", "claude")];
  return bases.map((b) => (b.endsWith("projects") ? b : join(b, "projects"))).filter(existsSync);
}

// ---------------------------------------------------------------------------
// optional config — ccstats.config.json beside this script, or --config <path>
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = {
  roots: null,        // string[] — override transcript locations entirely
  pricing: null,      // { "<substring or /regex/>": [inputPerMTok, outputPerMTok] }
  modelNames: null,   // { "<substring or /regex/>": "Display name" }
  accent: null,       // hex — overrides the green accent in both themes
  lang: null,         // "en" | "ko" — initial language, user can still switch
  theme: null,        // "light" | "dark" — initial theme, user can still switch
  currency: null,     // { symbol, rate } — rate multiplies the USD estimate
  hashSessions: true, // false keeps raw session UUIDs in the output; not recommended
};
function loadConfig(explicit) {
  const path = explicit || join(DIR, "ccstats.config.json");
  if (!existsSync(path)) return { ...CONFIG_DEFAULTS };
  try {
    return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    console.error("ccstats: ignoring " + path + " — " + e.message);
    return { ...CONFIG_DEFAULTS };
  }
}
let CONFIG = loadConfig();

// Geist + Geist Mono (Vercel fonts), extracted from the Flow app's embedded base64 —
// keeps the page fully offline. Missing file = graceful fallback to system fonts.
let FONTS = "";
try { FONTS = readFileSync(join(DIR, "geist-fonts.css"), "utf8"); } catch {}

function* jsonlFiles(dir) {
  let entries;
  // a transcript dir can vanish or be unreadable mid-scan; one bad directory must not take
  // down the whole run on someone else's machine
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

// FNV-1a. Session ids are needed to count distinct sessions across day boundaries, but the raw
// UUIDs identify real conversations and end up in the exported JSON, so they are reduced to an
// opaque 8-char token first. Collisions are irrelevant here — worst case two sessions merge in
// a count. Nothing is ever reversed back into an id.
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// day key in local time
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function buildData(opts = {}) {
const roots = opts.roots || CONFIG.roots || defaultRoots();
const hashSessions = CONFIG.hashSessions !== false;
const days = {}; // dayKey -> { models:{name:{i,o,cw,cr,c1h,msg}}, msgs, sessions:Set, hours:[24], hm }
const seenUsage = new Set(); // dedup token counting (message id + request id)
const seenMsg = new Set(); // dedup message counting (uuid)
const models = new Set();
let files = 0, lines = 0, badLines = 0;

// hm: hour -> model -> [i,o,cw,cr]. Sparse (only hours that actually billed) and keyed by model
// because cost per token spans 12x between the priciest and cheapest models — an hourly bar
// built from a blended day rate would be visibly wrong on any mixed-model hour.
const getDay = (k) => (days[k] ??= { models: {}, msgs: 0, sessions: new Set(), hours: new Array(24).fill(0), hm: {} });

for (const root of roots) {
for (const file of jsonlFiles(root)) {
  files++;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; } // locked/rotated mid-scan
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    let o;
    try { o = JSON.parse(line); } catch { badLines++; continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (!o.timestamp) continue;
    const d = new Date(o.timestamp);
    if (isNaN(d)) continue;
    const day = getDay(dayKey(d));

    // hashed, never the raw id — see shortHash
    if (o.sessionId) day.sessions.add(hashSessions ? shortHash(o.sessionId) : o.sessionId);

    // the fallback key uses only the file path's hash, so no path ever reaches the output
    const uuid = o.uuid || shortHash(file) + ":" + o.timestamp + ":" + o.type;
    if (!seenMsg.has(uuid)) {
      seenMsg.add(uuid);
      day.msgs++;
      day.hours[d.getHours()]++;
    }

    if (o.type === "assistant" && o.message) {
      const m = o.message;
      const model = m.model || "unknown";
      models.add(model);
      const entry = (day.models[model] ??= { i: 0, o: 0, cw: 0, cr: 0, c1h: 0, msg: 0 });
      entry.msg++;
      const u = m.usage;
      if (u) {
        const dedup = m.id ? m.id + ":" + (o.requestId || "") : uuid;
        if (!seenUsage.has(dedup)) {
          seenUsage.add(dedup);
          // Cache writes bill at different multipliers by TTL: 1.25x input for the 5-minute
          // cache, 2x for the 1-hour cache. Newer transcripts break this out under
          // usage.cache_creation; older ones only have the flat total, which we treat as 5m.
          const cc = u.cache_creation || null;
          const c1h = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
          const cwTotal = u.cache_creation_input_tokens != null
            ? u.cache_creation_input_tokens
            : (cc ? (cc.ephemeral_5m_input_tokens || 0) + c1h : 0);
          const vals = [
            u.input_tokens || 0,
            u.output_tokens || 0,
            Math.max(0, cwTotal - c1h), // 5-minute writes
            u.cache_read_input_tokens || 0,
            c1h,                        // 1-hour writes, billed at 2x
          ];
          entry.i += vals[0];
          entry.o += vals[1];
          entry.cw += vals[2];
          entry.cr += vals[3];
          entry.c1h += vals[4];
          const hb = (day.hm[d.getHours()] ??= {});
          const he = (hb[model] ??= [0, 0, 0, 0, 0]);
          for (let n = 0; n < 5; n++) he[n] += vals[n];
        }
      }
    }
  }
}
}

return {
  generatedAt: new Date().toISOString(),
  files, lines, badLines,
  roots: roots.length,          // count only — the paths themselves are not shipped
  models: [...models].sort(),
  config: {
    accent: CONFIG.accent || null,
    lang: CONFIG.lang || null,
    theme: CONFIG.theme || null,
    currency: CONFIG.currency || null,
    pricing: CONFIG.pricing || null,
    modelNames: CONFIG.modelNames || null,
  },
  days: Object.fromEntries(
    Object.entries(days)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { models: v.models, msgs: v.msgs, sessions: [...v.sessions], hours: v.hours, hm: v.hm }])
  ),
};
}

const TEMPLATE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Belt and braces on the privacy claim: this page has no reason to touch the network, and
     this policy makes that unenforceable-by-accident rather than merely true today. 'self' on
     connect-src is what lets the --serve build poll its own /data.json; the static file has
     nothing to connect to. No CDN, no font host, no analytics, no img-src beyond data: -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer">
<title>ccstats</title>
<style>__FONTS__</style>
<style>
  :root {
    --bg: #f2f3f2; --card: #e9ebea; --text: #2b3137; --muted: #6e7781;
    --chip: #dde0df; --chip-active: #f7f8f7; --border: #d3d7d5;
    /* fill ramp — the top end is compressed the way the dark ramp's is (b3→b4 barely
       moves) instead of marching down to a hard forest green, which read as too heavy
       against the light card. --accent stays put: it is a *text* colour and needs the
       contrast, so only the block fills soften. */
    --cell: #dfe2e0; --b1: #b7efc2; --b2: #7ad893; --b3: #4ec46f; --b4: #3aae5b;
    --accent: #2da44e; --on-accent: #f2f5f3;
    --glass: rgba(240, 243, 241, .93);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #1c1e21; --card: #26292d; --text: #e6e8ea; --muted: #8b949e;
      --chip: #31353a; --chip-active: #3d4248; --border: #363b41;
      --cell: #2e3236; --b1: #0e4429; --b2: #006d32; --b3: #26a641; --b4: #2fa852;
      --accent: #34b25c; --on-accent: #14201a;
      --glass: rgba(30, 33, 36, .93);
    }
  }
  :root[data-theme="dark"] {
    --bg: #1c1e21; --card: #26292d; --text: #e6e8ea; --muted: #8b949e;
    --chip: #31353a; --chip-active: #3d4248; --border: #363b41;
    --cell: #2e3236; --b1: #0e4429; --b2: #006d32; --b3: #26a641; --b4: #2fa852;
    --accent: #34b25c; --on-accent: #14201a;
    --glass: rgba(30, 33, 36, .93);
  }
  body { transition: background .3s ease, color .3s ease; }

  /* --- theme switch: From Uiverse.io by RiccardoRapelli (retokenized) --- */
  .switch { position: relative; display: inline-block; width: 60px; height: 34px; flex-shrink: 0; }
  .switch #themeInput { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute; cursor: pointer; inset: 0;
    background-color: #6aa5cc; transition: 0.4s; z-index: 0; overflow: hidden;
  }
  .sun-moon {
    position: absolute; height: 26px; width: 26px; left: 4px; bottom: 4px;
    background-color: #f0c53f; transition: 0.4s;
  }
  #themeInput:checked + .slider { background-color: #17191c; }
  #themeInput:focus-visible + .slider { box-shadow: 0 0 0 2px var(--accent); }
  #themeInput:checked + .slider .sun-moon {
    transform: translateX(26px); background-color: #e8eaec;
    animation: rotate-center 0.6s ease-in-out both;
  }
  /* the original references rotate-center but never defines it (Animista import);
     translateX must be baked in or the moon snaps left during the spin */
  @keyframes rotate-center {
    0% { transform: translateX(26px) rotate(0); }
    100% { transform: translateX(26px) rotate(360deg); }
  }
  .moon-dot { opacity: 0; transition: 0.4s; fill: #9aa2ab; }
  #themeInput:checked + .slider .sun-moon .moon-dot { opacity: 1; }
  .slider.round { border-radius: 34px; }
  .slider.round .sun-moon { border-radius: 50%; }
  #moon-dot-1 { left: 10px; top: 3px; position: absolute; width: 6px; height: 6px; z-index: 4; }
  #moon-dot-2 { left: 2px; top: 10px; position: absolute; width: 10px; height: 10px; z-index: 4; }
  #moon-dot-3 { left: 16px; top: 18px; position: absolute; width: 3px; height: 3px; z-index: 4; }
  #light-ray-1 { left: -8px; top: -8px; position: absolute; width: 43px; height: 43px; z-index: -1; fill: #f4f6f4; opacity: 10%; }
  #light-ray-2 { left: -50%; top: -50%; position: absolute; width: 55px; height: 55px; z-index: -1; fill: #f4f6f4; opacity: 10%; }
  #light-ray-3 { left: -18px; top: -18px; position: absolute; width: 60px; height: 60px; z-index: -1; fill: #f4f6f4; opacity: 10%; }
  .cloud-light { position: absolute; fill: #e9ecee; animation: cloud-move 6s infinite; }
  .cloud-dark { position: absolute; fill: #cdd3d8; animation: cloud-move 6s infinite 1s; }
  #cloud-1 { left: 30px; top: 15px; width: 40px; }
  #cloud-2 { left: 44px; top: 10px; width: 20px; }
  #cloud-3 { left: 18px; top: 24px; width: 30px; }
  #cloud-4 { left: 36px; top: 18px; width: 40px; }
  #cloud-5 { left: 48px; top: 14px; width: 20px; }
  #cloud-6 { left: 22px; top: 26px; width: 30px; }
  @keyframes cloud-move {
    0% { transform: translateX(0px); }
    40% { transform: translateX(4px); }
    80% { transform: translateX(-4px); }
    100% { transform: translateX(0px); }
  }
  .stars { transform: translateY(-32px); opacity: 0; transition: 0.4s; }
  .star {
    fill: #e8eaec; position: absolute; transition: 0.4s;
    animation: star-twinkle 2s infinite;
  }
  #themeInput:checked + .slider .stars { transform: translateY(0); opacity: 1; }
  #star-1 { width: 20px; top: 2px; left: 3px; animation-delay: 0.3s; }
  #star-2 { width: 6px; top: 16px; left: 3px; }
  #star-3 { width: 12px; top: 20px; left: 10px; animation-delay: 0.6s; }
  #star-4 { width: 18px; top: 0px; left: 18px; animation-delay: 1.3s; }
  @keyframes star-twinkle {
    0% { transform: scale(1); }
    40% { transform: scale(1.2); }
    80% { transform: scale(0.8); }
    100% { transform: scale(1); }
  }
  * { box-sizing: border-box; margin: 0; }
  ::selection { background: var(--accent); color: var(--on-accent); }
  .tabs, .ranges, .switch, .heat, .ctx, .card .label, .coststrip .clabel,
  .today .ttitle, #tip { user-select: none; -webkit-user-select: none; }
  body {
    background: var(--bg); color: var(--text);
    /* Geist has no Hangul — the Korean faces have to be reachable in the fallback chain */
    font: 17px/1.55 "Geist", -apple-system, "Segoe UI", "Malgun Gothic",
          "Apple SD Gothic Neo", "Noto Sans KR", system-ui, sans-serif;
    display: flex; justify-content: center; padding: 44px 20px;
  }
  .wrap { width: 100%; max-width: 800px; }
  .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
  .tabs, .ranges { display: flex; gap: 4px; background: var(--card); border-radius: 10px; padding: 4px; }
  .tabs button, .ranges button {
    border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 15px;
    padding: 6px 16px; border-radius: 8px; cursor: pointer;
  }
  .icon { width: 18px; height: 18px; vertical-align: -3px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .tcost .icon { color: var(--accent); }
  .tabs button.on, .ranges button.on { background: var(--chip-active); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .coststrip {
    background: var(--card); border-radius: 10px; padding: 15px 18px; margin-bottom: 10px;
    display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
    animation: rise .5s cubic-bezier(.22,1,.36,1) backwards;
    position: relative; overflow: hidden;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s ease, border-radius .18s ease;
  }
  .coststrip:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.12); border-radius: 4px; }
  .coststrip .clabel { font-size: 14px; color: var(--muted); }
  .coststrip .cval { font-size: 32px; font-weight: 700; color: var(--accent); white-space: nowrap; }
  .coststrip .cbreak { font-size: 13px; color: var(--muted); text-align: right; line-height: 1.8; }
  .coststrip .cbreak b { color: var(--text); font-weight: 600; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
  .card { background: var(--card); border-radius: 10px; padding: 13px 15px; }
  .card .label { font-size: 14px; color: var(--muted); }
  .card .value { font-size: 21px; font-weight: 650; margin-top: 3px; white-space: nowrap; }
  .heatwrap { background: var(--card); border-radius: 10px; padding: 14px; overflow-x: auto; }
  .heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 18px); gap: 4px; width: max-content; }
  .cell { width: 18px; height: 18px; border-radius: 4px; background: var(--cell); }
  .cell.l1 { background: var(--b1); } .cell.l2 { background: var(--b2); }
  .cell.l3 { background: var(--b3); } .cell.l4 { background: var(--b4); }
  .foot { color: var(--muted); font-size: 15px; margin-top: 14px; }
  .chartwrap {
    background: var(--card); border-radius: 10px; padding: 14px 16px; margin-top: 12px;
    position: relative; overflow: hidden;
    animation: rise .5s cubic-bezier(.22,1,.36,1) backwards .1s;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s ease, border-radius .18s ease;
  }
  .chartwrap:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.12); border-radius: 4px; }
  .chartwrap .ctitle { font-size: 14px; color: var(--muted); margin-bottom: 12px; display: flex; justify-content: space-between; user-select: none; }
  .chart { display: flex; align-items: flex-end; gap: 3px; height: 200px; }
  .chart .bar {
    flex: 1 1 0; min-width: 2px;
    background: linear-gradient(180deg, var(--b3), var(--b2));
    border-radius: 4px 4px 2px 2px; transform-origin: bottom;
    animation: growy .6s cubic-bezier(.22,1,.36,1) backwards;
    transition: filter .15s ease, transform .15s ease;
  }
  .chart .bar:hover { filter: brightness(1.25); transform: scaleY(1.03); }
  .chart .bar.peakbar { background: linear-gradient(180deg, var(--b4), var(--b3)); }
  .chart .bar.zero { background: var(--cell); height: 4px !important; animation: none; }
  @keyframes growy { from { transform: scaleY(0); } }
  .today {
    background: var(--card); border-radius: 10px; padding: 15px 18px; margin-top: 12px;
    position: relative; overflow: hidden;
    animation: rise .5s cubic-bezier(.22,1,.36,1) backwards .2s;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s ease, border-radius .18s ease;
  }
  .today:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.12); border-radius: 4px; }
  .today .ttitle { font-size: 14px; color: var(--muted); margin-bottom: 8px; display: flex; justify-content: space-between; }
  .today .ttitle span { display: inline-flex; align-items: center; gap: 5px; }
  .today .ttitle .icon { width: 15px; height: 15px; }
  .today .tstats { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 16px; align-items: center; }
  .today .tstats span { display: inline-flex; align-items: center; gap: 6px; }
  .today .tstats b { font-weight: 650; }
  .today .tstats .tcost b { color: var(--accent); }
  .ichip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 50%; background: var(--chip); flex-shrink: 0;
  }
  .ichip .icon { width: 15px; height: 15px; vertical-align: 0; }
  .dsign {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 50%;
    background: rgba(64, 196, 99, .18);
    color: var(--accent); font-weight: 800; font-size: 16px; flex-shrink: 0;
  }
  .dsign .icon { width: 15px; height: 15px; vertical-align: 0; }

  /* refresh button: From Uiverse.io by JaydipPrajapati1910 (retokenized, .button→.rbtn) */
  .rbtn {
    color: var(--text); background-color: var(--chip); font-weight: 600;
    border-radius: 10px; font-size: 15px; font-family: inherit;
    padding: 0 16px; height: 38px; cursor: pointer; text-align: center;
    display: inline-flex; align-items: center; border: none;
    transition: background-color .2s, border-radius .18s ease;
  }
  .rbtn:hover { background-color: var(--cell); border-radius: 4px; }
  .rbtn svg { display: inline; width: 17px; height: 17px; margin-right: 8px; color: var(--accent); }
  .rbtn:focus svg { animation: spin_357 0.5s linear; }
  @keyframes spin_357 {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .today .tnote { font-size: 14px; color: var(--muted); margin-top: 8px; display: flex; align-items: center; gap: 6px; }
  /* today: cost split + hourly strip + per-model rows */
  .today .tsplit {
    display: flex; flex-wrap: wrap; gap: 6px 8px; margin-top: 10px;
    font-size: 13.5px; color: var(--muted);
  }
  .today .tsplit em {
    font-style: normal; display: inline-flex; align-items: baseline; gap: 5px;
    background: var(--chip); border-radius: 8px; padding: 3px 9px;
    transition: background-color .16s ease;
  }
  .today .tsplit em:hover { background: var(--cell); }
  .today .tsplit em b { color: var(--text); font-weight: 650; }
  .today .tsec {
    margin-top: 14px; font-size: 13px; color: var(--muted);
    display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
  }
  .today .tsec i { font-style: normal; color: var(--text); font-weight: 600; }
  .today .thbars {
    display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px;
    align-items: end; height: 62px; margin-top: 7px;
  }
  /* every bar keeps a hit target even at 0 cost, so the tooltip works on quiet hours */
  .today .thbar {
    display: block; position: relative; height: 100%; border-radius: 3px;
    background: var(--cell); cursor: help; overflow: hidden;
  }
  .today .thbar::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: 0;
    height: max(var(--v), var(--vmin, 0px)); border-radius: 3px; background: var(--b3);
    transform-origin: bottom; animation: growy .6s cubic-bezier(.22,1,.36,1) backwards;
    animation-delay: var(--d, 0ms);
  }
  .today .thbar:hover::after { background: var(--b4); }
  /* current hour: accent fill plus a thin baseline tick. The 2px outline ring this replaces
     read as an error state on an otherwise flat strip, and it was the loudest thing in the card. */
  .today .thbar.now { background: var(--chip); }
  .today .thbar.now::after { background: var(--accent); }
  .today .thbar.now::before {
    content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; z-index: 2;
    background: var(--accent); border-radius: 3px;
  }
  /* same 24-column track as .thbars so each label sits under the hour it names — a 4-column
     axis put "6 PM" hard right, i.e. over hour 23 rather than hour 18 */
  .today .thaxis {
    display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px;
    font-size: 11.5px; color: var(--muted); margin-top: 5px;
  }
  .today .thaxis span { grid-row: 1; white-space: nowrap; }
  .today .thaxis span.mid { justify-self: center; }
  .today .thaxis span.end { justify-self: end; }
  .today .tmrow {
    display: grid; grid-template-columns: minmax(74px, auto) 1fr auto auto;
    align-items: center; gap: 10px; font-size: 14px; padding: 5px 0;
  }
  .today .tmrow + .tmrow { border-top: 1px solid var(--border); }
  .today .tmname { font-weight: 650; }
  .today .tmbar { display: block; height: 6px; border-radius: 3px; background: var(--cell); overflow: hidden; }
  .today .tmbar i {
    display: block; height: 100%; width: var(--p); border-radius: 3px; background: var(--b3);
    transform-origin: left; animation: growx .7s cubic-bezier(.22,1,.36,1) backwards .1s;
  }
  .today .tmtok { color: var(--muted); font-variant-numeric: tabular-nums; }
  .today .tmcost { font-weight: 650; color: var(--accent); font-variant-numeric: tabular-nums; min-width: 62px; text-align: right; }
  /* the note is the disclosure control for the yesterday comparison */
  .today .tnote {
    text-align: left; background: none; border: 0; padding: 6px 8px; margin: 8px -8px 0;
    width: calc(100% + 16px); border-radius: 8px; cursor: pointer; font: inherit;
    font-size: 14px; color: var(--muted);
    transition: background-color .16s ease, color .16s ease;
  }
  .today .tnote:hover, .today .tnote:focus-visible { background: var(--chip); color: var(--text); }
  .today .tnote .tchev { margin-left: auto; display: inline-flex; }
  .today .tnote .tchev .icon { width: 15px; height: 15px; transition: transform .3s ease; }
  .today.cmp-open .tnote .tchev .icon { transform: rotate(180deg); }
  /* content-agnostic collapse, same 0fr/1fr trick as .wcard — no magic max-height to outgrow.
     Spacing lives on the first child's margin, never as padding on the collapsing item itself. */
  .today .tcmpwrap { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .3s ease; }
  .today.cmp-open .tcmpwrap { grid-template-rows: 1fr; }
  .today .tcmpwrap > .tcmp { min-height: 0; overflow: hidden; }
  /* One grid for the whole table, rows as display:contents. Each row used to be its own grid
     with min-width:62px value cells and a fixed 62px delta track — 222px of floor before the
     label got anything, so on a narrow screen the row outgrew the card and the delta column,
     the most informative one, was clipped away by .today's overflow:hidden. Columns also only
     *appeared* aligned across rows; sharing one grid makes that real. */
  .today .tcmp {
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto;
    column-gap: 10px; align-items: baseline;
  }
  .today .tcmphead {
    grid-column: 1 / -1;
    margin-top: 10px; font-size: 13px; color: var(--muted);
    display: flex; justify-content: space-between; gap: 10px;
  }
  .today .tcmprow { display: contents; }
  .today .tcmprow > * { padding: 5px 0; font-size: 14px; }
  .today .tcmprow + .tcmprow > * { border-top: 1px solid var(--border); }
  .today .tcmpcols > * { font-size: 12px; color: var(--muted); padding-bottom: 2px; }
  .today .tcmpk { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .today .tcmpa, .today .tcmpb { font-variant-numeric: tabular-nums; text-align: right; }
  .today .tcmpa { font-weight: 650; }
  .today .tcmpb { color: var(--muted); }
  .today .tcmpd { font-variant-numeric: tabular-nums; text-align: right; font-weight: 650; font-size: 13px; }
  .today .tcmpd.up { color: var(--accent); }
  .today .tcmpd.down { color: var(--muted); }
  .today .tcmpd.flat { color: var(--muted); font-weight: 500; }
  /* models tab */
  .models { display: none; flex-direction: column; gap: 10px; }
  .mrow { background: var(--card); border-radius: 10px; padding: 13px 15px; }
  .mrow .mtop { display: flex; justify-content: space-between; font-size: 15px; margin-bottom: 8px; }
  .mrow .mname { font-weight: 650; }
  .mrow .mmeta { color: var(--muted); }
  .bar { height: 7px; border-radius: 4px; background: var(--cell); overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--b3); border-radius: 4px; }
  .empty { color: var(--muted); padding: 28px; text-align: center; }
  /* --- motion & fanciness --- */
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } }
  @keyframes pop { from { opacity: 0; transform: scale(.2); } }
  @keyframes growx { from { transform: scaleX(0); } }
  @keyframes tipin { from { opacity: 0; transform: translateY(4px) scale(.96); } }
  @keyframes flipY { 0% { transform: rotateX(0); } 50% { transform: rotateX(90deg); opacity: 0; } 51% { transform: rotateX(-90deg); } 100% { transform: rotateX(0); opacity: 1; } }
  @keyframes recordPulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,120,40,.7); } 50% { box-shadow: 0 0 0 5px rgba(255,120,40,0); } }

  .card {
    position: relative; overflow: hidden; animation: rise .5s cubic-bezier(.22,1,.36,1) backwards;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s ease, border-radius .18s ease;
  }
  .card:hover { transform: translateY(-3px) scale(1.02); box-shadow: 0 8px 20px rgba(0,0,0,.12); border-radius: 4px; }
  .card::after {
    content: ""; position: absolute; top: 0; left: -80%; width: 50%; height: 100%;
    background: linear-gradient(105deg, transparent, rgba(255,255,255,.4), transparent);
    transform: skewX(-20deg); transition: left .5s ease; pointer-events: none;
  }
  .card:hover::after { left: 140%; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .card::after { background: linear-gradient(105deg, transparent, rgba(255,255,255,.09), transparent); } }
  :root[data-theme="dark"] .card::after { background: linear-gradient(105deg, transparent, rgba(255,255,255,.09), transparent); }

  .tabs button, .ranges button { transition: transform .12s cubic-bezier(.34,1.56,.64,1), background .15s, color .15s; }
  .tabs button:active, .ranges button:active { transform: scale(.88); }

  .cell { cursor: default; animation: pop .35s cubic-bezier(.34,1.56,.64,1) backwards; transition: transform .15s cubic-bezier(.34,1.56,.64,1); }
  .cell:hover { transform: scale(1.45); outline: 2px solid var(--b4); outline-offset: 1px; z-index: 2; position: relative; }
  .cell.record { animation: pop .35s cubic-bezier(.34,1.56,.64,1) backwards, recordPulse 2s ease infinite 1s; }

  .mrow {
    animation: rise .5s cubic-bezier(.22,1,.36,1) backwards;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s ease, border-radius .18s ease;
  }
  .mrow:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,.1); border-radius: 4px; }
  .bar i { transform-origin: left; animation: growx .8s cubic-bezier(.22,1,.36,1) backwards .15s; }
  #tip { animation: tipin .15s ease; }
  [data-exact] {
    cursor: help;
    text-decoration: underline dotted 1px; text-decoration-color: var(--muted);
    text-underline-offset: 3px;
  }
  .foot { cursor: pointer; user-select: none; }
  /* book ticker: rolling lines (Uiverse.io by kennyotsu, adapted from the splash carousel) */
  .fwords { display: inline-block; vertical-align: bottom; overflow: hidden; position: relative; height: 1.55em; }
  .fwords::after {
    content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;
    background: linear-gradient(var(--bg) 8%, transparent 30%, transparent 70%, var(--bg) 92%);
  }
  .finner { display: block; }
  .fline { display: block; height: 1.55em; color: var(--accent); font-weight: 600; white-space: nowrap; }
  /* party mode is a background change only. It used to run a 3s infinite hue-rotate animation on
     the body element, which hue-rotates every descendant — the accent, the text, the chart bars —
     so the numbers became unreadable and the whole point of the page went away for as long as it
     was on. The rain (#rain, below) is the effect; nothing in the content shifts colour.
     Note: no literal HTML tags in comments here. The generated page is a single file that tools
     do string surgery on, and a stray tag name in CSS is the first match they hit. */
  /* copy confirmation. Deliberately quiet: no icon, no colour, and it never moves layout. */
  .toast {
    position: fixed; left: 50%; bottom: 26px; z-index: 120; pointer-events: none;
    transform: translate(-50%, 8px); opacity: 0;
    background: var(--card); color: var(--text); border: 1px solid var(--border);
    border-radius: 999px; padding: 8px 16px; font-size: 13.5px; font-weight: 600;
    box-shadow: 0 6px 20px rgba(0,0,0,.18);
    transition: opacity .22s ease, transform .22s cubic-bezier(.22,1,.36,1);
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }

  /* --- redacted mode: for screenshots, screen sharing, and sitting in a cafe ---
     Blurs the figures and leaves the labels, chrome and heatmap shape alone, so the page still
     looks like itself. filter does not affect layout, so nothing reflows on toggle.
     user-select is off too: a blurred number you can still select and copy is not hidden.
     The heatmap and daily chart deliberately stay — they carry no readable number, and they are
     what makes a shared screenshot worth looking at. Say so rather than implying total cover. */
  body.redacted :is(
    .coststrip .cval, .coststrip .cbreak,
    #cards .card .value,
    .today .tstats b, .today .tsplit em b, .today .tsec i,
    .today .tmtok, .today .tmcost,
    .today .tcmpa, .today .tcmpb, .today .tcmpd,
    .wcard .wbalance, .wcard .mcost2, .wcard .block b, .wcard .block .pct,
    .dval, .dpct, .dcenter b,
    .mrow .mmeta,
    #liveCost, #liveCount, #liveMeta,
    .foot, .irl-panel
  ) {
    filter: blur(6px); user-select: none; -webkit-user-select: none;
  }
  /* --- first-launch hello --- */
  .hello {
    position: fixed; inset: 0; z-index: 200; display: grid; place-items: center;
    padding: 24px; background: rgba(12, 14, 16, .55); backdrop-filter: blur(3px);
    animation: fadeSlideIn .3s ease-out;
  }
  .hello[hidden] { display: none; }
  .hello-card {
    width: min(560px, 100%); max-height: calc(100vh - 48px); overflow-y: auto;
    background: var(--card); border: 1px solid var(--border); border-radius: 16px;
    padding: 26px 28px; box-shadow: 0 24px 60px rgba(0,0,0,.32);
    animation: rise .45s cubic-bezier(.22,1,.36,1) backwards .05s;
  }
  .hello-head { display: flex; gap: 14px; align-items: flex-start; }
  .hello-heading { flex: 1; min-width: 0; }
  .hello-langs { flex-shrink: 0; margin: -2px -4px 0 0; background: var(--chip); }
  .hello-langs button { font-size: 13px; padding: 4px 9px; }
  .hello-mark {
    flex-shrink: 0; width: 44px; height: 44px; border-radius: 13px; background: var(--chip);
    display: grid; place-items: center; color: var(--accent);
  }
  .hello-mark .icon { width: 22px; height: 22px; vertical-align: 0; }
  .hello-card h2 { margin: 2px 0 0; font-size: 21px; letter-spacing: -0.02em; }
  .hello-sub { margin: 5px 0 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
  .hello-list { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 9px; }
  .hello-list li {
    display: grid; grid-template-columns: 22px 1fr; gap: 11px; align-items: start;
    font-size: 14.5px; line-height: 1.5;
  }
  .hello-list .icon { width: 17px; height: 17px; color: var(--accent); margin-top: 2px; vertical-align: 0; }
  .hello-list b { font-weight: 650; }
  .hello-list kbd {
    font: inherit; font-size: 12.5px; font-weight: 650; background: var(--chip);
    border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px;
  }
  .hello-privacy {
    margin-top: 18px; padding: 12px 14px; border-radius: 10px;
    background: var(--chip); color: var(--muted); font-size: 13.5px; line-height: 1.55;
  }
  .hello-privacy b { color: var(--text); }
  .hello-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 20px; }
  .hello-foot-l { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .hello-hint { color: var(--muted); font-size: 13px; }
  .hello-again {
    display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
    font-size: 13.5px; font-weight: 600; color: var(--text); user-select: none;
  }
  .hello-again input {
    appearance: none; -webkit-appearance: none; margin: 0; flex-shrink: 0;
    width: 17px; height: 17px; border: 2px solid var(--muted); border-radius: 5px;
    background: none; cursor: pointer; position: relative;
    transition: background-color .16s ease, border-color .16s ease;
  }
  .hello-again input:checked { background: var(--accent); border-color: var(--accent); }
  /* drawn with borders rather than a glyph so it needs no font and inherits no metrics */
  .hello-again input:checked::after {
    content: ""; position: absolute; left: 4px; top: 0.5px; width: 4px; height: 9px;
    border: solid var(--on-accent); border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  .hello-again input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hello-go {
    font: inherit; font-size: 15px; font-weight: 650; cursor: pointer;
    background: var(--accent); color: var(--on-accent); border: 0;
    border-radius: 10px; padding: 10px 22px;
    transition: transform .16s cubic-bezier(.34,1.56,.64,1), box-shadow .16s ease;
  }
  .hello-go:hover, .hello-go:focus-visible { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,.2); }

  /* --- no transcripts at all: the other thing a first run can hit --- */
  .nodata {
    background: var(--card); border: 1px solid var(--border); border-radius: 14px;
    padding: 30px 32px; margin-top: 14px;
    animation: rise .5s cubic-bezier(.22,1,.36,1) backwards;
  }
  .nodata h2 { margin: 0 0 8px; font-size: 19px; }
  .nodata p { margin: 0 0 14px; color: var(--muted); font-size: 15px; line-height: 1.6; max-width: 62ch; }
  .nodata code {
    font-family: var(--mono, ui-monospace, monospace); font-size: 13.5px;
    background: var(--chip); border-radius: 6px; padding: 2px 7px;
  }
  .nodata pre {
    margin: 0; background: var(--chip); border-radius: 10px; padding: 13px 15px;
    overflow-x: auto; font-family: var(--mono, ui-monospace, monospace); font-size: 13.5px; line-height: 1.7;
  }

  /* --- estimated-pricing warning: shown only when a model is missing from the table --- */
  .pricewarn {
    display: flex; gap: 10px; align-items: flex-start; margin-top: 12px;
    background: var(--chip); border-left: 3px solid var(--accent); border-radius: 8px;
    padding: 10px 14px; font-size: 13.5px; color: var(--muted); line-height: 1.55;
  }
  .pricewarn .icon { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; color: var(--accent); vertical-align: 0; }
  .pricewarn b { color: var(--text); font-weight: 650; }
  .confetti { position: fixed; z-index: 99; pointer-events: none; will-change: transform; }
  .ripple {
    position: absolute; border-radius: 50%; background: var(--b2); opacity: .35;
    transform: scale(0); pointer-events: none;
  }

  /* --- splash loader: From Uiverse.io by mobinkakei (retokenized) --- */
  #loader {
    position: fixed; inset: 0; z-index: 50; background: var(--bg);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 34px; transition: opacity .45s ease;
  }
  /* rolling digits: From Uiverse.io by vikramsinghnegi (retokenized, .loader→.digits) */
  .digits { display: inline-flex; border: 10px solid var(--chip); border-radius: 5px; background: var(--bg); }
  .digits::before,
  .digits::after {
    content: "0 1 2 3 4 5 6 7 8 9 0";
    font-size: 26px; font-family: "Geist Mono", ui-monospace, Consolas, monospace; font-weight: bold;
    line-height: 1em; height: 1em; width: 1.2ch; text-align: center;
    outline: 1px solid var(--border); color: #0000;
    text-shadow: 0 0 0 var(--accent);
    overflow: hidden; animation: digroll 2s infinite linear;
  }
  .digits::before { animation-duration: 4s; }
  @keyframes digroll { 100% { text-shadow: 0 var(--t, -10em) 0 var(--accent); } }
  /* Small variant inside the wallet header: the *real* cents of the balance, settling
     like a slot machine. Two things it must not do:
       1. use its own face — it inherited "Geist Mono" from .digits, so its zeros did not
          match the Geist zeros in .wbalance right next to it. Everything is inherited now.
       2. always land on 00 — the shared --t defaulted to -10em (line 10 == "0") for both
          reels, so a decorative "00" sat where cents belong and read as an exact value.
          --t1/--t2 are set per render from the actual cents; a 0 digit still rolls the
          full turn by landing on line 10 rather than not moving at all. */
  .wdigits { border: none; background: transparent; margin-left: 0; vertical-align: 0; }
  .wdigits::before, .wdigits::after {
    font-family: inherit; font-size: inherit; font-weight: inherit;
    letter-spacing: inherit; font-variant-numeric: tabular-nums;
    width: 1.05ch; outline: none;
  }
  .wdigits::before { --t: var(--t1, -10em); animation: digroll 3.6s cubic-bezier(.2, .9, .3, 1) 1 forwards; }
  .wdigits::after { --t: var(--t2, -10em); animation: digroll 2.4s cubic-bezier(.2, .9, .3, 1) 1 forwards; }

  /* smoother tab-pane switches */
  .pane-in { animation: fadeSlideIn .32s cubic-bezier(.22,1,.36,1); }

  /* --- live Today chip: From Uiverse.io by Li-Deheng (retokenized) --- */
  #btn-message {
    --text-color: var(--text);
    --bg-color-sup: var(--chip);
    --bg-color: var(--card);
    --bg-hover-color: var(--chip-active);
    --online-status: var(--accent);
    --font-size: 15px;
    --btn-transition: all 0.2s ease-out;
  }
  .button-message {
    display: flex; justify-content: center; align-items: center;
    font: 400 var(--font-size) inherit; font-family: inherit;
    box-shadow: 0 1.75px 6px rgba(0,0,0,.07), 0 3.63px 14px rgba(0,0,0,.09);
    background-color: var(--bg-color); border-radius: 68px; cursor: pointer;
    padding: 6px 10px 6px 6px; width: fit-content; height: 42px; border: 0;
    overflow: hidden; position: relative; transition: var(--btn-transition);
    color: var(--text-color); user-select: none;
  }
  .button-message:hover { height: 58px; padding: 8px 20px 8px 8px; background-color: var(--bg-hover-color); }
  .button-message:active { transform: scale(0.99); }
  .content-avatar { width: 30px; height: 30px; margin: 0; transition: var(--btn-transition); position: relative; flex-shrink: 0; }
  .button-message:hover .content-avatar { width: 40px; height: 40px; }
  .avatar { width: 100%; height: 100%; border-radius: 50%; overflow: hidden; background-color: var(--bg-color-sup); }
  .user-img { width: 100%; height: 100%; object-fit: cover; fill: var(--muted); }
  .status-user {
    position: absolute; width: 6px; height: 6px; right: 1px; bottom: 1px; border-radius: 50%;
    outline: solid 2px var(--bg-color); background-color: var(--online-status);
    transition: var(--btn-transition); animation: active-status 2s ease-in-out infinite;
  }
  .button-message:hover .status-user { width: 10px; height: 10px; outline: solid 3px var(--bg-hover-color); }
  .notice-content { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; padding-left: 8px; text-align: initial; color: var(--text-color); }
  .username, .user-id { white-space: nowrap; }
  .username { letter-spacing: -6px; height: 0; opacity: 0; transform: translateY(-20px); transition: var(--btn-transition); }
  .user-id { font-size: 12.5px; color: var(--muted); letter-spacing: -6px; height: 0; opacity: 0; transform: translateY(10px); transition: var(--btn-transition); }
  .lable-message { display: flex; align-items: center; opacity: 1; transform: scaleY(1); transition: var(--btn-transition); }
  .button-message:hover .username { height: auto; letter-spacing: normal; opacity: 1; transform: translateY(0); }
  .button-message:hover .user-id { height: auto; letter-spacing: normal; opacity: 1; transform: translateY(0); }
  .button-message:hover .lable-message { height: 0; transform: scaleY(0); }
  .lable-message, .username { font-weight: 600; }
  .number-message {
    display: flex; justify-content: center; align-items: center; text-align: center;
    margin-left: 8px; font-size: 12px; width: 18px; height: 18px;
    background-color: var(--bg-color-sup); border-radius: 20px;
  }
  @keyframes active-status {
    0% { background-color: var(--online-status); }
    33.33% { background-color: var(--b2); }
    66.33% { background-color: var(--b2); }
    100% { background-color: var(--online-status); }
  }
  .today.flash { outline: 3px solid var(--accent); outline-offset: 2px; transition: outline-color .6s ease; }

  /* --- IRL money egg: From Uiverse.io by Uncannypotato69 (Tailwind → vanilla, retokenized) --- */
  .irl {
    position: absolute; right: 14px; bottom: 12px; width: 34px; height: 34px;
    border-radius: 17px; border: 1px solid rgba(140, 148, 144, .45);
    background: rgba(120, 128, 124, .22); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center; overflow: hidden;
    transition: all .5s cubic-bezier(.22, 1, .36, 1); z-index: 6; cursor: default;
  }
  .irl:hover { width: 100%; height: 100%; right: 0; bottom: 0; border-radius: 10px; background: var(--glass); }
  .irl .icon-info { width: 17px; height: 17px; color: var(--muted); transition: opacity .3s; flex-shrink: 0; }
  .irl:hover .icon-info { opacity: 0; }
  .irl-panel {
    position: absolute; inset: 0; padding: 8px 18px;
    display: flex; flex-direction: column; justify-content: center; gap: 2px;
    transform: translateY(100%); transition: transform .5s cubic-bezier(.22, 1, .36, 1);
    font-size: 13.5px; line-height: 1.4; color: var(--text); white-space: nowrap; overflow: hidden;
  }
  .irl:hover .irl-panel { transform: translateY(0); }
  .irl:hover { cursor: pointer; }
  .irl-panel .irl-title {
    font-weight: 700; font-size: 13.5px;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .irl-panel .irl-line { animation: fadeSlideIn .32s cubic-bezier(.22,1,.36,1) backwards; }
  .irl-panel .irl-line b { color: var(--accent); }
  .irl-roll {
    flex-shrink: 0; display: inline-flex; padding: 4px; margin: -4px -6px -4px 0;
    border: 0; background: none; color: var(--muted); border-radius: 7px; cursor: pointer;
    transition: color .16s ease, background-color .16s ease, transform .3s cubic-bezier(.22,1,.36,1);
  }
  .irl-roll .icon { width: 15px; height: 15px; vertical-align: 0; }
  .irl:hover .irl-roll { color: var(--text); }
  .irl-roll:hover, .irl-roll:focus-visible { background: var(--chip); color: var(--accent); transform: rotate(180deg); }
  #loader.done { opacity: 0; pointer-events: none; }
  .wrapper { width: 200px; height: 60px; position: relative; z-index: 1; }
  .circle {
    width: 20px; height: 20px; position: absolute; border-radius: 50%;
    background-color: var(--b2); left: 15%; transform-origin: 50%;
    animation: circle7124 .5s alternate infinite ease;
  }
  @keyframes circle7124 {
    0% { top: 60px; height: 5px; border-radius: 50px 50px 25px 25px; transform: scaleX(1.7); }
    40% { height: 20px; border-radius: 50%; transform: scaleX(1); }
    100% { top: 0%; }
  }
  .circle:nth-child(2) { left: 45%; background-color: var(--b3); animation-delay: .2s; }
  .circle:nth-child(3) { left: auto; right: 15%; background-color: var(--b4); animation-delay: .3s; }
  .shadow {
    width: 20px; height: 4px; border-radius: 50%;
    background-color: rgba(20, 24, 22, .35);
    position: absolute; top: 62px; transform-origin: 50%; z-index: -1; left: 15%;
    filter: blur(1px); animation: shadow046 .5s alternate infinite ease;
  }
  @keyframes shadow046 {
    0% { transform: scaleX(1.5); }
    40% { transform: scaleX(1); opacity: .7; }
    100% { transform: scaleX(.2); opacity: .4; }
  }
  .shadow:nth-child(4) { left: 45%; animation-delay: .2s; }
  .shadow:nth-child(5) { left: auto; right: 15%; animation-delay: .3s; }

  /* --- context menu: From Uiverse.io by Na3ar-17 (retokenized, .card renamed .ctx) --- */
  .ctx {
    position: fixed; z-index: 60; min-width: 220px;
    background-color: var(--card);
    background-image: linear-gradient(139deg, var(--card) 0%, var(--card) 40%, var(--chip) 100%);
    border: 1px solid var(--border); border-radius: 10px; padding: 12px 0;
    display: none; flex-direction: column; gap: 10px;
    box-shadow: 0 12px 32px rgba(0,0,0,.28); transform-origin: top left;
  }
  .ctx.open { display: flex; animation: ctxin .18s cubic-bezier(.34,1.56,.64,1); }
  @keyframes ctxin { from { opacity: 0; transform: scale(.82); } }
  .ctx .sep { border-top: 1.5px solid var(--border); }
  .ctx ul { list-style: none; display: flex; flex-direction: column; gap: 6px; padding: 0 10px; }
  .ctx .el {
    display: flex; align-items: center; color: var(--muted); gap: 10px;
    transition: all .3s ease-out; padding: 6px 9px; border-radius: 8px;
    cursor: pointer; font-size: 15px; font-weight: 600;
  }
  .ctx .el .icon { width: 19px; height: 19px; transition: all .3s ease-out; }
  .ctx .el:hover { background-color: var(--accent); color: var(--on-accent); transform: translate(1px, -1px); border-radius: 3px; }
  .ctx .el:active { transform: scale(.98); }
  .ctx .el.special { color: var(--accent); }
  .ctx .el.special:hover { background-color: rgba(64, 196, 99, .16); color: var(--accent); }

  /* --- party-mode rain: From Uiverse.io by SelfMadeSystem (retokenized) --- */
  .wrap { position: relative; z-index: 2; }
  #rain {
    display: none; position: fixed; inset: 0; z-index: 0;
    --c: #26a641;
    background-color: #17191c;
    background-image: radial-gradient(4px 100px at 0px 235px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 235px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 117.5px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 252px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 252px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 126px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 150px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 150px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 75px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 253px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 253px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 126.5px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 204px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 204px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 102px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 134px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 134px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 67px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 179px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 179px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 89.5px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 299px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 299px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 149.5px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 215px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 215px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 107.5px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 281px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 281px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 140.5px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 158px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 158px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 79px, var(--c) 100%, #0000 150%),
      radial-gradient(4px 100px at 0px 210px, var(--c), #0000),
      radial-gradient(4px 100px at 300px 210px, var(--c), #0000),
      radial-gradient(1.5px 1.5px at 150px 105px, var(--c) 100%, #0000 150%);
    background-size:
      300px 235px, 300px 235px, 300px 235px,
      300px 252px, 300px 252px, 300px 252px,
      300px 150px, 300px 150px, 300px 150px,
      300px 253px, 300px 253px, 300px 253px,
      300px 204px, 300px 204px, 300px 204px,
      300px 134px, 300px 134px, 300px 134px,
      300px 179px, 300px 179px, 300px 179px,
      300px 299px, 300px 299px, 300px 299px,
      300px 215px, 300px 215px, 300px 215px,
      300px 281px, 300px 281px, 300px 281px,
      300px 158px, 300px 158px, 300px 158px,
      300px 210px, 300px 210px, 300px 210px;
    animation: rainfall 150s linear infinite;
  }
  #rain::after {
    content: ""; position: absolute; inset: 0; z-index: 1;
    backdrop-filter: blur(1em) brightness(6);
    background-image: radial-gradient(circle at 50% 50%, #0000 0, #0000 2px, hsl(0 0% 4%) 2px);
    background-size: 8px 8px;
  }
  body.party #rain { display: block; }

  /* --- wallet spend card: From Uiverse.io by Na3ar-17 (retokenized, .card→.wcard, semi-bold→600) --- */
  /* Collapse via grid 0fr/1fr, NOT max-height. A fixed max-height is a guess about how many
     model rows there are: at 5 rows the card wants 609px, so a 560px clamp silently ate 53px —
     precisely the .wbody padding-bottom that reserves space for the absolute .expandbtn, which
     then sat on top of the token blocks. 1fr sizes to content, so the reserve can never be cut. */
  .wcard {
    width: 100%; border: 2px solid var(--border); border-radius: 16px;
    padding-bottom: 10px; position: relative;
    display: grid; grid-template-rows: auto 1fr;
    transition: grid-template-rows .3s ease, padding .3s ease;
    overflow: hidden; background-color: var(--card);
    animation: rise .5s cubic-bezier(.22,1,.36,1) backwards;
  }
  .wcard:has(.wtoggle:checked) { grid-template-rows: auto 0fr; padding-bottom: 0; }
  /* a 0fr row zeroes the item's content box, but padding still occupies the border box —
     without this the collapsed card keeps the 56px pill reserve as dead space */
  .wcard:has(.wtoggle:checked) .wbody { padding-bottom: 0; }
  .wcard:has(.wtoggle:checked) .whead .close { opacity: 0; pointer-events: none; }
  .wcard:has(.wtoggle:not(:checked)) .wbody .bhead { animation: fadeSlideIn .35s ease-out forwards; animation-delay: .05s; }
  .wcard:has(.wtoggle:not(:checked)) .wbody .bank-cards { animation: fadeSlideIn .35s ease-out forwards; animation-delay: .15s; }
  .wcard:has(.wtoggle:not(:checked)) .wbody .wfoot { animation: fadeSlideIn .35s ease-out forwards; animation-delay: .25s; }
  .wcard .whead { border-bottom: 2px solid var(--border); }
  .wcard .whead .hrow { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; }
  .wcard .wallet { display: flex; align-items: center; gap: 12px; }
  .wcard .icon-wrapper { padding: 10px; border-radius: 14px; background-color: var(--chip); display: grid; place-items: center; color: var(--accent); }
  .wcard .wtitle { color: var(--muted); font-size: 14px; margin: 1px 0; }
  .wcard .wbalance { font-size: 22px; font-weight: 700; margin: 1px 0; color: var(--accent); }
  .wcard .close { border: 2px solid var(--chip); border-radius: 50%; width: 34px; height: 34px; display: grid; place-items: center; cursor: pointer; transition: opacity .3s ease, background-color .2s; }
  .wcard .close:hover { background-color: var(--chip); }
  .wcard .close .icon { width: 17px; height: 17px; color: var(--muted); vertical-align: 0; }
  .wcard .wtoggle { display: none; }
  .wcard .wbody { padding: 0 16px 56px; min-height: 0; overflow: hidden; transition: padding-bottom .3s ease; }
  .wcard .wbody .bhead { display: flex; align-items: center; justify-content: space-between; opacity: 0; padding: 10px 0; }
  .wcard .wbody .btitle { font-weight: 700; font-size: 16px; }
  .wcard .wbody .bcount { color: var(--muted); font-size: 14px; border: 2px solid var(--chip); border-radius: 12px; padding: 2px 10px; font-weight: 600; }
  .wcard .bank-cards { display: flex; flex-direction: column; gap: 10px; position: relative; opacity: 0; }
  .wcard .bank-cards::before {
    content: ""; position: absolute; inset: 0;
    height: calc((100% - (var(--wn, 2) - 1) * 10px) / var(--wn, 2));
    border-radius: 8px; outline: 2.5px solid var(--accent); pointer-events: none; opacity: 0;
  }
  .wcard .bank-cards:has(.wradio:checked)::before {
    opacity: 1;
    transition: transform .3s cubic-bezier(.4,0,.2,1), opacity .3s ease-in-out;
  }
  .wcard .bank-cards:has(.bank-card:nth-child(1) .wradio:checked)::before { transform: translateY(0); }
  .wcard .bank-cards:has(.bank-card:nth-child(2) .wradio:checked)::before { transform: translateY(calc(1 * (100% + 10px))); }
  .wcard .bank-cards:has(.bank-card:nth-child(3) .wradio:checked)::before { transform: translateY(calc(2 * (100% + 10px))); }
  .wcard .bank-cards:has(.bank-card:nth-child(4) .wradio:checked)::before { transform: translateY(calc(3 * (100% + 10px))); }
  .wcard .bank-cards:has(.bank-card:nth-child(5) .wradio:checked)::before { transform: translateY(calc(4 * (100% + 10px))); }
  .wcard .bank-cards:has(.bank-card:nth-child(6) .wradio:checked)::before { transform: translateY(calc(5 * (100% + 10px))); }
  .wcard .bank-card {
    display: flex; align-items: center; justify-content: space-between;
    border-radius: 8px; padding: 9px 12px; background-color: var(--chip);
    cursor: pointer; transition: background-color .2s, border-radius .18s ease;
  }
  .wcard .bank-card:hover { background-color: var(--cell); border-radius: 3px; }
  .wcard .bank-card .number { display: flex; align-items: center; gap: 10px; }
  .wcard .wradio { display: none; }
  .wcard .custom-radio { display: inline-block; width: 16px; aspect-ratio: 1; border: 2px solid var(--text); border-radius: 4px; position: relative; cursor: pointer; flex-shrink: 0; }
  .wcard .custom-radio::after {
    content: ""; position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%) scale(0); width: 8px; aspect-ratio: 1;
    background-color: var(--text); border-radius: 2px; transition: transform .2s;
  }
  .wcard .wradio:checked + .custom-radio::after { transform: translate(-50%, -50%) scale(1); }
  .wcard .mname2 { margin: 0; font-weight: 700; }
  .wcard .mcost2 { margin: 0; font-weight: 700; font-size: 15px; color: var(--muted); }
  .wcard .wfoot { margin-top: 15px; opacity: 0; }
  .wcard .cash-title { margin: 0; font-weight: 700; color: var(--muted); font-size: 14px; }
  .wcard .fhead { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .wcard .dtoggle {
    display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    color: var(--muted); background: none; border: 2px solid var(--chip);
    border-radius: 20px; padding: 4px 11px;
    transition: color .16s ease, background-color .16s ease, border-radius .18s ease;
  }
  .wcard .dtoggle:hover, .wcard .dtoggle:focus-visible {
    color: var(--text); background: var(--chip); border-radius: 6px;
  }
  .wcard .dtoggle .icon { width: 14px; height: 14px; vertical-align: 0; }
  .wcard .blocks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 8px; text-align: center; font-weight: 600; }
  .wcard .blocks.ischart { display: block; }

  /* --- donut view of the same three numbers --- */
  .donut { display: flex; align-items: center; gap: 20px; margin-top: 10px; }
  .dchart { position: relative; width: 128px; height: 128px; flex-shrink: 0; }
  .dchart svg { width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
  .dtrack { fill: none; stroke: var(--cell); stroke-width: 14; }
  .dseg {
    fill: none; stroke-width: 14; stroke-linecap: butt; cursor: pointer;
    transition: opacity .18s ease, stroke-width .18s ease;
    animation: dgrow .7s cubic-bezier(.22,1,.36,1) backwards; animation-delay: var(--d, 0ms);
  }
  .dseg.di { stroke: var(--b2); }
  .dseg.do { stroke: var(--b3); }
  .dseg.dc { stroke: var(--accent); }
  .dseg.dim { opacity: .28; }
  .dseg:hover { stroke-width: 18; }
  @keyframes dgrow { from { stroke-dasharray: 0 9999; } }
  .dcenter {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 1px; pointer-events: none; text-align: center;
  }
  .dcenter b { font-size: 21px; font-weight: 800; letter-spacing: -0.02em; }
  .dcenter span { font-size: 12px; color: var(--muted); font-weight: 600; }
  .dlegend { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
  .dleg {
    display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; gap: 9px;
    align-items: center; width: 100%; text-align: left;
    font: inherit; font-size: 14px; cursor: pointer;
    background: none; border: 0; border-radius: 8px; padding: 5px 8px; margin: 0 -8px;
    transition: background-color .16s ease;
  }
  .dleg:hover, .dleg:focus-visible, .dleg.on { background: var(--chip); }
  .ddot { width: 10px; height: 10px; border-radius: 3px; }
  .ddot.di { background: var(--b2); }
  .ddot.do { background: var(--b3); }
  .ddot.dc { background: var(--accent); }
  .dlabel { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dpct { color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }
  .dval { font-weight: 650; font-variant-numeric: tabular-nums; }
  /* the chart is 128px wide before the legend gets anything — below this the two stack */
  @media (max-width: 520px) {
    .donut { flex-direction: column; align-items: stretch; gap: 12px; }
    .dchart { align-self: center; }
  }
  .wcard .block { padding: 8px 10px; border-radius: 8px; border: 2px solid var(--chip); transition: background-color .2s, transform .2s, border-radius .18s ease; }
  .wcard .block:hover { background-color: var(--chip); transform: translateY(-2px); border-radius: 3px; }
  .wcard .block b { display: block; font-size: 17px; }
  .wcard .block span { font-size: 13px; color: var(--muted); }
  /* Breakdown pill with layered ripple hover: From Uiverse.io by OliverZeros
     (retokenized to mild sage/teal/accent; the snippet's unscoped button-reset rule deliberately dropped) */
  .wcard .expandbtn {
    position: absolute; right: 14px; bottom: 13px; display: flex; align-items: center; gap: 6px;
    cursor: pointer; border: none; background-color: var(--accent); color: var(--on-accent);
    padding: 7px 13px; border-radius: 20px; font-weight: 600; font-size: 14px;
    transition: box-shadow .3s ease; z-index: 5; overflow: hidden;
  }
  .wcard .expandbtn:hover { box-shadow: 0 4px 10px rgba(0,0,0,.25); }
  .wcard .expandbtn .icon, .wcard .expandbtn .einner { position: relative; z-index: 1; }
  .wcard .expandbtn .icon { width: 16px; height: 16px; vertical-align: 0; transition: transform .3s ease; color: var(--on-accent); }
  .wcard .expandbtn:hover .icon { transform: rotate(90deg); }
  .ebg { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; pointer-events: none; }
  .ebg-layers {
    position: absolute; left: 50%; transform: translateX(-50%); top: -60%;
    aspect-ratio: 1 / 1; width: max(200%, 10rem); display: block;
  }
  .ebg-layer { border-radius: 9999px; position: absolute; inset: 0; transform: scale(0); display: block; }
  .ebg-layer.l1 { background-color: #8fbfa0; }
  .ebg-layer.l2 { background-color: #5f9e8f; }
  .ebg-layer.l3 { background-color: var(--accent); }
  .expandbtn:hover .ebg-layer { transition: transform 1.3s cubic-bezier(.19, 1, .22, 1), opacity .3s linear; }
  .expandbtn:hover .ebg-layer.l1 { transform: scale(1); }
  .expandbtn:hover .ebg-layer.l2 { transition-delay: .1s; transform: scale(1); }
  .expandbtn:hover .ebg-layer.l3 { transition-delay: .2s; transform: scale(1); }
  .einner { position: relative; display: block; pointer-events: none; }
  .e-static, .e-hover { display: block; }
  .e-hover { position: absolute; top: 0; left: 0; opacity: 0; transform: translateY(70%); }
  .expandbtn:hover .e-static {
    opacity: 0; transform: translateY(-70%);
    transition: transform 1.4s cubic-bezier(.19, 1, .22, 1), opacity .3s linear;
  }
  .expandbtn:hover .e-hover {
    opacity: 1; transform: translateY(0);
    transition: transform 1.4s cubic-bezier(.19, 1, .22, 1), opacity 1.4s cubic-bezier(.19, 1, .22, 1);
  }
  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes rainfall {
    0% {
      background-position:
        0px 220px, 3px 220px, 151.5px 337.5px,
        25px 24px, 28px 24px, 176.5px 150px,
        50px 16px, 53px 16px, 201.5px 91px,
        75px 224px, 78px 224px, 226.5px 350.5px,
        100px 19px, 103px 19px, 251.5px 121px,
        125px 120px, 128px 120px, 276.5px 187px,
        150px 31px, 153px 31px, 301.5px 120.5px,
        175px 235px, 178px 235px, 326.5px 384.5px,
        200px 121px, 203px 121px, 351.5px 228.5px,
        225px 224px, 228px 224px, 376.5px 364.5px,
        250px 26px, 253px 26px, 401.5px 105px,
        275px 75px, 278px 75px, 426.5px 180px;
    }
    to {
      background-position:
        0px 6800px, 3px 6800px, 151.5px 6917.5px,
        25px 13632px, 28px 13632px, 176.5px 13758px,
        50px 5416px, 53px 5416px, 201.5px 5491px,
        75px 17175px, 78px 17175px, 226.5px 17301.5px,
        100px 5119px, 103px 5119px, 251.5px 5221px,
        125px 8428px, 128px 8428px, 276.5px 8495px,
        150px 9876px, 153px 9876px, 301.5px 9965.5px,
        175px 13391px, 178px 13391px, 326.5px 13540.5px,
        200px 14741px, 203px 14741px, 351.5px 14848.5px,
        225px 18770px, 228px 18770px, 376.5px 18910.5px,
        250px 5082px, 253px 5082px, 401.5px 5161px,
        275px 6375px, 278px 6375px, 426.5px 6480px;
    }
  }
  #tip {
    position: fixed; z-index: 10; pointer-events: none; display: none;
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 13px; font-size: 14px; box-shadow: 0 4px 14px rgba(0,0,0,.15);
    min-width: 190px;
  }
  #tip .tdate { font-weight: 650; margin-bottom: 4px; }
  #tip .trow { display: flex; justify-content: space-between; gap: 14px; color: var(--muted); }
  #tip .trow b { color: var(--text); font-weight: 600; }
  #tip .tmodels { border-top: 1px solid var(--border); margin-top: 5px; padding-top: 5px; }
  /* --- readability boost: bigger & bolder everywhere (driver mode), Vercel tracking --- */
  body { font-size: 18px; font-weight: 500; letter-spacing: -0.011em; }
  .card .value, .coststrip .cval, .wcard .wbalance { letter-spacing: -0.022em; }
  .mrow .mname, .wcard .mname2, .today .tstats b { letter-spacing: -0.015em; }
  .tabs button, .ranges button { font-size: 16px; font-weight: 600; }
  .card .label { font-size: 15px; font-weight: 600; }
  .card .value { font-size: 24px; font-weight: 800; }
  .coststrip .clabel { font-size: 15px; font-weight: 600; }
  .coststrip .cval { font-size: 38px; font-weight: 800; }
  .coststrip .cbreak { font-size: 14.5px; font-weight: 500; }
  .coststrip .cbreak b { font-weight: 800; }
  .chartwrap .ctitle { font-size: 15px; font-weight: 600; }
  .foot { font-size: 16px; font-weight: 500; }
  .fline { font-weight: 700; }
  .today .ttitle { font-size: 15px; font-weight: 600; }
  .today .tstats { font-size: 18px; }
  .today .tstats b { font-weight: 800; }
  .today .tnote { font-size: 15px; }
  .mrow .mtop { font-size: 17px; }
  .mrow .mname { font-weight: 800; }
  .mrow .mmeta { font-weight: 600; }
  #tip { font-size: 15px; }
  #tip .trow b { font-weight: 700; }
  .wcard .wtitle { font-size: 15px; font-weight: 600; }
  .wcard .wbalance { font-size: 26px; font-weight: 800; }
  .wcard .wbody .btitle { font-size: 17px; font-weight: 800; }
  .wcard .wbody .bcount { font-size: 15px; }
  .wcard .mname2 { font-size: 17px; font-weight: 800; }
  .wcard .mcost2 { font-size: 16px; font-weight: 700; }
  .wcard .cash-title { font-size: 15px; }
  .wcard .block b { font-size: 20px; font-weight: 800; }
  .wcard .block span { font-size: 14.5px; }
  .ctx .el { font-size: 16px; }
  .irl-panel { font-size: 14.5px; }
  .irl-panel .irl-title { font-size: 14.5px; }
  #btn-message { --font-size: 16px; }
  .user-id { font-size: 13.5px; }
  .rbtn { font-size: 16px; font-weight: 600; }

  /* --- language switch: the .ranges shell, tightened for two chips. The top bar carries
         one more control now, so let it wrap instead of overflowing at 800px. --- */
  .langs button { padding: 6px 11px; font-weight: 700; }
  .top { flex-wrap: wrap; gap: 10px; }

  /* --- wallet block shares --- */
  .wcard .block .pct { font-style: normal; font-weight: 800; color: var(--accent); }
  .wcard .block .pbar {
    display: block; height: 4px; margin-top: 8px; border-radius: 3px;
    background: var(--cell); position: relative; overflow: hidden;
  }
  .wcard .block .pbar::after {
    content: ""; position: absolute; top: 0; bottom: 0; left: 0;
    width: var(--p, 0%); min-width: var(--pmin, 0px);
    background: var(--b3); border-radius: 3px;
    transform-origin: left; animation: growx .8s cubic-bezier(.22,1,.36,1) backwards .2s;
    transition: background-color .2s ease;
  }
  .wcard .block:hover .pbar::after { background: var(--b4); }
  .wcard .wbalance .wdot { margin: 0 .02em; }

  /* --- hover coverage: every control answers to the pointer, with keyboard parity --- */
  .tabs button:hover:not(.on), .ranges button:hover:not(.on) { background: var(--chip); color: var(--text); }
  .tabs button.on:hover, .ranges button.on:hover { transform: translateY(-1px); }
  .tabs button:focus-visible, .ranges button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .rbtn:focus-visible, #btn-message:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* theme switch — never touch .sun-moon's transform, it carries the slide and the spin.
     The existing #themeInput:focus-visible ring outranks this shadow on specificity. */
  .switch .slider { transition: .4s, box-shadow .2s ease; }
  .switch:hover .slider { box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .switch:hover .sun-moon { box-shadow: 0 0 12px rgba(255,255,255,.5); }
  /* the heatmap panel was the only card that did not lift */
  .heatwrap {
    animation: rise .5s cubic-bezier(.22,1,.36,1) backwards .05s;
    transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s ease, border-radius .18s ease;
  }
  .heatwrap:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.12); border-radius: 4px; }
  /* today card: each stat is its own target rather than one flat row */
  .ichip, .dsign { transition: transform .16s cubic-bezier(.34,1.56,.64,1); }
  .today .tstats > span { padding: 2px 7px; margin: -2px -7px; border-radius: 9px; transition: background-color .16s ease; }
  .today .tstats > span:hover { background-color: var(--chip); }
  .today .tstats > span:hover .ichip, .today .tstats > span:hover .dsign { transform: scale(1.14); }
  .today .tnote { transition: color .18s ease; }
  .today:hover .tnote { color: var(--text); }
  /* model rows + wallet */
  .bar i { transition: background-color .2s ease; }
  .mrow:hover .bar i { background-color: var(--b4); }
  .wcard { transition: max-height .3s ease, padding .3s ease, border-color .2s ease, box-shadow .2s ease; }
  .wcard:hover { border-color: var(--accent); box-shadow: 0 6px 18px rgba(0,0,0,.10); }
  .wcard .bcount { transition: border-color .2s ease, color .2s ease; }
  .wcard:hover .bcount { border-color: var(--accent); color: var(--text); }
  /* these two were display:none, which also made them unreachable by Tab; hide them
     without removing them from the focus order so the outlines below can fire */
  .wcard .wtoggle, .wcard .wradio {
    display: block; position: absolute; opacity: 0; width: 0; height: 0;
    margin: 0; padding: 0; border: 0; pointer-events: none;
  }
  .wcard .bank-card:focus-within, .wcard .close:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* figures carrying an exact value (element+attr keeps these above .cbreak b) */
  b[data-exact], span[data-exact], div[data-exact] { transition: color .15s ease, text-decoration-color .15s ease; }
  b[data-exact]:hover, span[data-exact]:hover, div[data-exact]:hover { color: var(--accent); text-decoration-color: var(--accent); }
  /* book ticker */
  .foot { transition: color .18s ease; }
  .foot:hover { color: var(--text); }
  .foot:hover .fline { text-decoration: underline dotted 1.5px; text-underline-offset: 4px; }
  /* text labels carrying an explainer advertise it the way [data-exact] figures do,
     otherwise the tooltip is only discoverable by accident */
  .clabel [data-tip], .ctitle [data-tip] {
    cursor: help; text-decoration: underline dotted 1px;
    text-decoration-color: var(--border); text-underline-offset: 3px;
    transition: color .15s ease, text-decoration-color .15s ease;
  }
  .clabel [data-tip]:hover, .ctitle [data-tip]:hover { color: var(--text); text-decoration-color: var(--accent); }
  /* tooltip explainer line */
  #tip { max-width: 300px; }
  #tip .tdesc { color: var(--muted); font-size: 14.5px; line-height: 1.45; }
  #tip .tdate + .tdesc { border-top: 1px solid var(--border); margin-top: 6px; padding-top: 6px; }
</style>
</head>
<body>
<!-- From Uiverse.io by mobinkakei -->
<div id="loader">
  <div class="wrapper">
    <div class="circle"></div>
    <div class="circle"></div>
    <div class="circle"></div>
    <div class="shadow"></div>
    <div class="shadow"></div>
    <div class="shadow"></div>
  </div>
</div>
<!-- From Uiverse.io by SelfMadeSystem (party mode only) -->
<div id="rain"></div>
<div class="hello" id="hello" hidden>
  <div class="hello-card" role="dialog" aria-modal="true" aria-labelledby="helloTitle">
    <div class="hello-head">
      <div class="hello-mark" id="helloMark"></div>
      <div class="hello-heading">
        <h2 id="helloTitle" data-i18n="helloTitle">Hey — this is ccstats.</h2>
        <p class="hello-sub" data-i18n="helloSub"></p>
      </div>
      <!-- Language belongs here, not only in the top bar: this dialog is the first thing anyone
           sees, and it is the one screen you cannot read your way out of if it opened in the
           wrong language. Same [data-lang] hook as the top bar, so one handler drives both. -->
      <div class="ranges langs hello-langs">
        <button data-lang="en">EN</button>
        <button data-lang="ko">한</button>
      </div>
    </div>
    <ul class="hello-list" id="helloList"></ul>
    <div class="hello-privacy" id="helloPrivacy"></div>
    <div class="hello-foot">
      <div class="hello-foot-l">
        <label class="hello-again">
          <input type="checkbox" id="helloAgain" checked>
          <span data-i18n="helloDontShow"></span>
        </label>
        <span class="hello-hint" data-i18n="helloHint"></span>
      </div>
      <button type="button" class="hello-go" id="helloGo" data-i18n="helloGo">Let's go</button>
    </div>
  </div>
</div>
<div class="wrap">
  <div class="top">
    <div style="display:flex;gap:12px;align-items:center">
      <div class="tabs">
        <button data-tab="overview" class="on" data-i18n="tabOverview" data-tip-key="tipTabOverview">Overview</button>
        <button data-tab="models" data-i18n="tabModels" data-tip-key="tipTabModels">Models</button>
      </div>
      <!-- From Uiverse.io by Li-Deheng -->
      <button id="btn-message" class="button-message" data-tip-key="tipToday">
        <div class="content-avatar">
          <div class="status-user"></div>
          <div class="avatar">
            <svg class="user-img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12,12.5c-3.04,0-5.5,1.73-5.5,3.5s2.46,3.5,5.5,3.5,5.5-1.73,5.5-3.5-2.46-3.5-5.5-3.5Zm0-.5c1.66,0,3-1.34,3-3s-1.34-3-3-3-3,1.34-3,3,1.34,3,3,3Z"></path></svg>
          </div>
        </div>
        <div class="notice-content">
          <div class="username" id="liveCost">Today</div>
          <div class="lable-message"><span data-i18n="today">Today</span><span class="number-message" id="liveCount">0</span></div>
          <div class="user-id" id="liveMeta">no activity yet</div>
        </div>
      </button>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <!-- From Uiverse.io by JaydipPrajapati1910 -->
      <button id="refreshBtn" class="rbtn" type="button" data-tip-key="tipRefresh">
        <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 16 16">
          <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"></path>
          <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"></path>
        </svg>
        <span data-i18n="refresh">Refresh</span>
      </button>
      <div class="ranges">
        <button data-range="all" class="on" data-i18n="rAll">All</button>
        <button data-range="30" data-i18n="r30">30d</button>
        <button data-range="7" data-i18n="r7">7d</button>
      </div>
      <div class="ranges langs" data-tip-key="tipLang">
        <button data-lang="en">EN</button>
        <button data-lang="ko">한</button>
      </div>
      <!-- From Uiverse.io by RiccardoRapelli -->
      <label class="switch" data-tip-key="tipTheme">
        <input id="themeInput" type="checkbox" />
        <div class="slider round">
          <div class="sun-moon">
            <svg id="moon-dot-1" class="moon-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="moon-dot-2" class="moon-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="moon-dot-3" class="moon-dot" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="light-ray-1" class="light-ray" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="light-ray-2" class="light-ray" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="light-ray-3" class="light-ray" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="cloud-1" class="cloud-dark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="cloud-2" class="cloud-dark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="cloud-3" class="cloud-dark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="cloud-4" class="cloud-light" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="cloud-5" class="cloud-light" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
            <svg id="cloud-6" class="cloud-light" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50"></circle></svg>
          </div>
          <div class="stars">
            <svg id="star-1" class="star" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"></path></svg>
            <svg id="star-2" class="star" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"></path></svg>
            <svg id="star-3" class="star" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"></path></svg>
            <svg id="star-4" class="star" viewBox="0 0 20 20"><path d="M 0 10 C 10 10,10 10 ,0 10 C 10 10 , 10 10 , 10 20 C 10 10 , 10 10 , 20 10 C 10 10 , 10 10 , 10 0 C 10 10,10 10 ,0 10 Z"></path></svg>
          </div>
        </div>
      </label>
    </div>
  </div>

  <div id="overview">
    <div class="coststrip" id="coststrip">
      <div>
        <div class="clabel"><span data-i18n="costLabel" data-tip-key="costTip">Est. API cost</span> <span id="costrange"></span></div>
        <div class="cval" id="costval"></div>
      </div>
      <div class="cbreak" id="costbreak"></div>
      <!-- From Uiverse.io by Uncannypotato69 (Tailwind converted to vanilla) -->
      <div class="irl" id="irl">
        <svg class="icon-info" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path clip-rule="evenodd" fill-rule="evenodd" fill="currentColor"
            d="M21.6 36h4.8V21.6h-4.8V36ZM24 0C10.8 0 0 10.8 0 24s10.8 24 24 24 24-10.8 24-24S37.2 0 24 0Zm0 43.2C13.44 43.2 4.8 34.56 4.8 24 4.8 13.44 13.44 4.8 24 4.8c10.56 0 19.2 8.64 19.2 19.2 0 10.56-8.64 19.2-19.2 19.2Zm-2.4-26.4h4.8V12h-4.8v4.8Z"></path>
        </svg>
        <div class="irl-panel" id="irlPanel"></div>
      </div>
    </div>
    <div id="pricewarn"></div>
    <div class="cards" id="cards"></div>
    <div class="heatwrap"><div class="heat" id="heat"></div></div>
    <div class="chartwrap">
      <div class="ctitle"><span data-i18n="chartTitle" data-tip-key="chartTip">Daily tokens</span><span id="cpeak"></span></div>
      <div class="chart" id="chart"></div>
    </div>
    <div class="today" id="today"></div>
    <div class="foot" id="foot" data-tip-key="footTip"></div>
  </div>
  <div class="models" id="modelsPane"></div>
</div>
<div id="tip"></div>

<script>
const DATA = __DATA__;

// ---------- i18n ----------
// Every user-facing string goes through T(). Values are plain strings or functions of
// their interpolated parts — never sentence fragments glued together at the call site,
// because Korean puts the numbers and particles in different places than English.
// English is the fallback for any key a table happens to be missing.
const LANGS = {
  en: {
    locale: "en-US",
    tabOverview: "Overview", tabModels: "Models",
    tipTabOverview: "Totals, heatmap and the daily chart.",
    tipTabModels: "Spend and tokens per model.",
    today: "Today", refresh: "Refresh",
    rAll: "All", r30: "30d", r7: "7d",
    tipRange: (r) => (r === "all" ? "Every day on record." : "The last " + r + " days."),
    tipRefresh: "Recompute from the latest data and replay the animations.",
    tipTheme: "Light / dark.",
    tipLang: "English / 한국어",
    tipToday: "Jump to today's card.",
    costLabel: "Est. API cost",
    costTip: "Each model's public per-1M rates; cache write 1.25× input, cache read 0.1× input. An estimate, not a bill.",
    ofAll: "(all time)",
    ofDays: (n) => "(last " + n + " days)",
    brInput: "Input", brOutput: "Output", brCacheWrite: "Cache write", brCacheRead: "Cache read",
    chartTitle: "Daily tokens",
    chartTip: "Tokens per day. Hover a bar for that day, click it for sparks.",
    chartPeak: (n, peak) => "last " + n + " days · peak " + peak,
    unitTokens: "tokens", unitMsgs: "messages", unitSessions: "sessions",
    cards: ["Sessions", "Messages", "Total tokens", "Active days",
            "Current streak", "Longest streak", "Peak hour", "Favorite model"],
    cardTips: [
      "Distinct Claude Code sessions in this range.",
      "User and assistant messages, deduped by uuid.",
      "Input + output + cache read + cache write.",
      "Days carrying at least one message.",
      "Consecutive active days ending today (or yesterday).",
      "The longest run of consecutive active days on record.",
      "The hour of day that carries the most messages.",
      "The model with the most total tokens.",
    ],
    days: (n) => n + "d",
    hour: (h) => (h === 0 ? "12 AM" : h < 12 ? h + " AM" : h === 12 ? "12 PM" : h - 12 + " PM"),
    todayLabel: (d) => "Today · " + d,
    busiest: (h) => "busiest at " + h,
    todayEmpty: "Nothing yet — the grid awaits.",
    noteQuiet: "Yesterday was quiet. Today, not so much.",
    noteBothQuiet: "Nothing billed today — or yesterday.",
    bookNone: "No billable tokens yet — this fills in once you've used a model.",
    noteHot: (x) => " Burning " + x + "× more than yesterday.",
    noteCalm: (p) => " A calmer day — " + p + "% less than yesterday.",
    liveNone: "no activity yet",
    liveMeta: (s, m) => s + " sessions · " + m + " msgs",
    unitActiveHrs: "active hours",
    tipSplit: (l) => "What the " + l + " tokens cost today, at each model's own rate.",
    todayHourly: "Hourly spend",
    todayPeakHour: "priciest hour",
    todayByModel: "Today by model",
    tipHour: (c, t, m, top) =>
      '<div class="trow"><span>Est. cost</span><b>' + c + "</b></div>" +
      '<div class="trow"><span>Tokens</span><b>' + t + "</b></div>" +
      '<div class="trow"><span>Messages</span><b>' + m + "</b></div>" +
      '<div class="trow"><span>Top model</span><b>' + top + "</b></div>",
    tipHourIdle: "Nothing billed this hour.",
    avgTitle: "Averages",
    avgBasis: (d, h) => d + " active days · " + h + " active hours",
    avgDay: "per day", avgHour: "per active hour", avgSession: "per session", avgMsg: "per message",
    tipAvgDay: "Range cost divided by the days that carried at least one message.",
    tipAvgHour: "Range cost divided by the hours that actually billed — idle hours are excluded.",
    tipAvgSession: "Range cost divided by the number of sessions.",
    tipAvgMsg: "Range cost divided by every counted message, user and assistant.",
    cmpTitle: "Today vs yesterday",
    cmpVs: (d) => "vs " + d,
    cmpToday: "today", cmpYesterday: "yesterday",
    cmpTopModel: "Top model", cmpActiveHours: "Active hours",
    cmpNew: "new", cmpFlat: "flat",
    cmpNoYesterday: "nothing recorded yesterday",
    footPrefix: "You've used ",
    footTip: "Click to skip to the next book.",
    bookLine: (times, book) => "~" + times + "× more tokens than " + book + ".",
    books: {},
    tipCost: "Est. cost", tipTokens: "Tokens", tipMessages: "Messages",
    tipSessions: "Sessions", tipPeak: "Peak hour", tipNone: "No activity",
    walletTitle: (r) => "Est. spend · " + r,
    wAll: "all time", wDays: (n) => "last " + n + "d",
    wTopModels: "Top models",
    wModelCount: (n) => n + " models",
    wTokensOf: (m) => "Tokens · " + m,
    wInput: "input", wOutput: "output", wCache: "cache",
    wBreakdown: "Breakdown",
    wViewDonut: "Chart", wViewBars: "Bars",
    wViewTip: "Switch between the bar breakdown and a donut chart of the same three numbers.",
    wDonutAlt: "Share of tokens by input, output and cache",
    tipBalance: "Dollars and cents of the estimate for this range.",
    emptyRange: "No data in this range",
    ctxCopy: "Copy summary", ctxExport: "Export JSON", ctxTheme: "Toggle theme",
    ctxBook: "Reroll book", ctxParty: "Party mode", ctxLang: "한국어",
    ctxHello: "What is this?",
    ctxRedact: "Hide the numbers", ctxUnredact: "Show the numbers",
    redactOn: "Numbers hidden — safe to screenshot", redactOff: "Numbers visible again",
    helloTitle: "Hey — this is ccstats.",
    helloSub: "A picture of how you actually use Claude Code, built from the transcripts already sitting on this machine.",
    helloItems: [
      ["mouse", "<b>Hover anything.</b> Heatmap days, chart bars, hour bars and every abbreviated number carry the exact figure."],
      ["clipboard", "<b>Right-click</b> to copy — you get whatever you clicked on: one day, one hour, one model, or the whole range."],
      ["keyboard", "Ranges are <b>All / 30d / 7d</b>, the tabs split totals from per-model spend, and the <b>Today</b> card opens a yesterday comparison."],
      ["sliders", "Drop a <b>ccstats.config.json</b> next to the script to set your own pricing, model names, accent colour or currency. Run <b>--init-config</b> for a starter."],
      ["sparkles", "There are a few things hidden in here. Try the Konami code."],
    ],
    helloPrivacy:
      "<b>This never leaves your machine.</b> It reads usage metadata only — timestamps, model names, token counts, a hashed session id. " +
      "Not your messages, not your prompts, not your file or project names. The page makes no network requests and a Content-Security-Policy enforces it.",
    helloHint: "Right-click anywhere to see this again",
    helloDontShow: "Don't show this again",
    helloGo: "Let's go",
    priceWarn: (names, n) =>
      n === 1
        ? "<b>" + names + "</b> isn't in the pricing table, so its cost is a rough guess. Set a rate for it in ccstats.config.json to fix the number."
        : "<b>" + names + "</b> aren't in the pricing table, so their costs are rough guesses. Set rates in ccstats.config.json to fix the numbers.",
    noDataTitle: "No usage found yet.",
    noDataBody: "ccstats read your Claude Code transcript folder but found nothing to chart. Either you haven't used Claude Code on this machine yet, or the transcripts live somewhere it didn't look. If it's the second one:",
    noDataFoot: "Run node ccstats.mjs --help for the rest of the options.",
    ctxCopyOf: (what) => "Copy " + what,
    copied: "Summary copied",
    copiedOf: (what) => what + " copied",
    copyFailed: "Couldn't copy",
    copyScopeToday: "today",
    copyDay: (d, cost, toks, msgs, sess, fav) =>
      "ccstats " + d + ": " + cost + " est. API cost · " + toks + " tokens · " + msgs +
      " messages · " + sess + " sessions · top model " + fav,
    copyDayEmpty: (d) => "ccstats " + d + ": no activity.",
    copyHour: (h, d, cost, toks, msgs, fav) =>
      "ccstats " + d + " " + h + ": " + cost + " est. API cost · " + toks + " tokens · " +
      msgs + " messages · top model " + fav,
    copyHourEmpty: (h, d) => "ccstats " + d + " " + h + ": nothing billed.",
    copyModel: (m, scope, cost, toks, i, o, cw, cr, msgs) =>
      "ccstats " + m + " (" + scope + "): " + cost + " est. API cost · " + toks + " tokens (" +
      i + " in / " + o + " out / " + cw + " cache write / " + cr + " cache read) · " + msgs + " messages",
    copyCard: (label, value, scope) => "ccstats " + label + " (" + scope + "): " + value,
    copyLabel: (r) => (r === "all" ? "all time" : "last " + r + " days"),
    copySummary: (label, cost, toks, msgs, sess, act, cur, max, fav) =>
      "ccstats (" + label + "): " + cost + " est. API cost · " + toks + " tokens · " +
      msgs + " messages · " + sess + " sessions · " + act + " active days · streak " +
      cur + "d (best " + max + "d)" + (fav ? " · favorite model " + fav : ""),
    irlReroll: "Shuffle for three other things",
    irlTitle: (usd) => "IRL, " + usd + " is…",
    irlLine: (amount, name) => "≈ <b>" + amount + "</b> " + name,
    irlAmount: (n) =>
      n >= 10 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(1) : (n * 100).toFixed(1) + "% of a",
    irl: ["bags of Lay's Classic (rollback)", "Big Macs", "Costco hot dog combos",
          "Kirkland rotisserie chickens", "2-liter Cokes", "Crunchwrap Supremes",
          "Robux", "PS5 Pros", "Galaxy S26 Ultras", "Bitcoin"],
    sry: "sry anthropic",
    partyTitle: "ccstats — party mode",
  },
  ko: {
    locale: "ko-KR",
    tabOverview: "개요", tabModels: "모델별",
    tipTabOverview: "합계, 잔디, 일별 그래프.",
    tipTabModels: "모델별 지출과 토큰.",
    today: "오늘", refresh: "새로고침",
    rAll: "전체", r30: "30일", r7: "7일",
    tipRange: (r) => (r === "all" ? "기록된 모든 날." : "최근 " + r + "일."),
    tipRefresh: "최신 데이터로 다시 계산하고 애니메이션을 처음부터 재생합니다.",
    tipTheme: "밝게 / 어둡게.",
    tipLang: "English / 한국어",
    tipToday: "오늘 카드로 이동합니다.",
    costLabel: "예상 API 비용",
    costTip: "모델별 공개 단가를 100만 토큰 기준으로 계산합니다. 캐시 쓰기는 입력의 1.25배, 캐시 읽기는 0.1배. 청구서가 아니라 추정치입니다.",
    ofAll: "(전체 기간)",
    ofDays: (n) => "(최근 " + n + "일)",
    brInput: "입력", brOutput: "출력", brCacheWrite: "캐시 쓰기", brCacheRead: "캐시 읽기",
    chartTitle: "일별 토큰",
    chartTip: "하루에 쓴 토큰. 막대에 마우스를 올리면 그날 내역이, 클릭하면 불꽃이 나옵니다.",
    chartPeak: (n, peak) => "최근 " + n + "일 · 최고 " + peak,
    unitTokens: "토큰", unitMsgs: "메시지", unitSessions: "세션",
    cards: ["세션", "메시지", "총 토큰", "활동일", "현재 연속", "최장 연속", "피크 시간", "주력 모델"],
    cardTips: [
      "이 기간에 기록된 고유 세션 수입니다.",
      "사용자와 어시스턴트 메시지 합계입니다 (uuid로 중복 제거).",
      "입력 + 출력 + 캐시 읽기 + 캐시 쓰기.",
      "메시지가 하나 이상 있는 날입니다.",
      "오늘(또는 어제)까지 끊기지 않고 이어진 활동일.",
      "지금까지 가장 길었던 연속 활동일 기록입니다.",
      "메시지가 가장 많이 오간 시간대입니다.",
      "토큰을 가장 많이 쓴 모델입니다.",
    ],
    days: (n) => n + "일",
    hour: (h) =>
      h === 0 ? "오전 12시" : h < 12 ? "오전 " + h + "시" : h === 12 ? "오후 12시" : "오후 " + (h - 12) + "시",
    todayLabel: (d) => "오늘 · " + d,
    busiest: (h) => h + "에 가장 바빴어요",
    todayEmpty: "아직 아무것도 없어요 — 잔디가 기다리는 중.",
    noteQuiet: "어제는 조용했죠. 오늘은 좀 다르네요.",
    noteBothQuiet: "오늘도 어제도 청구된 내역이 없습니다.",
    bookNone: "아직 청구된 토큰이 없어요 — 모델을 쓰기 시작하면 채워집니다.",
    noteHot: (x) => " 어제보다 " + x + "배 더 태우는 중.",
    noteCalm: (p) => " 차분한 하루 — 어제보다 " + p + "% 적어요.",
    liveNone: "아직 활동 없음",
    liveMeta: (s, m) => s + " 세션 · " + m + " 메시지",
    unitActiveHrs: "활동 시간",
    tipSplit: (l) => "오늘 " + l + " 토큰에 든 비용입니다. 모델별 단가로 계산했어요.",
    todayHourly: "시간대별 지출",
    todayPeakHour: "가장 비싼 시간",
    todayByModel: "오늘 모델별",
    tipHour: (c, t, m, top) =>
      '<div class="trow"><span>예상 비용</span><b>' + c + "</b></div>" +
      '<div class="trow"><span>토큰</span><b>' + t + "</b></div>" +
      '<div class="trow"><span>메시지</span><b>' + m + "</b></div>" +
      '<div class="trow"><span>주 모델</span><b>' + top + "</b></div>",
    tipHourIdle: "이 시간에는 청구된 내역이 없습니다.",
    avgTitle: "평균",
    avgBasis: (d, h) => "활동일 " + d + "일 · 활동 시간 " + h + "시간",
    avgDay: "하루당", avgHour: "활동 시간당", avgSession: "세션당", avgMsg: "메시지당",
    tipAvgDay: "기간 비용을 메시지가 하나라도 있던 날 수로 나눈 값입니다.",
    tipAvgHour: "기간 비용을 실제로 청구가 발생한 시간 수로 나눈 값입니다. 쉬는 시간은 빠집니다.",
    tipAvgSession: "기간 비용을 세션 수로 나눈 값입니다.",
    tipAvgMsg: "기간 비용을 집계된 전체 메시지 수(사용자+어시스턴트)로 나눈 값입니다.",
    cmpTitle: "오늘 vs 어제",
    cmpVs: (d) => d + " 대비",
    cmpToday: "오늘", cmpYesterday: "어제",
    cmpTopModel: "주 모델", cmpActiveHours: "활동 시간",
    cmpNew: "신규", cmpFlat: "동일",
    cmpNoYesterday: "어제는 기록이 없습니다",
    footPrefix: "지금까지 ",
    footTip: "클릭하면 다음 책으로 넘어갑니다.",
    bookLine: (times, book) => "《" + book + "》의 ~" + times + "배에 달하는 토큰을 썼어요.",
    books: {
      "The Little Prince": "어린 왕자",
      "Animal Farm": "동물농장",
      "The Great Gatsby": "위대한 개츠비",
      "Harry Potter and the Philosopher's Stone": "해리 포터와 마법사의 돌",
      "1984": "1984",
      "Moby-Dick": "모비 딕",
      "War and Peace": "전쟁과 평화",
    },
    tipCost: "예상 비용", tipTokens: "토큰", tipMessages: "메시지",
    tipSessions: "세션", tipPeak: "피크 시간", tipNone: "활동 없음",
    walletTitle: (r) => "예상 지출 · " + r,
    wAll: "전체 기간", wDays: (n) => "최근 " + n + "일",
    wTopModels: "많이 쓴 모델",
    wModelCount: (n) => "모델 " + n + "개",
    wTokensOf: (m) => "토큰 · " + m,
    wInput: "입력", wOutput: "출력", wCache: "캐시",
    wBreakdown: "상세",
    wViewDonut: "차트", wViewBars: "막대",
    wViewTip: "같은 세 숫자를 막대 분해와 도넛 차트로 번갈아 봅니다.",
    wDonutAlt: "입력·출력·캐시 토큰 비율",
    tipBalance: "이 기간 추정치의 달러와 센트입니다.",
    emptyRange: "이 기간에는 데이터가 없습니다",
    ctxCopy: "요약 복사", ctxExport: "JSON 내보내기", ctxTheme: "테마 전환",
    ctxBook: "다른 책으로", ctxParty: "파티 모드", ctxLang: "English",
    ctxHello: "이게 뭔가요?",
    ctxRedact: "숫자 가리기", ctxUnredact: "숫자 보이기",
    redactOn: "숫자를 가렸습니다 — 캡처해도 안전해요", redactOff: "숫자를 다시 표시합니다",
    helloTitle: "안녕하세요 — ccstats입니다.",
    helloSub: "이 컴퓨터에 이미 쌓여 있는 대화 기록으로 그린, 당신의 실제 Claude Code 사용 그림입니다.",
    helloItems: [
      ["mouse", "<b>어디든 올려보세요.</b> 잔디의 하루, 그래프 막대, 시간대 막대, 그리고 축약된 숫자마다 정확한 값이 붙어 있습니다."],
      ["clipboard", "<b>우클릭</b>하면 가리킨 것만 복사됩니다 — 하루, 한 시간, 모델 하나, 또는 전체 기간."],
      ["keyboard", "기간은 <b>전체 / 30일 / 7일</b>, 탭은 합계와 모델별 지출로 나뉘고, <b>오늘</b> 카드를 누르면 어제와 비교됩니다."],
      ["sliders", "스크립트 옆에 <b>ccstats.config.json</b>을 두면 단가, 모델 이름, 강조색, 통화를 직접 정할 수 있습니다. <b>--init-config</b>로 예시 파일을 만들어 보세요."],
      ["sparkles", "숨겨둔 것들이 좀 있습니다. 코나미 커맨드부터 해보세요."],
    ],
    helloPrivacy:
      "<b>이 데이터는 컴퓨터 밖으로 나가지 않습니다.</b> 사용 메타데이터만 읽습니다 — 시각, 모델 이름, 토큰 수, 해시된 세션 id. " +
      "메시지 내용도, 프롬프트도, 파일이나 프로젝트 이름도 읽지 않습니다. 이 페이지는 네트워크 요청을 하지 않으며 CSP로 강제됩니다.",
    helloHint: "아무 데나 우클릭하면 다시 볼 수 있어요",
    helloDontShow: "다시 보지 않기",
    helloGo: "시작하기",
    priceWarn: (names) =>
      "<b>" + names + "</b>의 단가가 표에 없어 비용이 대략적인 추정치입니다. ccstats.config.json에 단가를 넣으면 정확해집니다.",
    noDataTitle: "아직 사용 기록이 없습니다.",
    noDataBody: "Claude Code 대화 기록 폴더를 읽었지만 그릴 데이터가 없었습니다. 이 컴퓨터에서 아직 Claude Code를 쓰지 않았거나, 기록이 다른 곳에 있을 수 있습니다. 후자라면:",
    noDataFoot: "나머지 옵션은 node ccstats.mjs --help 로 확인하세요.",
    ctxCopyOf: (what) => what + " 복사",
    copied: "요약을 복사했습니다",
    copiedOf: (what) => what + " 복사 완료",
    copyFailed: "복사하지 못했습니다",
    copyScopeToday: "오늘",
    copyDay: (d, cost, toks, msgs, sess, fav) =>
      "ccstats " + d + ": 예상 API 비용 " + cost + " · " + toks + " 토큰 · " + msgs +
      " 메시지 · " + sess + " 세션 · 주력 모델 " + fav,
    copyDayEmpty: (d) => "ccstats " + d + ": 활동 없음.",
    copyHour: (h, d, cost, toks, msgs, fav) =>
      "ccstats " + d + " " + h + ": 예상 API 비용 " + cost + " · " + toks + " 토큰 · " +
      msgs + " 메시지 · 주력 모델 " + fav,
    copyHourEmpty: (h, d) => "ccstats " + d + " " + h + ": 청구 내역 없음.",
    copyModel: (m, scope, cost, toks, i, o, cw, cr, msgs) =>
      "ccstats " + m + " (" + scope + "): 예상 API 비용 " + cost + " · " + toks + " 토큰 (입력 " +
      i + " / 출력 " + o + " / 캐시 쓰기 " + cw + " / 캐시 읽기 " + cr + ") · " + msgs + " 메시지",
    copyCard: (label, value, scope) => "ccstats " + label + " (" + scope + "): " + value,
    copyLabel: (r) => (r === "all" ? "전체 기간" : "최근 " + r + "일"),
    copySummary: (label, cost, toks, msgs, sess, act, cur, max, fav) =>
      "ccstats (" + label + "): 예상 API 비용 " + cost + " · " + toks + " 토큰 · " +
      msgs + " 메시지 · " + sess + " 세션 · " + act + "일 활동 · 연속 " +
      cur + "일 (최장 " + max + "일)" + (fav ? " · 주력 모델 " + fav : ""),
    irlReroll: "다른 항목 세 개로 바꾸기",
    irlTitle: (usd) => "실제로 " + usd + "면…",
    irlLine: (amount, name) => "≈ " + name + " <b>" + amount + "</b>개",
    irlAmount: (n) => (n >= 10 ? Math.round(n).toLocaleString() : n >= 1 ? n.toFixed(1) : n.toFixed(2)),
    irl: ["레이즈 감자칩", "빅맥", "코스트코 핫도그 세트", "커클랜드 통닭", "코카콜라 2L",
          "크런치랩 슈프림", "로벅스", "PS5 프로", "갤럭시 S26 울트라", "비트코인"],
    sry: "앤트로픽 미안",
    partyTitle: "ccstats — 파티 모드",
  },
};

// Precedence: what you last picked in the page > what the config file suggests > your browser.
// The config sets a starting point, it never overrides a choice you already made here.
const savedLang = localStorage.getItem("ccstats-lang");
const cfgLang = DATA.config && DATA.config.lang;
let lang =
  savedLang === "ko" || savedLang === "en"
    ? savedLang
    : cfgLang === "ko" || cfgLang === "en"
      ? cfgLang
      : (navigator.language || "en").toLowerCase().indexOf("ko") === 0 ? "ko" : "en";

function T(k, ...a) {
  let v = LANGS[lang][k];
  if (v === undefined) v = LANGS.en[k];
  return typeof v === "function" ? v(...a) : v;
}
// attribute-safe: every tooltip below is injected as a data-tip="..." value
const attr = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const bookName = (n) => T("books")[n] || n;

const BOOKS = [
  ["The Little Prince", 22000],
  ["Animal Farm", 39000],
  ["The Great Gatsby", 63000],
  ["Harry Potter and the Philosopher's Stone", 101000],
  ["1984", 116000],
  ["Moby-Dick", 274000],
  ["War and Peace", 750000],
];

// A config key is either a plain substring or a /regex/ in slashes. Substrings are the common
// case and need no escaping knowledge; the regex form is there when a substring is too blunt.
const toMatcher = (k) =>
  k.length > 1 && k.startsWith("/") && k.lastIndexOf("/") > 0
    ? new RegExp(k.slice(1, k.lastIndexOf("/")), k.slice(k.lastIndexOf("/") + 1))
    // NB: the brace is backslash-escaped so that a dollar sign never sits directly before an
    // opening brace — that two-character sequence would terminate the String.raw template this
    // whole page lives inside, and nothing would complain until much later.
    : new RegExp(k.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&"), "i");
const fromConfig = (obj) => Object.entries(obj || {}).map(([k, v]) => [toMatcher(k), v]);

// Config entries come first so a user override always wins over the built-in table.
const MODEL_NAMES = [
  ...fromConfig(DATA.config && DATA.config.modelNames),
  [/claude-fable-5/, "Fable 5"], [/claude-opus-5/, "Opus 5"],
  [/claude-sonnet-5/, "Sonnet 5"], [/opus-4-8/, "Opus 4.8"], [/opus-4/, "Opus 4.x"],
  // point releases must precede their family fallback — /sonnet-4/ would swallow sonnet-4-6
  [/sonnet-4-6/, "Sonnet 4.6"], [/sonnet-4/, "Sonnet 4.x"],
  [/haiku-4-5/, "Haiku 4.5"], [/haiku/, "Haiku"], [/synthetic|unknown/, "Other"],
];
// Fall back to a tidied-up raw id rather than the full "claude-foo-9-20991231" string, so a
// model this build has never heard of still reads like a name in the UI.
//
// This is the ONE display string that comes from the transcript rather than from a literal in
// this file or the user's own config, and model names are interpolated into innerHTML in half a
// dozen places. The page allows inline script (it has to — it is one file), so an id carrying
// markup would execute. Escaping here covers every call site at once.
function prettyFallback(m) {
  const s = String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/[-_]/g, " ");
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const pretty = (m) => {
  const hit = MODEL_NAMES.find(([re]) => re.test(m));
  return hit ? hit[1] : prettyFallback(m);
};

// USD per 1M tokens: [input, output].
// Cache read bills at 0.1x input; cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL).
const PRICING = [
  ...fromConfig(DATA.config && DATA.config.pricing),
  [/fable-5|mythos/, [10, 50]],
  [/opus-5|opus-4-[5-8]/, [5, 25]],
  [/opus-4/, [15, 75]],
  [/sonnet-5|sonnet-4/, [3, 15]],
  [/haiku-4/, [1, 5]],
  [/haiku/, [0.8, 4]],
];
const FALLBACK_RATE = [5, 25];
// Anything not in the table is priced at a mid-range guess, which is a wrong number wearing a
// confident face. Remember which models that happened to so the UI can say so out loud.
const unpriced = new Set();
function rates(m) {
  const hit = PRICING.find(([re]) => re.test(m));
  if (hit) return hit[1];
  if (!/synthetic|unknown/.test(m)) unpriced.add(m);
  return FALLBACK_RATE;
}
const mTok = (v) => v.i + v.o + v.cw + v.cr + (v.c1h || 0);
function mCost(model, v) {
  const [inp, out] = rates(model);
  return (v.i * inp + v.o * out + v.cw * inp * 1.25 + (v.c1h || 0) * inp * 2 + v.cr * inp * 0.1) / 1e6;
}
// Currency is display-only: a symbol and a multiplier on the USD estimate. It does not pretend
// to be a live FX rate, and the tooltips still say "estimate".
const CUR = (DATA.config && DATA.config.currency) || { symbol: "$", rate: 1 };
const cvt = (n) => n * (CUR.rate || 1);
const fmtUsd = (n) => {
  const v = cvt(n);
  if (v > 0 && v < 0.005) return "<" + CUR.symbol + "0.01";
  return v >= 100 ? CUR.symbol + Math.round(v).toLocaleString() : CUR.symbol + v.toFixed(2);
};
// A light user's whole history can be a fraction of a cent, and rounding every figure on the
// page to "$0.00" makes real usage look like no usage. Anything above zero but below a cent
// says so instead of claiming to be nothing.
const fmtUsdCents = (n) => {
  const v = cvt(n);
  if (v > 0 && v < 0.005) return "<" + CUR.symbol + "0.01";
  return CUR.symbol + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
// abbreviated number with the exact value in a hover tooltip
const exb = (n, unit) =>
  '<b data-exact="' + n.toLocaleString() + " " + (unit || T("unitTokens")) + '">' + fmt(n) + "</b>";

// inline SVG icons (lucide-style strokes, inherit currentColor)
const ICONS = {
  dollar: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  sprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-3.7.3-4.9 1.4-4.9 2z"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  shuffle: '<path d="M18 4l3 3-3 3"/><path d="M18 20l3-3-3-3"/><path d="M3 7h3c2 0 3 1.5 4.5 4S13 17 15 17h6"/><path d="M3 17h3c2 0 3-1.5 4.5-4"/><path d="M16.5 10.5C18 8 19 7 21 7"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  mouse: '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 7v3"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.9 17.9 0 0 1-3 3.9"/><path d="M6.2 6.2A17.7 17.7 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.5-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/>',
  pie: '<circle cx="12" cy="12" r="9"/><path d="M12 3v9h9"/>',
  bars: '<rect x="3" y="10" width="5" height="11" rx="1"/><rect x="10" y="4" width="5" height="17" rx="1"/><rect x="17" y="14" width="5" height="7" rx="1"/>',
};
const icon = (n) => '<svg class="icon" viewBox="0 0 24 24">' + ICONS[n] + "</svg>";

const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + "B" :
  n >= 1e6 ? (n / 1e6).toFixed(1) + "M" :
  n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);

const dayKeys = Object.keys(DATA.days).sort();
// stable identity for the stat cards — labels get translated, these never do, so anything
// keying off a card (the Total-tokens easter egg) keeps working in every language
const CARD_KEYS = ["sessions", "messages", "tokens", "activeDays",
                   "curStreak", "maxStreak", "peakHour", "favModel"];
let range = "all", tab = "overview";
// screenshot / screen-share mode — blurs the figures, keeps the layout
let redacted = localStorage.getItem("ccstats-redacted") === "1";
// today-card yesterday comparison; renderToday rebuilds its innerHTML, so the open/closed
// state has to live out here rather than on the DOM node
let cmpOpen = localStorage.getItem("ccstats-today-cmp") === "1";

function keysInRange() {
  if (range === "all") return dayKeys;
  const cut = new Date(); cut.setHours(0, 0, 0, 0);
  cut.setDate(cut.getDate() - (Number(range) - 1));
  return dayKeys.filter((k) => new Date(k + "T00:00:00") >= cut);
}

function aggregate(keys) {
  const sessions = new Set(); const hours = new Array(24).fill(0);
  const models = {}; let msgs = 0, tokens = 0, cost = 0;
  // cw here means "all cache writes" — the 5m and 1h tiers are summed for display but priced
  // separately (1.25x vs 2x input), which is why costParts is accumulated, not derived
  const totals = { i: 0, o: 0, cw: 0, cr: 0 };
  const costParts = { i: 0, o: 0, cw: 0, cr: 0 };
  for (const k of keys) {
    const d = DATA.days[k];
    d.sessions.forEach((s) => sessions.add(s));
    d.hours.forEach((h, i) => (hours[i] += h));
    msgs += d.msgs;
    for (const [m, v] of Object.entries(d.models)) {
      const e = (models[m] ??= { i: 0, o: 0, cw: 0, cr: 0, c1h: 0, msg: 0 });
      const h1 = v.c1h || 0;
      e.i += v.i; e.o += v.o; e.cw += v.cw; e.cr += v.cr; e.c1h += h1; e.msg += v.msg;
      totals.i += v.i; totals.o += v.o; totals.cw += v.cw + h1; totals.cr += v.cr;
      const [inp, out] = rates(m);
      costParts.i += v.i * inp / 1e6;
      costParts.o += v.o * out / 1e6;
      costParts.cw += (v.cw * 1.25 + h1 * 2) * inp / 1e6;
      costParts.cr += v.cr * inp * 0.1 / 1e6;
      tokens += mTok(v); cost += mCost(m, v);
    }
  }
  return { sessions: sessions.size, hours, models, msgs, tokens, cost, totals, costParts, activeDays: keys.filter((k) => DATA.days[k].msgs > 0).length };
}

function streaks(keys) {
  const set = new Set(keys.filter((k) => DATA.days[k].msgs > 0));
  if (!set.size) return { cur: 0, max: 0 };
  let max = 0;
  for (const k of set) {
    const prev = shiftDay(k, -1);
    if (set.has(prev)) continue; // not a streak start
    let len = 1, next = shiftDay(k, 1);
    while (set.has(next)) { len++; next = shiftDay(next, 1); }
    if (len > max) max = len;
  }
  let cur = 0, probe = todayKey();
  if (!set.has(probe)) probe = shiftDay(probe, -1); // streak alive if active yesterday
  while (set.has(probe)) { cur++; probe = shiftDay(probe, -1); }
  return { cur, max };
}

function shiftDay(k, n) {
  const d = new Date(k + "T00:00:00"); d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// Local date, not UTC — the day keys are built from local time in buildData, so a UTC-derived
// "today" would point at the wrong bucket for anyone east or west of Greenwich after 00:00.
const todayKey = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};

// If a model isn't in the pricing table its cost is a mid-range guess. Saying so is the
// difference between an estimate and a number that just looks authoritative.
function renderPriceWarning() {
  const host = document.getElementById("pricewarn");
  if (!host) return;
  if (!unpriced.size) { host.innerHTML = ""; return; }
  const names = [...unpriced].map(pretty).join(", ");
  host.innerHTML = '<div class="pricewarn">' + icon("alert") + "<span>" +
    T("priceWarn", names, unpriced.size) + "</span></div>";
}

// Nothing to chart at all — a different situation from "this range is empty", and the only one
// where the answer is instructions rather than zeroes.
function renderNoData() {
  document.querySelector(".wrap").innerHTML =
    '<div class="nodata">' +
    "<h2>" + T("noDataTitle") + "</h2>" +
    "<p>" + T("noDataBody") + "</p>" +
    "<pre>node ccstats.mjs --root /path/to/projects</pre>" +
    "<p style=\"margin-top:14px\">" + T("noDataFoot") + "</p>" +
    "</div>";
}

let noDataMode = false;
function render() {
  // renderNoData() replaces the whole shell, so once we are in that state there is nothing left
  // for a normal render to write into — see pollLive, which reloads instead of re-rendering.
  if (!dayKeys.length) { noDataMode = true; return renderNoData(); }
  // Cleared every render, then refilled by rates() during aggregate() below. Left to accumulate,
  // a model priced once stayed in the warning forever — including after switching to a range
  // that doesn't contain it, which named a model the visible numbers no longer depend on.
  unpriced.clear();
  const keys = keysInRange();
  const a = aggregate(keys);
  const st = streaks(keys);
  const peak = a.hours.some((h) => h) ? a.hours.indexOf(Math.max(...a.hours)) : null;
  const fav = Object.entries(a.models).sort((x, y) => mTok(y[1]) - mTok(x[1]))[0];

  document.getElementById("costrange").textContent =
    range === "all" ? T("ofAll") : T("ofDays", range);
  const costEl = document.getElementById("costval");
  costEl.dataset.usd = a.cost;
  countUpUsd(costEl, a.cost);
  document.getElementById("costbreak").innerHTML =
    T("brInput") + " " + exb(a.totals.i) + " (" + fmtUsdCents(a.costParts.i) + ") · " +
    T("brOutput") + " " + exb(a.totals.o) + " (" + fmtUsdCents(a.costParts.o) + ")<br>" +
    T("brCacheWrite") + " " + exb(a.totals.cw) + " (" + fmtUsdCents(a.costParts.cw) + ") · " +
    T("brCacheRead") + " " + exb(a.totals.cr) + " (" + fmtUsdCents(a.costParts.cr) + ")";
  lastShownCost = a.cost;
  // rates() fills the unpriced set as a side effect of the aggregate above — must come after it
  renderPriceWarning();
  const peakLabel = peak === null ? "—" : T("hour", peak);

  const labels = T("cards"), tips = T("cardTips");
  // values only — labels and tooltips come from the active language, keyed by position
  const vals = [
    [a.sessions], [a.msgs.toLocaleString()],
    [fmt(a.tokens), a.tokens.toLocaleString() + " " + T("unitTokens")], [a.activeDays],
    [T("days", st.cur)], [T("days", st.max)],
    [peakLabel], [fav ? pretty(fav[0]) : "—"],
  ];
  document.getElementById("cards").innerHTML = vals
    .map(([v, ex], i) =>
      '<div class="card" data-card="' + CARD_KEYS[i] + '" data-tip="' + attr(tips[i]) +
      '" style="animation-delay:' + i * 55 + 'ms"><div class="label">' + labels[i] +
      '</div><div class="value" data-final="' + attr(v) + '" data-tip="' + attr(tips[i]) + '"' +
      (ex ? ' data-exact="' + attr(ex) + '"' : "") + "></div></div>"
    ).join("");
  document.querySelectorAll("#cards .value").forEach((el) => countUp(el, el.dataset.final));

  renderHeat(keys);
  renderChart(keys);
  renderToday();
  rollBook();
  renderModels(a);
}

function renderChart() {
  const n = range === "all" ? 45 : Number(range);
  const tk = todayKey();
  let max = 0;
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const k = shiftDay(tk, -i);
    const v = DATA.days[k] ? dayTokens(k) : 0;
    list.push([k, v]);
    if (v > max) max = v;
  }
  document.getElementById("cpeak").innerHTML = max ? T("chartPeak", n, exb(max)) : "";
  document.getElementById("chart").innerHTML = list.map(([k, v], i) =>
    '<div class="bar' + (v === max && v > 0 ? " peakbar" : "") + (v === 0 ? " zero" : "") +
    '" data-k="' + k + '" style="height:' + (max && v ? Math.max((v / max) * 100, 2) : 1) +
    "%;animation-delay:" + i * 12 + 'ms"></div>'
  ).join("");
}

function renderToday() {
  const el = document.getElementById("today");
  const tk = todayKey();
  const d = DATA.days[tk];
  // live Today chip in the top bar
  document.getElementById("liveCost").textContent = fmtUsd(d ? dayCost(tk) : 0);
  document.getElementById("liveCount").textContent = d ? d.sessions.length : 0;
  document.getElementById("liveMeta").textContent = d && d.msgs
    ? T("liveMeta", d.sessions.length, d.msgs.toLocaleString())
    : T("liveNone");
  const now = new Date().toLocaleDateString(T("locale"), { weekday: "long", month: "short", day: "numeric" });
  if (!d || !d.msgs) {
    el.innerHTML = '<div class="ttitle"><span>' + T("todayLabel", now) + "</span></div>" +
      '<div class="tstats"><span>' + icon("sprout") + " " + T("todayEmpty") + "</span></div>";
    return;
  }
  const cost = dayCost(tk), toks = dayTokens(tk);
  const top = Object.entries(d.models).sort((a, b) => mTok(b[1]) - mTok(a[1]))[0];
  const busiest = d.hours.indexOf(Math.max(...d.hours));
  const hrs = hourStats(d);
  const peakCost = Math.max(...hrs.map((x) => x.cost));
  const nowH = new Date().getHours();
  const activeHrs = hrs.filter((x) => x.cost > 0).length;
  // Cost split across the four billed token classes, at each model's own rate.
  const split = { i: 0, o: 0, cw: 0, cr: 0 };
  const tsplit = { i: 0, o: 0, cw: 0, cr: 0 };
  for (const [m, v] of Object.entries(d.models)) {
    const [inp, out] = rates(m);
    const h1 = v.c1h || 0;
    split.i += (v.i * inp) / 1e6;
    split.o += (v.o * out) / 1e6;
    split.cw += ((v.cw * 1.25 + h1 * 2) * inp) / 1e6;
    split.cr += (v.cr * inp * 0.1) / 1e6;
    tsplit.i += v.i; tsplit.o += v.o; tsplit.cw += v.cw + h1; tsplit.cr += v.cr;
  }
  const splitChip = (key, label) =>
    '<em data-exact="' + attr(tsplit[key].toLocaleString() + " " + T("unitTokens")) +
    '" data-tip="' + attr(T("tipSplit", label)) + '">' + label +
    " <b>" + fmtUsdCents(split[key]) + "</b></em>";
  const hourBars = hrs.map((x, i) =>
    '<i class="thbar' + (i === nowH ? " now" : "") + '" data-h="' + i + '" style="--v:' +
    (peakCost ? (x.cost / peakCost) * 100 : 0) + "%;--vmin:" + (x.cost > 0 ? "3px" : "0px") +
    ";--d:" + i * 18 + 'ms" data-exact="' + attr(T("hour", i)) + '" data-tip="' +
    attr(x.msgs || x.cost
      ? T("tipHour", fmtUsdCents(x.cost), fmt(x.tok), x.msgs, x.top ? pretty(x.top) : "—")
      : T("tipHourIdle")) + '"></i>'
  ).join("");
  const mrows = Object.entries(d.models)
    .filter(([, v]) => mTok(v) > 0)
    .sort((a, b) => mCost(b[0], b[1]) - mCost(a[0], a[1]));
  const mMax = mrows.length ? mCost(mrows[0][0], mrows[0][1]) : 1;
  const modelRows = mrows.map(([m, v]) =>
    '<div class="tmrow" data-m="' + attr(m) + '"><span class="tmname">' + pretty(m) + "</span>" +
    '<i class="tmbar"><i style="--p:' + (mMax ? (mCost(m, v) / mMax) * 100 : 0) + '%"></i></i>' +
    '<span class="tmtok">' + exb(mTok(v)) + "</span>" +
    '<span class="tmcost">' + fmtUsdCents(mCost(m, v)) + "</span></div>"
  ).join("");
  const yk = shiftDay(tk, -1);
  const yCost = DATA.days[yk] ? dayCost(yk) : 0;
  let note;
  // "Yesterday was quiet, today not so much" only holds if today is actually loud. With both
  // days at zero — a real state for anyone whose messages carried no billable usage — it read
  // as a boast about nothing.
  if (!yCost && !cost) note = icon("sprout") + T("noteBothQuiet");
  else if (!yCost) note = T("noteQuiet");
  else if (cost > yCost) note = icon("flame") + T("noteHot", (cost / yCost).toFixed(1));
  else note = icon("leaf") + T("noteCalm", Math.round((1 - cost / yCost) * 100));
  el.innerHTML =
    '<div class="ttitle"><span>' + T("todayLabel", now) + "</span><span>" + icon("clock") + " " +
    T("busiest", T("hour", busiest)) + "</span></div>" +
    '<div class="tstats">' +
    // an icon, not the currency glyph: fmtUsd already prints the symbol, so a literal one here
    // rendered as "$ $282" — harmless-looking in USD, plainly wrong as "€ €210"
    '<span class="tcost"><span class="dsign">' + icon("dollar") + "</span> <b>" + fmtUsd(cost) + "</b></span>" +
    '<span><span class="ichip">' + icon("hash") + "</span> " + exb(toks) + " " + T("unitTokens") + "</span>" +
    '<span><span class="ichip">' + icon("message") + "</span> <b>" + d.msgs.toLocaleString() + "</b> " + T("unitMsgs") + "</span>" +
    '<span><span class="ichip">' + icon("folder") + "</span> <b>" + d.sessions.length + "</b> " + T("unitSessions") + "</span>" +
    (top ? '<span><span class="ichip">' + icon("cpu") + "</span> <b>" + pretty(top[0]) + "</b></span>" : "") +
    '<span><span class="ichip">' + icon("clock") + "</span> <b>" + activeHrs + "</b> " + T("unitActiveHrs") + "</span>" +
    "</div>" +
    '<div class="tsplit">' + splitChip("i", T("brInput")) + splitChip("o", T("brOutput")) +
    splitChip("cw", T("brCacheWrite")) + splitChip("cr", T("brCacheRead")) + "</div>" +
    // with nothing billed, reduce() keeps its seed and confidently named midnight as the
    // priciest hour of a day that cost nothing
    '<div class="tsec"><span>' + T("todayHourly") + "</span><span>" + T("todayPeakHour") +
    " <i>" + (peakCost ? T("hour", hrs.reduce((b, x, i) => (x.cost > hrs[b].cost ? i : b), 0)) : "—") +
    "</i></span></div>" +
    '<div class="thbars">' + hourBars + "</div>" +
    // one column per labelled hour (column N == hour N-1); the text is allowed to overflow its
    // 1/24 column so it can stay centred on the exact bar it names
    '<div class="thaxis">' +
    '<span style="grid-column:1">' + T("hour", 0) + "</span>" +
    '<span class="mid" style="grid-column:7">' + T("hour", 6) + "</span>" +
    '<span class="mid" style="grid-column:13">' + T("hour", 12) + "</span>" +
    '<span class="mid" style="grid-column:19">' + T("hour", 18) + "</span>" +
    '<span class="end" style="grid-column:24">' + T("hour", 23) + "</span></div>" +
    (modelRows
      ? '<div class="tsec"><span>' + T("todayByModel") + "</span><span>" +
        T("wModelCount", mrows.length) + "</span></div>" + modelRows
      : "") +
    avgHTML() +
    '<button type="button" class="tnote" id="tnote" aria-expanded="' + (cmpOpen ? "true" : "false") +
    '" aria-controls="tcmp">' + note + '<span class="tchev">' + icon("chevron") + "</span></button>" +
    '<div class="tcmpwrap" id="tcmp"><div class="tcmp">' + compareHTML(tk) + "</div></div>";
  el.classList.toggle("cmp-open", cmpOpen);
}

// Today vs yesterday, one row per metric. Deltas are today-relative: +% means today is the
// bigger day. Yesterday with a zero denominator gets a dash rather than an infinite percentage.
function compareHTML(tk) {
  const yk = shiftDay(tk, -1);
  const a = DATA.days[tk], b = DATA.days[yk];
  const yLabel = new Date(yk + "T12:00:00").toLocaleDateString(T("locale"), { weekday: "short", month: "short", day: "numeric" });
  if (!b || !b.msgs) return '<div class="tcmphead"><span>' + T("cmpTitle") + "</span><span>" + T("cmpNoYesterday") + "</span></div>";
  const stat = (k) => {
    const d = DATA.days[k];
    const t = Object.entries(d.models).sort((p, q) => mTok(q[1]) - mTok(p[1]))[0];
    return {
      cost: dayCost(k), tok: dayTokens(k), msgs: d.msgs, sess: d.sessions.length,
      hrs: hourStats(d).filter((x) => x.cost > 0).length, top: t ? pretty(t[0]) : "—",
    };
  };
  const A = stat(tk), B = stat(yk);
  const delta = (x, y) => {
    // 0 -> 0 is not "new", it is nothing happening. Only call it new if today actually has
    // something yesterday didn't; otherwise a day with no billed hours reported four "new"s.
    if (!y) return '<span class="tcmpd flat">' + T(x ? "cmpNew" : "cmpFlat") + "</span>";
    const p = ((x - y) / y) * 100;
    if (Math.abs(p) < 0.5) return '<span class="tcmpd flat">' + T("cmpFlat") + "</span>";
    const cls = p > 0 ? "up" : "down";
    return '<span class="tcmpd ' + cls + '">' + (p > 0 ? "+" : "−") +
      Math.abs(p) .toFixed(Math.abs(p) < 10 ? 1 : 0) + "%</span>";
  };
  const row = (label, av, bv, x, y) =>
    '<div class="tcmprow"><span class="tcmpk">' + label + '</span><span class="tcmpa">' + av +
    '</span><span class="tcmpb">' + bv + "</span>" + (x === null ? '<span class="tcmpd flat">—</span>' : delta(x, y)) + "</div>";
  return (
    '<div class="tcmphead"><span>' + T("cmpTitle") + "</span><span>" + T("cmpVs", yLabel) + "</span></div>" +
    '<div class="tcmprow tcmpcols"><span class="tcmpk"></span><span class="tcmpa">' + T("cmpToday") +
    '</span><span class="tcmpb">' + T("cmpYesterday") + '</span><span class="tcmpd"></span></div>' +
    row(T("tipCost"), fmtUsdCents(A.cost), fmtUsdCents(B.cost), A.cost, B.cost) +
    row(T("tipTokens"), fmt(A.tok), fmt(B.tok), A.tok, B.tok) +
    row(T("tipMessages"), A.msgs.toLocaleString(), B.msgs.toLocaleString(), A.msgs, B.msgs) +
    row(T("tipSessions"), A.sess, B.sess, A.sess, B.sess) +
    row(T("cmpActiveHours"), A.hrs, B.hrs, A.hrs, B.hrs) +
    row(T("cmpTopModel"), A.top, B.top, null, null)
  );
}

document.getElementById("today").addEventListener("click", (e) => {
  if (!e.target.closest("#tnote")) return;
  cmpOpen = !cmpOpen;
  localStorage.setItem("ccstats-today-cmp", cmpOpen ? "1" : "0");
  document.getElementById("today").classList.toggle("cmp-open", cmpOpen);
  document.getElementById("tnote").setAttribute("aria-expanded", cmpOpen ? "true" : "false");
});

// Averages over the selected range, not over today — today alone is one sample and the whole
// point of the block is to give today's numbers something to sit against.
// Denominators are all "active" counts (days/hours that actually billed), never a flat 24 or
// the calendar length, or every average would be diluted by the hours you were asleep.
function avgHTML() {
  const keys = keysInRange().filter((k) => DATA.days[k] && DATA.days[k].msgs);
  if (!keys.length) return "";
  let cost = 0, toks = 0, msgs = 0, sess = 0, activeHrs = 0;
  for (const k of keys) {
    const d = DATA.days[k];
    cost += dayCost(k);
    toks += dayTokens(k);
    msgs += d.msgs;
    sess += d.sessions.length;
    activeHrs += hourStats(d).filter((x) => x.cost > 0).length;
  }
  const chip = (label, n, unit, tip) =>
    '<em data-exact="' + attr(Math.round(unit).toLocaleString() + " " + T("unitTokens")) +
    '" data-tip="' + attr(tip) + '">' + label + " <b>" + fmtUsdCents(n) + "</b></em>";
  const per = (d) => (d ? cost / d : 0);
  const perT = (d) => (d ? toks / d : 0);
  return (
    '<div class="tsec"><span>' + T("avgTitle") + "</span><span>" +
    T("avgBasis", keys.length, activeHrs) + "</span></div>" +
    '<div class="tsplit tavg">' +
    chip(T("avgDay"), per(keys.length), perT(keys.length), T("tipAvgDay")) +
    chip(T("avgHour"), per(activeHrs), perT(activeHrs), T("tipAvgHour")) +
    chip(T("avgSession"), per(sess), perT(sess), T("tipAvgSession")) +
    chip(T("avgMsg"), per(msgs), perT(msgs), T("tipAvgMsg")) +
    "</div>"
  );
}

// Per-hour cost has to be summed model-by-model — see the hm comment in buildData.
function hourStats(d) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const bucket = (d.hm || {})[h] || {};
    let cost = 0, tok = 0, top = null, topTok = 0;
    for (const [m, a] of Object.entries(bucket)) {
      const v = { i: a[0], o: a[1], cw: a[2], cr: a[3], c1h: a[4] || 0 };
      const t = mTok(v);
      cost += mCost(m, v);
      tok += t;
      if (t > topTok) { topTok = t; top = m; }
    }
    out.push({ h, cost, tok, msgs: (d.hours && d.hours[h]) || 0, top });
  }
  return out;
}

function renderHeat(keys) {
  const heat = document.getElementById("heat");
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const totalDays = range === "all" ? Math.max(daysBetween(dayKeys[0]), 26 * 7) : Number(range);
  const start = new Date(end); start.setDate(start.getDate() - (totalDays - 1));
  start.setDate(start.getDate() - start.getDay()); // align to Sunday

  const vals = keys.map((k) => dayTokens(k)).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0;
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);

  const recordVal = Math.max(0, ...keys.map((k) => dayTokens(k)));
  let html = "", idx = 0;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const v = keys.includes(k) ? dayTokens(k) : 0;
    const lvl = v === 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4;
    const isRecord = v > 0 && v === recordVal;
    html += '<div class="cell' + (lvl ? " l" + lvl : "") + (isRecord ? " record" : "") +
      '" data-k="' + k + '" style="animation-delay:' + Math.floor(idx / 7) * 12 + 'ms"></div>';
    idx++;
  }
  heat.innerHTML = html;
  heat.parentElement.scrollLeft = heat.parentElement.scrollWidth;
}

const dayTokens = (k) => Object.values(DATA.days[k].models).reduce((s, m) => s + mTok(m), 0);
const dayCost = (k) => Object.entries(DATA.days[k].models).reduce((s, [m, v]) => s + mCost(m, v), 0);
const daysBetween = (k) => Math.round((new Date() - new Date(k + "T00:00:00")) / 864e5) + 1;

// wallet spend card (Uiverse.io by Na3ar-17, adapted)
let walletCollapsed = localStorage.getItem("ccstats-wallet-collapsed") === "1";
let walletSel = 0;

const topModels = (a) =>
  Object.entries(a.models)
    .filter(([, v]) => mTok(v) > 0)
    .sort((x, y) => mCost(y[0], y[1]) - mCost(x[0], x[1]));

// share of this model's own total. Raw counts alone are unreadable across four orders of
// magnitude (24.9K next to 109.2M), so each block carries its percentage and a fill bar.
function pctStr(part, total) {
  if (!total || !part) return "0%";
  const p = (part / total) * 100;
  return p < 0.01 ? "<0.01%" : p < 1 ? p.toFixed(2) + "%" : p.toFixed(1) + "%";
}
// The bar stays strictly proportional — a percentage floor would render 0.05% and 0.28%
// identically, which is the misreading the number is there to prevent. --pmin only keeps a
// nonzero share from disappearing entirely; the text carries the precision.
const wblock = (n, total, label) =>
  '<div class="block">' + exb(n) + "<span>" + label +
  ' <em class="pct">' + pctStr(n, total) + "</em></span>" +
  '<i class="pbar" style="--p:' + (total ? (n / total) * 100 : 0) + "%;--pmin:" +
  (n > 0 ? "2px" : "0px") + '"></i></div>';

const walletParts = (v) => [
  { key: "i", label: T("wInput"), n: v.i },
  { key: "o", label: T("wOutput"), n: v.o },
  { key: "c", label: T("wCache"), n: v.cw + (v.c1h || 0) + v.cr },
];

const walletBlocks = (v) => {
  const total = mTok(v);
  return walletParts(v).map((p) => wblock(p.n, total, p.label)).join("");
};

// Donut view of the same three numbers. Arcs are drawn with stroke-dasharray on concentric
// circles rather than <path> arcs — one number per segment, no trig, and no large-arc-flag
// discontinuity when a slice crosses 180deg.
//
// The geometry stays strictly proportional. With a typical cache share above 99% the other two
// slices are a fraction of a degree, so they render as a hairline: MIN_ARC keeps a nonzero
// segment from vanishing entirely, exactly like --pmin does on the bars, and the legend carries
// the real percentages. Deliberately NOT inflating small slices to a "readable" minimum angle —
// that would misstate the very ratio the chart exists to show. Every segment is hoverable from
// the legend too, so a hairline arc is still inspectable.
const DONUT_R = 52, DONUT_C = 2 * Math.PI * DONUT_R, MIN_ARC = 2;

function walletDonut(v) {
  const total = mTok(v);
  const parts = walletParts(v);
  let offset = 0;
  const arcs = parts.map((p, i) => {
    const frac = total ? p.n / total : 0;
    const len = p.n > 0 ? Math.max(MIN_ARC, frac * DONUT_C) : 0;
    const seg =
      '<circle class="dseg d' + p.key + '" data-seg="' + i + '" r="' + DONUT_R + '" cx="60" cy="60"' +
      ' stroke-dasharray="' + len.toFixed(3) + " " + (DONUT_C - len).toFixed(3) + '"' +
      ' stroke-dashoffset="' + (-offset).toFixed(3) + '"' +
      ' style="--d:' + (i * 120) + 'ms"></circle>';
    offset += frac * DONUT_C;
    return seg;
  }).join("");

  const legend = parts.map((p, i) =>
    '<button type="button" class="dleg" data-seg="' + i + '">' +
    '<span class="ddot d' + p.key + '"></span>' +
    '<span class="dlabel">' + p.label + "</span>" +
    '<span class="dpct">' + pctStr(p.n, total) + "</span>" +
    '<span class="dval">' + fmt(p.n) + "</span></button>"
  ).join("");

  return (
    '<div class="donut">' +
    '<div class="dchart">' +
    '<svg viewBox="0 0 120 120" role="img" aria-label="' + attr(T("wDonutAlt")) + '">' +
    '<circle class="dtrack" r="' + DONUT_R + '" cx="60" cy="60"></circle>' + arcs +
    "</svg>" +
    // the default (total) reading is stashed on the node so restoring it after a hover does not
    // have to re-derive anything
    '<div class="dcenter" data-total="' +
    attr("<b>" + fmt(total) + "</b><span>" + T("unitTokens") + "</span>") + '">' +
    "<b>" + fmt(total) + "</b><span>" + T("unitTokens") + "</span></div>" +
    "</div>" +
    '<div class="dlegend">' + legend + "</div>" +
    "</div>"
  );
}

// which view the wallet footer is showing; remembered like the collapse state
let walletChart = localStorage.getItem("ccstats-wallet-chart") === "1";
const walletFooter = (v) => (walletChart ? walletDonut(v) : walletBlocks(v));

function walletHTML(a) {
  const rows = topModels(a);
  if (!rows.length) return "";
  const top = rows;
  if (walletSel >= top.length) walletSel = 0;
  const rangeLabel = range === "all" ? T("wAll") : T("wDays", range);
  // Real cents for the odometer. Floor to whole cents first so the dollar part and the
  // reels come from one number — rounding the dollars separately (fmtUsd rounds at >=100)
  // would let "$1,404" sit next to cents belonging to 1403.96.
  // cvt() first: the reels are the real cents of the *displayed* figure, so with a currency
  // override they have to come from the converted number or they contradict every other total
  const totalCents = Math.max(0, Math.floor(cvt(a.cost) * 100));
  const whole = Math.floor(totalCents / 100), cents = totalCents % 100;
  // line 10 of the reel is also "0", so a zero digit still rolls a full turn instead of
  // sitting still at line 0
  const reel = (d) => (d === 0 ? -10 : -d) + "em";
  const bank = top.map(([m, v], i) =>
    '<label class="bank-card" data-m="' + attr(m) + '"><div class="number">' +
    '<input type="radio" name="wallet-model" class="wradio" data-idx="' + i + '"' + (i === walletSel ? " checked" : "") + '><span class="custom-radio"></span>' +
    '<p class="mname2">' + pretty(m) + '</p></div><p class="mcost2">' + fmtUsd(mCost(m, v)) + "</p></label>"
  ).join("");
  return (
    '<div class="wcard">' +
    '<header class="whead"><div class="hrow">' +
    '<div class="wallet"><div class="icon-wrapper">' + icon("wallet") + "</div>" +
    '<div><p class="wtitle">' + T("walletTitle", rangeLabel) + '</p>' +
    '<p class="wbalance" data-tip="' + attr(T("tipBalance")) + '">' + CUR.symbol + whole.toLocaleString() +
    '<span class="wdot">.</span><span class="digits wdigits" style="--t1:' + reel(Math.floor(cents / 10)) +
    ";--t2:" + reel(cents % 10) + '"></span></p></div></div>' +
    '<label class="close"><input type="checkbox" id="wtoggle" class="wtoggle"' + (walletCollapsed ? " checked" : "") + ">" + icon("x") + "</label>" +
    "</div></header>" +
    '<div class="wbody">' +
    '<div class="bhead"><p class="btitle">' + T("wTopModels") + '</p><span class="bcount">' + T("wModelCount", rows.length) + "</span></div>" +
    '<div class="bank-cards" style="--wn:' + top.length + '">' + bank + "</div>" +
    '<footer class="wfoot"><div class="fhead">' +
    '<p class="cash-title">' + T("wTokensOf", pretty(top[walletSel][0])) + "</p>" +
    '<button type="button" class="dtoggle" id="dtoggle" aria-pressed="' + (walletChart ? "true" : "false") +
    '" data-tip="' + attr(T("wViewTip")) + '">' + icon(walletChart ? "bars" : "pie") +
    '<span>' + T(walletChart ? "wViewBars" : "wViewDonut") + "</span></button></div>" +
    '<div class="blocks' + (walletChart ? " ischart" : "") + '" id="wblocks">' +
    walletFooter(top[walletSel][1]) + "</div></footer>" +
    "</div>" +
    '<label for="wtoggle" class="expandbtn">' +
    '<span class="ebg"><span class="ebg-layers"><span class="ebg-layer l1"></span><span class="ebg-layer l2"></span><span class="ebg-layer l3"></span></span></span>' +
    icon("plus") +
    '<span class="einner"><span class="e-static">' + T("wBreakdown") + '</span><span class="e-hover">' + T("wBreakdown") + "</span></span></label>" +
    "</div>"
  );
}

// the selected model's numbers, whichever of the two views is showing
function paintWalletFooter() {
  const top = topModels(aggregate(keysInRange()));
  if (!top[walletSel]) return;
  const host = document.getElementById("wblocks");
  host.classList.toggle("ischart", walletChart);
  host.innerHTML = walletFooter(top[walletSel][1]);
  document.querySelector(".wfoot .cash-title").textContent = T("wTokensOf", pretty(top[walletSel][0]));
}

document.getElementById("modelsPane").addEventListener("change", (e) => {
  if (e.target.classList.contains("wtoggle")) {
    walletCollapsed = e.target.checked;
    localStorage.setItem("ccstats-wallet-collapsed", walletCollapsed ? "1" : "0");
  } else if (e.target.classList.contains("wradio")) {
    walletSel = +e.target.dataset.idx;
    paintWalletFooter();
  }
});

document.getElementById("modelsPane").addEventListener("click", (e) => {
  const swap = e.target.closest("#dtoggle");
  if (swap) {
    walletChart = !walletChart;
    localStorage.setItem("ccstats-wallet-chart", walletChart ? "1" : "0");
    swap.setAttribute("aria-pressed", walletChart ? "true" : "false");
    swap.innerHTML = icon(walletChart ? "bars" : "pie") +
      "<span>" + T(walletChart ? "wViewBars" : "wViewDonut") + "</span>";
    paintWalletFooter();
    return;
  }
  // legend rows are the hit target for slices too thin to hover — with a 99% cache share the
  // other two arcs are a hairline, and a segment you cannot point at cannot be inspected
  const leg = e.target.closest(".dleg");
  if (leg) {
    const donut = leg.closest(".donut"), idx = +leg.dataset.seg;
    // clicking the pinned row again releases it, so there is always a way back to the total
    if (donut.dataset.pinned === String(idx)) focusSegment(donut, -1, false);
    else focusSegment(donut, idx, true);
  }
});

// hover/focus a slice or a legend row -> centre reads that segment instead of the total
function focusSegment(donut, idx, sticky) {
  if (!donut) return;
  const segs = [...donut.querySelectorAll(".dseg")];
  const legs = [...donut.querySelectorAll(".dleg")];
  const on = idx !== null && idx >= 0;
  // Pin bookkeeping happens BEFORE the clear-to-total path returns. It used to sit after, so
  // unpinning restored the total but left dataset.pinned set — and every later hover was then
  // ignored as "pinned", which killed the interaction for the rest of the session.
  if (sticky && on) donut.dataset.pinned = idx; else delete donut.dataset.pinned;
  donut.classList.toggle("focused", on);
  segs.forEach((s, i) => s.classList.toggle("dim", on && i !== idx));
  legs.forEach((l, i) => l.classList.toggle("on", on && i === idx));
  const centre = donut.querySelector(".dcenter");
  if (!on) { centre.innerHTML = centre.dataset.total; return; }
  const leg = legs[idx];
  centre.innerHTML = "<b>" + leg.querySelector(".dval").textContent + "</b><span>" +
    leg.querySelector(".dlabel").textContent + "</span>";
}

// One handler for the whole pane, so moving the pointer OFF the donut — to anywhere else in the
// card, not just past its edge — releases the reading. Scoping this to the donut alone left the
// centre stuck on whichever slice was touched last.
document.getElementById("modelsPane").addEventListener("mouseover", (e) => {
  const hit = e.target.closest(".dseg, .dleg");
  const donut = hit ? hit.closest(".donut") : null;
  document.querySelectorAll("#modelsPane .donut").forEach((d) => {
    if (d.dataset.pinned !== undefined) return;      // a pinned donut ignores hover entirely
    focusSegment(d, d === donut ? +hit.dataset.seg : -1, false);
  });
});
// keyboard parity: tabbing through the legend reads out the same way hovering does
document.getElementById("modelsPane").addEventListener("focusin", (e) => {
  const leg = e.target.closest(".dleg");
  if (!leg) return;
  const d = leg.closest(".donut");
  if (d.dataset.pinned === undefined) focusSegment(d, +leg.dataset.seg, false);
});

function renderModels(a) {
  const pane = document.getElementById("modelsPane");
  const rows = Object.entries(a.models).sort((x, y) => mTok(y[1]) - mTok(x[1]));
  const max = rows.length ? mTok(rows[0][1]) : 1;
  pane.innerHTML = walletHTML(a) + (rows.length
    ? rows.map(([m, v], i) =>
        '<div class="mrow" data-m="' + attr(m) + '" style="animation-delay:' + i * 60 + 'ms"><div class="mtop"><span class="mname">' + pretty(m) +
        '</span><span class="mmeta"><span data-exact="' + fmtUsdCents(mCost(m, v)) + '">' + fmtUsd(mCost(m, v)) + "</span> · " +
        exb(mTok(v)) + " " + T("unitTokens") + " · " + v.msg.toLocaleString() + " " + T("unitMsgs") +
        '</span></div><div class="bar"><i style="width:' + Math.max(2, (mTok(v) / max) * 100) + '%"></i></div></div>'
      ).join("")
    : '<div class="empty">' + T("emptyRange") + "</div>");
}

// --- day tooltip ---
const tip = document.getElementById("tip");

function tipHTML(k) {
  const d = DATA.days[k];
  const date = new Date(k + "T00:00:00").toLocaleDateString(T("locale"), {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
  if (!d) return '<div class="tdate">' + date + '</div><div class="trow">' + T("tipNone") + "</div>";
  const models = Object.entries(d.models).sort((a, b) => mTok(b[1]) - mTok(a[1]));
  const peak = d.hours.some((h) => h) ? d.hours.indexOf(Math.max(...d.hours)) : null;
  const peakLabel = peak === null ? "—" : T("hour", peak);
  return (
    '<div class="tdate">' + date + "</div>" +
    '<div class="trow"><span>' + T("tipCost") + "</span><b>" + fmtUsd(dayCost(k)) + "</b></div>" +
    '<div class="trow"><span>' + T("tipTokens") + "</span><b>" + fmt(dayTokens(k)) + "</b></div>" +
    '<div class="trow"><span>' + T("tipMessages") + "</span><b>" + d.msgs.toLocaleString() + "</b></div>" +
    '<div class="trow"><span>' + T("tipSessions") + "</span><b>" + d.sessions.length + "</b></div>" +
    '<div class="trow"><span>' + T("tipPeak") + "</span><b>" + peakLabel + "</b></div>" +
    (models.length
      ? '<div class="tmodels">' + models.map(([m, v]) =>
          '<div class="trow"><span>' + pretty(m) + "</span><b>" + fmt(mTok(v)) + "</b></div>"
        ).join("") + "</div>"
      : "")
  );
}

function moveTip(e) {
  const pad = 12, r = tip.getBoundingClientRect();
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}

let tipMode = null;
function bindDayHover(el) {
  el.addEventListener("mouseover", (e) => {
    const k = e.target.dataset && e.target.dataset.k;
    if (!k) return;
    if (redacted) return; // this popup is nothing but figures
    tip.innerHTML = tipHTML(k);
    tip.style.display = "block";
    tipMode = "day";
    moveTip(e);
  });
  el.addEventListener("mousemove", (e) => {
    if (tip.style.display === "block") moveTip(e);
  });
  el.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    tipMode = null;
  });
}
bindDayHover(document.getElementById("heat"));
bindDayHover(document.getElementById("chart"));

// exact-value / explainer tooltips on any [data-exact] or [data-tip] element.
// Deliberately not on .heatwrap or .chartwrap: closest() would find the wrapper from a
// cell or bar and clobber the richer day tooltip those bind themselves.
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest && e.target.closest("[data-exact],[data-tip]");
  if (el) {
    // The hourly bars put a table of figures in data-tip, so the whole tooltip goes; everywhere
    // else only the data-exact line is a value and the prose explainer can stay.
    if (redacted && el.closest(".thbar")) { tip.style.display = "none"; tipMode = null; return; }
    const exact = el.dataset.exact && !redacted;
    if (redacted && !el.dataset.tip) { tip.style.display = "none"; tipMode = null; return; }
    tip.innerHTML =
      (exact ? '<div class="tdate">' + el.dataset.exact + "</div>" : "") +
      (el.dataset.tip ? '<div class="tdesc">' + el.dataset.tip + "</div>" : "");
    tip.style.display = "block";
    tipMode = "exact";
    moveTip(e);
  } else if (tipMode === "exact") {
    tip.style.display = "none";
    tipMode = null;
  }
});
document.addEventListener("mousemove", (e) => {
  if (tipMode === "exact" && tip.style.display === "block") moveTip(e);
});

// --- count-up animations ---
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
function animateNum(el, target, format) {
  // Write the final value FIRST. requestAnimationFrame does not run in a backgrounded tab, in a
  // window that is not compositing, or under some remote-render setups — and a headline number
  // that only exists if an animation played is a number that is sometimes simply missing. The
  // count-up then overwrites this from zero; if it never starts, the right answer is already up.
  el.textContent = format(target);
  if (reducedMotion) return;
  const dur = 700, t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  // Writing the final value up front is not enough on its own: the first frame immediately
  // overwrites it with target*ease(0) === 0, and if no further frame ever arrives — tab
  // backgrounded mid-animation, window not compositing, virtual clock — the headline stays
  // stuck at 0. setTimeout keeps running where requestAnimationFrame does not, so this snaps
  // the real number into place regardless. Cleared on the frame that finishes normally.
  const snap = setTimeout(() => { el.textContent = format(target); }, dur + 120);
  function frame(now) {
    // Clamp BOTH ends. The rAF timestamp is the frame's start time, which can predate the
    // performance.now() above when a frame was already in flight — so p can arrive negative,
    // and the cubic ease amplifies rather than absorbs it: p = -1 gives ease = -7, i.e. the
    // headline briefly renders as "$-1,526.81". Small negative p only flashes for one frame,
    // but under a virtual clock it persists and every number on the page reads negative.
    const p = Math.max(0, Math.min(1, (now - t0) / dur));
    el.textContent = format(target * ease(p));
    if (p < 1) requestAnimationFrame(frame);
    else clearTimeout(snap);
  }
  requestAnimationFrame(frame);
}

function countUp(el, finalStr) {
  // Hangul is allowed in the suffix so the Korean streak values ("10일") count up the same
  // way "10d" does. "12 AM" / "오전 12시" still fall through to a plain set, as before.
  const m = /^([\d.,]+)([A-Za-z가-힣]*)$/.exec(finalStr);
  if (!m) { el.textContent = finalStr; return; }
  const num = parseFloat(m[1].replace(/,/g, "")), suffix = m[2];
  const decimals = (m[1].split(".")[1] || "").length;
  const hasComma = m[1].includes(",");
  animateNum(el, num, (v) => {
    const s = decimals ? v.toFixed(decimals) : Math.round(v);
    return (hasComma ? Number(s).toLocaleString() : s) + suffix;
  });
}

const countUpUsd = (el, usd) => animateNum(el, usd, fmtUsdCents);
let lastShownCost = 0;

// --- book comparison ticker (auto-rolls; click to skip ahead) ---
let bookIdx = 0, bookTimer = null;
function rollBook() {
  const all = aggregate(dayKeys);
  // "You've used ~0x more tokens than The Little Prince" is what every book line said before
  // any billable usage existed — the exact state a first-time reader is in.
  if (!all.tokens) {
    document.getElementById("foot").innerHTML = '<span class="fline">' + T("bookNone") + "</span>";
    clearInterval(bookTimer);
    return;
  }
  const lines = BOOKS.map(([name, toks]) =>
    T("bookLine", Math.round(all.tokens / toks).toLocaleString(), bookName(name))
  );
  lines.push(lines[0]); // duplicate first line for a seamless loop
  document.getElementById("foot").innerHTML =
    T("footPrefix") + '<span class="fwords"><span class="finner" id="finner">' +
    lines.map((l) => '<span class="fline">' + l + "</span>").join("") +
    "</span></span>";
  bookIdx = 0;
  clearInterval(bookTimer);
  bookTimer = setInterval(advanceBook, 2600);
}
function advanceBook() {
  const inner = document.getElementById("finner");
  if (!inner) return;
  bookIdx++;
  inner.style.transition = "transform .55s cubic-bezier(.34,1.4,.64,1)";
  inner.style.transform = "translateY(" + bookIdx * -1.55 + "em)";
  if (bookIdx >= BOOKS.length) {
    setTimeout(() => {
      inner.style.transition = "none";
      inner.style.transform = "translateY(0)";
      bookIdx = 0;
    }, 600);
  }
}
document.getElementById("foot").addEventListener("click", advanceBook);

// --- IRL money easter egg: what the est. cost buys in the real world ---
// prices only — the names live in the language tables, index-aligned with this list
const IRL_PRICES = [2.5, 5.79, 1.5, 4.99, 2.2, 6.5, 199.99 / 22500, 899.99, 1299.99, 64170];
let irlLast = "";
// Fisher-Yates. The old sort-with-a-random-comparator is not a shuffle — comparator-based
// shuffles are biased, and with a reroll button you notice: the same trio kept coming back.
function irlPick() {
  const idx = IRL_PRICES.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, 3);
}
function renderIRL() {
  const cost = lastShownCost;
  const names = T("irl");
  // reroll until the trio actually changes, so a click always visibly does something
  let picks = irlPick();
  for (let tries = 0; tries < 6 && picks.join() === irlLast; tries++) picks = irlPick();
  irlLast = picks.join();
  const lines = picks.map((i, n) =>
    '<div class="irl-line" style="animation-delay:' + n * 55 + 'ms">' +
    T("irlLine", T("irlAmount", cost / IRL_PRICES[i]), names[i]) + "</div>"
  );
  document.getElementById("irlPanel").innerHTML =
    '<div class="irl-title"><span>' + T("irlTitle", fmtUsdCents(cost)) + "</span>" +
    '<button type="button" class="irl-roll" title="' + attr(T("irlReroll")) + '">' +
    icon("shuffle") + "</button></div>" + lines.join("");
}
document.getElementById("irl").addEventListener("mouseenter", renderIRL);
// the whole panel is the reroll target — the button is just the affordance that says so
document.getElementById("irl").addEventListener("click", (e) => {
  // No stopPropagation: the ripple runs on pointerdown so there was nothing here to suppress,
  // and swallowing the click meant the document-level handler never ran — so an open
  // right-click menu stayed open behind the panel.
  const btn = e.target.closest(".irl-roll");
  renderIRL();
  if (btn) {
    const r = document.querySelector(".irl-roll").getBoundingClientRect();
    confetti(r.left + r.width / 2, r.top + r.height / 2, { n: 8 });
  }
});

// Refresh: replay the whole dashboard (count-ups, chart, odometer, ticker)
document.getElementById("refreshBtn").addEventListener("click", render);

// Today chip: jump to the Today card
document.getElementById("btn-message").addEventListener("click", () => {
  if (tab !== "overview") document.querySelector('[data-tab="overview"]').click();
  const t = document.querySelector(".today");
  t.scrollIntoView({ behavior: "smooth", block: "center" });
  t.classList.add("flash");
  setTimeout(() => t.classList.remove("flash"), 1200);
});

// --- confetti ---
function confetti(x, y, opts = {}) {
  const { n = 24, text = null } = opts;
  const colors = opts.colors || ["#9be9a8", "#40c463", "#30a14e", "#216e39", "#39d353"];
  for (let i = 0; i < n; i++) {
    const p = document.createElement("div");
    p.className = "confetti";
    if (text) {
      p.textContent = text;
      p.style.fontSize = 12 + Math.random() * 12 + "px";
      p.style.fontWeight = "700";
      p.style.color = colors[Math.floor(Math.random() * colors.length)];
    } else {
      p.style.width = p.style.height = 6 + Math.random() * 7 + "px";
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.borderRadius = Math.random() < 0.5 ? "50%" : "2px";
    }
    p.style.left = x + "px"; p.style.top = y + "px";
    document.body.appendChild(p);
    const angle = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 160;
    p.animate([
      { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
      { transform: "translate(" + Math.cos(angle) * dist + "px," + (Math.sin(angle) * dist + 120) + "px) rotate(" + (Math.random() * 720 - 360) + "deg)", opacity: 0 },
    ], { duration: 900 + Math.random() * 600, easing: "cubic-bezier(.22,1,.36,1)" })
      .onfinish = () => p.remove();
  }
}

// heatmap cell / chart bar click: green sparks; the record day gets flames
function bindDaySpark(el) {
  el.addEventListener("click", (e) => {
    const k = e.target.dataset && e.target.dataset.k;
    if (!k) return;
    const r = e.target.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const isPeak = e.target.classList.contains("record") || e.target.classList.contains("peakbar");
    if (isPeak) confetti(cx, cy, { n: 20, colors: ["#ff6b35", "#f7931a", "#ffb347", "#e25822"] });
    else if (dayTokens(k) > 0) confetti(cx, cy, { n: 10 });
  });
}
bindDaySpark(document.getElementById("heat"));
bindDaySpark(document.getElementById("chart"));

// --- ripple on cards ---
document.addEventListener("pointerdown", (e) => {
  const card = e.target.closest(".card, .coststrip, .today");
  if (!card) return;
  // Not from a control. The ripple is a "you tapped this card" affordance sized to the whole
  // card — on the Today card that is a 1600px accent circle, and it fired on every expand AND
  // collapse of the yesterday comparison, so the disclosure button flashed a huge green sphere
  // across the panel it was opening. Buttons, labels and inputs already give their own
  // feedback; the card-wide wash on top of that is noise. Same rule kills it on the IRL
  // shuffle button inside the cost strip.
  if (e.target.closest("button, a, label, input, select, textarea, [role='button']")) return;
  const r = card.getBoundingClientRect();
  const rip = document.createElement("span");
  rip.className = "ripple";
  const size = Math.max(r.width, r.height) * 2;
  rip.style.width = rip.style.height = size + "px";
  rip.style.left = e.clientX - r.left - size / 2 + "px";
  rip.style.top = e.clientY - r.top - size / 2 + "px";
  card.appendChild(rip);
  rip.animate([{ transform: "scale(0)", opacity: 0.35 }, { transform: "scale(1)", opacity: 0 }],
    { duration: 600, easing: "ease-out" }).onfinish = () => rip.remove();
});

// --- easter egg: click Total tokens card 5 times ---
let tokClicks = 0, tokTimer;
document.getElementById("cards").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card || card.dataset.card !== "tokens") return;
  clearTimeout(tokTimer);
  tokTimer = setTimeout(() => (tokClicks = 0), 1500);
  if (++tokClicks >= 5) {
    tokClicks = 0;
    const r = card.getBoundingClientRect();
    confetti(r.left + r.width / 2, r.top + r.height / 2, { n: 22, text: CUR.symbol });
    const v = card.querySelector(".value"), orig = v.textContent;
    v.textContent = T("sry");
    setTimeout(() => (v.textContent = orig), 2000);
  }
});

// --- easter egg: Konami code → party mode ---
const KONAMI = ["ArrowUp","ArrowUp","ArrowDown","ArrowDown","ArrowLeft","ArrowRight","ArrowLeft","ArrowRight","b","a"];
let kIdx = 0;
document.addEventListener("keydown", (e) => {
  kIdx = e.key === KONAMI[kIdx] ? kIdx + 1 : e.key === KONAMI[0] ? 1 : 0;
  if (kIdx === KONAMI.length) {
    kIdx = 0;
    document.body.classList.toggle("party");
    confetti(innerWidth / 2, innerHeight / 3, { n: 60 });
    document.title = document.body.classList.contains("party") ? T("partyTitle") : "ccstats";
  }
});

// --- theme toggle (day/night switch) ---
const themeInput = document.getElementById("themeInput");
const applyTheme = (t) => {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  themeInput.checked = dark;
};
// same precedence as language: saved choice, then config, then the OS preference
applyTheme(localStorage.getItem("ccstats-theme") || (DATA.config && DATA.config.theme) || null);

// config accent: one hex drives the accent in both themes. The fill ramp is left alone — it is
// tuned per theme for contrast against the cards, and tinting it from a single hex made the
// heatmap unreadable at the low end.
if (DATA.config && DATA.config.accent && /^#[0-9a-f]{3,8}$/i.test(DATA.config.accent)) {
  document.documentElement.style.setProperty("--accent", DATA.config.accent);
  document.documentElement.style.setProperty("--b3", DATA.config.accent);
  document.documentElement.style.setProperty("--b4", DATA.config.accent);
}
themeInput.addEventListener("change", () => {
  const next = themeInput.checked ? "dark" : "light";
  localStorage.setItem("ccstats-theme", next);
  applyTheme(next);
});

// --- language toggle (EN / 한국어) ---
// Static markup carries data-i18n for its text and data-tip-key for its tooltip; both are
// resolved here so a language change never has to rebuild the top bar by hand.
function applyStatic() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = T(el.dataset.i18n); });
  document.querySelectorAll("[data-tip-key]").forEach((el) => { el.dataset.tip = T(el.dataset.tipKey); });
  document.querySelectorAll("[data-range]").forEach((b) => { b.dataset.tip = T("tipRange", b.dataset.range); });
  document.querySelectorAll("[data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
  if (document.body.classList.contains("party")) document.title = T("partyTitle");
}
function setLang(next) {
  if (next === lang || !LANGS[next]) return;
  lang = next;
  localStorage.setItem("ccstats-lang", lang);
  applyStatic();
  render(); // every pane is rebuilt from T(), so one re-render retranslates the whole page
  // the welcome dialog is outside .wrap, so render() does not reach it
  if (helloEl && !helloEl.hidden) paintHello();
}
document.querySelectorAll("[data-lang]").forEach((b) =>
  b.addEventListener("click", () => setLang(b.dataset.lang))
);

// Restarting only the pane's own .pane-in animation leaves everything inside it alone, and a
// pane that has NEVER been on screen keeps its entrance animations ticking while display:none —
// the browser only cancels them on a visible->none transition, which never happened. So the very
// first visit to Models showed every row already settled (measured: the .bhead fadeSlideIn was at
// 400ms of a 350ms run, the odometer at 3600ms), while the 2nd and later visits replayed fine.
// Rewinding the whole revealed subtree makes every visit look identical to the first.
function replayEntrance(pane) {
  pane.getAnimations({ subtree: true }).forEach((a) => {
    a.cancel();
    a.play();
  });
}
document.querySelectorAll("[data-tab]").forEach((b) =>
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("on", x === b));
    const ov = document.getElementById("overview"), mp = document.getElementById("modelsPane");
    ov.style.display = tab === "overview" ? "" : "none";
    mp.style.display = tab === "models" ? "flex" : "none";
    const shown = tab === "overview" ? ov : mp;
    shown.classList.remove("pane-in");
    void shown.offsetWidth;
    shown.classList.add("pane-in");
    replayEntrance(shown);
  })
);
document.querySelectorAll("[data-range]").forEach((b) =>
  b.addEventListener("click", () => {
    range = b.dataset.range;
    document.querySelectorAll("[data-range]").forEach((x) => x.classList.toggle("on", x === b));
    render();
  })
);

// --- right-click context menu (Uiverse.io by Na3ar-17, adapted) ---
const ctx = document.createElement("div");
ctx.className = "ctx";
// labels are filled by applyStatic() so the menu follows the active language
ctx.innerHTML =
  '<ul>' +
  '<li class="el" data-act="copy">' + icon("clipboard") + '<span data-i18n="ctxCopy"></span></li>' +
  '<li class="el" data-act="export">' + icon("download") + '<span data-i18n="ctxExport"></span></li>' +
  '</ul><div class="sep"></div><ul>' +
  '<li class="el" data-act="theme">' + icon("moon") + '<span data-i18n="ctxTheme"></span></li>' +
  '<li class="el" data-act="lang">' + icon("globe") + '<span data-i18n="ctxLang"></span></li>' +
  '<li class="el" data-act="book">' + icon("book") + '<span data-i18n="ctxBook"></span></li>' +
  '<li class="el" data-act="redact">' + icon("eyeoff") + '<span data-i18n="ctxRedact"></span></li>' +
  '<li class="el" data-act="hello">' + icon("sparkles") + '<span data-i18n="ctxHello"></span></li>' +
  '</ul><div class="sep"></div><ul>' +
  '<li class="el special" data-act="party">' + icon("sparkles") + '<span data-i18n="ctxParty"></span></li>' +
  '</ul>';
document.body.appendChild(ctx);

function closeCtx() { ctx.classList.remove("open"); }

// Redacted mode. Blurring a number is theatre if hovering it still prints the exact value, so
// this also gates every tooltip that carries one — data-exact, the per-day heat/chart popups,
// and the hourly bars, whose data-tip is a table of figures. The plain explainer tooltips are
// prose about what a stat means and stay.
function setRedacted(on) {
  redacted = on;
  localStorage.setItem("ccstats-redacted", on ? "1" : "0");
  document.body.classList.toggle("redacted", on);
  tip.style.display = "none";
  const item = ctx.querySelector('[data-act="redact"]');
  if (item) item.innerHTML = icon(on ? "eye" : "eyeoff") + "<span>" + T(on ? "ctxUnredact" : "ctxRedact") + "</span>";
  toast(T(on ? "redactOn" : "redactOff"));
}

// "Copy summary" copies whatever you right-clicked ON — a heatmap day, an hour bar, a model
// row, a stat card — and only falls back to the whole-range summary on background. The menu
// label names the scope so you can see what you are about to get before you click.
const dayLabel = (k) =>
  new Date(k + "T12:00:00").toLocaleDateString(T("locale"), { weekday: "short", month: "short", day: "numeric" });

function copyContext(el) {
  const at = (sel) => el && el.closest && el.closest(sel);

  const dayEl = at("[data-k]");
  if (dayEl) {
    const k = dayEl.dataset.k, d = DATA.days[k], label = dayLabel(k);
    if (!d || !d.msgs) return { label, text: T("copyDayEmpty", label) };
    const t = Object.entries(d.models).sort((p, q) => mTok(q[1]) - mTok(p[1]))[0];
    return { label, text: T("copyDay", label, fmtUsdCents(dayCost(k)), fmt(dayTokens(k)),
      d.msgs.toLocaleString(), d.sessions.length, t ? pretty(t[0]) : "—") };
  }

  const hourEl = at(".thbar");
  if (hourEl) {
    const tk = todayKey(), d = DATA.days[tk];
    const h = +hourEl.dataset.h, x = hourStats(d || { hours: [], hm: {} })[h];
    const label = T("hour", h);
    if (!x.tok && !x.msgs) return { label, text: T("copyHourEmpty", label, dayLabel(tk)) };
    return { label, text: T("copyHour", label, dayLabel(tk), fmtUsdCents(x.cost), fmt(x.tok),
      x.msgs.toLocaleString(), x.top ? pretty(x.top) : "—") };
  }

  // .tmrow is today-scoped, .mrow / .bank-card are range-scoped — same markup shape, different totals
  const todayModel = at(".tmrow");
  const rangeModel = at(".mrow, .bank-card");
  const modelEl = todayModel || rangeModel;
  if (modelEl) {
    const m = modelEl.dataset.m;
    const scopeKeys = todayModel ? [todayKey()] : keysInRange();
    const v = { i: 0, o: 0, cw: 0, cr: 0, c1h: 0, msg: 0 };
    for (const k of scopeKeys) {
      const e2 = DATA.days[k] && DATA.days[k].models[m];
      if (e2) { v.i += e2.i; v.o += e2.o; v.cw += e2.cw; v.cr += e2.cr; v.c1h += e2.c1h || 0; v.msg += e2.msg || 0; }
    }
    const scope = todayModel ? T("copyScopeToday") : T("copyLabel", range);
    return { label: pretty(m), text: T("copyModel", pretty(m), scope, fmtUsdCents(mCost(m, v)),
      // v.cw is 5-minute writes only; the 1-hour tier is a separate field. Reporting the bare
      // v.cw here left the four components short of the total they sit next to — on real data
      // that was 16.5M tokens of 1h cache writes silently dropped out of the copied text.
      fmt(mTok(v)), fmt(v.i), fmt(v.o), fmt(v.cw + v.c1h), fmt(v.cr), v.msg.toLocaleString()) };
  }

  const cardEl = at("[data-card]");
  if (cardEl) {
    const label = cardEl.querySelector(".label").textContent;
    const value = cardEl.querySelector(".value").textContent;
    return { label, text: T("copyCard", label, value, T("copyLabel", range)) };
  }

  if (at("#today")) {
    const tk = todayKey(), d = DATA.days[tk], label = T("copyScopeToday");
    if (!d || !d.msgs) return { label, text: T("copyDayEmpty", dayLabel(tk)) };
    const t = Object.entries(d.models).sort((p, q) => mTok(q[1]) - mTok(p[1]))[0];
    return { label, text: T("copyDay", dayLabel(tk), fmtUsdCents(dayCost(tk)), fmt(dayTokens(tk)),
      d.msgs.toLocaleString(), d.sessions.length, t ? pretty(t[0]) : "—") };
  }

  const keys = keysInRange();
  const a = aggregate(keys), st = streaks(keys);
  const fav = Object.entries(a.models).sort((x, y) => mTok(y[1]) - mTok(x[1]))[0];
  return { label: null, text: T("copySummary", T("copyLabel", range), fmtUsd(a.cost), fmt(a.tokens),
    a.msgs.toLocaleString(), a.sessions, a.activeDays, st.cur, st.max, fav ? pretty(fav[0]) : "") };
}

let ctxCopy = null;
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  ctxCopy = copyContext(e.target);
  // applyStatic() resets this row from data-i18n on every language change, so the label is
  // re-derived from the live state each time the menu opens rather than only on toggle
  const rl = ctx.querySelector('[data-act="redact"]');
  if (rl) rl.innerHTML = icon(redacted ? "eye" : "eyeoff") +
    "<span>" + T(redacted ? "ctxUnredact" : "ctxRedact") + "</span>";
  ctx.querySelector('[data-act="copy"] span').textContent =
    ctxCopy.label ? T("ctxCopyOf", ctxCopy.label) : T("ctxCopy");
  ctx.classList.add("open");
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(e.clientX, innerWidth - w - 10) + "px";
  ctx.style.top = Math.min(e.clientY, innerHeight - h - 10) + "px";
});

// copy confirmation — one chip, bottom centre, replaces itself if you copy again
let toastTimer = null;
const toastEl = document.createElement("div");
toastEl.className = "toast";
document.body.appendChild(toastEl);
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}
document.addEventListener("click", (e) => { if (!ctx.contains(e.target)) closeCtx(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtx(); });

ctx.addEventListener("click", (e) => {
  const el = e.target.closest(".el");
  if (!el) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  switch (el.dataset.act) {
    case "copy": {
      const c = ctxCopy || copyContext(null);
      navigator.clipboard.writeText(c.text)
        .then(() => {
          confetti(cx, cy, { n: 10 });
          toast(c.label ? T("copiedOf", c.label) : T("copied"));
        })
        .catch(() => toast(T("copyFailed")));
      break;
    }
    case "export": {
      const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "ccstats-data.json";
      a.click();
      URL.revokeObjectURL(a.href);
      break;
    }
    case "theme": themeInput.click(); break;
    case "lang": setLang(lang === "en" ? "ko" : "en"); break;
    case "book": rollBook(); break;
    case "redact": setRedacted(!redacted); break;
    case "hello": closeCtx(); showHello(); break;
    case "party":
      document.body.classList.toggle("party");
      confetti(cx, cy, { n: 40 });
      document.title = document.body.classList.contains("party") ? T("partyTitle") : "ccstats";
      break;
  }
  closeCtx();
});

// --- live mode: poll for fresh data when served by ccstats-server ---
let liveSig = null;
async function pollLive() {
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    if (!res.ok) return;
    const fresh = await res.json();
    const sig = JSON.stringify(fresh.days);
    if (liveSig === null) { liveSig = JSON.stringify(DATA.days); }
    if (sig !== liveSig) {
      liveSig = sig;
      DATA.days = fresh.days;
      dayKeys.length = 0;
      dayKeys.push(...Object.keys(DATA.days).sort());
      // first usage arriving while the empty-state shell is up: the dashboard markup is gone,
      // so rebuild it from scratch rather than rendering into elements that no longer exist
      if (noDataMode && dayKeys.length) return location.reload();
      render();
    }
  } catch {} // static file / no server — stay silent
}
setInterval(pollLive, 60000);

// --- first launch: a hello, and what to do with the thing ---
const helloEl = document.getElementById("hello");
// Split from showHello so switching language repaints the open dialog in place — setLang's
// render() rebuilds the panes, but this dialog lives outside .wrap and would otherwise keep
// the text of the language you just switched away from.
function paintHello() {
  document.getElementById("helloMark").innerHTML = icon("sparkles");
  document.getElementById("helloList").innerHTML = T("helloItems")
    .map(([ic, html]) => "<li>" + icon(ic) + "<span>" + html + "</span></li>").join("");
  document.getElementById("helloPrivacy").innerHTML = T("helloPrivacy");
  helloEl.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = T(el.dataset.i18n); });
  helloEl.querySelectorAll("[data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
}
function showHello() {
  paintHello();
  helloEl.hidden = false;
  document.getElementById("helloGo").focus();
}
function dismissHello() {
  helloEl.hidden = true;
  // "1" suppresses it, "0" means show it again next launch. Ticked by default, so the standing
  // behaviour is unchanged — a dashboard you open daily should not greet you every time — but
  // unticking is now the way to keep it, rather than the dialog being silently one-shot.
  const again = document.getElementById("helloAgain");
  localStorage.setItem("ccstats-welcomed", !again || again.checked ? "1" : "0");
}
document.getElementById("helloGo").addEventListener("click", () => {
  const r = document.getElementById("helloGo").getBoundingClientRect();
  dismissHello();
  confetti(r.left + r.width / 2, r.top + r.height / 2, { n: 24 });
});
// click-outside and Esc both dismiss; the panel is informational, not a decision
helloEl.addEventListener("click", (e) => { if (e.target === helloEl) dismissHello(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !helloEl.hidden) dismissHello(); });

document.body.classList.toggle("redacted", redacted); // restore before first paint
applyStatic();
render();
// splash loader: hold ~1s, then fade and replay the entrance animations
const loader = document.getElementById("loader");
setTimeout(() => {
  loader.classList.add("done");
  render();
  setTimeout(() => loader.remove(), 500);
  // after the splash, not during it — two overlapping overlays on first run looks broken
  if (localStorage.getItem("ccstats-welcomed") !== "1") setTimeout(showHello, 260);
}, 1000);
</script>
</body>
</html>`;

// .replace with a function argument, not a string: a literal replacement would treat $& / $1 in
// the font base64 or the JSON as substitution patterns and silently corrupt the output.
export const buildHTML = (data) =>
  TEMPLATE.replace("__FONTS__", () => FONTS).replace("__DATA__", () => JSON.stringify(data));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = `ccstats — a local usage dashboard for Claude Code

  node ccstats.mjs                 build ccstats.html next to this script
  node ccstats.mjs --serve         live dashboard, rescans as you work
  node ccstats.mjs --serve --open  ...and open it in your browser

Options
  -s, --serve          run a local server instead of writing a file
  -p, --port <n>       port for --serve (default 8743)
  -o, --out <path>     output path for the static build
      --open           open the result in your default browser
      --lan            with --serve, also accept connections from your network
                       (default is localhost only)
      --root <path>    transcript folder to scan; repeatable
      --config <path>  JSON config file (default: ccstats.config.json beside this script)
      --init-config    write a commented starter config and exit
  -h, --help           this text

Privacy
  Reads only usage metadata from the transcripts Claude Code already writes locally:
  timestamps, model names, token counts, and a hashed session id. Never reads message
  content, prompts, file paths, or project names. Makes no network requests, and the
  page it generates makes none either — fonts and data are inlined.

Data location
  Auto-detected from CLAUDE_CONFIG_DIR, then ~/.claude/projects, then
  ~/.config/claude/projects. Override with --root or "roots" in the config file.`;

const CONFIG_TEMPLATE = {
  $schema: "https://example.invalid/ccstats — every field is optional; delete what you don't need",
  $help: {
    pricing: "USD per 1M tokens as [input, output]. Key is a substring of the model id, or /regex/. Cache read bills at 0.1x input, cache writes at 1.25x (5m) or 2x (1h).",
    modelNames: "Display name overrides. Key is a substring of the model id, or /regex/.",
    accent: "Hex colour for the accent, e.g. \"#2da44e\". Applies to both light and dark.",
    currency: "Display only — multiplies the USD estimate. { \"symbol\": \"€\", \"rate\": 0.92 }",
    roots: "Absolute paths to transcript folders. Omit to auto-detect.",
    lang: "\"en\" or \"ko\" — the initial language. You can still switch in the page.",
    theme: "\"light\" or \"dark\" — the initial theme. You can still switch in the page.",
    hashSessions: "true (default) replaces session UUIDs with an opaque hash before they reach the output.",
  },
  pricing: { "my-model": [3, 15] },
  modelNames: { "my-model": "My Model" },
  accent: "#2da44e",
};

function parseArgs(argv) {
  const a = { roots: [], serve: false, port: 0, out: "", open: false, lan: false, config: "", help: false, init: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    // A value-taking flag left dangling used to reach resolve(undefined) and print a raw Node
    // stack trace. Every one of them goes through here so the message is about the flag.
    const next = () => {
      const n = argv[++i];
      if (n === undefined || n.startsWith("-")) {
        console.error("ccstats: " + v + " needs a value.\nTry: node ccstats.mjs --help");
        process.exit(1);
      }
      return n;
    };
    if (v === "-h" || v === "--help") a.help = true;
    else if (v === "-s" || v === "--serve") a.serve = true;
    else if (v === "-p" || v === "--port") {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        console.error("ccstats: --port must be a whole number between 1 and 65535.");
        process.exit(1);
      }
      a.port = n;
    }
    else if (v === "-o" || v === "--out") a.out = next();
    else if (v === "--open") a.open = true;
    else if (v === "--lan") a.lan = true;
    else if (v === "--root") a.roots.push(resolve(next()));
    else if (v === "--config") a.config = next();
    else if (v === "--init-config") a.init = true;
    else if (v.startsWith("-")) { console.error("ccstats: unknown option " + v + "\n"); a.help = true; }
    else { console.error("ccstats: unexpected argument " + JSON.stringify(v) + "\n"); a.help = true; }
  }
  // flags that quietly do nothing in the mode they were given in are worth a word
  if (a.serve && a.out) console.error("ccstats: --out is ignored with --serve.");
  if (!a.serve && a.lan) console.error("ccstats: --lan only applies to --serve.");
  return a;
}

function openInBrowser(target) {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  import("node:child_process").then(({ spawn }) => {
    try {
      spawn(process.platform === "win32" ? "cmd" : cmd, process.platform === "win32" ? args : [target],
        { detached: true, stdio: "ignore" }).unref();
    } catch { /* opening a browser is a convenience, never a failure */ }
  });
}

function describe(data) {
  const days = Object.keys(data.days).length;
  const parts = ["Scanned " + data.files.toLocaleString() + " transcript files",
                 days.toLocaleString() + " active days",
                 data.models.length + " models"];
  if (data.badLines) parts.push(data.badLines.toLocaleString() + " unparseable lines skipped");
  return parts.join(" · ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { console.log(HELP); process.exit(0); }

  if (args.init) {
    const path = args.config || join(DIR, "ccstats.config.json");
    if (existsSync(path)) { console.error("ccstats: " + path + " already exists — not overwriting."); process.exit(1); }
    writeFileSync(path, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n");
    console.log("Wrote " + path + " — edit it, then run ccstats again.");
    process.exit(0);
  }

  if (args.config) CONFIG = loadConfig(resolve(args.config));

  // An explicitly-supplied root that doesn't exist is a typo, not an empty dataset. Auto-detected
  // roots are already filtered by existsSync, so this only ever fires on --root / config "roots".
  const asked = args.roots.length ? args.roots : CONFIG.roots;
  if (asked) {
    const missing = asked.filter((p) => !existsSync(p));
    if (missing.length) {
      console.error("ccstats: these transcript folders don't exist:\n  " + missing.join("\n  "));
      process.exit(1);
    }
  }
  const roots = asked || defaultRoots();
  if (!roots.length) {
    // The single most likely first-run failure on someone else's machine. Say what we looked
    // for and how to point us at the right place, instead of throwing ENOENT.
    console.error(
      "ccstats: couldn't find any Claude Code transcripts.\n\n" +
      "Looked in:\n" +
      "  " + join(homedir(), ".claude", "projects") + "\n" +
      "  " + join(homedir(), ".config", "claude", "projects") + "\n" +
      (process.env.CLAUDE_CONFIG_DIR ? "  (and CLAUDE_CONFIG_DIR=" + process.env.CLAUDE_CONFIG_DIR + ")\n" : "") +
      "\nIf your transcripts live elsewhere:\n" +
      "  node ccstats.mjs --root /path/to/projects\n\n" +
      "If you have never run Claude Code on this machine, there is nothing to chart yet."
    );
    process.exit(1);
  }

  const build = () => buildData({ roots });

  if (args.serve) {
    const { createServer } = await import("node:http");
    const { networkInterfaces } = await import("node:os");
    const PORT = args.port || Number(process.env.PORT) || 8743;
    const HOST = args.lan ? "0.0.0.0" : "127.0.0.1";
    const TTL_MS = 15000; // rescan the transcripts at most this often

    let cache = { t: 0, data: null };
    const fresh = () => {
      const now = Date.now();
      if (!cache.data || now - cache.t > TTL_MS) cache = { t: now, data: build() };
      return cache.data;
    };

    const server = createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      if (url === "/" || url === "/ccstats.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(buildHTML(fresh()));
      } else if (url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(fresh()));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error("ccstats: port " + PORT + " is already in use. Try --port " + (PORT + 1) + ".");
        process.exit(1);
      }
      throw e;
    });

    server.listen(PORT, HOST, () => {
      const data = fresh();
      const local = "http://localhost:" + PORT + "/";
      console.log("ccstats live · " + describe(data));
      console.log("  " + local);
      if (args.lan) {
        // Opt-in only: anyone on the same network can read the dashboard while this runs.
        Object.values(networkInterfaces()).flat()
          .filter((i) => i && i.family === "IPv4" && !i.internal)
          .forEach((i) => console.log("  http://" + i.address + ":" + PORT + "/  (LAN)"));
        console.log("\n  --lan is on: any device on your network can open this. Ctrl+C to stop.");
      }
      if (args.open) openInBrowser(local);
    });
  } else {
    const out = args.out ? resolve(args.out) : join(DIR, "ccstats.html");
    const data = build();
    writeFileSync(out, buildHTML(data));
    console.log(describe(data) + "\n-> " + out);
    if (!Object.keys(data.days).length) {
      console.log("\nNo usage found in those transcripts yet — the page will say so too.");
    }
    if (args.open) openInBrowser(pathToFileURL(out).href);
  }
}
