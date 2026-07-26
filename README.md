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
- **Today card** — cost split by token class, a 24-bar hourly spend strip, per-model rows,
  averages per day / active hour / session / message, and a collapsible today-vs-yesterday table.
- **Heatmap + daily chart** with per-day tooltips, streaks, and a record-day marker.
- **Models tab** — a wallet card with a cost odometer, per-model token breakdowns and shares.
- **Right-click anything** to copy just that scope: a heatmap day, an hour bar, a model row, a
  stat card. Right-click the background for the whole-range summary.
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

**npm** — once the package is published:

```bash
npm install -g ccusage-interface   # then: ccstats --serve --open
```

**From source**

```bash
git clone https://github.com/heistkit/ccusage-interface
cd ccusage-interface && node ccstats.mjs --serve --open
```

Note that from source, `geist-fonts.css` must sit beside `ccstats.mjs`. Release builds inline it;
the repo build reads it off disk and falls back to system fonts without it.

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
| `-h, --help` | full help text |

Transcript location is auto-detected from `CLAUDE_CONFIG_DIR`, then `~/.claude/projects`, then
`~/.config/claude/projects`. Override with `--root` or `roots` in the config file.

## Privacy

ccstats reads **usage metadata only**: timestamps, model names, token counts, and a truncated
hash of each session id. It never reads message content, prompts, file paths, or project names.
It makes no network requests, and neither does the page it generates — fonts and data are inlined,
so the output works from `file://` and offline.

The generated `ccstats.html` does embed *your* numbers, though, so it is gitignored here. If you
share one, know that you are sharing your day-by-day token counts and estimated spend.

## Costs are estimates

Prices are hardcoded list rates per model, applied to the token counts in your transcripts.
Subscription allowances, discounts, and batch pricing are **not** modeled, so this is not a bill —
it is what the same work would cost at API list price. Override rates via `pricing` in the config
file if yours differ.

## Credits

UI components adapted from [Uiverse.io](https://uiverse.io), retokenised to this palette —
thanks to JaydipPrajapati1910, kennyotsu, Li-Deheng, mobinkakei, Na3ar-17, OliverZeros,
RiccardoRapelli, SelfMadeSystem, Uncannypotato69, and vikramsinghnegi.

Typeface is [Geist](https://vercel.com/font) by Vercel, licensed under the
[SIL Open Font License 1.1](https://openfontlicense.org/) and inlined as base64 in
`geist-fonts.css`.

## License

MIT — see [LICENSE](LICENSE). The bundled Geist font files remain under the SIL OFL 1.1.
