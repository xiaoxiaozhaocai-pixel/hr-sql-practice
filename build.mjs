/*
 * build.mjs — 把 vendor + data + src 打成单文件 dist/hr-sql-practice.html
 * ---------------------------------------------------------------------------
 * 约束：纯 fs，不 spawn 任何子进程，不引任何 npm 依赖。
 *
 * 内联技巧与易错点：
 *   1) WASM 以 base64 字符串内联，运行时用 atob 解成 ArrayBuffer 传给 initSqlJs({wasmBinary})，
 *      所以绝不走 locateFile / fetch —— file:// 双击可跑，零外部请求。
 *   2) 占位符替换一律用 split/join（字面量），不用 String.replace(pattern, value)，
 *      否则 SQL / JSON 里的 `$&`、`$1` 会被当成替换模式吃掉。
 *   3) 内联脚本里若出现 `</script` 会把 script 标签提前闭合，统一改写为 `<\/script`。
 *   4) vendor 的 sql-wasm.js 注释里有两条 github URL（无功能），构建时中性化，
 *      好让产物通过「零外链」自检；vendor 源文件本身只读、不改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(DIST_DIR, 'hr-sql-practice.html');

const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readBuffer = (rel) => fs.readFileSync(path.join(ROOT, rel));

/* 内联进 <script> 前把 </script 中性化 */
const escapeScriptClose = (s) => s.replace(/<\/script/gi, '<\\/script');

/* 字面量占位符替换；占位符缺失或重复都直接报错，避免静默打出坏产物 */
function inject(html, marker, value) {
  const parts = html.split(marker);
  if (parts.length !== 2) {
    throw new Error(`占位符 ${marker} 在模板中出现 ${parts.length - 1} 次，期望恰好 1 次`);
  }
  return parts[0] + value + parts[1];
}

function main() {
  const template = readText('src/index.html');

  /* ---- vendor：sql.js loader（注释 URL 中性化）+ wasm（base64） ---- */
  let sqlJsLoader = readText('vendor/sqljs/sql-wasm.js');
  sqlJsLoader = sqlJsLoader.split('// https://github.com/kripken/emscripten/issues/5820')
    .join('// [build] vendor comment URL removed; original reference: emscripten issue 5820');
  const wasmBase64 = readBuffer('vendor/sqljs/sql-wasm.wasm').toString('base64');

  /* ---- data：DDL / DML / 题库 / 11 表期望行数 ---- */
  const schemaSql = readText('data/schema_sqlite.sql');
  const seedSql = readText('data/seed_sqlite.sql');
  const pack = JSON.parse(readText('data/questions.json'));
  const rowcountExpected = JSON.parse(readText('data/rowcount_expected.json'));
  /* 造数意图：表中文名 / 业务角色 / 每题涉及的表，唯一权威源 docs/model-notes-v1.json */
  const modelNotes = JSON.parse(readText('docs/model-notes-v1.json'));

  if (!Array.isArray(pack.questions) || pack.questions.length === 0) {
    throw new Error('data/questions.json 里没有 questions 数组');
  }
  if (!wasmBase64) throw new Error('vendor/sqljs/sql-wasm.wasm 读出来是空的');

  const bootstrap = {
    baselineDate: (pack.db && pack.db.baseline_date) || '2026-06-30',
    schemaVersion: pack.schema_version || null,
    questionDb: pack.db || null,
    questions: pack.questions,
    modelNotes: modelNotes,
    rowcountExpected: rowcountExpected,
    schemaSql: schemaSql,
    seedSql: seedSql,
    wasmBase64: wasmBase64
  };

  /* ---- 拼装 ---- */
  let html = template;
  html = inject(html, '/*__HR_STYLE__*/', readText('src/style.css'));
  html = inject(html, '/*__HR_WASM_LOADER__*/', escapeScriptClose(sqlJsLoader));
  html = inject(html, '/*__HR_BOOTSTRAP__*/', escapeScriptClose(JSON.stringify(bootstrap)));
  html = inject(html, '/*__HR_JUDGE__*/', escapeScriptClose(readText('src/judge.js')));
  html = inject(html, '/*__HR_LEVELS__*/', escapeScriptClose(readText('src/levels.js')));
  html = inject(html, '/*__HR_TABLES__*/', escapeScriptClose(readText('src/tables.js')));
  html = inject(html, '/*__HR_DB__*/', escapeScriptClose(readText('src/db.js')));
  html = inject(html, '/*__HR_QA__*/', escapeScriptClose(readText('src/qa.js')));
  html = inject(html, '/*__HR_APP__*/', escapeScriptClose(readText('src/app.js')));

  /* ---- 自检：产物不得有任何外部请求 ----
   * 例外只有一类：页面里的普通外链标签 <a href="http(s)://…">。
   * 先把这类标签整段摘出、计数并打印目标地址，再拿「摘掉之后剩下的 HTML」跑下面 7 条检查；
   * 非 a[href] 的 http(s):// 一律仍然拦死。产物零资源请求（script/link/img/url()/@import 无外链）。 */
  const externalAnchorRe = /<a\s[^>]*href=["']https?:\/\/[^"']+["'][^>]*>/gi;
  const allowedAnchors = [];
  const htmlWithoutAnchors = html.replace(externalAnchorRe, (tag) => {
    const m = tag.match(/href=["'](https?:\/\/[^"']+)["']/i);
    allowedAnchors.push(m ? m[1] : tag);
    return '';
  });

  const checks = [
    ['http://', /http:\/\//i],
    ['https://', /https:\/\//i],
    ['<script src=', /<script[^>]*\ssrc\s*=/i],
    ['<link href=', /<link[^>]*\shref\s*=/i],
    ['<img src=', /<img[^>]*\ssrc\s*=/i],
    ['css @import', /@import\s/i],
    ['css url(//', /url\(\s*['"]?(?:https?:)?\/\//i]
  ];
  const hits = [];
  for (const [name, re] of checks) {
    const m = htmlWithoutAnchors.match(re);
    if (m) {
      hits.push(`${name} -> ${JSON.stringify(htmlWithoutAnchors.slice(Math.max(0, m.index - 40), m.index + 60))}`);
    }
  }
  if (hits.length) {
    console.error('[build] 外部引用自检失败，产物未写出：');
    for (const h of hits) console.error('  - ' + h);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, html, 'utf8');

  const bytes = fs.statSync(OUT_FILE).size;
  console.log('[build] external-reference self-check: PASS (0 resource hits)');
  console.log('[build] external a[href] allowed:', allowedAnchors.length,
    allowedAnchors.map((u) => `-> ${u}`).join(' '));
  console.log('[build] questions inlined:', pack.questions.length, '| wasm base64 chars:', wasmBase64.length);
  console.log('[build] wrote', path.relative(ROOT, OUT_FILE).replace(/\\/g, '/'), '=', bytes, 'bytes');
}

main();
