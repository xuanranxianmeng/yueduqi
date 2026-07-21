/* app.js — 青简阅读：调用书源规则引擎 + 代理抓书，纯前端 SPA */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // 桌面 UA：若初/黑岩等站会按 UA 返回桌面版 HTML（含规则所需的 .pic / 开始阅读 / pre.note 等节点），
  // 移动 UA 会被重定向到移动版 XHTML，导致书源 CSS/XPath 选择器全部扑空。
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const LS = {
    shelf: 'nov_shelf',
    settings: 'nov_settings',
    prog: (id) => 'nov_prog_' + id,
    srcPref: 'nov_srcpref',
    bm: (id) => 'nov_bm_' + id,
  };

  let SOURCES = [];
  let disabledSrc = new Set(); // 同域名重复的冗余源索引（清理垃圾源用，不删数组以保索引稳定）
  let activeSourceIdx = -1;
  let currentBook = null;
  let currentToc = [];
  let currentChap = 0;
  let sourcesLoaded = false;
  let searchSeq = 0; // 搜索序号：防止上一次搜索的迟到结果污染本次列表
  let prevView = 'home'; // 记录进入详情/阅读器前的来源视图（搜索 or 书架）
  let prevBeforeDetail = 'home'; // 进入详情页之前的视图（供详情页‹返回按钮用，不被阅读器覆盖）
  let currentSrcEntry = null; // 当前选中的书源（合并书的多源之一）

  // ---- 翻页模式相关（真正的"一屏一页"，对标微信读书/番茄翻页）----
  let currentPageMode = 'scroll'; // 'scroll' 滚动 | 'page' 翻页
  let pageAnim = 'slide';         // 'fade' 淡入 | 'slide' 横移
  let readerPages = [];           // 当前章按屏切分后的页面数组（每元素是 HTML 片段数组）
  // 自动翻页（会话级，不持久化）
  let autoOn = false, autoTimer = null, autoCooldownUntil = 0;
  // 书架视图/排序偏好（持久化）
  let shelfViewMode = localStorage.getItem('nov_shelfview') || 'grid';
  let shelfSort = localStorage.getItem('nov_shelfsort') || 'recent';
  let currentPageNo = 0;          // 当前章内页码（从 0 起）
  let currentChapterTitle = '';   // 当前章标题（仅在第 1 页显示）
  let currentChapterHtml = '';    // 当前章正文 HTML（不含标题），scroll/page 共用
  let currentChapterText = '';    // 当前章纯文本（去广告后，用于听书TTS）
  let chapterWordCounts = [];     // 各章字数缓存（openChapter 读取后存入，目录显示用）

  // ---- 正文去广告/清洗：第三方镜像站常在章节里注入推广文案、收藏网址等 ----
  // 返回 { html: 清洗后HTML(用于渲染), text: 纯文本(用于字数+TTS) }
  var AD_PATTERNS = [
    // URL 推广：常见小说镜像站域名
    /(?:https?:\/\/)?(?:www\.)?(?:52shuku|52书库|69shuba|69书吧|69yuedu|biquge|xbiquge|bbiquge|ibiquges|ddxs|81xsw|77shuku|kanunu|630book|360xs|shubaow|xmsishu|84bus|bidan)\.(?:net|com|cc|la|cx|info|org)[^\n]*/gi,
    // 推广话术
    /记得收藏网址[^\n]*/gi,
    /(?:小伙伴|亲们?|读者|书友)(?:们?)?(?:如果觉得|觉得)?[^\n]{0,20}(?:不错|好看|喜欢|推荐)[^\n]*?(?:收藏|网址|分享|转发)[^\n]*/gi,
    /(?:拜托啦|拜托了|求支持|求关注|求收藏|感谢支持)[^\n]{0,40}/gi,
    /(?:推荐给朋友|分享给朋友|告诉朋友)[^\n]*/gi,
    // 纯表情符号推广段
    /^[^。！？\w\u4e00-\u9fff]*(?:\(>?[.<>]+\)|[☺😊😄😉🙏💕❤👍🎁⭐★]+)[^。！？\w\u4e00-\u9fff]*$/gm,
    // "xx书库" 站点名 + 段落太短(<30字)且含网址关键词
    /^(?:.{0,5}(?:书库|小说网|阅读网).{0,30})$/gm,
  ];
  function cleanContent(rawHtml) {
    if (!rawHtml) return { html: '', text: '' };
    var html = rawHtml;
    // 逐条规则替换广告内容为空
    for (var i = 0; i < AD_PATTERNS.length; i++) {
      html = html.replace(AD_PATTERNS[i], '');
    }
    // 剥除空 <p></p> 段落（广告被删后残留的空标签）
    html = html.replace(/<p>\s*<\/p>/gi, '').replace(/<p>\s*<br\s*\/?>\s*<\/p>/gi, '');
    // 合并连续空白段落
    html = html.replace(/(<p[^>]*>\s*(?:<br\s*\/?\s*)*\s*<\/p>(?:\s*<p[^>]*>\s*(?:<br\s*\/?\s*)*\s*<\/p>)*){2,}/g, function(m) {
      return '<p><br/></p>';
    });
    // 提取纯文本（用于 TTS 和字数）
    var text = html.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, '');
    return { html: html.trim(), text: text };
  }

  // 格式化字数显示：≥10000 用 "x.x万"，≥1000 用 "x.xk"，否则直接数字+"字"
  function fmtWordCount(n) {
    if (!n || n <= 0) return '';
    if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '万字';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k字';
    return n + '字';
  }

  // ---- 书源偏好：记住每本书上次可用的源，失效源自动跳过 ----
  // 存储结构：{ [bookId]: { sel: srcIdx, bad: [srcIdx,...] } }
  function getSrcPrefAll() {
    try { return JSON.parse(localStorage.getItem(LS.srcPref)) || {}; } catch (e) { return {}; }
  }
  function saveSrcPref(id, pref) {
    const all = getSrcPrefAll(); all[id] = pref;
    localStorage.setItem(LS.srcPref, JSON.stringify(all));
  }
  function setBookSel(id, srcIdx) {
    const all = getSrcPrefAll(); const p = all[id] || {};
    p.sel = srcIdx; p.bad = (p.bad || []).filter((x) => x !== srcIdx);
    saveSrcPref(id, p);
  }
  function markSrcBad(id, srcIdx) {
    const all = getSrcPrefAll(); const p = all[id] || {};
    p.bad = p.bad || []; if (!p.bad.includes(srcIdx)) p.bad.push(srcIdx);
    saveSrcPref(id, p);
  }
  // 清除某本书的全部失效标记（重试/重新加入书架时用）
  function clearBookBad(id) {
    const all = getSrcPrefAll();
    if (all[id]) { all[id].bad = []; saveSrcPref(id, all[id]); }
  }
  // 为某本书挑源：优先上次选过且非失效的；否则第一个有链接且非失效的；再退而求其次任意有链接的
  function pickSourceForBook(merged) {
    const id = bookId(merged);
    const pref = getSrcPrefAll()[id] || {};
    const bad = new Set(pref.bad || []);
    const srcs = merged._sources || [];
    if (pref.sel != null) {
      const s = srcs.find((x) => x.srcIdx === pref.sel);
      if (s && !bad.has(s.srcIdx)) return s;
    }
    const c = srcs.find((s) => s.bookUrl && !bad.has(s.srcIdx));
    if (c) return c;
    const c2 = srcs.find((s) => s.bookUrl);
    return c2 || srcs[0] || null;
  }

  // ---------------- 全局错误捕获 ----------------
  window.addEventListener('error', (e) => {
    console.error('[全局错误]', e.message, e.filename, e.lineno);
    showToast('页面出错: ' + e.message.slice(0, 80));
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[Promise 错误]', e.reason);
    showToast('操作失败: ' + String(e.reason).slice(0, 80));
  });

  function showToast(msg, duration = 4000) {
    const existing = document.getElementById('toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.id = 'toast';
    el.textContent = msg;
    el.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:rgba(31,35,41,0.92);color:#fff;padding:8px20px;border-radius:10px;font-size:14px;z-index:999;max-width:80%;text-align:center;word-break:break-all;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  // ---------------- 阅读器菜单（沉浸式：默认隐藏，点击正文中间唤出）----------------
  let readerMenuVisible = false;
  let menuHideTimer = null;
  let justSwiped = false; // 手势滑动翻页后抑制随后触发的 click
  function showReaderMenu(on) {
    readerMenuVisible = on;
    $('readerTop').classList.toggle('r-hidden', !on);
    $('readerBottom').classList.toggle('r-hidden', !on);
    if (on) {
      // 抽屉/设置打开时不清掉它们，仅重置自动隐藏计时
      clearTimeout(menuHideTimer);
      const anyOpen = $('tocDrawer').classList.contains('open')
        || $('srcDrawer').classList.contains('open')
        || $('readerSettings').classList.contains('open');
      if (!anyOpen) menuHideTimer = setTimeout(() => showReaderMenu(false), 3200);
    } else {
      clearTimeout(menuHideTimer);
      closeTocDrawer(); closeSrcDrawer(); $('readerSettings').classList.remove('open');
    }
  }
  function toggleReaderMenu() { showReaderMenu(!readerMenuVisible); }
  function hideReaderMenu() { showReaderMenu(false); }
  let tocBmOnly = false;
  function renderTocList() {
    const el = $('tocDrawerList'); el.innerHTML = '';
    const bmSet = getBmSet();
    const kw = ($('tocSearch').value || '').trim().toLowerCase();
    let shown = 0;
    currentToc.forEach((ch, i) => {
      const name = ch.name || ('第' + (i + 1) + '章');
      if (kw && !name.toLowerCase().includes(kw)) return;
      if (tocBmOnly && !bmSet.has(i)) return;
      shown++;
      const d = document.createElement('div');
      d.className = 'drawer-item' + (i === currentChap ? ' active' : '') + (bmSet.has(i) ? ' bm-on' : '');
      const star = bmSet.has(i) ? '<span class="bm-star">★</span>' : '';
      const wc = fmtWordCount(chapterWordCounts[i]);
      d.innerHTML = star
        + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</span>'
        + (wc ? '<span class="drawer-wc">' + wc + '</span>' : '');
      d.onclick = () => { openChapter(i); closeTocDrawer(); };
      el.appendChild(d);
    });
    if (!shown) el.innerHTML = '<p class="drawer-empty">' + (tocBmOnly ? '还没有书签' : '没有匹配的章节') + '</p>';
    const act = el.querySelector('.active');
    if (act && !kw && !tocBmOnly) act.scrollIntoView({ block: 'center' });
  }
  function openTocDrawer() {
    clearTimeout(menuHideTimer); // 打开抽屉则保持菜单可见
    stopAuto(); // 自动翻页时打开抽屉先暂停（关闭时若仍开启则恢复）
    const sb = $('tocSearch'); if (sb) sb.value = '';
    tocBmOnly = false;
    const bf = $('tocBmFilter'); if (bf) bf.classList.remove('active');
    renderTocList();
    $('tocDrawer').classList.add('open');
    $('tocMask').classList.add('show');
  }
  function closeTocDrawer() {
    $('tocDrawer').classList.remove('open');
    $('tocMask').classList.remove('show');
    if (autoOn) startAuto();
  }
  // 换源抽屉（阅读器内，不跳详情页）
  function openSrcDrawer() {
    clearTimeout(menuHideTimer); // 打开抽屉则保持菜单可见
    stopAuto();
    if (!currentBook) return;
    const el = $('srcDrawerList'); el.innerHTML = '';
    const srcs = currentBook._sources || [];
    if (!srcs.length) {
      el.innerHTML = '<div style="padding:24px 16px;text-align:center;color:var(--muted);font-size:13px;">该书没有可选书源</div>';
    } else {
      const bad = new Set(((getSrcPrefAll()[bookId(currentBook)] || {}).bad || []));
      srcs.slice().sort((a, b) => (bad.has(a.srcIdx) ? 1 : 0) - (bad.has(b.srcIdx) ? 1 : 0)).forEach((s, i) => {
        const d = document.createElement('div');
        const isActive = currentSrcEntry && currentSrcEntry.srcIdx === s.srcIdx;
        const isBad = bad.has(s.srcIdx);
        const hasLink = !!s.bookUrl && !isBad;
        d.className = 'drawer-item' + (isActive ? ' active' : '') + (isBad ? ' disabled' : '');
        const dotClass = hasLink ? 'ok' : 'bad';
        d.innerHTML = '<span class="src-dot ' + dotClass + '"></span>'
          + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (s.srcName || ('源' + (i + 1))) + '</span>'
          + (isActive ? '<span style="font-size:11px;color:var(--accent);flex-shrink:0;">当前</span>'
             : (isBad ? '<span style="font-size:11px;color:#c44030;flex-shrink:0;">失效</span>' : ''));
        d.onclick = () => { if (isBad) return; switchSourceInReader(s); closeSrcDrawer(); };
        el.appendChild(d);
      });
    }
    $('srcDrawer').classList.add('open');
    $('srcMask').classList.add('show');
  }
  function closeSrcDrawer() {
    $('srcDrawer').classList.remove('open');
    $('srcMask').classList.remove('show');
    if (autoOn) startAuto();
  }
  // 在阅读器内切换书源：加载新源目录后自动刷新当前章节
  async function switchSourceInReader(entry) {
    if (!entry || !entry.bookUrl) { showToast('该源无可用链接'); return; }
    showToast('正在切换到 ' + (entry.srcName || '…'));
    // 记住当前章节号，切完源后跳回来
    const targetChap = currentChap;
    await loadSource(currentBook, entry);
    if (currentToc.length > 0) setBookSel(bookId(currentBook), entry.srcIdx); // 阅读器内换源成功即记为默认
    // 目录加载完后，如果目标章节在范围内则跳转
    if (currentToc.length > 0 && targetChap < currentToc.length) {
      openChapter(targetChap);
    } else if (currentToc.length > 0) {
      openChapter(0);
    }
    showToast('已切换到 ' + (entry.srcName || '…'));
  }
  function updateMiniBar() {
    if (!currentToc.length) return;
    const pct = Math.round(((currentChap + 1) / currentToc.length) * 100);
    $('readerMini').querySelector('span').style.width = pct + '%';
  }

  // 翻页箭头在首页/末章时禁用（模块级，供 openChapter / bind 调用）
  function updateNavArrows() {
    const prev = $('navPrev'), next = $('navNext');
    if (!prev || !next) return;
    prev.classList.toggle('disabled', currentChap <= 0);
    next.classList.toggle('disabled', currentChap >= currentToc.length - 1);
  }

  // 翻页方式应用（当前仅支持滚动模式；翻页方式/翻页效果行已隐藏）
  function applyPageMode(mode) {
    currentPageMode = 'scroll'; // 强制滚动，忽略参数
    const rc = $('readerContent');
    if (!rc) return;
    const rv = $('readerView');
    rc.style.overflowY = 'auto';
    rc.classList.remove('paged');
    if (rv) rv.classList.remove('show-nav');
    // 按当前模式重渲染正文；未加载章节时挂自动加载
    if (currentChapterHtml) renderCurrentChapter();
    else bindAutoLoadNext();
    updateReaderPageNum();
  }

  // ---------------- 书签 ----------------
  function getBmSet() {
    if (!currentBook) return new Set();
    try { return new Set(JSON.parse(localStorage.getItem(LS.bm(bookId(currentBook))) || '[]')); } catch (e) { return new Set(); }
  }
  function saveBmSet(set) {
    if (!currentBook) return;
    localStorage.setItem(LS.bm(bookId(currentBook)), JSON.stringify([...set]));
  }
  function refreshBmBtn() {
    const btn = $('rBm'); if (!btn) return;
    const on = getBmSet().has(currentChap);
    btn.dataset.on = on ? 'true' : 'false';
    const tx = btn.querySelector('.r-tool-tx'); if (tx) tx.textContent = on ? '已签' : '书签';
  }
  function toggleBookmark() {
    if (!currentBook || !currentToc.length) return;
    const set = getBmSet();
    if (set.has(currentChap)) { set.delete(currentChap); showToast('已取消本章书签'); }
    else { set.add(currentChap); showToast('已添加本章书签'); }
    saveBmSet(set);
    refreshBmBtn();
    // 目录抽屉若打开则同步高亮
    if ($('tocDrawer').classList.contains('open')) openTocDrawer();
  }

  // ---------------- 夜间模式（复用背景主题：深色；切回上次非夜间主题）----------------
  let _lastLightBg = null, _lastLightColor = null;
  function toggleNight() {
    const st = getSettings();
    const btn = $('rNight');
    const isNight = (st.bg === '#16181d');
    if (isNight) {
      // 切回之前的非夜间主题（没有则纸白）
      const bg = _lastLightBg || '#f6f3ea';
      const color = _lastLightColor || '#33312b';
      st.bg = bg; st.color = color;
      if (btn) btn.dataset.on = 'false';
    } else {
      _lastLightBg = st.bg || '#f6f3ea';
      _lastLightColor = st.color || '#33312b';
      st.bg = '#16181d'; st.color = '#e8e8e8';
      if (btn) btn.dataset.on = 'true';
    }
    localStorage.setItem(LS.settings, JSON.stringify(st));
    // 同步背景主题圆点高亮
    document.querySelectorAll('.theme-dot').forEach((x) => x.classList.toggle('active', x.dataset.bg === st.bg));
    applyReaderStyle();
  }

  // ---------------- 代理抓书 ----------------
  async function proxyFetch(urlRule, tpl, retry = 3, extraHeaders = {}) {
    let url = urlRule, method = 'GET', body = null, headers = Object.assign({ 'User-Agent': UA }, extraHeaders);
    const ci = urlRule.indexOf(',');
    if (ci > 0) {
      const after = urlRule.slice(ci + 1).trim();
      if (after.startsWith('{')) {
        url = urlRule.slice(0, ci);
        try {
          const opt = JSON.parse(after);
          method = opt.method || 'GET';
          body = opt.body || null;
          if (opt.headers) headers = Object.assign(headers, opt.headers);
        } catch (e) { /* ignore */ }
      }
    }
    url = BookEngine.fillTemplates(url, tpl, { vars: {} });
    if (body) body = BookEngine.fillTemplates(body, tpl, { vars: {} });

    let lastErr;
    for (let i = 0; i < retry; i++) {
      try {
        const resp = await fetch('/api/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, method, body, headers }),
        });
        if (!resp.ok) throw new Error('代理返回 ' + resp.status);
        return await resp.text();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
    throw lastErr || new Error('抓取失败');
  }

  function newCtx() { return { vars: {}, baseUrl: '', source: {} }; }

  // 解析书源自带的 header（sources.json 里是 JSON 字符串，legado 会原样透传给请求）
  function parseHeader(src) {
    let h = src && src.header;
    if (typeof h === 'string') { try { h = JSON.parse(h); } catch (e) { h = {}; } }
    return h && typeof h === 'object' ? h : {};
  }
  // 相对路径拼成绝对地址（legado 会用 bookSourceUrl 做基准，否则 /s/1.html 会打到 localhost）
  function resolveAbs(url, base) {
    if (!url) return url;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return url;
    if (!base) return url;
    try { return new URL(url, base).href; } catch (e) { return url; }
  }
  // 并发池：同时最多 n 个任务
  async function mapPool(items, n, fn) {
    let i = 0; const ret = [];
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const idx = i++; ret.push(await fn(items[idx], idx)); }
    });
    await Promise.all(workers);
    return ret;
  }

  // ---------------- 书源健康检测（精选可用源）----------------
  // health: Map<srcIdx, 'ok'|'bad'>；未探测的源视为 unknown，搜索时按"可用"处理；一旦探测标记为 bad 则剔除。
  const health = new Map();
  let healthProbeRunning = false;
  let hadLocalHealth = false;
  const HEALTH_KEY = 'nov_health_v1';
  const PROBE_KWS = ['斗破', '凡人']; // 绝大多数聚合站都有这两本，用作探针词（首个命中即 ok）
  // 解析书源自带 header 已在上面定义，这里直接复用 parseHeader / resolveAbs / newCtx

  function loadHealthLocal() {
    try {
      const raw = localStorage.getItem(HEALTH_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && obj.v === 1 && obj.map) {
        let n = 0;
        for (const k in obj.map) { health.set(Number(k), obj.map[k]); n++; }
        if (n) hadLocalHealth = true;
      }
    } catch (e) { /* ignore */ }
  }
  function saveHealthLocal() {
    try {
      const map = {};
      health.forEach((v, k) => { map[k] = v; });
      localStorage.setItem(HEALTH_KEY, JSON.stringify({ v: 1, map, at: Date.now() }));
    } catch (e) { /* ignore */ }
  }
  // 读取 webapp/sources-health.json（由探针脚本在"好 IP"环境生成）作为预标记，避免上线后重新探测全部
  async function loadHealthSeed() {
    try {
      const resp = await fetch('sources-health.json?' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) return;
      const obj = await resp.json();
      if (obj && obj.map) {
        for (const k in obj.map) {
          const idx = Number(k), st = obj.map[k];
          if (st === 'bad' && !health.has(idx)) health.set(idx, 'bad'); // 种子只预标 bad，ok 仍由后台探测确认
        }
      }
    } catch (e) { /* 没有种子文件就用本地/localStorage 的 */ }
  }
  function usableCount() {
    let ok = 0;
    SOURCES.forEach((s, i) => { if (health.get(i) !== 'bad') ok++; });
    return ok;
  }
  function updateHealthBar(extra) {
    const bar = $('healthBar');
    if (!bar) return;
    const total = SOURCES.length;
    const usable = usableCount();
    const probing = healthProbeRunning ? '（检测中…）' : '';
    bar.querySelector('.hb-text').textContent = '可用源 ' + usable + ' / ' + total + probing + (extra ? ' · ' + extra : '');
  }
  async function probeFetchText(url, src) {
    const resp = await fetch('/api/fetch?timeout=8000', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method: 'GET', body: null, headers: Object.assign({ 'User-Agent': UA }, parseHeader(src)) }),
    });
    if (!resp.ok) throw new Error('代理 ' + resp.status);
    return await resp.text();
  }
  async function probeOne(src, idx) {
    try {
      const ctx = newCtx(); ctx.source = src;
      let searchUrl = BookEngine.fillTemplates(src.searchUrl || '', { key: PROBE_KWS[0] }, ctx);
      searchUrl = resolveAbs(searchUrl, src.bookSourceUrl);
      const html = await probeFetchText(searchUrl, src);
      ctx.baseUrl = searchUrl;
      let books = BookEngine.parseSearch(html, src, ctx);
      if (!books.length && PROBE_KWS[1]) { // 第一个词没结果，再用第二个词试一次
        const ctx2 = newCtx(); ctx2.source = src;
        const u2 = resolveAbs(BookEngine.fillTemplates(src.searchUrl || '', { key: PROBE_KWS[1] }, ctx2), src.bookSourceUrl);
        const h2 = await probeFetchText(u2, src);
        ctx2.baseUrl = u2;
        books = BookEngine.parseSearch(h2, src, ctx2);
      }
      health.set(idx, books.length ? 'ok' : 'bad'); // 返回 0 本也视为该源当前不可用
    } catch (e) {
      health.set(idx, 'bad');
    }
    updateHealthBar();
  }
  async function startHealthProbe() {
    if (healthProbeRunning) return;
    healthProbeRunning = true;
    updateHealthBar();
    const targets = [];
    SOURCES.forEach((s, i) => { if (s.searchUrl && health.get(i) !== 'ok') targets.push([s, i]); }); // 跳过已确认 ok
    let i = 0;
    const worker = async () => {
      while (i < targets.length) {
        const [s, idx] = targets[i++];
        await probeOne(s, idx);
        if (i % 10 === 0) saveHealthLocal();
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
    healthProbeRunning = false;
    saveHealthLocal();
    updateHealthBar('检测完成');
  }
  function resetHealth() {
    health.clear();
    hadLocalHealth = false;
    try { localStorage.removeItem(HEALTH_KEY); } catch (e) {}
    updateHealthBar();
    startHealthProbe();
  }
  function exportHealth() {
    const map = {};
    health.forEach((v, k) => { map[k] = v; });
    const blob = new Blob([JSON.stringify({ v: 1, map, at: Date.now() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sources-health.json';
    a.click();
    showToast('已导出健康清单，放到 webapp 目录即可作为种子');
  }

  // ---------------- 书源加载（后台，不阻塞 UI）----------------
  async function loadSources(retryCount = 0) {
    try {
      $('sourceBar').innerHTML = '<span style="color:var(--muted);font-size:13px;">书源加载中…</span>';
      const resp = await fetch('sources.json?' + Date.now(), { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const txt = await resp.text();
      SOURCES = JSON.parse(txt).filter((s) => s.enabled !== false);
      // 清理垃圾源：同域名重复源只保留首个，其余禁用（不删数组，避免破坏已存书架的 srcIdx 索引）
      disabledSrc = new Set();
      (function () {
        const seen = {};
        SOURCES.forEach((s, i) => {
          let d = '';
          try { const h = new URL(s.bookSourceUrl || '').hostname; const p = h.split('.'); d = p.slice(-2).join('.'); } catch (e) {}
          if (!d) return;
          if (seen[d] !== undefined) disabledSrc.add(i); else seen[d] = i;
        });
        if (disabledSrc.size) console.log('[sources] 已禁用 ' + disabledSrc.size + ' 个重复域名冗余源，活跃域 ' + (SOURCES.length - disabledSrc.size) + ' 个');
      })();
      sourcesLoaded = true;
      renderSourceBar();
      // 启动书源健康检测（精选可用源）：本地缓存优先，否则读种子文件，都没有则首次自动全量探测
      loadHealthLocal();
      await loadHealthSeed();
      updateHealthBar();
      if (!hadLocalHealth && health.size === 0) startHealthProbe();
      console.log('[init] 书源已加载:', SOURCES.length, '个');
    } catch (e) {
      console.error('[init] 书源加载失败 (尝试' + (retryCount + 1) + '):', e.message, e);
      if (retryCount < 2) {
        await new Promise(r => setTimeout(r, 800));
        return loadSources(retryCount + 1); // 自动重试
      }
      $('sourceBar').innerHTML = '<span style="color:#c44030;font-size:13px;">书源加载失败（可仍用搜索）</span>';
      sourcesLoaded = false;
    }
  }

  function renderSourceBar() {
    const bar = $('sourceBar');
    bar.innerHTML = '';
    const all = mkChip('全部源', activeSourceIdx === -1);
    all.onclick = () => { activeSourceIdx = -1; renderSourceBar(); };
    bar.appendChild(all);
    SOURCES.slice(0, 40).forEach((s, i) => {
      const c = mkChip((s.bookSourceName || ('源' + i)).replace(/[\u{1F300}-\u{1FAFF}]/gu, ''), activeSourceIdx === i);
      c.onclick = () => { activeSourceIdx = i; renderSourceBar(); };
      bar.appendChild(c);
    });
  }
  function mkChip(text, active) {
    const c = document.createElement('div');
    c.className = 'chip' + (active ? ' active' : '');
    c.textContent = text;
    return c;
  }

  // ---------------- 搜索 ----------------
  async function doSearch() {
    const mySeq = ++searchSeq; // 本次搜索序号
    const kw = $('searchInput').value.trim();
    if (!kw) { showToast('请输入书名或作者'); return; }

    showLoading(true);
    $('resultTitle').classList.remove('hidden');
    $('resultTitle').textContent = '搜索中…';

    if (!sourcesLoaded) {
      $('resultList').innerHTML = '<p style="color:var(--muted);grid-column:1/-1;padding:20px 0;">书源还在加载中，稍后再搜…</p>';
      showLoading(false);
      return;
    }

    // 全部源模式下，用健康检测结果剔除已确认不可用的源（精选可用源）；指定单源时一律尊重用户选择
    let sourcesToSearch;
    if (activeSourceIdx >= 0) {
      sourcesToSearch = [SOURCES[activeSourceIdx]];
    } else {
      sourcesToSearch = SOURCES.filter((s, i) => s.searchUrl && health.get(i) !== 'bad' && !disabledSrc.has(i));
    }

    const results = [];
    let done = 0;
    const kwLower = kw.toLowerCase();
    function score(b) {
      const n = (b.name || '').toLowerCase();
      const a = (b.author || '').toLowerCase();
      // 硬性门槛：书名或作者必须包含搜索关键词，否则 0 分（直接剔除）
      if (!n.includes(kwLower) && !a.includes(kwLower)) return 0;
      let s = n === kwLower ? 100 : n.startsWith(kwLower) ? 80 : n.includes(kwLower) ? 60 : a.includes(kwLower) ? 40 : 0;
      // 有作者信息的书更可能是正版/完整版，同分时微升
      if (a) s += 2;
      if (b.coverUrl) s += 1; // 有封面说明书源信息更完整
      return s;
    }
    function renderNow() {
      if (mySeq !== searchSeq) return; // 已有更新的搜索发起，丢弃本次迟到结果（竞态防护）
      results.forEach((b) => { if (b._score == null) b._score = score(b); });
      // 剔除 0 分结果（书名和作者都不包含搜索关键词的无关书籍）
      const filtered = results.filter((b) => (b._score || 0) > 0);
      filtered.sort((a, b) => (b._score || 0) - (a._score || 0));
      const grouped = window.groupBooks ? window.groupBooks(filtered) : filtered;
      renderBooks(grouped, 'resultList', 'home');
      $('resultTitle').textContent = '搜索结果（' + grouped.length + ' 本，已查 ' + done + '/' + sourcesToSearch.length + ' 源）';
    }

    // 并发搜全部启用源（每次最多 16 个），结果边搜边出，不再只搜前 10 个
    await mapPool(sourcesToSearch, 16, async (src) => {
      try {
        const ctx = newCtx();
        ctx.source = src;
        let searchUrl = BookEngine.fillTemplates(src.searchUrl || '', { key: kw }, ctx);
        searchUrl = resolveAbs(searchUrl, src.bookSourceUrl); // 相对路径拼域名（legado 行为）
        const html = await proxyFetch(searchUrl, { key: kw }, 2, parseHeader(src)); // 透传书源 header
        ctx.baseUrl = searchUrl; // 让搜索结果里的相对 bookUrl 能拼回绝对地址
        const books = BookEngine.parseSearch(html, src, ctx);
        books.forEach((b) => { b._srcIdx = SOURCES.indexOf(src); b._srcName = src.bookSourceName; b._score = score(b); });
        if (books.length) { results.push(...books); renderNow(); }
      } catch (e) {
        console.warn('搜索失败 [' + (src.bookSourceName || '?') + ']:', e.message);
      } finally {
        done++;
        if (done % 3 === 0 || done === sourcesToSearch.length) renderNow();
      }
    });

    showLoading(false);
    if (!results.length) $('resultList').innerHTML = '<p style="color:var(--muted);grid-column:1/-1;padding:20px 0;">没搜到结果，换个关键词或书源试试</p>';
    renderNow();
  }

  // ---------------- 相关度排序辅助（用于去重后重排）----------------
  function scoreRelevance(book, kw) {
    const kl = kw.toLowerCase();
    const n = (book.name || '').toLowerCase();
    const a = (book.author || '').toLowerCase();
    if (n === kl) return 100;
    if (n.startsWith(kl)) return 80;
    if (n.includes(kl)) return 60;
    if (a.includes(kl)) return 40;
    return 20;
  }

  // ---------------- 封面渲染（真实优先 + 渐变兜底，永不空白）----------------
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  const COVER_GRADS = [
    'linear-gradient(135deg,#667eea,#764ba2)',
    'linear-gradient(135deg,#f093fb,#f5576c)',
    'linear-gradient(135deg,#4facfe,#00f2fe)',
    'linear-gradient(135deg,#43e97b,#38f9d7)',
    'linear-gradient(135deg,#fa709a,#fee140)',
    'linear-gradient(135deg,#30cfd0,#330867)',
    'linear-gradient(135deg,#a18cd1,#fbc2eb)',
    'linear-gradient(135deg,#ff9a9e,#fecfef)',
    'linear-gradient(135deg,#2af598,#009efd)',
    'linear-gradient(135deg,#ee9ca7,#ffdde1)',
  ];
  function gradFor(name) {
    const s = name || '?'; let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return COVER_GRADS[h % COVER_GRADS.length];
  }
  function coverHtml(b, cls) {
    const name = b.name || '?';
    const url = (b.coverUrl || '').trim();
    if (url && /^https?:\/\//i.test(url)) {
      return '<img class="' + cls + '" src="' + escHtml(b.coverUrl) + '" alt="" '
        + 'data-name="' + escHtml(name) + '" data-author="' + escHtml(b.author || '') + '" onerror="coverFail(this)" />';
    }
    const g = gradFor(name);
    const t = escHtml(name).slice(0, 6);
    const au = b.author ? '<span class="ph-author">' + escHtml(b.author) + '</span>' : '';
    return '<div class="' + cls + ' ph-cover" style="background:' + g + '"><span class="ph-title">' + t + '</span>' + au + '</div>';
  }
  function coverFail(img) {
    const g = gradFor(img.dataset.name || '?');
    const t = escHtml(img.dataset.name || '?').slice(0, 6);
    const au = img.dataset.author ? '<span class="ph-author">' + escHtml(img.dataset.author) + '</span>' : '';
    const cls = img.className;
    img.outerHTML = '<div class="' + cls + ' ph-cover" style="background:' + g + '"><span class="ph-title">' + t + '</span>' + au + '</div>';
  }
  window.coverFail = coverFail;

  // ---------------- 渲染书籍列表 ----------------
  function renderBooks(list, containerId, fromView) {
    const el = $(containerId);
    el.innerHTML = '';
    if (!list.length) {
      el.innerHTML = '<p style="color:var(--muted);grid-column:1/-1;padding:20px 0;">暂无结果</p>';
      return;
    }
    list.forEach((b) => {
      const card = document.createElement('div');
      card.className = 'book-card';
      const srcCount = Array.isArray(b._sources) ? b._sources.length : 0;
      const badge = srcCount > 1 ? '<span class="src-badge">' + srcCount + ' 源</span>' : '';
      card.innerHTML = coverHtml(b, 'cover') + badge
        + '<div class="book-title">' + (b.name || '未知') + '</div>'
        + '<div class="author">' + (b.author || '') + '</div>';
      card.onclick = () => { prevView = fromView || 'home'; openBook(b); };
      el.appendChild(card);
    });
  }

  // ---------------- 详情 + 目录（多书源选择 / 换源）----------------
  async function openBook(merged, opts) {
    opts = opts || {};
    currentBook = merged;
    const direct = !!opts.direct;

    if (!direct) {
      // 搜索结果 → 详情页（查看简介、选源、加书架）
      prevBeforeDetail = prevView || 'home'; // 保存进入详情前的视图，供‹返回用
      showView('detail');
      $('dName').textContent = merged.name || '';
      $('dAuthor').textContent = merged.author || '';
      $('dCoverWrap').innerHTML = coverHtml(merged, 'cover');
      $('dIntro').textContent = merged.intro || '';
      const kindEl = $('dKind');
      const srcs = merged._sources || [];
      if (srcs.length > 1) { kindEl.textContent = '共 ' + srcs.length + ' 个书源可选'; kindEl.style.display = ''; }
      else if (srcs.length === 1) { kindEl.textContent = srcs[0].srcName || '单一书源'; kindEl.style.display = ''; }
      else { kindEl.style.display = 'none'; }
      const lastEl = $('dLast'); if (lastEl) lastEl.style.display = 'none';
      renderSourceSelect(merged);
    } else {
      // 书架 → 直接进阅读器，跳过详情页
      prevView = 'shelf';
      showView('reader');
      maybeShowReaderHint();
      $('rTitle').textContent = currentBook.name || '';
      $('readerContent').innerHTML = '<p style="color:var(--muted);padding:40px 0;text-align:center;">正在准备目录...</p>';
      hideReaderMenu();
    }

    const srcs = merged._sources || [];
    // 挑源策略：优先上次用过且非失效的源；否则第一个有链接且非失效的源。
    // 加载失败（无目录/超时）自动标记为失效并换下一个，避免每次都卡在第一个无效源。
    let entry = pickSourceForBook(merged);
    if (!entry) {
      if (direct) $('readerContent').innerHTML = '<p style="color:#c44030;padding:40px 0;text-align:center;">该书在所有书源中都没有可用的详情链接</p>';
      else $('tocList').innerHTML = '<p style="color:#c44030;padding:12px 0;">该书在所有书源中都没有可用的详情链接</p>';
      return;
    }
    let tried = 0;
    while (entry && tried < srcs.length) {
      await loadSource(merged, entry);
      if (currentToc.length > 0) { setBookSel(bookId(merged), entry.srcIdx); break; }
      markSrcBad(bookId(merged), entry.srcIdx);
      const bad = new Set((getSrcPrefAll()[bookId(merged)] || {}).bad || []);
      const next = srcs.find((s) => s.bookUrl && !bad.has(s.srcIdx) && s.srcIdx !== entry.srcIdx);
      if (!next) break;
      entry = next; tried++;
    }

    // 续读 / 首章：目录加载完后直接跳到目标章节
    if (currentToc && currentToc.length) {
      const saved = loadProgress(merged);
      const target = (opts.autoChap != null) ? Math.max(0, Math.min(opts.autoChap, currentToc.length - 1)) : 0;
      if (!direct) prevView = 'detail'; // 从详情页进阅读器，返回应回详情页（书架直进已在开头设 'shelf'）
      openChapter(target, saved ? saved.page : 0); // 恢复上次阅读到的页
      // 书架直进且源较少时，后台静默补充更多源（解决"搜索中途进书导致源不全"）
      if (direct && (!merged._sources || merged._sources.length < 10)) { enrichSources(merged); }
    } else {
      // 所有书源都试过了仍无目录 → 先尝试补充源再兜底
      if (direct) await enrichSources(merged);
      if (currentToc && currentToc.length) {
        const saved = loadProgress(merged);
        openChapter(opts.autoChap || 0, saved ? saved.page : 0);
      } else {
        showAllSourcesFailed(merged, direct);
      }
    }
  }

  // 所有书源都不可用时的友好兜底（不会崩溃/空白）
  function showAllSourcesFailed(merged, direct) {
    const n = (merged._sources || []).length;
    const wrap = document.createElement('div');
    wrap.className = 'src-all-failed';
    wrap.innerHTML = '<div class="saf-ico">📭</div>'
      + '<div class="saf-title">该书的所有书源暂时都不可用</div>'
      + '<div class="saf-sub">共 ' + n + ' 个书源，当前均无法返回目录或正文<br>可能是书源已失效、站点反爬拦截或网络异常</div>';
    const actions = document.createElement('div');
    actions.className = 'saf-actions';
    const retry = document.createElement('button');
    retry.className = 'btn primary'; retry.textContent = '重试';
    retry.onclick = () => { resetHealth(); clearBookBad(bookId(merged)); openBook(merged, { direct: !!direct, autoChap: 0 }); };
    actions.appendChild(retry);
    if (direct) {
      const back = document.createElement('button');
      back.className = 'btn'; back.textContent = '返回书架';
      back.onclick = () => showView('shelf');
      actions.appendChild(back);
    }
    wrap.appendChild(actions);
    if (direct) { $('readerContent').innerHTML = ''; $('readerContent').appendChild(wrap); }
    else { $('tocList').innerHTML = ''; $('tocList').appendChild(wrap); }
  }

  // 从书架直接进正文（跳过详情）
  function openBookDirect(b) {
    const p = loadProgress(b);
    openBook(b, { direct: true, autoChap: p ? p.chap : 0 });
  }

  // 为已合并的书补充更多书源（从书架打开时，原搜索可能只查了部分源）
  async function enrichSources(merged) {
    const name = (merged.name || '').trim();
    const author = (merged.author || '').trim();
    if (!name) return;
    const existingIdx = new Set((merged._sources || []).map((s) => s.srcIdx));
    let added = 0;
    // 用健康可用源做快速补充搜索（静默，不渲染结果列表）
    const extraSources = SOURCES.filter((s, i) => s.searchUrl && health.get(i) !== 'bad' && !disabledSrc.has(i) && !existingIdx.has(i));
    await mapPool(extraSources.slice(0, 30), 10, async (src) => {
      try {
        const ctx = newCtx(); ctx.source = src;
        let url = BookEngine.fillTemplates(src.searchUrl || '', { key: name }, ctx);
        url = resolveAbs(url, src.bookSourceUrl);
        const html = await proxyFetch(url, { key: name }, 1, parseHeader(src));
        ctx.baseUrl = url;
        const books = BookEngine.parseSearch(html, src, ctx);
        const hit = books.find((b) => {
          const n = (b.name || '').trim(); const a = (b.author || '').trim();
          return n === name && (!author || !a || a === author || author.includes(a) || a.includes(author));
        });
        if (hit && merged._sources) {
          merged._sources.push({ srcIdx: SOURCES.indexOf(src), srcName: src.bookSourceName, coverUrl: hit.coverUrl || '', bookUrl: hit.bookUrl || '', intro: hit.intro || '', author: hit.author || '' });
          added++;
        }
      } catch (e) { /* 静默忽略 */ }
    });
    if (added > 0) {
      console.log('[enrich] 为《' + name + '》补充了 ' + added + ' 个新书源（总计 ' + merged._sources.length + '）');
      // 刷新详情页源列表（如果在详情页的话）
      if (!$('detailView').classList.contains('hidden')) renderSourceSelect(merged);
    }
  }

  // 阅读器首次引导（只提示一次，避免读者不知道如何翻页/唤出菜单）
  function maybeShowReaderHint() {
    if (localStorage.getItem('nov_reader_hint')) return;
    localStorage.setItem('nov_reader_hint', '1');
    const h = $('readerHint');
    if (!h) return;
    h.textContent = '点屏幕两侧翻页 · 点中间唤出菜单与设置';
    h.classList.add('show');
    setTimeout(() => h.classList.remove('show'), 3400);
  }

  // 渲染书源选择条（失效源标注"失效"并排到后面）
  function renderSourceSelect(merged) {
    const box = $('sourceSelect');
    const srcsAll = merged._sources || [];
    const head = $('srcHead');
    if (head) head.textContent = '书源（' + srcsAll.length + '）· 点不可看的源可换其他';
    box.innerHTML = '';
    const bad = new Set(((getSrcPrefAll()[bookId(merged)] || {}).bad || []));
    const srcs = (merged._sources || []).slice().sort((a, b) => (bad.has(a.srcIdx) ? 1 : 0) - (bad.has(b.srcIdx) ? 1 : 0));
    srcs.forEach((s) => {
      const i = merged._sources.indexOf(s);
      const isBad = bad.has(s.srcIdx);
      const item = document.createElement('div');
      item.className = 'src-item' + (currentSrcEntry === s ? ' active' : '') + (isBad ? ' disabled' : '');
      const ok = !!s.bookUrl && !isBad;
      item.innerHTML = '<span class="src-name">' + (s.srcName || ('源' + (i + 1))) + '</span>'
        + '<span class="src-status ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '可看' : (isBad ? '失效' : '无链接')) + '</span>';
      item.onclick = () => selectSource(merged, i);
      box.appendChild(item);
    });
  }

  // 用户点击某个书源 → 切换并重新加载（换源）
  async function selectSource(merged, i) {
    const s = merged._sources[i];
    if (!s) return;
    await loadSource(merged, s);
    if (currentToc.length > 0) setBookSel(bookId(merged), s.srcIdx); // 手动选的可用源记为默认
  }

  // 用指定书源加载详情 + 目录
  async function loadSource(merged, entry) {
    currentSrcEntry = entry;
    currentToc = []; // 先清空，避免上本书的目录残留被误判为"加载成功"
    const src = SOURCES[entry.srcIdx];
    if (!src) { showToast('书源信息丢失'); return; }

    renderSourceSelect(merged); // 刷新高亮

    // 检测当前是否在阅读器视图（书架直跳 / direct 模式），是则更新 readerContent 而非 tocList
    const inReader = !$('readerView').classList.contains('hidden');
    const statusEl = inReader ? $('readerContent') : $('tocList');
    const setStatus = (html) => {
      if (inReader) {
        statusEl.innerHTML = '<p style="color:var(--muted);padding:40px 0;text-align:center;">' + html + '</p>';
      } else {
        statusEl.innerHTML = '<p style="color:var(--muted);padding:12px 0;">' + html + '</p>';
      }
    };
    setStatus('目录加载中…（' + (entry.srcName || '') + '）');

    if (!entry.bookUrl) {
      setStatus('<span style="color:#c44030;">该源未提供详情页链接，点其他源试试</span>');
      return;
    }

    try {
      const ctx = newCtx(); ctx.source = src;
      let biUrl = BookEngine.fillTemplates(entry.bookUrl, {}, ctx);
      biUrl = resolveAbs(biUrl, src.bookSourceUrl);
      if (!biUrl) {
        setStatus('<span style="color:#c44030;">详情页链接解析为空</span>');
        return;
      }
      ctx.baseUrl = biUrl;

      // 用 Promise.race 加 25 秒超时兜底（防止某个站一直不响应导致永久卡在"正在准备目录"）
      const fetchWithTimeout = (url, opts) => Promise.race([
        proxyFetch(url, {}, 2, parseHeader(src)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('请求超时')), 25000))
      ]);

      setStatus('正在获取书籍信息…');
      const html = await fetchWithTimeout(biUrl, {});
      const info = BookEngine.parseBookInfo(html, src, ctx);

      // 用当前源详情刷新头部（更准确）
      if (!$('dName')) { /* detail view may not be visible */ }
      else { $('dName').textContent = info.name || merged.name || ''; }
      if (!$('dAuthor')) { /* */ }
      else { $('dAuthor').textContent = info.author || merged.author || ''; }
      if (!$('dIntro')) { /* */ }
      else { $('dIntro').textContent = info.intro || merged.intro || ''; }
      if ($('dCoverWrap')) {
        const bestCover = info.coverUrl || merged.coverUrl || '';
        $('dCoverWrap').innerHTML = coverHtml(Object.assign({}, merged, { coverUrl: bestCover }), 'cover');
      }

      // 目录
      let tocUrl = info.tocUrl || entry.bookUrl || biUrl;
      tocUrl = resolveAbs(tocUrl, src.bookSourceUrl);
      if (!tocUrl) {
        setStatus('<span style="color:#c44030;">该源未提供目录链接</span>');
        return;
      }
      ctx.baseUrl = tocUrl;
      setStatus('正在获取章节目录…');
      const tocRaw = await fetchWithTimeout(tocUrl, {});
      currentToc = BookEngine.parseToc(tocRaw, src, ctx);

      if (!currentToc.length) {
        markSrcBad(bookId(merged), entry.srcIdx); // 无目录 = 失效源，记录后下次自动跳过
        setStatus('<span style="color:#e67e22;">该源没有返回章节目录，正在尝试其他书源…</span>');
        return;
      }

      renderToc();
    } catch (e) {
      console.error('详情/目录加载失败:', e);
      markSrcBad(bookId(merged), entry.srcIdx); // 加载失败（超时/报错）也记为失效源
      var errMsg = e.message || String(e);
      if (errMsg.includes('超时')) {
        setStatus('<span style="color:#c44030;">加载超时，网络可能较慢或该站不可用<br><span style="font-size:13px;color:var(--muted)">建议点击「换源」试试其他书源</span></span>');
      } else {
        setStatus('<span style="color:#c44030;">加载失败: ' + errMsg.slice(0, 50) + '，点其他源试试</span>');
      }
    }
  }

  let tocReverse = false;
  function renderToc() {
    const el = $('tocList');
    el.innerHTML = '';
    const list = tocReverse ? currentToc.slice().reverse() : currentToc;
    list.forEach((ch, k) => {
      const realIdx = tocReverse ? currentToc.length - 1 - k : k;
      const item = document.createElement('div');
      item.className = 'toc-item';
      const wc = fmtWordCount(chapterWordCounts[realIdx]);
      item.innerHTML = '<span class="toc-name">' + escapeHtml(ch.name || ('第' + (realIdx + 1) + '章')) + '</span>'
        + (wc ? '<span class="toc-wc">' + wc + '</span>' : '');
      item.onclick = () => openChapter(realIdx); // 点章节直接跳读 = 章节导航
      el.appendChild(item);
    });
    const cnt = $('tocCount'); if (cnt) cnt.textContent = (currentToc.length || 0) + ' 章';
    el.scrollTop = 0;
  }

  // ---------------- 阅读器 ----------------

  // 正文格式化：纯文本 → 番茄小说"一段一句"风格
  function formatContentParagraphs(text) {
    if (!text) return '';
    text = text.trim().replace(/\n{3,}/g, '\n\n');
    var blocks = text.split(/\n\n+/);
    var paras = [];
    blocks.forEach(function (block) {
      block = block.trim();
      if (!block) return;
      var sentences = block.split(/(?<=[。！？…])\s*/);
      sentences.forEach(function (s) {
        s = s.trim();
        if (!s) return;
        var html = s.replace(/\n/g, '<br/>');
        paras.push('<p>' + escapeHtml(html) + '</p>');
      });
    });
    return paras.join('');
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- 滚动触底自动加载下一章（无缝滚动模式）----
  var autoLoadingNext = false;
  var autoLoadBound = false; // 只绑定一次，避免在 openChapter 里 cloneNode 把正文点击监听也干掉
  function bindAutoLoadNext() {
    if (autoLoadBound) return;
    autoLoadBound = true;
    var el = $('readerContent');
    if (!el) return;
    // 监听挂在稳定的 readerContent 元素上（innerHTML 替换不会丢监听），不 clone 替换
    el.addEventListener('scroll', function () {
      if (currentPageMode === 'page') return; // 翻页模式不自动加载
      if (autoLoadingNext || !currentToc || currentChap >= currentToc.length - 1) return;
      var dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist < 300 && dist > -50) { autoLoadNextChapter(); }
    }, { passive: true });
  }
  async function autoLoadNextChapter() {
    if (autoLoadingNext || !currentToc || currentChap >= currentToc.length - 1) return;
    autoLoadingNext = true;
    var nextIdx = currentChap + 1;
    var ch = currentToc[nextIdx];
    var body = document.querySelector('.reader-body', $('readerContent'));
    if (body) {
      var hint = document.createElement('div');
      hint.id = 'autoLoadHint';
      hint.style.cssText = 'text-align:center;color:var(--muted);padding:24px 0 40px;font-size:14px;';
      hint.innerHTML = '\u23F3 \u6B63\u5728\u52A0\u8F7D\u300C' + escapeHtml(ch.name || '') + '\u300D…';
      body.appendChild(hint);
    }
    try { await openChapterSilent(nextIdx); }
    catch (e) {
      console.warn('[autoLoad] next chapter failed:', e);
      var h = document.getElementById('autoLoadHint');
      if (h) h.innerHTML = '<span style="color:#e67e22;">加载失败，点击右侧区域手动翻页</span>';
    } finally { autoLoadingNext = false; }
  }
  async function openChapterSilent(idx) {
    if (idx < 0 || idx >= currentToc.length || !currentSrcEntry) return;
    currentChap = idx;
    var ch = currentToc[idx];
    var src = SOURCES[currentSrcEntry.srcIdx];
    $('rProg').textContent = '\u7B2C ' + (idx + 1) + ' / ' + currentToc.length + ' \u7AE0';
    $('rChap').textContent = (ch && ch.name) || '';
    updateMiniBar();

    var ctx = newCtx(); ctx.source = src;
    var chapUrl = resolveAbs(ch.url, src.bookSourceUrl);
    ctx.baseUrl = chapUrl;

    var MAX_PAGES = 20, allContent = '', curUrl = chapUrl;
    for (var pg = 0; pg < MAX_PAGES; pg++) {
      var raw = await proxyFetch(curUrl, {}, 2, parseHeader(src));
      ctx.baseUrl = curUrl;
      var result = BookEngine.parseContent(raw, src, ctx);
      var content = typeof result === 'string' ? result : (result && result.content) || '';
      allContent += (allContent ? '\n\n' : '') + content;
      var nextUrl = typeof result === 'object' ? (result.nextUrl || '') : '';
      if (!nextUrl || nextUrl === curUrl) break;
      curUrl = resolveAbs(nextUrl, src.bookSourceUrl);
    }

    var content = allContent.trim();
    var body = document.querySelector('.reader-body', $('readerContent'));
    if (!body) { saveProgress(); return; }

    var hint = document.getElementById('autoLoadHint');
    if (hint) hint.remove();

    if (!content || content.length < 30) {
      var d = document.createElement('div');
      d.style.cssText = 'text-align:center;color:#e67e22;padding:20px 0;font-size:14px;';
      d.textContent = '\u300C' + (ch.name || '') + '\u300D内容为空或过短，建议换源';
      body.appendChild(d);
      saveProgress(); return;
    }

    var sep = document.createElement('div');
    sep.className = 'chap-separator';
    sep.innerHTML = '<h3 class="reader-chap-title" style="margin-top:36px;border:none;">' + escapeHtml(ch.name || '') + '</h3>';
    body.appendChild(sep);

    var hasBlock = /<(p|div|section|article|br\s*\/?)\b/i.test(content);
    var w = document.createElement('div');
    w.innerHTML = hasBlock
      ? content.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>')
      : formatContentParagraphs(content);
    while (w.firstChild) body.appendChild(w.firstChild);
    saveProgress();
  }

  async function openChapter(idx, startPage) {
    if (idx < 0 || idx >= currentToc.length) return;
    if (!currentSrcEntry) { showToast('请先选择一个书源'); return; }
    currentChap = idx;
    refreshBmBtn();
    const ch = currentToc[idx];
    const src = SOURCES[currentSrcEntry.srcIdx];

    showView('reader');
    maybeShowReaderHint();
    $('rTitle').textContent = currentBook.name || '';
    $('rChap').textContent = ch.name || '';
    const cn = $('rChapNav'); if (cn) cn.textContent = (idx + 1) + '/' + currentToc.length;
    $('rProg').textContent = '第 ' + (idx + 1) + ' / ' + currentToc.length + ' 章';
    updateMiniBar();
    updateNavArrows();
    $('readerContent').innerHTML = '<p style="color:var(--muted);padding:20px 0;text-align:center;">加载中...</p>';
    hideReaderMenu();

    try {
      const ctx = newCtx(); ctx.source = src;
      let chapUrl = ch.url;
      chapUrl = resolveAbs(chapUrl, src.bookSourceUrl); // 章节相对路径→绝对地址（legado 行为）
      ctx.baseUrl = chapUrl;

      // 分页循环：抓第1页 → 检查 nextContentUrl → 有则继续抓下一页，最多20页防死循环
      const MAX_PAGES = 20;
      let allContent = '';
      let curUrl = chapUrl;
      for (let pg = 0; pg < MAX_PAGES; pg++) {
        const raw = await proxyFetch(curUrl, {}, 2, parseHeader(src));
        ctx.baseUrl = curUrl;
        const result = BookEngine.parseContent(raw, src, ctx);
        // 兼容旧格式：如果返回的是字符串（不应发生但防御），包装成对象
        const content = typeof result === 'string' ? result : (result && result.content) || '';
        allContent += (allContent ? '\n\n' : '') + content;
        // 取得"下一页"URL
        const nextUrl = typeof result === 'object' ? (result.nextUrl || '') : '';
        if (!nextUrl || nextUrl === curUrl) break;
        // 下一页可能是相对路径
        curUrl = resolveAbs(nextUrl, src.bookSourceUrl);
      }

      const rawContent = allContent.trim();
      // 去广告/清洗：第三方镜像站常注入推广文案（"收藏网址 52shuku"等）
      const cleaned = cleanContent(rawContent);
      const content = cleaned.html || rawContent; // 清洗后为空则回退原文
      // 缓存本章字数（用于目录显示）：用清洗后的纯文本字符数
      if (cleaned.text && cleaned.text.length >= 30) {
        chapterWordCounts[idx] = cleaned.text.length;
      } else if (content.length >= 30) {
        chapterWordCounts[idx] = content.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, '').length || content.length;
      }
      // 存清洗后纯文本（听书 TTS 用）
      currentChapterText = cleaned.text || content.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ');
      let bodyHtml;
      if (!content || content.trim().length < 30) {
        // 正文为空或过短（<30 字符）→ 可能源正文规则依赖 JS/Java，或页面被反爬拦
        const rc = src.ruleContent;
        const cRule = (rc && typeof rc === 'object' ? rc.content : rc) || '';
        const isJsRule = /<js>|@js:/i.test(cRule);
        bodyHtml =
          '<div style="padding:24px 16px;text-align:center;">'
          + '<p style="color:var(--muted);margin-bottom:12px;">该章节正文为空或内容过短</p>'
          + (isJsRule ? '<p style="color:#e67e22;font-size:13px;margin-bottom:12px;">此书源的正文规则使用了 JS/Java 脚本（浏览器环境可能不支持）</p>' : '')
          + '<p style="color:var(--muted);font-size:13px;">建议：点击右下角「换源」切换其他书源试试</p>'
          + '</div>';
      } else {
        // 正文排版：参考番茄小说"一段一句"风格；源自带 HTML 直接用，纯文本智能分句
        const hasBlock = /<(p|div|section|article|br\s*\/?)\b/i.test(content);
        bodyHtml = hasBlock
          ? content.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>')
          : formatContentParagraphs(content);
      }
      // 存入当前章缓存，交给 renderCurrentChapter 按模式（滚动/翻页）渲染
      currentChapterTitle = ch.name || '';
      currentChapterHtml = bodyHtml;
      // 起始页：'last' 跳末页（上一章翻页到本章），数字则指定页，否则第 1 页
      if (startPage === 'last') currentPageNo = 999999;
      else if (typeof startPage === 'number') currentPageNo = startPage;
      else currentPageNo = 0;
      renderCurrentChapter(content && content.trim().length >= 30 ? 'fade' : null);
      saveProgress();
    } catch (e) {
      $('readerContent').innerHTML = '<p style="color:#c44030;padding:20px 0;text-align:center;">章节加载失败: ' + e.message.slice(0, 80) + '<br><span style="font-size:13px;color:var(--muted)">建议换个书源再试</span></p>';
    }
  }

  // ---------------- 翻页模式渲染 ----------------
  // 按当前模式渲染正文：滚动=整章连续；翻页=按屏切分多页、标题仅第1页
  function renderCurrentChapter(anim) {
    const rcEl = $('readerContent');
    if (!rcEl) return;
    if (currentPageMode !== 'page') {
      rcEl.classList.remove('paged');
      rcEl.innerHTML = (currentChapterTitle ? '<h2 class="reader-chap-title">' + escapeHtml(currentChapterTitle) + '</h2>' : '') + '<div class="reader-body">' + currentChapterHtml + '</div>';
      bindAutoLoadNext();
      applyReaderStyle();
      rcEl.classList.remove('fade-in'); void rcEl.offsetWidth; rcEl.classList.add('fade-in');
      updateReaderPageNum();
      return;
    }
    // 翻页模式：把正文按可见高度切成 N 页
    rcEl.classList.add('paged');
    const titleHtml = currentChapterTitle ? '<h2 class="reader-chap-title">' + escapeHtml(currentChapterTitle) + '</h2>' : '';
    readerPages = paginate(titleHtml, currentChapterHtml);
    if (currentPageNo > 9999) currentPageNo = readerPages.length - 1; // 'last'
    if (currentPageNo >= readerPages.length) currentPageNo = readerPages.length - 1;
    if (currentPageNo < 0) currentPageNo = 0;
    const pageBlocks = readerPages[currentPageNo] || [];
    const showTitle = (currentPageNo === 0); // 标题只在每章第 1 页显示
    rcEl.innerHTML = '<div class="reader-page">' + (showTitle ? titleHtml : '') + '<div class="reader-body">' + pageBlocks.join('') + '</div></div>';
    applyReaderStyle();
    if (anim) {
      rcEl.classList.remove('page-anim-fade', 'page-anim-slide');
      void rcEl.offsetWidth;
      rcEl.classList.add('page-anim-' + anim);
    }
    updateReaderPageNum();
  }

  // 把一章正文切成多页（每页 = 一屏高度）。返回二维数组：每页是若干块 HTML 字符串
  function paginate(titleHtml, bodyHtml) {
    const rc = $('readerContent');
    // 先整章渲染进容器，量每块真实高度
    // 关键：测量前临时去掉 paged 的 overflow:hidden，避免父容器 height=0 导致 pageH=0 触发整章兜底后被裁切
    const wasPaged = rc.classList.contains('paged');
    if (wasPaged) rc.classList.remove('paged');
    rc.innerHTML = (titleHtml || '') + '<div class="reader-body">' + bodyHtml + '</div>';
    const cs = getComputedStyle(rc);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    let pageH = rc.clientHeight - padTop - padBot;
    // 兜底：如果容器高度不正常（隐藏/未布局），用视口高度的 85% 作为估算
    if (pageH < 200) pageH = Math.floor(window.innerHeight * 0.85);
    const bodyEl = rc.querySelector('.reader-body');
    // 若没有真正的块级子元素（仅文本 + <br> 分隔，很多小说源如此输出），
    // 把 <br> 当作段落分隔切成多个 <p>，否则整章被当成一个块、翻页模式一页装不下、
    // 剩余内容被 overflow:hidden 裁切且翻不到（典型 bug：长文读不到后半段）
    if (bodyEl && bodyEl.children.length <= 1) {
      bodyEl.innerHTML = '<p>' + bodyEl.innerHTML.replace(/<br\s*\/?>/gi, '</p><p>') + '</p>';
    }
    // 超高单块（如一个超长 <p> 跨多屏）拆小，避免单段被裁切读不全
    if (bodyEl && pageH > 0) {
      Array.from(bodyEl.children).forEach((blk) => {
        if (blk.offsetHeight > pageH) {
          let parts = blk.innerHTML.split(/<br\s*\/?>/i);
          if (parts.length <= 1) { try { parts = blk.innerHTML.split(/(?<=[。！？!?；;])/); } catch (e) { parts = [blk.innerHTML]; } }
          if (parts.length > 1) {
            const frag = document.createDocumentFragment();
            parts.forEach((p) => { const d = document.createElement('p'); d.innerHTML = p.trim(); frag.appendChild(d); });
            blk.replaceWith(frag);
          }
        }
      });
    }
    if (!bodyEl || pageH <= 0) return [[bodyHtml]]; // 兜底：整章算一页
    const titleEl = rc.querySelector('.reader-chap-title');
    const titleH = titleEl ? titleEl.offsetHeight + 14 : 0;
    const blocks = Array.from(bodyEl.children);
    const pages = [[]];
    let acc = 0;
    let avail = pageH - titleH; // 第 1 页要扣掉标题高度
    for (const b of blocks) {
      const h = b.offsetHeight + 4; // +4 近似块间距
      if (acc + h > avail && pages[pages.length - 1].length) {
        pages.push([]);
        acc = 0;
        avail = pageH; // 后续页无标题，满高
      }
      pages[pages.length - 1].push(b.outerHTML);
      acc += h;
    }
    if (!pages.length) pages.push([]);
    return pages;
  }

  // 翻页（章内翻页，翻到章末自动进下一章；翻到章首自动回上一章末页）
  function turnPage(dir) {
    if (!readerPages.length) { renderCurrentChapter(); return; }
    if (dir > 0) {
      if (currentPageNo < readerPages.length - 1) { currentPageNo++; renderCurrentChapter(pageAnim); saveProgress(); }
      else if (currentChap < currentToc.length - 1) { openChapter(currentChap + 1, 0); }
      else if (autoOn) { autoOn = false; const cb = $('autoPage'); if (cb) cb.checked = false; stopAuto(); showToast('已到最后一章，自动翻页已关闭'); }
      else showToast('已经是最后一章');
    } else {
      if (currentPageNo > 0) { currentPageNo--; renderCurrentChapter(pageAnim); saveProgress(); }
      else if (currentChap > 0) { openChapter(currentChap - 1, 'last'); }
      else if (autoOn) { autoOn = false; const cb = $('autoPage'); if (cb) cb.checked = false; stopAuto(); showToast('已到第一章，自动翻页已关闭'); }
      else showToast('已经是第一章');
    }
  }
  // 上一页/上一章、下一页/下一章（按当前模式分流）
  function goPrev() {
    if (currentPageMode === 'page') turnPage(-1);
    else openChapter(Math.max(0, currentChap - 1));
  }
  function goNext() {
    if (currentPageMode === 'page') turnPage(1);
    else openChapter(Math.min(currentToc.length - 1, currentChap + 1));
  }
  // 阅读器底栏「上一章 / 下一章」实体按钮（整章跳）
  function goToPrevChap() {
    if (!currentToc || !currentToc.length) return;
    if (currentChap > 0) openChapter(currentChap - 1, 'last');
    else showToast('已经是第一章');
  }
  function goToNextChap() {
    if (!currentToc || !currentToc.length) return;
    if (currentChap < currentToc.length - 1) openChapter(currentChap + 1, 0);
    else showToast('已经是最后一章');
  }
  // 底部页码（翻页模式显示"第 X / Y 页"，滚动模式显示章节进度）
  function updateReaderPageNum() {
    const el = $('readerPageNum');
    if (!el) return;
    if (currentPageMode === 'page') {
      el.textContent = '第 ' + (currentPageNo + 1) + ' / ' + Math.max(1, readerPages.length) + ' 页';
    } else {
      el.textContent = '第 ' + (currentChap + 1) + ' / ' + (currentToc.length || 1) + ' 章';
    }
    el.style.display = '';
  }
  // 设置变化（字号/行距/字体/背景）后，若处于翻页模式则重新分页，避免分页错位
  function refreshPageMode() { if (currentPageMode === 'page' && currentChapterHtml) renderCurrentChapter(); }

  // ---------------- 自动翻页 ----------------
  function startAuto() {
    stopAuto();
    if (!autoOn || !currentBook) return;
    if (currentPageMode === 'scroll') {
      autoTimer = setInterval(() => {
        const rc = $('readerContent'); if (!rc) return;
        const now = Date.now();
        if (now < autoCooldownUntil) return;
        if (rc.scrollTop + rc.clientHeight >= rc.scrollHeight - 2) {
          if (currentChap < currentToc.length - 1) { autoCooldownUntil = now + 1500; goNext(); }
          else { autoOn = false; const cb = $('autoPage'); if (cb) cb.checked = false; stopAuto(); showToast('已到最后一章，自动翻页已关闭'); }
        } else rc.scrollTop += 1;
      }, 50);
    } else {
      autoTimer = setInterval(() => { goNext(); }, 3000);
    }
  }
  function stopAuto() { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } }

  // ---- 听书 TTS（Web Speech API） ----
  var ttsOn = false, ttsPaused = false;
  var ttsUtter = null;          // 当前 SpeechSynthesisUtterance
  var ttsParas = [];             // 当前章按 <p> 切分的纯文本段落
  var ttsParaIdx = 0;           // 当前读到第几段
  var ttsSpeed = 1;             // 语速倍率
  var ttsVoiceName = '';        // 选中的语音名称
  var ttsAutoNext = true;       // 播完是否自动进下一章

  function initTtsVoices() {
    var sel = $('ttsVoice');
    if (!sel) return;
    sel.innerHTML = '';
    var voices = speechSynthesis.getVoices();
    if (!voices.length) {
      // 部分浏览器需等 voiceschanged 事件
      speechSynthesis.addEventListener('voiceschanged', function () { initTtsVoices(); }, { once: true });
      return;
    }
    // 优先中文语音排前面
    var zh = [], other = [];
    voices.forEach(function (v) {
      if (/zh|cmn|chinese/i.test(v.lang)) zh.push(v);
      else other.push(v);
    });
    (zh.concat(other)).forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.name + (v.lang ? ' (' + v.lang + ')' : '');
      sel.appendChild(opt);
    });
    // 恢复之前选的
    if (ttsVoiceName) sel.value = ttsVoiceName;
    else if (zh.length) { sel.value = zh[0].name; ttsVoiceName = zh[0].name; }
  }

  function getTtsText() {
    if (!currentChapterText) return '';
    // 按句号切分为段落（TTS 一段一段读）
    var text = currentChapterText.replace(/\s+/g, '');
    // 按 。！？…\n 切段，每段不要太长（TTS 引擎长文本会截断）
    var segs = text.split(/(?<=[。！？…])/).filter(function (s) { return s.trim().length > 0; });
    return segs;
  }

  function highlightTtsPara(idx) {
    var rc = $('readerContent');
    if (!rc) return;
    // 清除旧高亮
    rc.querySelectorAll('.p-tts-active').forEach(function (el) { el.classList.remove('p-tts-active'); });
    // 高亮当前段：找第 idx 个 <p> 标签
    var paras = rc.querySelectorAll(':scope > p');
    if (paras[idx]) paras[idx].classList.add('p-tts-active');
    // 滚动到当前段（如果不在可视区）
    if (paras[idx]) {
      var rect = paras[idx].getBoundingClientRect();
      var viewH = window.innerHeight || rc.clientHeight;
      if (rect.top < 60 || rect.bottom > viewH - 100) {
        paras[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  function clearTtsHighlight() {
    var rc = $('readerContent');
    if (rc) rc.querySelectorAll('.p-tts-active').forEach(function (el) { el.classList.remove('p-tts-active'); });
  }

  function updateTtsUi() {
    var bar = $('ttsBar');
    var btn = $('rTts');
    if (!bar || !btn) return;
    if (ttsOn) {
      bar.classList.remove('hidden');
      btn.dataset.on = 'true';
      btn.querySelector('.r-tool-tx').textContent = '听书中';
      btn.style.background = 'var(--accent)';
    } else {
      bar.classList.add('hidden');
      btn.dataset.on = 'false';
      btn.querySelector('.r-tool-tx').textContent = '听书';
      btn.style.background = '';
    }
    var pp = $('ttsPlayPause');
    if (pp) pp.textContent = ttsPaused ? '▶' : '⏸';
    var info = $('ttsInfo');
    if (info && ttsParas.length) info.textContent = (ttsParaIdx + 1) + '/' + ttsParas.length;
  }

  function speakPara(idx) {
    if (!ttsOn || idx >= ttsParas.length) {
      // 本章读完
      if (idx >= ttsParas.length && ttsAutoNext && currentChap < currentToc.length - 1) {
        showToast('正在进入下一章...');
        openChapter(currentChap + 1, function () {
          ttsPaused = false;
          startTts();
        });
      } else {
        stopTts();
      }
      return;
    }
    ttsParaIdx = idx;
    updateTtsUi();
    highlightTtsPara(idx);

    var utt = new SpeechSynthesisUtterance(ttsParas[idx]);
    utt.rate = parseFloat($('ttsSpeed') ? $('ttsSpeed').value : ttsSpeed) || 1;
    utt.lang = 'zh-CN';

    var voiceSel = $('ttsVoice');
    if (voiceSel && voiceSel.value) {
      var voices = speechSynthesis.getVoices();
      var picked = voices.find(function (v) { return v.name === voiceSel.value; });
      if (picked) { utt.voice = picked; ttsVoiceName = picked.name; }
    }

    utt.onend = function () {
      if (ttsOn && !ttsPaused) speakPara(ttsParaIdx + 1);
    };
    utt.onerror = function (e) {
      console.warn('[TTS] utter error:', e.message);
      // 出错也继续下一段
      if (ttsOn && !ttsPaused) speakPara(ttsParaIdx + 1);
    };

    ttsUtter = utt;
    speechSynthesis.speak(utt);
  }

  function startTts() {
    if (!currentChapterText || !currentChapterText.trim()) {
      showToast('当前没有可朗读的内容');
      return;
    }
    ttsOn = true;
    ttsPaused = false;
    ttsParas = getTtsText();
    ttsParaIdx = 0;
    initTtsVoices();
    updateTtsUi();
    speakPara(0);
  }

  function toggleTtsPause() {
    if (!ttsOn) { startTts(); return; }
    if (ttsPaused) {
      ttsPaused = false;
      speechSynthesis.resume();
      $('ttsPlayPause').textContent = '⏸';
    } else {
      ttsPaused = true;
      speechSynthesis.pause();
      $('ttsPlayPause').textContent = '▶';
    }
  }

  function stopTts() {
    ttsOn = false;
    ttsPaused = false;
    speechSynthesis.cancel();
    ttsUtter = null;
    ttsParas = [];
    ttsParaIdx = 0;
    clearTtsHighlight();
    updateTtsUi();
  }

  function saveProgress() {
    if (!currentBook) return;
    const total = currentToc ? currentToc.length : 0;
    localStorage.setItem(LS.prog(bookId(currentBook)), JSON.stringify({ chap: currentChap, page: currentPageNo || 0, total }));
  }
  function loadProgress(item) {
    try {
      const raw = localStorage.getItem(LS.prog(bookId(item)));
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (p && typeof p.chap === 'number') return p;
      return null;
    } catch (e) { return null; }
  }
  function bookId(b) { return ((b.name || '') + '\x00' + (b.author || '')) || '?'; }

  // ---------------- 书架（localStorage）----------------
  function getShelf() { try { return JSON.parse(localStorage.getItem(LS.shelf) || '[]'); } catch (e) { return []; } }
  function saveShelf(s) { localStorage.setItem(LS.shelf, JSON.stringify(s)); }

  function addToShelf() {
    if (!currentBook) return;
    const shelf = getShelf();
    const id = bookId(currentBook);
    if (shelf.find((b) => bookId(b) === id)) { showToast('已在书架中'); return; }
    clearBookBad(id); // 重新加入时清理旧的失效标记，避免"删了重加才能恢复"
    shelf.push({ ...currentBook, addedAt: Date.now() });
    saveShelf(shelf);
    showToast('已加入书架');
  }

  function renderShelf() {
    const shelf = getShelf();
    $('shelfEmpty').classList.toggle('hidden', shelf.length > 0);
    // 书架工具条：视图切换 + 排序 同步状态
    const gBtn = $('shelfGridBtn'), lBtn = $('shelfListBtn');
    if (gBtn) gBtn.classList.toggle('active', shelfViewMode === 'grid');
    if (lBtn) lBtn.classList.toggle('active', shelfViewMode === 'list');
    if ($('shelfSort')) $('shelfSort').value = shelfSort;
    $('shelfGrid').classList.toggle('list', shelfViewMode === 'list');

    // ---- 顶部「继续阅读」横幅：取有进度且最近添加的一本（借鉴微信读书/Kindle 突出正在读的书）----
    const resumeBox = $('shelfResume');
    const withProg = shelf
      .map((b) => ({ b, p: loadProgress(b) }))
      .filter((x) => x.p && x.p.chap > 0);
    if (withProg.length) {
      withProg.sort((a, b) => (b.b.addedAt || 0) - (a.b.addedAt || 0));
      const { b, p } = withProg[0];
      const pct = p.total > 0 ? Math.round((p.chap / p.total) * 100) : -1;
      const cover = coverHtml(b, 'resume-cover');
      resumeBox.innerHTML =
        '<div class="resume-card">'
        + cover
        + '<div class="resume-info">'
        +   '<div class="resume-name">' + (b.name || '未知') + '</div>'
        +   '<div class="resume-author">' + (b.author || '') + '</div>'
        +   '<div class="resume-prog"><div class="resume-bar"><span style="width:' + (pct >= 0 ? pct : 0) + '%"></span></div><em>' + (pct >= 0 ? ('已读 ' + pct + '%') : ('读到第 ' + (p.chap + 1) + ' 章')) + '</em></div>'
        +   '<button class="resume-btn">继续阅读 ›</button>'
        + '</div>'
        + '</div>';
      resumeBox.querySelector('.resume-card').onclick = (e) => { if (e.target.closest('.resume-btn')) return; openBookDirect(b); };
      resumeBox.querySelector('.resume-btn').onclick = (e) => { e.stopPropagation(); openBookDirect(b); };
    } else {
      resumeBox.innerHTML = '';
    }

    // ---- 封面墙：按排序渲染（最近阅读 / 加入时间 / 书名）----
    const grid = $('shelfGrid');
    grid.innerHTML = '';
    const sorted = shelf.slice();
    if (shelfSort === 'added') sorted.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    else if (shelfSort === 'name') sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else sorted.sort((a, b) => { const pa = loadProgress(a), pb = loadProgress(b); const wa = (pa && pa.chap > 0) ? 1 : 0, wb = (pb && pb.chap > 0) ? 1 : 0; if (wa !== wb) return wb - wa; return (b.addedAt || 0) - (a.addedAt || 0); });
    sorted.forEach((b) => {
      const p = loadProgress(b);
      const pct = (p && p.total > 0) ? Math.round((p.chap / p.total) * 100) : (p && p.chap > 0 ? -1 : 0);
      const isReading = p && p.chap > 0;
      const card = document.createElement('div');
      card.className = 'shelf-book';
      const cover = coverHtml(b, 'shelf-cover');
      const progHtml = isReading
        ? '<div class="shelf-prog"><div class="shelf-bar"><span style="width:' + (pct >= 0 ? pct : 0) + '%"></span></div><em>' + (pct >= 0 ? ('已读' + pct + '%') : ('第' + (p.chap + 1) + '章')) + '</em></div>'
        : '<div class="shelf-prog empty">未开始阅读</div>';
      card.innerHTML = cover
        + '<button class="shelf-del" title="从书架移除" aria-label="移除">×</button>'
        + '<div class="shelf-info">'
        +   '<div class="shelf-title">' + (b.name || '未知') + '</div>'
        +   '<div class="shelf-author">' + (b.author || '') + '</div>'
        +   progHtml
        + '</div>'
        + '<button class="shelf-play">' + (isReading ? '▶ 继续' : '▶ 开始') + '</button>';
      card.onclick = () => openBookDirect(b);
      card.querySelector('.shelf-play').onclick = (e) => { e.stopPropagation(); openBookDirect(b); };
      card.querySelector('.shelf-del').onclick = (e) => {
        e.stopPropagation();
        const sid = bookId(b);
        saveShelf(getShelf().filter((x) => bookId(x) !== sid));
        renderShelf();
        showToast('已从书架移除：' + (b.name || ''));
      };
      grid.appendChild(card);
    });
  }

  function updateMine() {
    $('mineShelfCount').textContent = getShelf().length;
    $('mineSourceCount').textContent = usableCount() + ' / ' + SOURCES.length;
  }

  // ---------------- 视图切换 ----------------
  function showView(v) {
    const idMap = { home: 'homeView', shelf: 'shelfView', mine: 'mineView', detail: 'detailView', reader: 'readerView' };
    const id = idMap[v] || v;
    ['homeView', 'shelfView', 'mineView', 'detailView', 'readerView'].forEach((vid) => { const e = $(vid); if (e) e.classList.add('hidden'); });
    if ($(id)) $(id).classList.remove('hidden');

    const inReader = (v === 'reader');
    const inDetail = (v === 'detail');
    if (!inReader) { stopAuto(); stopTts(); } // 离开阅读器则停止自动翻页和听书
    $('bottomNav').classList.toggle('hidden', inReader || inDetail);    // 详情/阅读时隐藏底部导航
    $('backBtn').classList.toggle('hidden', !inDetail);                 // 仅详情页显示全局返回
    document.querySelector('.topbar').classList.toggle('hidden', inReader); // 阅读器用自己的沉浸式顶栏

    $('topTitle').textContent = v === 'home' ? '青简阅读'
      : v === 'shelf' ? '我的书架'
      : v === 'mine' ? '我的'
      : v === 'detail' ? '书籍详情' : '阅读';
    document.querySelectorAll('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));

    if (v === 'shelf') renderShelf();
    if (v === 'mine') updateMine();
  }

  function showLoading(on) {
    $('loading').classList.toggle('hidden', !on);
  }

  // ---------------- 设置 ----------------
  function getSettings() { try { return JSON.parse(localStorage.getItem(LS.settings) || '{}'); } catch (e) { return {}; } }
  function hexToRgba(hex, a) {
    hex = (hex || '').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6) return hex || 'rgba(0,0,0,0.9)';
    const n = parseInt(hex, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  const FONT_MAP = {
    system: "'system-ui','PingFang SC','Microsoft YaHei',sans-serif",
    hei: "'Microsoft YaHei','Heiti SC','SimHei',sans-serif",
    song: "'SimSun','Songti SC',serif",
    kai: "'KaiTi','STKaiti',serif"
  };
  function applyReaderStyle() {
    const st = getSettings();
    const c = $('readerContent');
    const rv = $('readerView');
    const top = $('readerTop');
    const bot = $('readerBottom');
    const mask = $('readerBrightMask');
    const bg = st.bg || '#f6f3ea';
    const color = st.color || '#33312b';
    rv.style.background = bg;
    c.style.background = bg;
    c.style.color = color;
    // 工具栏纯色跟随主题（去掉半透明+毛玻璃，避免"上一块下一块"割裂）
    top.style.background = bg;
    top.style.borderBottomColor = 'rgba(125,125,125,0.18)';
    top.style.color = color;
    bot.style.background = bg;
    bot.style.borderTopColor = 'rgba(125,125,125,0.18)';
    bot.style.color = color;
    // 字号（默认18）+ 行距（容器控制，<p> 继承，默认1.8；修掉"拉到最小还很大"）
    c.style.fontSize = (st.fontSize || 18) + 'px';
    c.style.lineHeight = (st.lineHeight || 1.8);
    // 字体
    if (st.font) c.style.fontFamily = FONT_MAP[st.font] || FONT_MAP.system;
    // 加粗
    c.style.fontWeight = st.bold ? '700' : '400';
    // 段距（em，相对字号）
    c.style.setProperty('--reader-para', (st.para != null ? st.para : 1.4) + 'em');
    // 亮度（20~100 → 遮罩透明度 0~0.8，独立调暗，不影响系统亮度）
    const bright = st.bright != null ? st.bright : 100;
    if (mask) mask.style.opacity = ((100 - bright) / 100 * 0.8).toFixed(2);
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    $('searchBtn').onclick = doSearch;
    $('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    // 底部导航
    document.querySelectorAll('.bottom-nav button').forEach((b) => {
      b.onclick = () => { const v = b.dataset.view; prevView = v; showView(v); };
    });

    // 全局返回（详情页用：回到搜索/书架，不走 prevView（后者被阅读器覆盖为'detail'））
    $('backBtn').onclick = () => showView(prevBeforeDetail || 'home');
    $('addShelfBtn').onclick = addToShelf;
    $('reprobeBtn').onclick = () => { resetHealth(); showToast('已重置，正在重新检测全部书源…'); };
    $('exportHealthBtn').onclick = () => exportHealth();
    // "我的"页面重置按钮
    $('resetSettingsBtn').onclick = () => {
      localStorage.removeItem(LS.settings);
      applyReaderStyle();
      showToast('已重置阅读设置');
    };
    // 书架：网格/列表切换 + 排序
    $('shelfGridBtn').onclick = () => { shelfViewMode = 'grid'; localStorage.setItem('nov_shelfview', 'grid'); renderShelf(); };
    $('shelfListBtn').onclick = () => { shelfViewMode = 'list'; localStorage.setItem('nov_shelfview', 'list'); renderShelf(); };
    $('shelfSort').onchange = (e) => { shelfSort = e.target.value; localStorage.setItem('nov_shelfsort', shelfSort); renderShelf(); };
    // 自动翻页开关
    $('autoPage').onchange = (e) => { autoOn = e.target.checked; if (autoOn) startAuto(); else stopAuto(); };

    // ---- 阅读器 ----
    // 沉浸式返回
    $('rBack').onclick = () => showView(prevView || 'home');
    // 点击阅读器区域：左半屏翻上一章，右半屏翻下一章，中间唤出菜单
    // 绑在 readerView（全屏）而非 readerContent（窄栏），确保桌面端大片区域也能点
    $('readerView').addEventListener('click', (e) => {
      if (justSwiped) { justSwiped = false; return; } // 手势滑动刚翻过页，忽略随后触发的 click
      if (e.target.closest('.reader-top') || e.target.closest('.reader-bottom') || e.target.closest('.toc-drawer') || e.target.closest('.src-drawer') || e.target.closest('.mask') || e.target.closest('.r-sheet')) return;
      // 点击翻页箭头：直接翻上一页/下一页（翻页模式）或上一章/下一章（滚动模式）
      if (e.target.closest('.reader-nav-arrow')) {
        const isPrev = e.target.closest('.reader-nav-arrow.left');
        isPrev ? goPrev() : goNext();
        return;
      }
      const rect = $('readerView').getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width * 0.38) { goPrev(); }
      else if (x > rect.width * 0.62) { goNext(); }
      else { toggleReaderMenu(); }
    });

    // 桌面端：鼠标移到屏幕左/右 18% 边缘时浮现翻页箭头，提示可点击翻章（对标 Kindle/微信读书桌面端）
    const rvEl = $('readerView');
    rvEl.addEventListener('mousemove', (e) => {
      const rect = rvEl.getBoundingClientRect();
      const xr = (e.clientX - rect.left) / rect.width;
      rvEl.classList.toggle('nav-left', xr < 0.18);
      rvEl.classList.toggle('nav-right', xr > 0.82);
    });
    rvEl.addEventListener('mouseleave', () => { rvEl.classList.remove('nav-left', 'nav-right'); });

    // 进入阅读器时刷新一次箭头状态
    updateNavArrows();
    // 手势左右滑翻页（移动端，参考微信读书/番茄；与点击分区共存）
    let _tsX = 0, _tsY = 0, _swiping = false;
    const rcEl = $('readerContent');
    rcEl.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; _tsX = t.clientX; _tsY = t.clientY; _swiping = false;
    }, { passive: true });
    rcEl.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (Math.abs(t.clientX - _tsX) > Math.abs(t.clientY - _tsY) && Math.abs(t.clientX - _tsX) > 12) _swiping = true;
    }, { passive: true });
    rcEl.addEventListener('touchend', (e) => {
      if (!_swiping) return; // 竖向滚动 / 轻点交给 click 处理
      const t = e.changedTouches[0];
      const dx = t.clientX - _tsX;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(t.clientY - _tsY)) {
        justSwiped = true;
        if (dx < 0) goNext(); // 左滑→下一页/下一章
        else goPrev();        // 右滑→上一页/上一章
      }
    }, { passive: true });
    // 键盘左右方向键翻页（阅读器可见时）
    document.addEventListener('keydown', (e) => {
      if ($('readerView').classList.contains('hidden')) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { goPrev(); }
      else if (e.key === 'ArrowRight') { goNext(); }
    });
    // 工具条 Aa（点屏幕中间唤出菜单后，底栏第一行右侧即显示，对标微信读书/番茄的设置入口）
    $('rAa').onclick = (e) => { e.stopPropagation(); clearTimeout(menuHideTimer); const open = $('readerSettings').classList.toggle('open'); if (open) stopAuto(); else if (autoOn) startAuto(); };
    // 底栏按钮（两行工具条：目录 / 书签 / 夜间 / Aa / 换源；亮度第二行）
    $('rToc').onclick = (e) => { e.stopPropagation(); openTocDrawer(); };
    $('rBm').onclick = (e) => { e.stopPropagation(); toggleBookmark(); };
    $('rNight').onclick = (e) => { e.stopPropagation(); toggleNight(); };
    // 听书：工具条按钮 → 切换播放/停止
    $('rTts').onclick = (e) => { e.stopPropagation(); if (ttsOn) stopTts(); else { stopAuto(); startTts(); } };
    // TTS 控制条
    var tpp = $('ttsPlayPause');
    if (tpp) tpp.onclick = (e) => { e.stopPropagation(); toggleTtsPause(); };
    var tStop = $('ttsStop');
    if (tStop) tStop.onclick = (e) => { e.stopPropagation(); stopTts(); };
    var tPrev = $('ttsPrev');
    if (tPrev) tPrev.onclick = (e) => { e.stopPropagation(); if (ttsOn && ttsParaIdx > 0) { speechSynthesis.cancel(); speakPara(ttsParaIdx - 1); } };
    var tNext = $('ttsNext');
    if (tNext) tNext.onclick = (e) => { e.stopPropagation(); if (ttsOn && ttsParaIdx < ttsParas.length - 1) { speechSynthesis.cancel(); speakPara(ttsParaIdx + 1); } };
    var tSpd = $('ttsSpeed');
    if (tSpd) tSpd.onchange = (e) => { ttsSpeed = parseFloat(e.target.value); };
    $('rSwitch').onclick = (e) => { e.stopPropagation(); openSrcDrawer(); }; // 换源 → 阅读器内弹窗
    // 阅读器上一章 / 下一章（整章跳）
    $('rPrevChap').onclick = (e) => { e.stopPropagation(); goToPrevChap(); };
    $('rNextChap').onclick = (e) => { e.stopPropagation(); goToNextChap(); };
    // 详情页目录倒序
    $('tocReverse').onclick = (e) => { e.stopPropagation(); tocReverse = !tocReverse; renderToc(); };
    // 目录抽屉
    $('tocClose').onclick = (e) => { e.stopPropagation(); closeTocDrawer(); };
    $('tocSearch').oninput = () => renderTocList();
    $('tocBmFilter').onclick = (e) => { e.stopPropagation(); tocBmOnly = !tocBmOnly; $('tocBmFilter').classList.toggle('active', tocBmOnly); renderTocList(); };
    $('tocMask').onclick = () => { closeTocDrawer(); closeSrcDrawer(); $('readerSettings').classList.remove('open'); if (autoOn) startAuto(); };
    // 换源抽屉
    $('srcClose').onclick = (e) => { e.stopPropagation(); closeSrcDrawer(); };
    $('srcMask').onclick = () => { closeSrcDrawer(); };

    // ---- 设置：字号 A-/A+ 步进（12~30，每次1px，精确可控）----
    function setFontSize(px) {
      px = Math.max(12, Math.min(30, px));
      const st = getSettings(); st.fontSize = px;
      localStorage.setItem(LS.settings, JSON.stringify(st));
      $('fontSizeVal').textContent = px + 'px';
      applyReaderStyle();
      refreshPageMode();
    }
    $('fontDown').onclick = () => setFontSize((getSettings().fontSize || 18) - 1);
    $('fontUp').onclick = () => setFontSize((getSettings().fontSize || 18) + 1);
    // 行距（1.2~2.4，步进0.05，实时数值）
    $('lineHeight').oninput = (e) => {
      const v = +e.target.value; const st = getSettings(); st.lineHeight = v;
      localStorage.setItem(LS.settings, JSON.stringify(st));
      $('lineHeightVal').textContent = v.toFixed(2).replace(/0$/, '');
      applyReaderStyle();
      refreshPageMode();
    };
    // 亮度（20~100，独立调暗，不影响系统亮度）
    $('brightness').oninput = (e) => {
      const v = +e.target.value; const st = getSettings(); st.bright = v;
      localStorage.setItem(LS.settings, JSON.stringify(st));
      $('brightVal').textContent = v + '%';
      applyReaderStyle();
    };
    // 段距（0.4~2.4 em）
    $('paraSpace').oninput = (e) => {
      const v = +e.target.value; const st = getSettings(); st.para = v;
      localStorage.setItem(LS.settings, JSON.stringify(st));
      $('paraVal').textContent = v.toFixed(1);
      applyReaderStyle();
      refreshPageMode();
    };
    // 字体 chips
    document.querySelectorAll('#fontChips .chip').forEach((chip) => {
      chip.onclick = () => {
        document.querySelectorAll('#fontChips .chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const st = getSettings(); st.font = chip.dataset.font;
        localStorage.setItem(LS.settings, JSON.stringify(st));
        applyReaderStyle();
        refreshPageMode();
      };
    });
    // 加粗
    $('fontBold').onchange = (e) => {
      const st = getSettings(); st.bold = e.target.checked;
      localStorage.setItem(LS.settings, JSON.stringify(st));
      applyReaderStyle();
      refreshPageMode();
    };
    // 翻页方式（对标微信读书/番茄：滚动 / 翻页）
    document.querySelectorAll('#pageModeChips .chip').forEach((chip) => {
      chip.onclick = () => {
        document.querySelectorAll('#pageModeChips .chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const st = getSettings(); st.pageMode = chip.dataset.mode;
        localStorage.setItem(LS.settings, JSON.stringify(st));
        applyPageMode(chip.dataset.mode);
        showToast('已切换为' + (chip.dataset.mode === 'page' ? '翻页' : '滚动') + '模式');
      };
    });
    // 翻页效果（淡入 / 横移）
    document.querySelectorAll('#pageAnimChips .chip').forEach((chip) => {
      chip.onclick = () => {
        document.querySelectorAll('#pageAnimChips .chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        pageAnim = chip.dataset.anim;
        const st = getSettings(); st.pageAnim = pageAnim;
        localStorage.setItem(LS.settings, JSON.stringify(st));
        showToast('翻页动画：' + chip.textContent);
      };
    });
    // 背景主题
    document.querySelectorAll('.theme-dot').forEach((d) => {
      d.onclick = () => {
        document.querySelectorAll('.theme-dot').forEach((x) => x.classList.remove('active'));
        d.classList.add('active');
        const st = getSettings(); st.bg = d.dataset.bg; st.color = d.dataset.color;
        localStorage.setItem(LS.settings, JSON.stringify(st));
        applyReaderStyle();
        refreshPageMode();
      };
    });
    // 重置（阅读器设置面板内）
    $('readerResetBtn').onclick = () => {
      localStorage.removeItem(LS.settings);
      const ap = $('autoPage'); if (ap) ap.checked = false; autoOn = false; stopAuto();
      $('fontSizeVal').textContent = '18px';
      $('lineHeight').value = 1.8; $('lineHeightVal').textContent = '1.8';
      $('brightness').value = 100; $('brightVal').textContent = '100%';
      $('paraSpace').value = 1.4; $('paraVal').textContent = '1.4';
      document.querySelectorAll('#fontChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.font === 'system'));
      $('fontBold').checked = false;
      document.querySelectorAll('#pageModeChips .chip').forEach((c, i) => c.classList.toggle('active', i === 0));
      applyPageMode('scroll');
      document.querySelectorAll('.theme-dot').forEach((x, i) => x.classList.toggle('active', i === 0));
      const nb = $('rNight'); if (nb) nb.dataset.on = 'false';
      applyReaderStyle();
      showToast('阅读设置已重置');
    };
  }

  // ---------------- 关闭 Service Worker（调试期避免缓存旧版导致页面空白/不更新）----------------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister().catch(() => {}));
    }).catch(() => {});
  }

  // ---------------- 启动（立即显示 UI，不等待书源）----------------
  bind();
  showView('home');

  const st = getSettings();
  if (st.fontSize) $('fontSizeVal').textContent = st.fontSize + 'px';
  if (st.lineHeight) { $('lineHeight').value = st.lineHeight; $('lineHeightVal').textContent = (+st.lineHeight).toString(); }
  if (st.bright != null) { $('brightness').value = st.bright; $('brightVal').textContent = st.bright + '%'; }
  if (st.para != null) { $('paraSpace').value = st.para; $('paraVal').textContent = (+st.para).toFixed(1); }
  if (st.font) document.querySelectorAll('#fontChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.font === st.font));
  if (st.bold) $('fontBold').checked = true;
  if (st.pageMode) document.querySelectorAll('#pageModeChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.mode === st.pageMode));
  if (st.pageAnim) {
    pageAnim = (st.pageAnim === 'flip') ? 'slide' : st.pageAnim; // 仿真翻页已移除，旧值回退
    document.querySelectorAll('#pageAnimChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.anim === pageAnim));
  }
  // 同步翻页模式状态（含动画行显隐）
  applyPageMode(st.pageMode || 'scroll');
  if (st.bg) document.querySelectorAll('.theme-dot').forEach((x) => x.classList.toggle('active', x.dataset.bg === st.bg));

  // 后台加载书源（不阻塞）
  loadSources();

  console.log('[init] 青简阅读已启动');
})();
