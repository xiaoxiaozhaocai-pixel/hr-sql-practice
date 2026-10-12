# DB Quest v2 — Offline Single-File HR SQL Practice

**English** ｜ [中文](README.md)

## What it is

A gamified SQL practice page for the HR domain, shipped as **one offline HTML file**.
It packs the database schema, seed data, **120 exercises**, the SQL judge and the quest UI into a single
`dist/hr-sql-practice.html`. Double-click to play — no install, no backend, no dependencies, works from `file://`.

Every exercise is given in **two dialects side by side**: the authoritative **SQL Server (T-SQL)** form and the
**SQLite** form that actually runs in the browser.

## Try it online

<https://hr-sql.page.coze.site> — no sign-up, no install.

## Key facts

| Fact | Detail |
| --- | --- |
| **120 exercises · 6 sections** | Grouped by the `section` field, ordered by `seq` within a section |
| **T-SQL ↔ SQLite side by side** | Authoritative SQL Server form + runnable SQLite form for every question |
| **Single-file, offline, zero dependency, zero backend** | One ~1.9 MB HTML file, double-click to run, works over `file://` |
| **MIT** | Open source; the inlined sql.js 1.14.2 is MIT as well |

All data is **fictional sample data** (a made-up HRIS with 11 tables, 3 views and ~4,842 rows) with **no relation
whatsoever to any real organization, system or person**.

## Quick start

1. **Play online** — open <https://hr-sql.page.coze.site>.
2. **Play offline** — grab [`dist/hr-sql-practice.html`](dist/hr-sql-practice.html) and double-click it
   (any recent Chrome / Edge / Firefox).
3. **Stuck?** Open the built-in **"Ask" (问一问)** panel inside the page — a fully local Q&A panel, no network.

## Screenshots

| Desktop overview | Mobile portrait |
| --- | --- |
| ![Desktop overview: six-section level list on the left, question and SQL editor in the middle, result table on the right](docs/images/overview-1280.png) | ![Mobile portrait: the level list collapses into a top drawer](docs/images/overview-375.png) |

![The local "Ask" panel expanded](docs/images/qa-panel-1280.png)

*The local "Ask" panel: answers from the inlined exercise data and syntax cards, with no network access.*

## Source code

<https://github.com/xiaoxiaozhaocai-pixel/hr-sql-practice>

`node build.mjs` rebuilds the single file; `npm test` runs the unit tests; `npm run verify` re-checks all 120
reference queries against a freshly rebuilt database. See the [Chinese README](README.md) for the full
engineering notes (build pipeline, judging rules, dialect mapping, known limits).

## License

MIT — see [LICENSE](LICENSE). The inlined sql.js 1.14.2 distribution is MIT as well.
