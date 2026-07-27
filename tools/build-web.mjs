// Builds public/ — the static site that Vercel (or any file host) serves.
//
//   node tools/build-web.mjs
//
// The site is the same dashboard, with the one job the CLI does for you handed back: finding the
// transcripts. You point the browser at the folder, the browser parses it, and the page is built
// in the tab. Nothing is uploaded, so there is nothing to deploy but static files — no functions,
// no runtime, no environment variables.
//
// Three pieces come out of this:
//   index.html          the drop zone (web/index.html + fonts + the parse loop)
//   dashboard.tpl.html  the dashboard with __DATA__ still a placeholder
//   demo.html           the fabricated-data page, so the site has something to show
//
// The parse loop is *lifted* out of ccstats.mjs with Function.prototype.toString() rather than
// reimplemented. That is the whole trick: there is exactly one copy of the counting logic, and
// the browser runs it character for character. The catch is that a lifted function silently
// loses its module scope, so the checks at the bottom compile it in an empty scope and run it
// against the CLI to prove the two still agree before anything is written.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildShell, createCollector } from "../ccstats.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const repo = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
// owner/name, for the `npx github:owner/name` install line. Derived rather than written out
// again so the page cannot drift from the repository field above it.
const slug = repo.replace(/^https?:\/\/github\.com\//, "");

let failed = false;
const check = (label, ok, detail) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failed = true;
};
const die = (msg) => { console.error("build-web: " + msg); process.exit(1); };

// ---------------------------------------------------------------------------
// 1. the dashboard shell
// ---------------------------------------------------------------------------
let shell = buildShell();

if ((shell.match(/__DATA__/g) || []).length !== 1) {
  die("expected exactly one __DATA__ placeholder in the shell — the template changed shape");
}
if (shell.includes("__FONTS__")) die("fonts were not inlined into the shell");

// The dashboard polls data.json every minute so that `--serve` can push fresh numbers at it. On
// a static host that file does not exist, so the poll is a 404 every minute forever. Drop it —
// and assert the anchor first, so this fails at build time rather than quietly doing nothing if
// the live-mode code is ever reworked.
const POLL = "setInterval(pollLive, 60000);";
if (!shell.includes(POLL)) die("could not find the live-poll timer to strip — update POLL in tools/build-web.mjs");
shell = shell.replace(
  POLL,
  "/* live polling removed by tools/build-web.mjs: there is no server behind the static site */"
);

// Two pages come out of the one shell.
//
// dashboard.html is what people actually look at. Its payload is read from sessionStorage, which
// the landing page fills in just before navigating — a real page load, not a document rewritten
// in place. The obvious shortcut (parse, then document.write the finished page over the picker)
// renders a half-built dashboard: the written document runs the script but never completes the
// deferred work the page does after first paint, so the splash never lifts. A navigation to a
// static URL behaves exactly like opening the file the CLI writes, because it is the same thing.
//
// dashboard.tpl.html keeps __DATA__ intact and is only fetched when someone asks to download
// their dashboard as a file — that path has to bake the numbers in, the way the CLI does.
const STORE_KEY = "ccstats:data";
const EMPTY = JSON.stringify({
  generatedAt: "", files: 0, lines: 0, badLines: 0, roots: 0, models: [],
  config: { accent: null, lang: null, theme: null, currency: null, pricing: null, modelNames: null },
  days: {},
});
const dashboard = shell.replace("__DATA__", () => `(function () {
  var raw = null;
  try { raw = sessionStorage.getItem(${JSON.stringify(STORE_KEY)}); } catch (e) {}
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  // Opened directly, or reloaded after the tab's session store was cleared. There is nothing to
  // draw and no way to get it from here, so hand back to the picker instead of showing an empty
  // dashboard that looks like a bug. The payload below just keeps render() alive until we go.
  location.replace("./");
  return ${EMPTY};
})()`);

// ---------------------------------------------------------------------------
// 2. the landing page
// ---------------------------------------------------------------------------
const collectorSrc = createCollector.toString();
const page = readFileSync(join(ROOT, "web", "index.html"), "utf8")
  .replace("__FONTS__", () => readFileSync(join(ROOT, "geist-fonts.css"), "utf8"))
  .replace("__COLLECTOR__", () => collectorSrc)
  .replace(/__REPOSLUG__/g, () => slug)
  .replace(/__REPO__/g, () => repo)
  .replace(/__VERSION__/g, () => pkg.version);

for (const left of ["__FONTS__", "__COLLECTOR__", "__REPO__", "__REPOSLUG__", "__VERSION__"]) {
  if (page.includes(left)) die("placeholder " + left + " survived into the built page");
}

// ---------------------------------------------------------------------------
// 3. write it out
// ---------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.html"), page);
writeFileSync(join(OUT, "dashboard.html"), dashboard);
writeFileSync(join(OUT, "dashboard.tpl.html"), shell);

// Regenerated rather than copied from the repo root: a committed demo.html can be out of date
// with the template it is supposed to be demonstrating, and this is cheap and deterministic.
const demo = spawnSync(process.execPath, [join(ROOT, "tools", "demo.mjs"), "-o", join(OUT, "demo.html")],
  { encoding: "utf8" });
if (demo.status !== 0) {
  console.error(demo.stdout, demo.stderr);
  die("could not build the demo page");
}

// ---------------------------------------------------------------------------
// 4. checks
// ---------------------------------------------------------------------------
console.log("");

// The one that matters. new Function compiles in the global scope with none of ccstats.mjs's
// module bindings in reach — exactly the environment the browser gives it. If the parse loop
// ever grows a reference to something defined outside itself, this throws here instead of
// throwing in a stranger's tab.
let lifted;
try {
  lifted = new Function("return (" + collectorSrc + ")")();
} catch (e) {
  check("lifted collector compiles standalone", false, e.message);
  process.exit(1);
}

const SAMPLE = (() => {
  const out = [];
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 6; i++) {
      const ts = new Date(Date.UTC(2026, 0, 5 + d, 9 + i, 15)).toISOString();
      const model = ["claude-opus-5", "claude-sonnet-4-6"][i % 2];
      out.push(JSON.stringify({ type: "user", timestamp: ts, uuid: "u" + d + i, sessionId: "s" + d }));
      out.push(JSON.stringify({
        type: "assistant", timestamp: ts, uuid: "a" + d + i, sessionId: "s" + d, requestId: "r" + d + i,
        message: { id: "m" + d + i, model, usage: {
          input_tokens: 1000, output_tokens: 500,
          cache_creation_input_tokens: 2000, cache_read_input_tokens: 40000,
          cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
        } },
      }));
    }
  }
  out.push("{ not json");            // the bad-line path
  return out.join("\n") + "\n";
})();

const runOn = (factory) => {
  const c = factory({ hashSessions: true });
  c.addFile("session.jsonl", SAMPLE);
  c.skipFile();
  const r = c.result({ roots: 1, config: null });
  delete r.generatedAt; // wall clock — the only field that legitimately differs between runs
  return r;
};

let liftedOut, nativeOut;
try {
  liftedOut = runOn(lifted);
  nativeOut = runOn(createCollector);
} catch (e) {
  check("lifted collector runs standalone", false, e.message);
  process.exit(1);
}
// Reaching here at all is the result: both calls above compile in an empty scope and complete.
check("lifted collector compiles and runs with no module scope", true);
check("lifted collector agrees with the CLI byte for byte",
  JSON.stringify(liftedOut) === JSON.stringify(nativeOut));
check("sample actually exercised the parser",
  Object.keys(nativeOut.days).length === 3 && nativeOut.badLines === 1 && nativeOut.files === 2,
  Object.keys(nativeOut.days).length + " days, " + nativeOut.badLines + " bad, " + nativeOut.files + " files");
check("session ids are hashed in the browser path too", !JSON.stringify(liftedOut).includes("s0"));

// No page here may pull anything off the network: that is the product claim, and a stray CDN
// link would break it silently. Anchors are exempt — the GitHub link is a navigation the reader
// chooses, not a resource the page loads.
const loadsRemote = (html) =>
  /<script[^>]+src=|<link[^>]+href="(?!data:)|<img[^>]+src="(?!data:)|@import|url\(\s*['"]?https?:/i.test(html);
check("landing page loads nothing remote", !loadsRemote(page));
check("dashboard shell loads nothing remote", !loadsRemote(shell));
check("fonts inlined in both", (page.match(/@font-face/g) || []).length >= 2 && /@font-face/.test(shell));
check("no live-poll timer left in the shell", !shell.includes(POLL));
check("GitHub link present in the footer", page.includes('class="ghbig" href="' + repo + '"'));
check("feedback opens the repo's issue form, not a form post",
  page.includes(repo + "/issues/new") && !/<form/i.test(page));
// This package is not on the npm registry, so `npx <name>` 404s. The site shipped that command
// once; this keeps it from coming back the next time someone tidies the install line.
check("install command does not point at the unpublished npm name",
  page.includes("npx github:" + slug) && !new RegExp("npx\\s+" + pkg.name + "\\b").test(page));
check("dashboard carries the feedback action", shell.includes('data-act="feedback"'));
check("dashboard reads its payload from the session store",
  dashboard.includes(JSON.stringify(STORE_KEY)) && !dashboard.includes("__DATA__"));
check("landing page and dashboard agree on the store key", page.includes(JSON.stringify(STORE_KEY)));
check("download template still has its placeholder", (shell.match(/__DATA__/g) || []).length === 1);

const demoHtml = readFileSync(join(OUT, "demo.html"), "utf8");
check("demo page built", demoHtml.length > 100_000, Math.round(demoHtml.length / 1024) + " KB");

const kb = (s) => Math.round(s.length / 1024) + " KB";
console.log(
  "\n-> " + OUT +
  "\n   index.html          " + kb(page) +
  "\n   dashboard.html      " + kb(dashboard) +
  "\n   dashboard.tpl.html  " + kb(shell) +
  "\n   demo.html           " + kb(demoHtml)
);
if (failed) process.exit(1);
