// Generates a dashboard from fabricated transcripts, for screenshots and for anyone who wants
// to see the thing before pointing it at their own data.
//
//   node tools/demo.mjs [-o demo.html]
//
// Deterministic: a seeded PRNG, and dates counted back from a fixed day. Two runs produce the
// same page, so a committed screenshot does not churn every time this is run.
//   --lang en|ko   force the language (default: whatever the viewer's browser prefers)
//   --seen         pre-set the "already welcomed" flag, so the first-run dialog stays closed.
//                  Wanted for screenshots; not wanted when demoing the real first-run flow.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv;
const outArg = argv.indexOf("-o");
const out = outArg > -1 ? argv[outArg + 1] : join(ROOT, "demo.html");
const langArg = argv.indexOf("--lang");
const lang = langArg > -1 ? argv[langArg + 1] : null;
const seen = argv.includes("--seen");

// mulberry32 — small, seeded, good enough for shaping fake data.
let seed = 0x9e3779b9;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => Math.floor(lo + rnd() * (hi - lo));

// Weighted so the page shows what real usage looks like: a couple of models carrying almost
// everything, and cache reads dwarfing every other token class.
const MODELS = [
  ["claude-opus-5", 46],
  ["claude-fable-5", 28],
  ["claude-sonnet-4-6", 18],
  ["claude-haiku-4-5-20251001", 8],
];
const MODEL_POOL = MODELS.flatMap(([m, w]) => Array(w).fill(m));

const DAYS = 45;
const END = new Date(Date.UTC(2026, 6, 26)); // fixed anchor keeps output stable

const box = mkdtempSync(join(tmpdir(), "ccstats-demo-"));
const projects = join(box, "projects");
const lines = [];
let n = 0;

for (let back = DAYS - 1; back >= 0; back--) {
  const d = new Date(END);
  d.setUTCDate(d.getUTCDate() - back);
  const dow = d.getUTCDay();

  // weekends quieter, a slow ramp over the period, and a couple of standout days
  let intensity = dow === 0 || dow === 6 ? 0.28 : 1;
  intensity *= 0.35 + 0.65 * ((DAYS - back) / DAYS);
  if (back === 2 || back === 9) intensity *= 2.6;
  if (back === 30 || back === 31) intensity = 0; // a gap, so the streak logic has something to show

  const turns = Math.round(intensity * between(14, 46));
  if (!turns) continue;

  const sessions = Math.max(1, Math.round(turns / between(8, 22)));
  for (let t = 0; t < turns; t++) {
    // clustered around working hours, with a late-evening second peak
    const hour = rnd() < 0.72 ? between(9, 19) : pick([20, 21, 22, 23, 0, 1]);
    const ts = new Date(d);
    ts.setUTCHours(hour, between(0, 60), between(0, 60));

    const model = pick(MODEL_POOL);
    const sess = "demo-" + back + "-" + (t % sessions);
    const inTok = between(300, 2600);
    const outTok = between(180, 2200);
    const c1h = rnd() < 0.25 ? between(2000, 26000) : 0;
    const cw5 = between(4000, 52000);
    const cr = between(60000, 900000); // the class that dominates real usage

    // How the request was served. Weighted so the demo shows what the serving-mode card is for
    // — mostly standard, a visible slice of Fast Mode, a little batched work, and a tail of old
    // turns that predate the fields entirely.
    const roll = rnd();
    const serving =
      roll < 0.72 ? { speed: "standard", service_tier: "standard" }
      : roll < 0.88 ? { speed: "fast", service_tier: "standard" }
      : roll < 0.95 ? { speed: "standard", service_tier: "batch" }
      : null;

    lines.push(JSON.stringify({ type: "user", timestamp: ts.toISOString(), uuid: "u" + n, sessionId: sess }));
    lines.push(JSON.stringify({
      type: "assistant", timestamp: ts.toISOString(), uuid: "a" + n, sessionId: sess, requestId: "r" + n,
      message: {
        id: "m" + n, model,
        usage: {
          input_tokens: inTok,
          output_tokens: outTok,
          cache_creation_input_tokens: cw5 + c1h,
          cache_read_input_tokens: cr,
          cache_creation: { ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: c1h },
          ...(serving || {}),
        },
      },
    }));
    n++;
  }
}

mkdirSync(join(projects, "demo"), { recursive: true });
writeFileSync(join(projects, "demo", "session.jsonl"), lines.join("\n") + "\n");

const args = [join(ROOT, "ccstats.mjs"), "--root", projects, "-o", out];
if (lang) {
  // the supported route: config lang wins over browser detection, loses to a saved choice —
  // and a fresh screenshot profile has no saved choice
  const cfg = join(box, "ccstats.config.json");
  writeFileSync(cfg, JSON.stringify({ lang }, null, 2));
  args.push("--config", cfg);
}

const run = spawnSync(process.execPath, args, { encoding: "utf8" });
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  process.exit(1);
}

// buildData stamps the payload with a wall-clock generatedAt, which is the one thing in this
// otherwise seeded, fixed-date page that changes between runs — so "two runs produce the same
// page" was not true, and a committed demo.html churned by one line every time it was rebuilt.
// Pin it to the same anchor the synthetic days are counted back from.
{
  const html = readFileSync(out, "utf8");
  const stamped = html.replace(
    /("generatedAt":")[^"]*(")/,
    (_, a, b) => a + END.toISOString() + b
  );
  if (stamped === html) {
    console.error("demo: no generatedAt field to pin — output would not be reproducible");
    process.exit(1);
  }
  writeFileSync(out, stamped);
}

if (seen) {
  // Injected after <body> so it runs before the app script, which reads the flag on boot. The
  // page's CSP allows 'unsafe-inline' script (it has to — the whole app is one inline block), so
  // this is not fighting the policy. Only ever applied to this throwaway page, never to a build.
  //
  // A plain localStorage.setItem is not enough: Chrome refuses storage access entirely on
  // file:// origins, so the write throws and the app then reads null and shows the dialog
  // anyway. --allow-file-access-from-files does not change this; it governs fetch/XHR, not
  // storage. So fall back to an in-memory shim that satisfies the same interface.
  const html = readFileSync(out, "utf8");
  // CSS, not a localStorage write: the dialog is a static #hello element the app unhides by
  // clearing `hidden`, and display:none beats that — no timing to get right.
  //
  // Anchored on </head>, NOT on the first "<body>". The stylesheet is inline in this document and
  // a tag name written inside a CSS comment matches first, which put an injected block in the
  // middle of a comment and let its closing tag terminate the stylesheet early — the page then
  // rendered its own CSS as visible text. Asserting the anchor is unique keeps that honest.
  const anchor = "</head>";
  const hits = html.split(anchor).length - 1;
  if (hits !== 1) {
    console.error(`demo: expected exactly one ${anchor}, found ${hits} — injection is unsafe`);
    process.exit(1);
  }
  if (!/id="hello"/.test(html)) {
    console.error("demo: no #hello dialog found — --seen needs updating");
    process.exit(1);
  }
  const tag = "<style>#hello{display:none!important}</style>";
  writeFileSync(out, html.replace(anchor, tag + anchor));
}

console.log(run.stdout.trim());
console.log(
  `${(lines.length / 2).toLocaleString()} synthetic turns over ${DAYS} days -> ${out}` +
  (lang ? `  [lang=${lang}]` : "") + (seen ? "  [first-run dialog suppressed]" : "")
);
