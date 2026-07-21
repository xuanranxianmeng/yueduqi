# 青简阅读 · 部署指南（GitHub + Cloudflare Pages 免费长期 · 国内可直连）

> 目标：把项目放到 GitHub 仓库，用 **Cloudflare Pages** 部署，拿到 `https://<项目名>.pages.dev` 免费域名，
> 让朋友**不用 VPN 也能直连**，**搜索 / 换源 / 阅读 / 听书功能与本地完全一致**。
> 相比 Vercel：Cloudflare 在国内访问稳定很多（Vercel 在国内常被墙/极慢，需挂 VPN）。

## 为什么「功能不变」
- 前端调用的是相对路径 `/api/fetch`（同源），本地靠 `server.js` 提供代理。
- 部署到 Cloudflare Pages 时，仓库根的 `functions/api/fetch.js` 会自动成为 Pages Function，
  在 Cloudflare 边缘节点（含香港/东京等近国内节点）抓取外部小说站，**绕开浏览器 CORS**，搜索 / 换源照常工作。
- 代理的 UA / Referer / Accept 已对齐本地 `server.js`，行为一致。
- `_routes.json` 声明只有 `/api/*` 走函数、其余全走静态，避免 Functions 误拦截 `index.html`。

## 项目结构（部署相关）
```
.
├── functions/                 # Cloudflare Pages Functions（必须在仓库根，非 webapp 内）
│   └── api/
│       └── fetch.js           # → /api/fetch 书源代理
├── webapp/                    # 构建输出目录（Build output directory）
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── server.js              # 本地开发服务器（零依赖，仅本地用）
│   ├── sources.json           # 精简书源（约 1MB）
│   ├── _routes.json           # 路由声明：仅 /api/* 走函数
│   └── package.json
├── userscripts/               # 独立 Tampermonkey 听书增强脚本
│   └── novel_voice_clone.user.js
└── DEPLOY.md
```

## 部署步骤（在浏览器完成，无需命令行）
1. **GitHub 建仓并推送**（已完成）：`github.com/xuanranxianmeng/yueduqi`，分支 `main`。
2. 打开 **https://dash.cloudflare.com** → 左侧 **Workers & Pages** → **Create** → 选 **Pages**。
3. 选 **Connect to Git** → 用 GitHub 登录授权 → 选仓库 `yueduqi` → **Begin setup**。
4. **构建配置**（关键）：
   - **Framework preset**：`None`
   - **Build command**：**留空**
   - **Build output directory**：填 **`webapp`**（重要，否则找不到 index.html）
   - **Root directory**：留空（默认仓库根，functions/ 在仓库根会被自动识别）
5. 点 **Save and Deploy** → 约 1 分钟完成，得到 `https://yueduqi.pages.dev`。
6. 进入 **Settings → Functions**，确认 Compatibility date 默认即可（Workers 原生运行时，已用 Web 标准 API，无需 Node 兼容）。
7. 把 `https://yueduqi.pages.dev` 发给朋友，国内可直连。

## 国内访问 & 搜索验证
- 直接手机浏览器打开 `https://<项目名>.pages.dev`，**无需 VPN**。
- 书源约 1MB，几秒加载完；搜索走 Cloudflare 边缘节点抓国内站，比 Vercel 海外节点快很多。
- 打开后若白屏：Ctrl+Shift+R 硬刷新。

## 本地运行（开发用）
```bash
cd webapp && node server.js   # http://localhost:3000
```

## 后续改动如何上线
在本地改完代码 → `git push` → Cloudflare 自动重新部署（约 1-2 分钟），**不用手动操作**。

## 备注
- Cloudflare Pages Functions 免费额度：每日 10 万次请求；单次挂钟上限约 10s（代理超时已设 8s 规避）。
- 若某源极慢偶尔超时，前端已有 3 次重试，可忽略。
- 听书增强脚本 `userscripts/novel_voice_clone.user.js` 是独立 Tampermonkey 插件，与网站部署互不影响。
- CosyVoice 自己声音克隆（方案 B）后续接入，不影响本次部署。
- 自定义顶级域名（如 `.com`/`.cn`）可在 Cloudflare 绑定，需自购域名（约 ¥60/年）并改 DNS。
