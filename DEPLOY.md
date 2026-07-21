# 青简阅读 · 部署指南（GitHub + Vercel 免费长期）

> 目标：把项目放到 GitHub 仓库，用 Vercel 部署，拿到免费长期域名 `https://<项目名>.vercel.app`，
> 让朋友直接访问，**搜索 / 换源 / 阅读 / 听书功能与本地完全一致**。

## 为什么这样能「功能不变」
- 前端调用的是相对路径 `/api/fetch`（同源），本地靠 `server.js` 提供代理。
- 部署到 Vercel 时，`webapp/api/fetch.js` 会自动成为 Serverless Function，在 Vercel 服务端抓取外部小说站，
  **同样绕开浏览器 CORS**，所以搜索 / 换源照常工作。
- 已把 `api/fetch.js` 的 UA / Referer / Accept 等对齐本地 `server.js`，行为一致。

## 部署步骤
1. **GitHub 建仓**：在 github.com 新建仓库（如 `qingjian-reader`），公开私有均可。
2. **推送代码**（本机已 `git init` 并提交）：
   ```bash
   git remote add origin https://github.com/<你的用户名>/qingjian-reader.git
   git branch -M main
   git push -u origin main
   ```
3. **Vercel 导入**：打开 vercel.com → 用 GitHub 登录 → New Project → Import 该仓库。
4. **配置项目**（关键）：
   - **Root Directory（根目录）**：填 `webapp`
   - **Framework Preset**：`Other`
   - **Build Command**：留空
   - **Output Directory**：留空（默认用 `webapp` 根）
5. **Deploy** → 得到 `https://<项目名>.vercel.app`，发给朋友即可。

## 本地运行（开发用）
```bash
cd webapp && node server.js   # http://localhost:3000
```

## 备注
- Vercel Hobby 免费层函数超时上限 20s（`vercel.json` 已设 `maxDuration: 20`）；个别超慢源可能超时，可忽略或升级套餐。
- 国内访问 Vercel 偶尔偏慢：如需更稳可改 **Cloudflare Pages**（把 `api/fetch.js` 挪到 `functions/api/fetch.js`，其余不变）。
- 听书增强脚本 `userscripts/novel_voice_clone.user.js` 是独立 Tampermonkey 插件，与网站部署互不影响。
- CosyVoice 自己声音克隆那套（方案 B）后续接入，不影响本次部署。

## 项目结构
```
.
├── webapp/                # 青简阅读前端 + 本地 Node 服务 + Vercel 代理
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── server.js          # 本地开发服务器（零依赖）
│   ├── api/fetch.js       # Vercel Serverless 代理（部署后生效）
│   ├── sources.json
│   ├── vercel.json
│   └── package.json
├── userscripts/           # 独立 Tampermonkey 听书增强脚本
│   └── novel_voice_clone.user.js
└── DEPLOY.md
```
