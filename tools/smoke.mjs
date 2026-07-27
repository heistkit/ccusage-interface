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

// How each request was served. The fourth entry omits both fields on purpose: transcripts
// written before Claude Code recorded them are a real and common case, and any code that prices
// by serving mode has to have an answer for traffic it cannot classify.
const SERVING = [
  { speed: "fast", service_tier: "standard" },
  { service_tier: "batch" },
  { service_tier: "priority" },
  null,
  {}, { }, { }, { },
].map((s) => (s === null ? null : { speed: "standard", service_tier: "standard", ...s }));

const lines = [];
let n = 0;
for (let d = 0; d < DAYS; d++) {
  for (let i = 0; i < PER_DAY; i++) {
    // fixed clock: a smoke test that changes shape by the hour is not a smoke test
    const ts = new Date(Date.UTC(2026, 0, 5 + d, 9 + (i % 6), 30)).toISOString();
    const model = MODELS[i % MODELS.length];
    // One session deliberately spans all three days. Sessions are keyed independently of the
    // day buckets they touch, and a fixture where every session lives inside one day would let
    // a per-session rollup that silently drops the boundary case pass.
    const sess = i === 0 ? "sess-spanning" : "sess-" + d;
    const serving = SERVING[i % SERVING.length];
    // cwd is present in real transcripts and is exactly the field the privacy promise is about.
    // It is the sandbox path here, which turns the leaked-path assertion below into a real
    // negative control: if project reading ever becomes the default, this fixture fails loudly.
    lines.push(JSON.stringify({ type: "user", timestamp: ts, uuid: "u" + n, sessionId: sess, cwd: roots }));
    lines.push(JSON.stringify({
      type: "assistant", timestamp: ts, uuid: "a" + n, sessionId: sess, requestId: "req" + n, cwd: roots,
      message: { id: "msg" + n, model, usage: { ...PER_MSG, ...(serving || {}) } },
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
check("no external references", !/(src|href)="(?!#)(https?:|\/\/)/.test(html));

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

  // Every counted usage record lands in exactly one serving bucket, so the serving buckets must
  // reproduce the model totals exactly. This is the invariant that anything pricing by serving
  // mode depends on: if the two ever disagree, a figure on the page is double-counting or
  // dropping traffic, and a bucket total that merely looks plausible would hide it.
  const spArrays = Object.values(data.days).flatMap((d) => Object.values(d.sp || {}).flatMap((b) => Object.values(b)));
  const spTally = (idx) => spArrays.reduce((t, a) => t + (a[idx] || 0), 0);
  const FIELDS = ["i", "o", "cw", "cr", "c1h"];
  const mismatched = FIELDS.filter((f, idx) => spTally(idx) !== tally(f));
  check("serving buckets reproduce the model totals", mismatched.length === 0,
    mismatched.length ? mismatched.map((f) => f + ": " + spTally(FIELDS.indexOf(f)) + " vs " + tally(f)).join(", ")
                      : FIELDS.map((f, idx) => f + " " + spTally(idx)).join(", "));
  check("serving buckets account for every message", spTally(5) === MSGS, spTally(5) + " vs " + MSGS);

  // The fixture serves one message per day as Fast Mode, one via Batch, one via Priority, and
  // one with the fields absent entirely. All four have to survive into the payload, or the
  // how-it-was-served card is being tested against traffic that is uniformly standard.
  const spKeys = new Set(Object.values(data.days).flatMap((d) => Object.keys(d.sp || {})));
  check("every serving mode in the fixture survived",
    ["fast|standard", "standard|batch", "standard|priority", "unknown|unknown", "standard|standard"]
      .every((k) => spKeys.has(k)), [...spKeys].join(", "));

  // A session that spans day boundaries is the case a per-day rollup gets wrong, so assert the
  // fixture really produced one: the same hash has to appear under all three days.
  const spanning = [...new Set(Object.values(data.days)[0].sessions)]
    .filter((s) => Object.values(data.days).every((d) => d.sessions.includes(s)));
  check("a session spans every day in the fixture", spanning.length === 1, spanning.join(", ") || "none");

  // The per-session bucket is keyed globally while every other bucket is keyed by day, so the two
  // can drift apart without anything else noticing. These invariants are what say they have not:
  // the sessions must account for exactly the same tokens and exactly the same billed requests as
  // the day buckets do, no more and no less.
  const sess = data.sessions || {};
  const sTok = [0, 0, 0, 0, 0], dTok = [0, 0, 0, 0, 0];
  let sReq = 0, spReq = 0;
  for (const s of Object.values(sess)) {
    sReq += s.req;
    for (const arr of Object.values(s.models)) for (let i = 0; i < 5; i++) sTok[i] += arr[i];
  }
  for (const d of Object.values(data.days)) {
    for (const v of Object.values(d.models)) {
      dTok[0] += v.i; dTok[1] += v.o; dTok[2] += v.cw; dTok[3] += v.cr; dTok[4] += v.c1h || 0;
    }
    for (const b of Object.values(d.sp || {})) for (const arr of Object.values(b)) spReq += arr[5];
  }
  check("session tokens reproduce the day-model totals",
    JSON.stringify(sTok) === JSON.stringify(dTok), sTok.join("/") + " vs " + dTok.join("/"));
  // req is counted inside the usage dedup guard; models[].msg is counted outside it and runs far
  // higher. Matching the serving buckets is what proves req is the deduped population.
  check("session requests match the serving-bucket requests", sReq === spReq, sReq + " vs " + spReq);

  // The spanning session must appear ONCE in the global bucket with days = 3, not once per day.
  // That is the whole reason the bucket is not nested under days.
  const multi = Object.values(sess).filter((s) => s.days > 1);
  check("the spanning session is one row covering every day",
    multi.length === 1 && multi[0].days === DAYS, multi.map((s) => s.days + "d").join(", ") || "none");
  check("session count matches the fixture",
    Object.keys(sess).length === DAYS + 1 && data.sessionsSeen === DAYS + 1,
    Object.keys(sess).length + " kept, " + data.sessionsSeen + " seen");
  // The hash is a DOM key, never a label — the raw id must not survive into the session bucket.
  check("session keys are hashed here too", !Object.keys(sess).some((k) => k.startsWith("sess-")));
}
check("csv export reaches the artifact",
  html.includes('data-act="csv"') && html.includes("cache_write_1h_tokens"));
check("no leaked absolute paths", !html.includes(box) && !/[A-Za-z]:\\Users/.test(html));

console.log("\nsandbox: " + box);
if (failed) process.exit(1);
console.log("smoke: artifact is a working dashboard");
