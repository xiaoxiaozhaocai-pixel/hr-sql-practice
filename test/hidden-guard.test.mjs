/*
 * test/hidden-guard.test.mjs — [hidden] 显隐守卫护栏
 * 运行：node --test test/hidden-guard.test.mjs
 *
 * 背景（线上 version 16 实测）：#next-action 带 hidden 属性，但 .next-action 的
 * 显式 display:flex 压掉了 UA 样式表的 [hidden]{display:none}，容器仍以 flex 渲染，
 * 其内未带 hidden 的空文本主按钮被一并显形（32×16 空红按钮）。
 *
 * 本测试机检同类隐患：src/index.html 中所有带 hidden 属性的元素，若在 src/style.css
 * 里被某条会命中它的规则显式赋予了「非 none」的 display，则必须同时存在一条能命中
 * 该元素的 [hidden] { display: none } 守卫。删掉 src/style.css 里的守卫行，本测试变红。
 *
 * 覆盖层级（解析器为最小实现，刻意保守）：
 *   - 处理：逗号分组选择器、后代（空格）/ 子代（>）组合器、.class / #id / tag /
 *     * / [attr] / 伪类；@media / @supports / @layer 内的规则按「可能命中」摊平后参与判定。
 *   - 处理 !important：display: none !important 也算守卫。
 *   - 不处理（漏检边界，见文件末）：+ / ~ 兄弟组合器按后代处理（可能误报，不会漏报）；
 *     属性选择器除 [hidden] 外一律视为命中（可能误报，不会漏报）；:not()/:has() 等
 *     函数式伪类不展开、视为命中；不在 HTML 里静态出现、由 JS innerHTML 注入的元素
 *     不在检查范围内；内联 style="display:..." 不参与判定；HTML 只解析双引号属性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* 已知安全项白名单：键 = 元素标识，值 = 必须写清的理由（每条都要能自圆其说）。
 * 判定器宁可误报（多包一层 [hidden] 守卫无副作用），所以白名单只放「命中判定过宽
 * 造成的误报」或「确有 display 但隐藏不依赖 UA [hidden] 规则」两类。 */
const WHITELIST = {
  // 无（当前工程零白名单）。新增条目必须在此写明「元素 + 为什么不需要守卫」。
};

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseHtml(src) {
  const out = [];
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = tagRe.exec(src))) {
    const slash = m[1];
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (slash) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el = { tag, id: null, classes: [], hidden: false, ancestors: stack.slice() };
    const idM = /\bid\s*=\s*"([^"]*)"/.exec(attrs);
    if (idM) el.id = idM[1].trim();
    const clM = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
    if (clM) el.classes = clM[1].trim().split(/\s+/).filter(Boolean);
    el.hidden = /(^|\s)hidden(\s|=|$|\/)/.test(attrs);
    out.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push(el);
  }
  return out;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/* 递归拆规则；@media/@supports/@layer 的内容摊平（保守：按可能命中处理） */
function splitRules(src) {
  const rules = [];
  let i = 0;
  while (i < src.length) {
    const brace = src.indexOf('{', i);
    if (brace === -1) break;
    const selector = src.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') depth -= 1;
      j += 1;
    }
    const body = src.slice(brace + 1, j - 1);
    if (selector.startsWith('@')) {
      const name = selector.split(/[\s({]/)[0];
      if (name === '@media' || name === '@supports' || name === '@layer') {
        rules.push(...splitRules(body));
      }
    } else if (selector) {
      rules.push({ selector, body });
    }
    i = j;
  }
  return rules;
}

function declarations(body) {
  const out = {};
  for (const chunk of body.split(';')) {
    const idx = chunk.indexOf(':');
    if (idx === -1) continue;
    const prop = chunk.slice(0, idx).trim().toLowerCase();
    const value = chunk.slice(idx + 1).trim();
    if (prop) out[prop] = value;
  }
  return out;
}

function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], hidden: false };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '*') { i += 1; continue; }
    if (ch === '#') {
      const m = /^#([\w-]+)/.exec(s.slice(i));
      if (m) { c.id = m[1]; i += m[0].length; continue; }
      i += 1; continue;
    }
    if (ch === '.') {
      const m = /^\.([\w-]+)/.exec(s.slice(i));
      if (m) { c.classes.push(m[1]); i += m[0].length; continue; }
      i += 1; continue;
    }
    if (ch === '[') {
      const end = s.indexOf(']', i);
      const attr = s.slice(i + 1, end === -1 ? s.length : end).split(/[~^|*$=\s]/)[0].toLowerCase();
      if (attr === 'hidden') c.hidden = true;
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (ch === ':') {
      const m = /^::?[\w-]+(\([^)]*\))?/.exec(s.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }
    const m = /^[\w-]+/.exec(s.slice(i));
    if (m) { c.tag = m[0].toLowerCase(); i += m[0].length; continue; }
    i += 1;
  }
  return c;
}

function tokenize(group) {
  const cleaned = group.replace(/([>+~])/g, ' $1 ');
  const raw = cleaned.split(/\s+/).filter(Boolean);
  const seq = [];
  let child = false;
  for (const t of raw) {
    if (t === '>') { child = true; continue; }
    if (t === '+' || t === '~') { child = false; continue; } /* 兄弟组合器降级为后代 */
    seq.push({ c: parseCompound(t), child });
    child = false;
  }
  return seq;
}

function compoundMatches(c, el) {
  if (c.tag && c.tag !== el.tag) return false;
  if (c.id && c.id !== el.id) return false;
  for (const cls of c.classes) if (!el.classes.includes(cls)) return false;
  if (c.hidden && !el.hidden) return false;
  return true;
}

function selectorMatches(selector, el) {
  for (const group of selector.split(',')) {
    if (!group.trim()) continue;
    if (group.includes('::')) continue; /* 伪元素不命中元素本身 */
    const seq = tokenize(group);
    if (!seq.length) continue;
    if (!compoundMatches(seq[seq.length - 1].c, el)) continue;
    let ai = 0;
    let ok = true;
    for (let k = seq.length - 2; k >= 0; k -= 1) {
      if (seq[k + 1].child) {
        if (ai >= el.ancestors.length || !compoundMatches(seq[k].c, el.ancestors[ai])) { ok = false; break; }
        ai += 1;
      } else {
        let found = false;
        while (ai < el.ancestors.length) {
          const hit = compoundMatches(seq[k].c, el.ancestors[ai]);
          ai += 1;
          if (hit) { found = true; break; }
        }
        if (!found) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

function isDisplayNoneRule(rule) {
  const d = declarations(rule.body).display;
  return typeof d === 'string' && /^none\b/i.test(d.trim());
}

function elementKey(el, i) {
  if (el.id) return `#${el.id}`;
  const cls = el.classes.length ? `.${el.classes.join('.')}` : '';
  return `${el.tag}${cls}#${i}`;
}

/* 返回未受守卫保护的隐患清单 */
function findUnguardedHiddenElements(html, css) {
  const els = parseHtml(html).filter((e) => e.hidden);
  const rules = splitRules(stripComments(css));
  const offenders = [];
  for (let i = 0; i < els.length; i += 1) {
    const el = els[i];
    const key = elementKey(el, i);
    const overrides = rules.filter((r) => {
      if (!('display' in declarations(r.body))) return false;
      if (isDisplayNoneRule(r)) return false; /* display:none 不会「显形」 */
      return selectorMatches(r.selector, el);
    });
    if (!overrides.length) continue;
    const guarded = rules.some((r) => r.selector.includes('[hidden]')
      && isDisplayNoneRule(r)
      && selectorMatches(r.selector, el));
    if (!guarded && !Object.prototype.hasOwnProperty.call(WHITELIST, key)) {
      offenders.push({ key, tag: el.tag, id: el.id, classes: el.classes, by: overrides.map((r) => r.selector) });
    }
  }
  return offenders;
}

test('hidden_elements_with_display_overrides_must_have_a_hidden_guard', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');
  const offenders = findUnguardedHiddenElements(html, css);
  assert.deepEqual(
    offenders,
    [],
    `带 hidden 的元素被显式 display 覆盖却无 [hidden]{display:none} 守卫：\n${offenders
      .map((o) => `  ${o.key} 被 ${o.by.join(' , ')} 命中`).join('\n')}`,
  );
});

/* 判定器自检：保证护栏本身不是永不报警的空壳 */
test('guard_checker_flags_unguarded_and_accepts_guarded', () => {
  const html = '<div id="next-action" class="next-action" hidden=""><button class="btn primary"></button></div>';
  const unguarded = findUnguardedHiddenElements(html, '.next-action { display: flex; }');
  assert.equal(unguarded.length, 1, '无守卫时必须报出 #next-action');
  assert.equal(unguarded[0].key, '#next-action');
  const guarded = findUnguardedHiddenElements(
    html,
    '.next-action { display: flex; }\n.next-action[hidden] { display: none; }',
  );
  assert.deepEqual(guarded, [], '补上守卫后必须不再报出');
});

test('checker_covers_the_three_selector_shapes_used_in_this_repo', () => {
  const html = '<div class="q-syntax" hidden=""><div class="syntax-body" hidden=""></div></div>'
    + '<aside class="drawer" hidden=""></aside>';
  const css = [
    '.q-syntax { display: flex; }',
    '.q-syntax[hidden] { display: none; }',
    '.q-syntax .syntax-body { display: block; }',
    '.q-syntax .syntax-body[hidden] { display: none; }',
    '.drawer { display: flex; }',
  ].join('\n');
  const offenders = findUnguardedHiddenElements(html, css);
  assert.deepEqual(offenders.map((o) => o.key), ['aside.drawer#2'], '后代选择器与分组守卫都要认');
});
