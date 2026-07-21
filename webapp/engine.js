/*
 * engine.js — 忠实移植 legado(开源阅读/黑猫小说) 书源规则引擎到网页端
 *
 * 参考：legado AnalyzeRule / BookAnalyzer 的官方规则语法(ruleDoc.md)。
 * 支持的规则能力（覆盖本仓库 397 个源实际用到的写法）：
 *   - 默认 CSS/Jsoup 规则：以 '@' 分隔步骤，每段 = 类型.名称.位置
 *       .class. / #id. / tag / [attr] 选择器；.0 / :0 索引（支持负向）；!N 排除
 *       text / textNodes / ownText / html / href / src / content / all 取值器
 *       text.名称  = 按文本内容查找元素
 *   - XPath：以 '//' 或 '@XPath:' 开头（浏览器用 document.evaluate）
 *   - JSONPath：以 '$' 或 '@Json:' 开头
 *   - @js: 与内联 <js>...</js>（含 href<js>.. 这类"取值后处理"）
 *   - {{ }} 模板（默认按 js 求值，$.x 走 JSONPath）、{$.x} 简写
 *   - 运算符：||(首个非空) &&(拼接) %%(交错) ,(拆分)
 *   - ##正则##替换## 净化（末尾 ### 表示仅替换首个）
 *   - @put:{k:path} / @get:{k} 跨规则变量
 *
 * 纯解析器：输入"抓回来的内容字符串 + 书源规则"，输出结构化数据。
 * 网络抓取由调用方（经代理）完成，引擎只做解析。
 */
(function (global) {
  'use strict';

  // ===================== 基础工具 =====================
  const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
  const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const nonEmptyStr = (x) => typeof x === 'string' && x.trim() !== '';
  const hasDOM = typeof DOMParser !== 'undefined';
  const hasXPath = typeof document !== 'undefined' && typeof document.evaluate === 'function';

  function parseHtml(c) {
    if (!hasDOM) return null;
    try { return new DOMParser().parseFromString(c, 'text/html'); }
    catch (e) { return null; }
  }
  function isJsonContent(text) {
    const t = (text || '').trim();
    return t.startsWith('{') || t.startsWith('[');
  }

  // ===================== JSONPath（覆盖书源常用写法）=====================
  function jsonPath(obj, path) {
    if (path == null) return undefined;
    let p = String(path).trim();
    if (p === '$' || p === '$.' || p === '') return obj;
    // 去掉开头的 $ 以及可能的 @Json: 前缀
    p = p.replace(/^@?Json:/, '').replace(/^\$\.?/, '');
    if (!p) return obj;
    // 递归搜索 $..x
    if (p.startsWith('..')) {
      const key = p.slice(2).split(/[.\[]/)[0];
      const found = [];
      (function walk(o) {
        if (o == null || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        for (const k in o) {
          if (k === key) found.push(o[k]);
          walk(o[k]);
        }
      })(obj);
      return found.length ? found : undefined;
    }
    const tokens = p.split(/\.(?![^\[]*\])/).filter(Boolean);
    let cur = obj;
    for (const t of tokens) {
      if (t === '*') continue;
      const m = t.match(/^([^\[]+)?(\[\*\]|\[-?\d+\])$/);
      if (m) {
        const name = m[1];
        const idx = m[2];
        if (name) cur = cur == null ? undefined : cur[name];
        if (cur == null) return undefined;
        if (idx === '[*]') {
          cur = Array.isArray(cur) ? cur : [cur];
        } else {
          const i = +idx.slice(1, -1);
          cur = Array.isArray(cur) ? cur[i] : undefined;
        }
      } else {
        cur = cur == null ? undefined : cur[t];
      }
      if (cur === undefined) return undefined;
    }
    return cur;
  }

  // ===================== JS 沙箱执行（@js / <js> / {{}}）=====================
  // 提供 legado 习惯的变量：result / baseUrl / source / java（getString 等）
  function makeJava(obj) {
    const get = (p) => jsonPath(obj, p.startsWith('$') ? p : '$' + p);
    return {
      getString: (p) => { const v = get(p); return v == null ? '' : String(v); },
      getInt: (p) => { const v = get(p); return v == null ? 0 : parseInt(v, 10) || 0; },
      getBoolean: (p) => { const v = get(p); return !!v; },
      getDouble: (p) => { const v = get(p); return v == null ? 0 : parseFloat(v) || 0; },
      timeFormat: (t) => {
        try { const d = new Date(+t); return isNaN(d) ? String(t) : d.toISOString().slice(0, 19).replace('T', ' '); }
        catch (e) { return String(t); }
      },
      // 17K 等源会调用 java.ajax 在 js 内再抓详情页；浏览器端这里尽力提供
      // 同步实现做不到，返回 '' 以便至少不崩溃（这类源作为已知限制）。
      ajax: (url) => { return ''; },
    };
  }
  function runJs(code, result, ctx) {
    const baseUrl = (ctx && ctx.baseUrl) || '';
    const source = (ctx && ctx.source) || {};
    const java = makeJava(ctx && ctx._obj);
    try {
      const fn = new Function('result', 'baseUrl', 'source', 'java', 'document', 'return (' + code + ');');
      const r = fn(result, baseUrl, source, java, global.document);
      return r == null ? '' : r;
    } catch (e1) {
      try {
        const fn = new Function('result', 'baseUrl', 'source', 'java', 'document', code);
        const r = fn(result, baseUrl, source, java, global.document);
        return r == null ? '' : r;
      } catch (e2) {
        return '';
      }
    }
  }

  // ===================== 模板替换 {{ }} 与 {$.x} =====================
  function evalBrace(inner, obj, ctx) {
    inner = inner.trim();
    if (inner.startsWith('$')) return jsonPath(obj, inner);
    if (inner.startsWith('@json:') || inner.startsWith('@Json:')) return jsonPath(obj, inner);
    if (inner.startsWith('@xpath:') || inner.startsWith('//')) {
      // 在模板里用 xpath 极少，交给 DOM 模式处理；这里返回 ''
      return '';
    }
    // legado 习惯命名变量：{{key}} 搜索关键词，{{page}} 页码
    if (inner === 'key') return (obj && obj.key != null) ? obj.key : (ctx && ctx.keyword != null ? ctx.keyword : '');
    if (inner === 'page') return (obj && obj.page != null) ? obj.page : (ctx && ctx.page != null ? ctx.page : '1');
    // obj 自身有该字段（如 {{id}}、{{name}}）直接取，避免被当成 JS 表达式执行出错
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, inner)) return obj[inner];
    return runJs(inner, obj, ctx);
  }
  function fillTemplates(str, obj, ctx) {
    if (typeof str !== 'string') return str;
    str = str.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner) => {
      const r = evalBrace(inner, obj, ctx);
      return r == null ? '' : (typeof r === 'object' ? JSON.stringify(r) : String(r));
    });
    str = str.replace(/\{\$([^{}]*?)\}/g, (_, p) => {
      const r = jsonPath(obj, '$' + p);
      return r == null ? '' : (typeof r === 'object' ? JSON.stringify(r) : String(r));
    });
    return str;
  }

  // ===================== ## 正则净化 ## =====================
  // 返回 { base, regex, replace, onlyOne }；无 ## 时返回 null
  function splitRegex(rule) {
    const i = rule.indexOf('##');
    if (i < 0) return null;
    const before = rule.slice(0, i);
    const rest = rule.slice(i + 2);
    // 第二段（替换内容）：到下一个 ## 或行尾；OnlyOne 以 ### 结尾
    let regex, replace = '', onlyOne = false;
    const j = rest.indexOf('##');
    if (j < 0) {
      regex = rest; // 形如 base##regex（替换内容为空）
    } else {
      regex = rest.slice(0, j);
      let tail = rest.slice(j + 2);
      if (tail.endsWith('###')) { onlyOne = true; tail = tail.slice(0, -3); }
      else if (tail.endsWith('##')) { tail = tail.slice(0, -2); }
      replace = tail;
    }
    return { base: before, regex, replace, onlyOne };
  }
  function applyRegex(val, info) {
    if (!info || !info.regex) return val;
    try {
      const rx = new RegExp(info.regex, info.onlyOne ? '' : 'g');
      return String(val).replace(rx, info.replace);
    } catch (e) {
      return val;
    }
  }

  // ===================== 顶层运算符切分（尊重 {{}} 与 <js>）=====================
  function splitTopLevel(str, delim) {
    const out = []; let depth = 0, jsDepth = 0, cur = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (str.startsWith('{{', i)) { depth++; cur += '{{'; i++; continue; }
      if (str.startsWith('}}', i)) { depth = Math.max(0, depth - 1); cur += '}}'; i++; continue; }
      if (str.startsWith('<js>', i)) { jsDepth++; cur += '<js>'; i += 3; continue; }
      if (str.startsWith('</js>', i)) { jsDepth = Math.max(0, jsDepth - 1); cur += '</js>'; i += 4; continue; }
      if (depth === 0 && jsDepth === 0 && str.startsWith(delim, i)) {
        out.push(cur); cur = ''; i += delim.length - 1; continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  // ===================== DOM 查询辅助 =====================
  function qsa(root, sel) {
    try {
      if (root.nodeType === 9 || root.nodeType === 1) return Array.from(root.querySelectorAll(sel));
    } catch (e) {}
    return [];
  }
  function resolveHref(url, ctx) {
    if (!url) return url;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return url; // 绝对
    const base = (ctx && ctx.baseUrl) || '';
    if (!base) return url;
    try { return new URL(url, base).href; } catch (e) { return url; }
  }
  const ACTIONS = { text: 1, html: 1, textNodes: 1, ownText: 1, href: 1, src: 1, content: 1, all: 1 };
  function getVal(el, action, ctx) {
    if (action === 'text') return (el.textContent || '').trim();
    if (action === 'html') return el.innerHTML || '';
    if (action === 'href') return resolveHref(el.getAttribute('href') || '', ctx);
    if (action === 'src') return resolveHref(el.getAttribute('src') || '', ctx);
    if (action === 'content') return el.getAttribute('content') || '';
    if (action === 'all') return el.outerHTML || '';
    if (action === 'ownText') {
      return Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    }
    if (action === 'textNodes') return collectTextNodes(el);
    return (el.textContent || '').trim();
  }
  function collectTextNodes(el) {
    const out = [];
    (function walk(n) {
      if (n.nodeType === 3) out.push(n.textContent);
      else if (n.nodeType === 1) Array.from(n.childNodes).forEach(walk);
    })(el);
    return out.join('').trim();
  }

  // 解析一个选择器步骤：class./id./tag. 前缀 + 末尾 .N/:N 索引 + !N 排除
  function parseSelectorStep(step) {
    let sel = step;
    if (sel.startsWith('class.')) {
      // legado：class 名可含多个类（空格分隔）→ 转为 .a.b 形式
      sel = '.' + sel.slice(6).trim().replace(/\s+/g, '.');
    } else if (sel.startsWith('id.')) sel = '#' + sel.slice(3);
    else if (sel.startsWith('tag.')) sel = sel.slice(4);
    let exclude = null, index = null;
    const em = sel.match(/!(-?\d+)$/);
    if (em) { exclude = +em[1]; sel = sel.slice(0, em.index); }
    const im = sel.match(/[.:](-?\d+)$/);
    if (im) { index = +im[1]; sel = sel.slice(0, im.index); }
    return { sel, index, exclude };
  }
  function applyIndex(list, index, exclude) {
    let r = list;
    if (exclude != null) {
      if (exclude < 0) r = r.filter((_, i) => i !== r.length + exclude);
      else r = r.filter((_, i) => i !== exclude);
    }
    if (index != null) {
      if (index < 0) r = r.slice(r.length + index, r.length);
      else r = r.slice(index, index + 1);
    }
    return r;
  }
  // 按文本查找元素（text.名称）
  function findText(current, name) {
    const out = [];
    const norm = name.trim();
    const searchIn = (el) => {
      const all = [el].concat(Array.from(el.querySelectorAll('*')));
      for (const n of all) {
        if (n.nodeType === 1 && (n.textContent || '').includes(norm)) out.push(n);
      }
    };
    current.forEach(searchIn);
    return out;
  }

  // ===================== CSS @-链求值（DOM 模式）=====================
  function evalCssChain(rule, root, ctx) {
    // 保护 <js>...</js> 不被 '@' 拆分
    const parts = [];
    let buf = '', i = 0;
    while (i < rule.length) {
      if (rule.startsWith('<js>', i)) {
        const end = rule.indexOf('</js>', i);
        const seg = end < 0 ? rule.slice(i) : rule.slice(i, end + 5);
        buf += seg; i = end < 0 ? rule.length : end + 5; continue;
      }
      if (rule[i] === '@') { parts.push(buf); buf = ''; i++; continue; }
      buf += rule[i]; i++;
    }
    if (buf) parts.push(buf);
    // 去掉空段（规则首尾的 @）
    let steps = parts.map((s) => s.trim()).filter((s, idx) => !(s === '' && idx > 0 && idx < parts.length - 1));
    if (steps.length === 0) return []; // 空规则 → 空结果（而非返回 root）

    let current = [root];
    for (let s = 0; s < steps.length; s++) {
      let step = steps[s];
      if (step === '') continue;

      // 取值后接 <js>：如 href<js>...</js>
      const jsAttr = step.match(/^(\w+)<js>([\s\S]*?)<\/js>$/);
      if (jsAttr) {
        const action = jsAttr[1];
        const code = jsAttr[2];
        const strs = current.map((el) => getVal(el, action, ctx));
        current = [runJs(code, strs.length === 1 ? strs[0] : strs, ctx)];
        break;
      }
      // 纯取值器
      if (ACTIONS[step]) {
        current = current.map((el) => getVal(el, step, ctx));
        break;
      }
      // @js: 步骤（对当前列表跑脚本）
      if (step.startsWith('js:')) {
        current = asArray(runJs(step.slice(3), current, ctx));
        continue;
      }
      // text.名称 按文本查找
      if (step.startsWith('text.')) {
        current = findText(current, step.slice(5));
        continue;
      }
      // 普通选择器步骤
      const { sel, index, exclude } = parseSelectorStep(step);
      if (!sel) continue;
      const next = [];
      current.forEach((el) => { qsa(el, sel).forEach((x) => next.push(x)); });
      current = applyIndex(next, index, exclude);
    }
    return current;
  }

  // ===================== XPath 求值（DOM 模式）=====================
  function xpathQuery(expr, root, ctx) {
    if (hasXPath) {
      try {
        const res = document.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = [];
        for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
        return out;
      } catch (e) { return []; }
    }
    return [];
  }
  function evalXpath(rule, root, ctx) {
    let expr = rule.replace(/^@XPath:/, '').trim();
    const nodes = xpathQuery(expr, root, ctx);
    // 属性节点(2)/文本节点(3) → 字符串；元素节点保留以便继续链式取值
    // href/src 属性值做相对→绝对
    return nodes.map((n) => {
      if (n.nodeType === 2) {
        const name = (n.nodeName || n.name || '').toLowerCase();
        const v = n.nodeValue;
        return (name === 'href' || name === 'src') ? resolveHref(v, ctx) : v;
      }
      if (n.nodeType === 3) return n.nodeValue;
      return n;
    });
  }

  // ===================== DOM 模式顶层 =====================
  // 返回数组（元素或字符串）
  function analyzeDom(rule, root, ctx) {
    ctx = ctx || {};
    const alts = splitTopLevel(rule, '||');
    for (const alt of alts) {
      const r = analyzeDomAlt(alt, root, ctx);
      if (r.some((x) => (typeof x === 'string' ? nonEmptyStr(x) : !!x))) return r;
    }
    return [];
  }
  function analyzeDomAlt(alt, root, ctx) {
    // %% 交错、&& 拼接
    if (alt.includes('%%')) {
      const parts = splitTopLevel(alt, '%%').map((p) => analyzeDomAlt(p, root, ctx));
      const max = Math.max(1, ...parts.map((p) => p.length));
      const out = [];
      for (let i = 0; i < max; i++) for (const p of parts) if (p[i] != null) out.push(p[i]);
      return out;
    }
    if (alt.includes('&&')) {
      const parts = splitTopLevel(alt, '&&');
      const out = [];
      parts.forEach((p) => analyzeDomRule(p, root, ctx).forEach((x) => out.push(x)));
      return out;
    }
    // 单段（可能带 , 拆分为多值）
    if (alt.includes(',')) {
      return splitTopLevel(alt, ',').map((p) => analyzeDomRule(p, root, ctx)).flat();
    }
    return analyzeDomRule(alt, root, ctx);
  }
  function analyzeDomRule(rule, root, ctx) {
    const info = splitRegex(rule);
    const base = info ? info.base : rule;
    let res;
    const trimmed = base.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('@XPath:')) {
      res = evalXpath(trimmed, root, ctx);
    } else if (trimmed.startsWith('@js:')) {
      res = asArray(runJs(trimmed.slice(4), root, ctx));
    } else if (trimmed.startsWith('{{')) {
      res = [evalBrace(trimmed.slice(2, -2), ctx._obj || {}, ctx)];
    } else if (trimmed.startsWith('@')) {
      // 其它 @ 前缀（@json: 在 DOM 下无意义）
      res = evalCssChain(trimmed, root, ctx);
    } else {
      res = evalCssChain(trimmed, root, ctx);
    }
    if (info) res = res.map((x) => (typeof x === 'string' ? applyRegex(x, info) : x));
    return res;
  }

  // ===================== JSON 模式 =====================
  function evalJsonRule(rule, obj, ctx) {
    ctx = ctx || {}; ctx._obj = obj;
    const alts = String(rule).split('||');
    for (const alt of alts) {
      const r = evalJsonAlt(alt.trim(), obj, ctx);
      if (nonEmptyStr(r)) return r;
    }
    return '';
  }
  function evalJsonAlt(alt, obj, ctx) {
    if (alt.includes('&&')) {
      return splitTopLevel(alt, '&&').map((p) => evalJsonPiece(p.trim(), obj, ctx)).join('');
    }
    if (alt.includes('%%')) {
      const parts = splitTopLevel(alt, '%%').map((p) => evalJsonPiece(p.trim(), obj, ctx));
      return parts.join('');
    }
    return evalJsonPiece(alt, obj, ctx);
  }
  function evalJsonPiece(piece, obj, ctx) {
    let p = piece;
    const info = splitRegex(p);
    if (info) p = info.base;
    // {{ }} 模板
    p = p.replace(/\{\{([\s\S]*?)\}\}/g, (_, inner) => {
      const r = evalBrace(inner, obj, ctx);
      return r == null ? '' : (typeof r === 'object' ? JSON.stringify(r) : String(r));
    });
    p = p.replace(/\{\$([^{}]*?)\}/g, (_, pp) => {
      const r = jsonPath(obj, '$' + pp);
      return r == null ? '' : (typeof r === 'object' ? JSON.stringify(r) : String(r));
    });
    // @put 设变量
    const pm = p.match(/@put:\{([\s\S]*?)\}/);
    if (pm) {
      pm[1].split(',').forEach((kv) => {
        const ci = kv.indexOf(':'); if (ci < 0) return;
        const k = kv.slice(0, ci).trim(); const pp = kv.slice(ci + 1).trim();
        if (k) ctx.vars = ctx.vars || {}, ctx.vars[k] = jsonPath(obj, pp.startsWith('$') ? pp : '$' + pp);
      });
      p = p.replace(/@put:\{[\s\S]*?\}/, '');
    }
    p = p.replace(/@get:\{([^}]*)\}/g, (_, v) => (ctx.vars && ctx.vars[v] != null ? String(ctx.vars[v]) : ''));

    // @js: 后置
    let jsCode = null;
    const jm = p.match(/@js:\s*([\s\S]*)$/);
    if (jm) { jsCode = jm[1]; p = p.slice(0, jm.index); }
    const im = p.match(/<js>([\s\S]*?)<\/js>/);
    if (im) { jsCode = im[1]; p = p.replace(/<js>[\s\S]*?<\/js>/, ''); }

    let val;
    if (p.startsWith('$') || p.startsWith('@Json:')) {
      val = jsonPath(obj, p);
    } else if (p === '') {
      val = '';
    } else {
      val = p; // 纯文本
    }
    if (jsCode) val = runJs(jsCode, val, ctx);
    if (info) val = applyRegex(val, info);
    return val == null ? '' : (typeof val === 'object' ? JSON.stringify(val) : String(val));
  }

  // ===================== URL 解析（bookUrl/tocUrl/chapterUrl）=====================
  function toAbs(u, base) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (!base) return u;
    try { return new URL(u, base).href; } catch (e) { return u; }
  }
  function resolveUrl(rule, obj, ctx) {
    if (!rule) return '';
    ctx = ctx || {}; ctx._obj = obj; ctx.vars = ctx.vars || {};
    let m = rule.match(/@js:\s*([\s\S]*)$/);
    let js = null, base = rule;
    if (m) { js = m[1]; base = rule.slice(0, m.index); }
    m = base.match(/@put:\{([\s\S]*?)\}/);
    if (m) {
      m[1].split(',').forEach((kv) => {
        const ci = kv.indexOf(':'); if (ci <= 0) return;
        const k = kv.slice(0, ci).trim(); const pp = kv.slice(ci + 1).trim();
        if (k) ctx.vars[k] = jsonPath(obj, pp.startsWith('$') ? pp : '$' + pp);
      });
      base = base.replace(/@put:\{[\s\S]*?\}/, '');
    }
    let val;
    if (/^\$/.test(base) || /^@Json:/i.test(base)) {
      val = jsonPath(obj, base); // bookUrl 等为 JSONPath（如 $.id）
    } else {
      val = fillTemplates(base, obj, ctx);
    }
    if (js) val = runJs(js, val, ctx);
    return val == null ? '' : String(val);
  }

  // ===================== 对外解析接口 =====================
  function firstOf(arr) {
    for (const x of arr) {
      if (x == null) continue;
      if (typeof x === 'string') { if (nonEmptyStr(x)) return x.trim(); continue; }
      // 纯选择器（如 .name）未带取值动作时，legado 默认取元素文字；这里补上，否则会返回 DOM 元素对象
      if (typeof x === 'object' && x.nodeType) { const t = (x.textContent || '').trim(); if (t) return t; continue; }
      if (x) return x;
    }
    return '';
  }

  function parseSearch(content, source, ctx) {
    const obj = isJsonContent(content) ? JSON.parse(content) : null;
    ctx = ctx || {}; ctx.source = source;
    if (obj) {
      const list = asArray(jsonPath(obj, ((source.ruleSearch || source.searchRule || {}).bookList) || '$'));
      return list.map((it) => {
        const rs = source.ruleSearch || source.searchRule || {};
        const bctx = Object.assign({}, ctx, { _obj: it });
        return {
          name: evalJsonRule(rs.name || '', it, bctx),
          author: evalJsonRule(rs.author || '', it, bctx),
          bookUrl: resolveUrl(rs.bookUrl || '', it, bctx),
          coverUrl: toAbs(evalJsonRule(rs.coverUrl || '', it, bctx), ctx.baseUrl || ''),
          intro: evalJsonRule(rs.intro || '', it, bctx),
          kind: evalJsonRule(rs.kind || '', it, bctx),
          lastChapter: evalJsonRule(rs.lastChapter || '', it, bctx),
        };
      });
    }
    const doc = parseHtml(content);
    if (!doc) return [];
    const rs = source.ruleSearch || source.searchRule || {};
    const nodes = analyzeDom(rs.bookList || '', doc, ctx);
    const els = nodes.filter((n) => typeof n !== 'string');
    return els.map((el) => ({
      name: firstOf(analyzeDom(rs.name || '', el, ctx)),
      author: firstOf(analyzeDom(rs.author || '', el, ctx)),
      bookUrl: firstOf(analyzeDom(rs.bookUrl || '', el, ctx)),
      coverUrl: toAbs(firstOf(analyzeDom(rs.coverUrl || '', el, ctx)), ctx.baseUrl || ''),
      intro: firstOf(analyzeDom(rs.intro || '', el, ctx)),
      kind: firstOf(analyzeDom(rs.kind || '', el, ctx)),
      lastChapter: firstOf(analyzeDom(rs.lastChapter || '', el, ctx)),
    }));
  }

  function parseBookInfo(content, source, ctx) {
    const obj = isJsonContent(content) ? JSON.parse(content) : null;
    const r = (source.ruleBookInfo || {});
    ctx = ctx || {}; ctx.source = source;
    if (obj) {
      const bctx = Object.assign({}, ctx, { _obj: obj });
      return {
        name: evalJsonRule(r.name || '', obj, bctx),
        author: evalJsonRule(r.author || '', obj, bctx),
        coverUrl: evalJsonRule(r.coverUrl || '', obj, bctx),
        intro: evalJsonRule(r.intro || '', obj, bctx),
        kind: evalJsonRule(r.kind || '', obj, bctx),
        lastChapter: evalJsonRule(r.lastChapter || '', obj, bctx),
        wordCount: evalJsonRule(r.wordCount || '', obj, bctx),
        tocUrl: resolveUrl(r.tocUrl || '', obj, bctx),
      };
    }
    const doc = parseHtml(content);
    if (!doc) return { name: '', author: '', coverUrl: '', intro: '', tocUrl: '' };
    return {
      name: firstOf(analyzeDom(r.name || '', doc, ctx)),
      author: firstOf(analyzeDom(r.author || '', doc, ctx)),
      coverUrl: firstOf(analyzeDom(r.coverUrl || '', doc, ctx)),
      intro: firstOf(analyzeDom(r.intro || '', doc, ctx)),
      kind: firstOf(analyzeDom(r.kind || '', doc, ctx)),
      lastChapter: firstOf(analyzeDom(r.lastChapter || '', doc, ctx)),
      wordCount: firstOf(analyzeDom(r.wordCount || '', doc, ctx)),
      tocUrl: firstOf(analyzeDom(r.tocUrl || '', doc, ctx)),
    };
  }

  function parseToc(content, source, ctx) {
    const obj = isJsonContent(content) ? JSON.parse(content) : null;
    const r = (source.ruleToc || {});
    ctx = ctx || {}; ctx.source = source;
    if (obj) {
      const list = asArray(jsonPath(obj, r.chapterList || '$'));
      return list.map((it) => {
        const bctx = Object.assign({}, ctx, { _obj: it });
        const name = evalJsonRule(r.chapterName || '', it, bctx);
        const url = resolveUrl(r.chapterUrl || '', it, bctx);
        return url ? { name, url } : null;
      }).filter(Boolean);
    }
    const doc = parseHtml(content);
    if (!doc) return [];
    const nodes = analyzeDom(r.chapterList || '', doc, ctx);
    const els = nodes.filter((n) => typeof n !== 'string');
    return els.map((el) => {
      const name = firstOf(analyzeDom(r.chapterName || '', el, ctx));
      const url = firstOf(analyzeDom(r.chapterUrl || '', el, ctx));
      return url ? { name, url } : null;
    }).filter(Boolean);
  }

  function parseContent(content, source, ctx) {
    const obj = isJsonContent(content) ? JSON.parse(content) : null;
    const rc = source.ruleContent || {};
    const r = (rc.content || (typeof rc === 'string' ? rc : '')) || '';
    ctx = ctx || {}; ctx.source = source;
    if (obj) {
      const bctx = Object.assign({}, ctx, { _obj: obj });
      const text = evalJsonRule(r, obj, bctx) || '';
      const nextUrl = extractNextUrl(obj, rc, bctx);
      return { content: text, nextUrl };
    }
    const doc = parseHtml(content);
    if (!doc) return { content: '', nextUrl: '' };
    const nodes = analyzeDom(r, doc, ctx);
    const strs = nodes.map((n) => (typeof n === 'string' ? n : (n.innerHTML || n.textContent || '')));
    let text = strs.join('\n').trim() || '';
    // legado 的 replaceRegex：对正文做正则清洗（去广告、"本章未完"提示等）
    // 格式与规则内 ##正则##替换## 相同
    if (rc.replaceRegex && text && typeof rc.replaceRegex === 'string') {
      const parts = rc.replaceRegex.split('##');
      if (parts.length >= 2) {
        try { text = text.replace(new RegExp(parts[1], parts[2] === '' ? 'g' : ''), parts[2] || ''); } catch (e) { /* 忽略无效正则 */ }
      } else if (parts.length === 1) {
        try { text = text.replace(new RegExp(parts[0], 'g'), ''); } catch (e) {}
      }
    }
    const nextUrl = extractNextUrl(doc, rc, ctx);
    return { content: text, nextUrl };
  }

  // 从当前页面提取"下一页"URL（legado nextContentUrl 规则）
  function extractNextUrl(rootObj, ruleContent, ctx) {
    const nc = (ruleContent && ruleContent.nextContentUrl) || '';
    if (!nc) return '';
    try {
      if (rootObj && typeof rootObj === 'object' && rootObj.nodeType) {
        // DOM 模式
        const url = firstOf(analyzeDom(nc, rootObj, ctx));
        return resolveHref(String(url || ''), ctx);
      } else {
        // JSON 模式
        return String(evalJsonRule(nc, rootObj, ctx || {}) || '');
      }
    } catch (e) { return ''; }
  }

  global.BookEngine = {
    isJsonContent,
    parseSearch,
    parseBookInfo,
    parseToc,
    parseContent,
    jsonPath,
    fillTemplates,
    resolveUrl,
    // 测试/调试用
    _analyzeDom: analyzeDom,
    _evalJsonRule: evalJsonRule,
  };
})(typeof window !== 'undefined' ? window : globalThis);
