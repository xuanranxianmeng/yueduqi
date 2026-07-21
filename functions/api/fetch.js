// functions/api/fetch.js — Cloudflare Pages Functions（书源代理）
// 部署到 Cloudflare Pages 时，functions/ 目录会自动映射为 /api/fetch 接口。
// 作用与本地 server.js 的 /api/fetch 完全一致：服务端抓取外部小说站，绕开浏览器 CORS。
// 注意：本文件使用 Web 标准 API（Request/Response/fetch），运行在 Cloudflare Workers 原生运行时。

// 桌面 UA：若初/黑岩等站会按 UA 返回桌面版 HTML，移动 UA 会被重定向到移动版导致选择器扑空
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function onRequest(context) {
  const { request } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405,
      headers: { 'content-type': 'application/json' },
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'bad json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { url, method = 'GET', body = null, headers = {} } = payload || {};
  if (!url) {
    return new Response(JSON.stringify({ error: 'missing url' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  try {
    // Referer 取目标站自身源（模拟站内跳转），很多书站会据此决定是否返回数据
    let referer = headers['Referer'];
    if (!referer) {
      try { referer = new URL(url).origin + '/'; } catch (e) { referer = 'https://www.ruochu.com/'; }
    }
    const sendHeaders = {
      'User-Agent': UA,
      'Accept': 'text/html,application/json,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Referer': referer,
      ...headers,
    };
    if (method === 'POST' && body && !/content-type/i.test(Object.keys(headers).join(','))) {
      sendHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      method,
      body: body || undefined,
      headers: sendHeaders,
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    const text = await r.text();
    return new Response(text, {
      status: 200,
      headers: {
        'content-type': r.headers.get('content-type') || 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return new Response('fetch error: ' + (e && e.message ? e.message : String(e)), {
      status: 502,
    });
  }
}
