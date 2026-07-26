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
const PER_MSG = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 40000 };
const DAYS = 3, PER_DAY = 8;

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
const expectTokens = DAYS * PER_DAY * Object.values(PER_MSG).reduce((a, b) => a + b, 0);

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
  const sum = Object.values(data.days)
    .flatMap((d) => Object.values(d.models))
    .reduce((t, v) => t + v.i + v.o + v.cw + v.cr, 0);
  const msgs = Object.values(data.days).reduce((t, d) => t + d.msgs, 0);
  const seenModels = new Set(Object.values(data.days).flatMap((d) => Object.keys(d.models)));

  check("all synthetic days present", days.length === DAYS, days.join(", "));
  check("token total matches what was fed in", sum === expectTokens, sum + " vs " + expectTokens);
  check("message count matches", msgs === DAYS * PER_DAY * 2, msgs + " vs " + DAYS * PER_DAY * 2);
  check("all models represented", MODELS.every((m) => seenModels.has(m)), [...seenModels].join(", "));
  check("hourly buckets populated", Object.values(data.days).every((d) => Object.keys(d.hm || {}).length > 0));
  check("session ids are hashed, not raw", !JSON.stringify(data).includes("sess-0"));
}
check("no leaked absolute paths", !html.includes(box) && !/[A-Za-z]:\\Users/.test(html));

console.log("\nsandbox: " + box);
if (failed) process.exit(1);
console.log("smoke: artifact is a working dashboard");
