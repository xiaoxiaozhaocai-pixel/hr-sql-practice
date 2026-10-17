/*
 * test/repo-face.test.mjs — 「对外第一印象」守门单测
 * 运行：node --test test/repo-face.test.mjs
 *
 * 锁住三条对外口径（本单 Q2 交付）：
 *   1) README 首屏（前 30 行）对外可读：在线地址 + 四条关键事实（120 题/6 段、双方言、单文件离线、MIT）。
 *   2) README.en.md 存在且与中文版互链；README 里的图片引用全部是相对路径（禁图床 / 徽章服务）。
 *   3) 构建产物里 a[href] 的 http(s) 链接只有仓库地址这一个；产物不存在 script/link/img 外链。
 *
 * 注意：本测试直接读仓库根的真实文件，不 spawn 子进程；需先跑过 node build.mjs 让产物含页脚入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const REPO_URL = 'https://github.com/xiaoxiaozhaocai-pixel/hr-sql-practice';
const SITE_URL = 'https://hr-sql.page.coze.site';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readLines = (rel, n) => read(rel).split(/\r?\n/).slice(0, n).join('\n');

const readmeZh = read('README.md');
const readmeEn = read('README.en.md');
const product = read('dist/hr-sql-practice.html');

test('readme_first_30_lines_are_external_facing', () => {
  const screen = readLines('README.md', 30);
  assert.ok(screen.includes(SITE_URL), '首屏应含在线体验地址');
  assert.match(screen, /120\s*题/, '首屏应含 120 题');
  assert.match(screen, /6\s*段/, '首屏应含 6 段');
  assert.match(screen, /T-SQL/, '首屏应含 T-SQL');
  assert.match(screen, /SQLite/, '首屏应含 SQLite');
  assert.match(screen, /离线/, '首屏应含「离线」');
  assert.match(screen, /零依赖零后端/, '首屏应含「零依赖零后端」');
  assert.match(screen, /MIT/, '首屏应含 MIT');
});

test('readme_keeps_engineering_sections_after_external_part', () => {
  for (const heading of [
    '## 1. 怎么用',
    '## 2. 目录结构',
    '## 3. 怎么加题 / 加关',
    '## 4. 引擎依赖来自哪里',
    '## 5. build.mjs 做了什么',
    '## 6. 方言与判题口径',
    '## 7. 已知限制',
    '## 8. 口径裁定与待定点',
    '## 9. 许可'
  ]) {
    assert.ok(readmeZh.includes(heading), `原工程章节不得删除：${heading}`);
    assert.ok(readmeZh.indexOf(heading) > readmeZh.indexOf('## 快速上手'),
      `工程章节应下移到对外首屏之后：${heading}`);
  }
});

test('readme_en_exists_and_cross_links_chinese', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'README.en.md')), 'README.en.md 应存在');
  assert.match(readmeEn, /\]\(README\.md\)/, '英文版应链接中文版');
  assert.match(readmeZh, /\]\(README\.en\.md\)/, '中文版应链接英文版');
});

test('readme_english_covers_external_skeleton', () => {
  for (const heading of ['## What it is', '## Try it online', '## Key facts', '## Quick start', '## License']) {
    assert.ok(readmeEn.includes(heading), `英文版应含章节：${heading}`);
  }
  assert.ok(readmeEn.includes(SITE_URL) && readmeEn.includes(REPO_URL));
});

test('readme_images_are_relative_paths_only', () => {
  const imgs = [...readmeZh.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 3, `README 应引用至少 3 张图，实际 ${imgs.length}`);
  for (const src of imgs) {
    assert.ok(!/^https?:\/\//i.test(src), `禁止外链图床/徽章：${src}`);
    assert.ok(!src.startsWith('//'), `禁止协议相对外链：${src}`);
    assert.equal(src, src.trim());
  }
  for (const name of ['docs/images/overview-1280.png', 'docs/images/overview-375.png', 'docs/images/qa-panel-1280.png']) {
    assert.ok(imgs.includes(name), `README 应引用 ${name}`);
  }
  for (const src of imgs) {
    assert.ok(fs.existsSync(path.join(ROOT, src)), `README 引用的图片必须真实存在于仓库：${src}`);
  }
  const html = readmeZh;
  assert.ok(!/shields\.io/i.test(html), '禁止 shields.io 徽章');
  assert.ok(!/img\.shields/i.test(html), '禁止 shields 图床');
});

test('product_has_exactly_one_external_anchor_and_it_is_the_repo', () => {
  const hrefs = [...product.matchAll(/<a\s[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi)].map((m) => m[1]);
  assert.deepEqual(hrefs, [REPO_URL], `产物外链 a[href] 应只有仓库地址，实际 ${JSON.stringify(hrefs)}`);
  assert.match(product, /target="_blank"/, '仓库入口应新窗口打开');
  assert.match(product, /rel="noopener"/, '仓库入口应带 rel=noopener');
});

test('product_has_no_external_resource_requests', () => {
  for (const [name, re] of [
    ['script src', /<script[^>]*\ssrc\s*=/i],
    ['link href', /<link[^>]*\shref\s*=/i],
    ['img src', /<img[^>]*\ssrc\s*=/i],
    ['css @import', /@import\s/i],
    ['css url(//', /url\(\s*['"]?(?:https?:)?\/\//i]
  ]) {
    assert.ok(!re.test(product), `产物不得有外链资源：${name}`);
  }
});

/* 2026-10-17 补：在线入口标签页文案守门。
 * 背景：10-10 v6 曾把部署目录的 title 从「离线单文件」改成「题库 v1.0」，
 * 但当时只改了部署产物、源码 src/index.html 未同步，回灌后又退回旧文案。
 * 教训＝同一件事只许一个来源：title 只能来自 src/index.html，且必须与页面 brand 一致。 */
test('product_title_is_online_facing_and_matches_brand', () => {
  const srcTitle = (read('src/index.html').match(/<title>([^<]*)<\/title>/i) || [])[1];
  const distTitle = (product.match(/<title>([^<]*)<\/title>/i) || [])[1];
  assert.ok(srcTitle, 'src/index.html 应有 title');
  assert.equal(distTitle, srcTitle, '产物 title 必须与源码一致（build.mjs 不得改写 title）');
  assert.ok(!/离线单文件/.test(srcTitle), `在线入口标签页不得出现「离线单文件」：${srcTitle}`);

  const brand = (read('src/index.html').match(/<div class="brand">([^<]*)/i) || [])[1];
  assert.ok(brand, '页内应有 brand 文案');
  assert.ok(srcTitle.startsWith(brand.trim()), `title 应以页内 brand 开头，brand=${brand}，title=${srcTitle}`);
});
