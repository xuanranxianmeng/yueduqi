// api/fetch.js — Vercel Serverless Function（书源代理）
// 部署到 Vercel 时，将此文件放在 api/ 目录即可自动成为 /api/fetch 接口。
// 作用与本地 server.js 的 /api/fetch 完全一致：服务端抓取外部小说站，绕开浏览器 CORS。
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let payload;
  try { payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (e) { return res.status(400).json({ error: 'bad json' }); }

  const { url, method = 'GET', body = null, headers = {} } = payload || {};
  if (!url) return res.status(400).json({ error: 'missing url' });

  // 桌面 UA：若初/黑岩等站会按 UA 返回桌面版 HTML，移动 UA 会被重定向到移动版导致选择器扑空
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
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
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, {
      method,
      body: body || undefined,
      headers: sendHeaders,
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'text/plain; charset=utf-8');
    res.status(200).send(text);
  } catch (e) {
    res.status(502).send('fetch error: ' + e.message);
  }
}
