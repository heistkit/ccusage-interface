# ccusage-interface

A local usage dashboard for [Claude Code](https://claude.com/claude-code). It reads the JSONL
transcripts Claude Code already writes on your machine — the same files
[`ccusage`](https://github.com/ryoppippi/ccusage) reads — and turns them into a single
self-contained HTML page.

One file in, one file out. No dependencies, no build step, no network requests.

```bash
node ccstats.mjs           # build ccstats.html next to the script
node ccstats.mjs --serve   # live dashboard on http://127.0.0.1:8743
```

## What you get

- **Estimated API cost** per model, with cache-write (1.25×) and cache-read (0.1×) priced
  separately — cache read is usually the overwhelming majority of tokens and a large share of
  the bill, and blending it into one rate hides that.
- **A Standard / As billed switch** in the header. Standard prices everything at each model's list
  rate, which is what any two dashboards can be compared on; As billed applies the Fast Mode
  premium and the Batch discount your transcripts actually recorded, to every figure on the page.
  Traffic whose serving mode was never recorded is carried at standard rates rather than guessed
  at, so the as-billed total is a floor — and the page says what share that is.
- **What the cache saved** — the same traffic priced with no cache at all. Cache reads and writes
  are both tokens you really sent, so the counterfactual bills each at the full input rate and
  moves nothing else. It can come out negative: filling a cache costs 1.25× or 2× and only repays
  on reuse, and the card says so rather than clamping at zero.
- **Costliest sessions** — a session is the unit you actually remember, and it is the one axis the
  day and model buckets cannot express, because sessions cross midnight. Named by when they ran;
  the session id is a one-way hash and is never shown.
- **Ranges**: All / 90d / 30d / 7d / this month / last month, with a month-to-date pace line.
- **Today card** — cost split by token class, a 24-bar hourly spend strip, per-model rows,
  averages per day / active hour / session / message, and a collapsible today-vs-yesterday table.
- **Heatmap + daily chart** with per-day tooltips, streaks, and a record-day marker.
- **Models tab** — a wallet card with a cost odometer, per-model token breakdowns and shares, and
  a **how it was served** card: Fast Mode, the Batch API, and Priority Tier split out from
  standard traffic, read from `usage.speed` and `usage.service_tier` in the transcripts.
- **Right-click anything** to copy just that scope: a heatmap day, an hour bar, a model row, a
  session, a stat card. Right-click the background for the whole-range summary, or export the
  whole history as JSON (lossless) or CSV (one row per day per model, RFC 4180, no BOM).
- **Per-project spend**, off by default and opt-in only — see [Projects](#projects) below.
- English / 한국어, light / dark, and a few easter eggs.

## Install

Pick whichever is least effort. Everything needs **Node 18+** and nothing else.

**Run it without installing anything**

```bash
npx github:heistkit/ccusage-interface --serve --open
```

```bash
bunx github:heistkit/ccusage-interface --serve --open
```

**Download one file**

```bash
curl -fsSLO https://github.com/heistkit/ccusage-interface/releases/latest/download/ccstats.mjs
node ccstats.mjs --serve --open
```

**Double-click, no terminal** — grab `ccstats-<version>.zip` from
[Releases](https://github.com/heistkit/ccusage-interface/releases), then double-click
`ccstats.cmd` (Windows) or `ccstats.command` (macOS). Both also work as normal CLIs if you pass
arguments.

**Scoop** (Windows) — installs straight from the release, no bucket to add:

```powershell
scoop install https://github.com/heistkit/ccusage-interface/releases/latest/download/ccstats.json
```

**Homebrew** — every release ships a `ccstats.rb` formula with that release's checksum. Drop it
into a tap repo as `Formula/ccstats.rb` and `brew install <yourtap>/ccstats`.

**npm** — not published. Use `npx` above; it needs nothing installed either.

**From source**

```bash
git clone https://github.com/heistkit/ccusage-interface
cd ccusage-interface && node ccstats.mjs --serve --open
```

Note that from source, `geist-fonts.css` must sit beside `ccstats.mjs`. Release builds inline it;
the repo build reads it off disk and falls back to system fonts without it.

## Run it in a browser instead (Vercel)

The same dashboard, with the one job the CLI does for you handed back: finding the transcripts.
You point the browser at your `projects` folder, the browser parses it, and the page is built in
the tab. **Nothing is uploaded** — there is no server to upload to. The deploy is static files
only: no serverless functions, no runtime, no environment variables.

```bash
npm run build:web      # -> public/
```

Deploying to Vercel needs no configuration beyond the committed `vercel.json` — import the repo
and it runs `build:web` and serves `public/`. The same output works on any static host.

| File | |
|---|---|
| `public/index.html` | the drop zone: folder picker, drag-and-drop, and the parse loop lifted out of `ccstats.mjs` |
| `public/dashboard.html` | the dashboard; reads its payload from the tab's `sessionStorage` |
| `public/dashboard.tpl.html` | the same page with `__DATA__` intact, fetched only when you ask to download your dashboard as a file |
| `public/demo.html` | the fabricated-data page |

The browser runs the **same** counting code as the CLI: `tools/build-web.mjs` lifts
`createCollector()` out of `ccstats.mjs` with `Function.prototype.toString()` rather than
reimplementing it, then compiles it in an empty scope and asserts it agrees with the CLI byte for
byte before writing anything. There is exactly one copy of the parse loop.

## Requirements

Node 18 or newer. That's it. No install step, no dependencies, no network access — not from the
tool, and not from the page it generates.

## Usage

```
node ccstats.mjs                 build ccstats.html next to this script
node ccstats.mjs --serve         live dashboard, rescans as you work
node ccstats.mjs --serve --open  ...and open it in your browser
```

| Option | |
|---|---|
| `-s, --serve` | run a local server instead of writing a file |
| `-p, --port <n>` | port for `--serve` (default 8743) |
| `-o, --out <path>` | output path for the static build |
| `--open` | open the result in your default browser |
| `--lan` | with `--serve`, also accept connections from your network (default is localhost only) |
| `--root <path>` | transcript folder to scan; repeatable |
| `--config <path>` | JSON config file (default `ccstats.config.json` beside the script) |
| `--init-config` | write a commented starter config and exit |
| `--projects` | break usage down by project folder name — **off by default**, read [Projects](#projects) first |
| `-h, --help` | full help text |

Transcript location is auto-detected from `CLAUDE_CONFIG_DIR`, then `~/.claude/projects`, then
`~/.config/claude/projects`. Override with `--root` or `roots` in the config file.

## Projects

`--projects` is the one option that changes what the tool is willing to put in a file, so it is
off by default and it fails closed.

**Without it**, no project information of any kind reaches the output. The field is not empty, it
is not there at all, and nothing reads the working directory. That is the difference that lets
someone reading an exported payload tell "this build did not collect projects" from "it did and
found none".

**With it**, ccstats reads the `cwd` on each transcript record and keeps the **last path segment
only** — the project folder's own name. `/Users/you/work/acme-billing` becomes `acme-billing`. The
directories above it are never read into the page, so your directory layout does not travel with
the file. Bucket ids are ordinals (`p0`, `p1`), never hashes of the path: a hash would be derived
from the exact string this is meant to keep out of the file, and with the folder name printed in
plain text beside it, anyone who could guess the parent directories could confirm them against it.

Be clear about what a folder name still gives away. It is often the name of a client, an employer,
an unannounced product, or an acquisition, and the page prints it next to what you spent there.
**And one case the rule does not protect:** if you ran Claude Code straight from your home
directory, the last segment *is* your username; a drive root lands as `C:`. A page built this way
says so in its header, so you can tell before you share it — but check the list first.

## Privacy

ccstats reads **usage metadata only**: timestamps, model names, token counts, and a truncated
hash of each session id. Message content and prompts are never read, at any setting. Nothing
identifying your projects reaches the output unless you pass `--projects` — see above. It makes no
network requests, and neither does the page it generates — fonts and data are inlined, so the
output works from `file://` and offline.

The generated `ccstats.html` does embed *your* numbers, though, so it is gitignored here. If you
share one, know that you are sharing your day-by-day token counts and estimated spend.

The hosted version holds to the same line. Your files are read by the browser itself, the page
declares `default-src 'none'` with no outbound channel, and the deploy has no backend to receive
anything — so you can confirm it in the network tab rather than take our word for it. The
*Send feedback* action is a link, not a submission: it opens GitHub's issue form with a template
already in it, and the report exists only once you have read it over and pressed submit there.

## Costs are estimates

Prices are hardcoded list rates per model, applied to the token counts in your transcripts.
Subscription allowances and negotiated discounts are **not** modeled, so this is not a bill — it
is what the same work would cost at API list price. Override rates via `pricing` in the config
file if yours differ.

Which rates apply is your choice, in the header. **Standard** prices every figure at each model's
list rate. **As billed** applies the Fast Mode premium (2×) and the Batch API discount (0.5×) that
your transcripts recorded, to every figure on the page — headline, cards, hourly strip, model
rows, tooltips, copied text and the CSV. Priority Tier has no published flat multiplier, so it
gets its own row but is costed at standard rates rather than being given an invented number, and
requests whose serving mode was never recorded are carried at standard rates rather than assumed
to be standard. Both of those make the as-billed total a floor, which the page states wherever it
shows one.

Token counts never move between modes. A billing multiplier inside a token count would be a
fabrication, so the heatmap, the daily chart and the wallet donut are identical in both.

## Credits

UI components adapted from [Uiverse.io](https://uiverse.io), retokenised to this palette —
thanks to JaydipPrajapati1910, kennyotsu, Li-Deheng, mobinkakei, Na3ar-17, OliverZeros,
RiccardoRapelli, SelfMadeSystem, Uncannypotato69, and vikramsinghnegi.

Typeface is [Geist](https://vercel.com/font) by Vercel, licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org/) and inlined as base64 in
`geist-fonts.css`.

## License

MIT — see [LICENSE](LICENSE). The bundled Geist font files remain under the SIL OFL 1.1.
