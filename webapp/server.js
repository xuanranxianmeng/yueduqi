/*
 * server.js — 本地开发服务器（零依赖，Node 18+）
 * 1) 托管 webapp 静态文件
 * 2) POST /api/fetch 充当"书源代理"：在服务端抓取外部小说站，绕开浏览器 CORS
 *    浏览器 → /api/fetch → 目标站（服务端无 CORS 限制）→ 返回原文
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
// 桌面 UA：若初/黑岩等站会按 UA 返回桌面版 HTML，移动 UA 会被重定向到移动版导致选择器扑空
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ---- 代理接口 ----
  if (url.pathname === '/api/fetch' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400); return res.end('bad json'); }
    const { url: target, method = 'GET', body: postBody = null, headers = {} } = payload;
    if (!target) { res.writeHead(400); return res.end('missing url'); }
    try {
      // Referer 取目标站自身源（模拟站内跳转），很多书站会据此决定是否返回数据
      let referer = headers['Referer'];
      if (!referer) {
        try { referer = new URL(target).origin + '/'; } catch (e) { referer = 'https://www.ruochu.com/'; }
      }
      const sendHeaders = { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Referer': referer, ...headers };
      if (method === 'POST' && postBody && !/content-type/i.test(Object.keys(headers).join(','))) {
        sendHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      const reqTimeout = Math.min(parseInt(url.searchParams.get('timeout') || '', 10) || 20000, 30000);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), reqTimeout);
      const r = await fetch(target, {
        method,
        body: postBody || undefined,
        headers: sendHeaders,
        redirect: 'follow',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      console.error('[proxy]', method, target.slice(0, 60), '| body=', (postBody || '').slice(0, 60), '| ct=', sendHeaders['Content-Type']);
      // 注意：undici 的 r.text() 只会按 UTF-8 解码，遇到 charset=gbk/gb2312 的站点会乱码。
      // 因此改取原始字节 Buffer，按响应声明的编码用 TextDecoder 解码，再统一以 UTF-8 回传。
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || 'text/plain';
      const cm = ct.match(/charset=([^;]+)/i);
      let charset = (cm ? cm[1] : 'utf-8').trim().toLowerCase();
      if (charset === 'gb2312' || charset === 'gb18030') charset = 'gbk';
      const tryDecode = (cs) => { try { return new TextDecoder(cs).decode(buf); } catch (e) { return null; } };
      let text = tryDecode(charset) || tryDecode('utf-8') || '';
      // 启发式纠错：若按声明(尤其 utf-8)解码出现大量替换符，且字节更像 gbk，则改用 gbk
      if (charset === 'utf-8' && /�/.test(text)) {
        const gbk = tryDecode('gbk');
        if (gbk && !/�/.test(gbk)) text = gbk;
      }
      const outCt = /charset=/i.test(ct) ? ct.replace(/charset=[^;]+/i, 'charset=utf-8') : ct + '; charset=utf-8';
      console.error('[proxy] resp', r.status, 'charset=' + charset, text.slice(0, 80));
      res.writeHead(200, { 'Content-Type': outCt });
      return res.end(text);
    } catch (e) {
      res.writeHead(502);
      return res.end('fetch error: ' + e.message);
    }
  }

  // ---- 静态文件 ----
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('青简阅读 → http://localhost:' + PORT);
});
