// Builds dist/ccstats.mjs — the release artifact: ONE file, fonts baked in, nothing beside it.
//
// The repo version reads geist-fonts.css off disk at startup and silently falls back to system
// fonts if it is missing. That is right for development and wrong for a download: a two-file
// release means anyone who grabs only the .mjs gets a page that looks subtly wrong, with no
// error to tell them why. So the release inlines the CSS and stops depending on the file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "ccstats.mjs"), "utf8");
const css = readFileSync(join(ROOT, "geist-fonts.css"), "utf8");

// Tolerates CRLF: .gitattributes normalises to LF in the repo, but a Windows working copy has
// CRLF on disk, and a literal "\n" needle would silently fail to match there.
const FONT_LOAD =
  /let FONTS = "";\r?\ntry \{ FONTS = readFileSync\(join\(DIR, "geist-fonts\.css"\), "utf8"\); \} catch \{\}/;

if (!FONT_LOAD.test(src)) {
  console.error(
    "bundle: could not find the font-loading block in ccstats.mjs.\n" +
    "It was refactored — update FONT_LOAD in tools/bundle.mjs to match."
  );
  process.exit(1);
}

// JSON.stringify, not a template literal. The CSS carries single quotes, and the file it is
// being spliced into is full of String.raw templates — a double-quoted escaped literal is the
// one form that cannot interact with either.
const bundled = src.replace(
  FONT_LOAD,
  "// fonts inlined by tools/bundle.mjs — this build needs no files beside it\n" +
  "const FONTS = " + JSON.stringify(css) + ";"
);

mkdirSync(join(ROOT, "dist"), { recursive: true });
const out = join(ROOT, "dist", "ccstats.mjs");
writeFileSync(out, bundled);

// Verify rather than assume: a release artifact that does not parse, or that quietly lost the
// font payload, is worse than no release at all.
// `node --check` on the written file, not new Function() on the string — this is an ES module,
// so import.meta and top-level import make the Function constructor throw on valid input.
let failed = false;
const check = (label, ok) => {
  console.log((ok ? "  ok   " : "  FAIL ") + label);
  if (!ok) failed = true;
};
const parsed = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
check("output parses as a module", parsed.status === 0);
if (parsed.status !== 0) console.error(parsed.stderr.trim());
check("font payload embedded", bundled.includes("@font-face") && bundled.length > src.length);
check("no residual disk read for the font file", !/readFileSync\(join\(DIR, "geist-fonts/.test(bundled));

console.log(`\n-> ${out}  (${(bundled.length / 1024).toFixed(0)} KB)`);
if (failed) process.exit(1);
