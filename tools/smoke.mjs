// Smoke-tests a built artifact against synthetic transcripts.
//
//   node tools/smoke.mjs [path-to-ccstats.mjs]   (default: dist/ccstats.mjs)
//
// Runs the real CLI over fabricated JSONL in a temp folder, then asserts the page it produced
// is actually a working dashboard: fonts inlined, data inlined, no network references, and the
// numbers add up to the tokens we fed in. Deliberately uses --root and a temp dir so it never
// touches the transcripts on the machine running it.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(ROOT, "dist", "ccstats.mjs");

const box = mkdtempSync(join(tmpdir(), "ccstats-smoke-"));
const roots = join(box, "projects", "demo-project");
mkdirSync(roots, { recursive: true });

const MODELS = ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const DAYS = 3, PER_DAY = 8;

// cache_creation_input_tokens is the TOTAL creation figure; the nested cache_creation object
// splits it into 5-minute and 1-hour tiers, and the 1-hour tier bills at 2x. So the 5m share is
// (total - 1h) and every assertion below has to account for both, or the tier that costs double
// is the one silently missing. Exercised deliberately: omitting it once already cost 16.5M
// tokens out of the copy-summary text on real data.
const CACHE_1H = 500;
const PER_MSG = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 2000,
  cache_read_input_tokens: 40000,
  cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: CACHE_1H },
};
const EXPECT_5M = PER_MSG.cache_creation_input_tokens - CACHE_1H;

const lines = [];
let n = 0;
for (let d = 0; d < DAYS; d++) {
  for (let i = 0; i < PER_DAY; i++) {
    // fixed clock: a smoke test that changes shape by the hour is not a smoke test
    const ts = new Date(Date.UTC(2026, 0, 5 + d, 9 + (i % 6), 30)).toISOString();
    const model = MODELS[i % MODELS.length];
    lines.push(JSON.stringify({ type: "user", timestamp: ts, uuid: "u" + n, sessionId: "sess-" + d }));
    lines.push(JSON.stringify({
      type: "assistant", timestamp: ts, uuid: "a" + n, sessionId: "sess-" + d, requestId: "req" + n,
      message: { id: "msg" + n, model, usage: { ...PER_MSG } },
    }));
    n++;
  }
}
writeFileSync(join(roots, "session.jsonl"), lines.join("\n") + "\n");

const outFile = join(box, "out.html");
const run = spawnSync(process.execPath, [target, "--root", join(box, "projects"), "-o", outFile], { encoding: "utf8" });
if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  console.error("smoke: the CLI exited " + run.status);
  process.exit(1);
}

const html = readFileSync(outFile, "utf8");
const MSGS = DAYS * PER_DAY;
// i + o + cache_read + (5m + 1h creation) — cache_creation_input_tokens already covers both
// creation tiers, so it is counted once, not added on top of its own split.
const expectTokens = MSGS * (
  PER_MSG.input_tokens + PER_MSG.output_tokens +
  PER_MSG.cache_read_input_tokens + PER_MSG.cache_creation_input_tokens
);

let failed = false;
const check = (label, ok, detail) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failed = true;
};

check("page was written", html.length > 50_000, Math.round(html.length / 1024) + " KB");
check("fonts inlined", (html.match(/@font-face/g) || []).length >= 2);
// Allow Vercel Analytics CDN as an expected external reference
const hasVercelAnalytics = html.includes('cdn.vercel-insights.com');
const htmlWithoutVercel = html.replace(/https:\/\/cdn\.vercel-insights\.com[^"']*/g, '');
const hasOtherExternal = /(src|href)="(?!#)(https?:|\/\/)/.test(htmlWithoutVercel);
check("no external references (except Vercel Analytics)", !hasOtherExternal && hasVercelAnalytics);

// The embedded payload is the source of truth for every number the page renders, so parse it
// and check the arithmetic rather than grepping the HTML for digits that happen to appear.
const embedded = html.match(/^const DATA = (\{.*\});$/m);
check("usage payload is embedded and parseable", !!embedded);
if (embedded) {
  const data = JSON.parse(embedded[1]);
  const days = Object.keys(data.days).sort();
  const entries = Object.values(data.days).flatMap((d) => Object.values(d.models));
  const tally = (k) => entries.reduce((t, v) => t + (v[k] || 0), 0);
  const sum = entries.reduce((t, v) => t + v.i + v.o + v.cw + v.cr + (v.c1h || 0), 0);
  const msgs = Object.values(data.days).reduce((t, d) => t + d.msgs, 0);
  const seenModels = new Set(Object.values(data.days).flatMap((d) => Object.keys(d.models)));

  check("all synthetic days present", days.length === DAYS, days.join(", "));
  check("token total matches what was fed in", sum === expectTokens, sum + " vs " + expectTokens);
  check("message count matches", msgs === MSGS * 2, msgs + " vs " + MSGS * 2);
  check("all models represented", MODELS.every((m) => seenModels.has(m)), [...seenModels].join(", "));
  check("hourly buckets populated", Object.values(data.days).every((d) => Object.keys(d.hm || {}).length > 0));
  check("session ids are hashed, not raw", !JSON.stringify(data).includes("sess-0"));

  // The 1h tier bills at 2x and lives in its own field, so it is the one most likely to be
  // dropped by a call site that just adds up the fields it remembers.
  check("5-minute cache writes split out", tally("cw") === MSGS * EXPECT_5M, tally("cw") + " vs " + MSGS * EXPECT_5M);
  check("1-hour cache writes captured separately", tally("c1h") === MSGS * CACHE_1H, tally("c1h") + " vs " + MSGS * CACHE_1H);
  check("creation tiers sum to the reported total",
    tally("cw") + tally("c1h") === MSGS * PER_MSG.cache_creation_input_tokens);
}
check("no leaked absolute paths", !html.includes(box) && !/[A-Za-z]:\\Users/.test(html));

console.log("\nsandbox: " + box);
if (failed) process.exit(1);
console.log("smoke: artifact is a working dashboard");
