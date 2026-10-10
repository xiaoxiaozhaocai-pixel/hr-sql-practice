# Third-party notices

## sql.js 1.14.2

`vendor/sqljs/sql-wasm.js` and `vendor/sqljs/sql-wasm.wasm` are the
SQLite-compiled-to-WebAssembly distribution of **sql.js** (version 1.14.2),
licensed under the MIT License.

These files are vendored as-is and are inlined into the built single-file HTML
artifact by `build.mjs`.

Upstream project: <https://github.com/sql-js/sql.js>

## Runtime assets

No other third-party code, font, image, icon, or network resource is bundled
into or referenced by the built artifact. The offline single-file build is
self-contained by design; `build.mjs` runs an external-reference self-check
that must report zero hits.
