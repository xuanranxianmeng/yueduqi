// ==UserScript==
// @name         青简听书·音色克隆 (Novel Voice Clone TTS)
// @namespace    https://github.com/codebuddy/novel-voice-clone
// @version      1.0.0
// @description  通用小说网站听书增强插件：①选音色（官方预设+自定义录音克隆）②录音自定义声音 ③自动识别情绪/语气。后端=火山引擎豆包TTS。抄自 tm-tts-multirole(GitHub) 的骨架 + 小說朗讀助手(greasyfork) 的健壮性 hack。
// @author       WorkBuddy
// @match        http://localhost:3000/*
// @match        *://*.biquge*.com/*
// @match        *://*.biquuge*.com/*
// @match        *://*.biquge*.net/*
// @match        *://*.bqg*.org/*
// @match        *://*.69shuba*.cx/*
// @match        *://*.69shuba*.com/*
// @match        *://*.linovelib*.com/*
// @match        *://*.czbooks*.net/*
// @match        *://*.wenku8*.net/*
// @match        *://*.ttkan*.co/*
// @match        *://*.ttk*.tw/*
// @match        *://*.wa01*.com/*
// @match        *://*.qidian*.com/*
// @match        *://*.jjwxc*.net/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== 配置 / 存储 ===================== */
  const CFG = {
    appid: GM_getValue('nvc_appid', ''),
    token: GM_getValue('nvc_token', ''),
    cluster: GM_getValue('nvc_cluster', 'volcano_tts'),
    apiKey: GM_getValue('nvc_apiKey', ''),          // 新版简化鉴权（可选，优先于 appid/token）
    baseUrl: GM_getValue('nvc_baseUrl', 'https://openspeech.bytedance.com/api/v1/tts'),
    voiceType: GM_getValue('nvc_voice', 'zh_female_qingxin'),
    speed: GM_getValue('nvc_speed', 1.0),
    volume: GM_getValue('nvc_volume', 1.0),
    emotionMode: GM_getValue('nvc_emotion', 'auto'), // auto | off | global
    globalEmotion: GM_getValue('nvc_globalEmotion', 'neutral'),
    myVoice: GM_getValue('nvc_myVoice', ''),          // base64(不含 data: 前缀)
    myVoiceFmt: GM_getValue('nvc_myVoiceFmt', 'wav'),
    useMyVoice: GM_getValue('nvc_useMyVoice', false),
    enabled: GM_getValue('nvc_enabled', true),
  };

  // 官方预设音色（豆包语音合成 2.0, seed-tts-2.0 常见音色）
  const PRESET_VOICES = [
    { id: 'zh_female_qingxin', name: '清新女声' },
    { id: 'zh_male_suspense', name: '悬疑男声' },
    { id: 'zh_female_maiya', name: '麦芽女声' },
    { id: 'zh_male_qingdai', name: '青黛男声' },
    { id: 'zh_female_yuanxi', name: '渊溪女声' },
    { id: 'zh_male_zhibei', name: '稚贝男声' },
    { id: 'zh_female_shuangkuan', name: '爽快女声' },
    { id: 'zh_male_dongfang', name: '东方男声' },
  ];

  // 情绪映射：enum 用于 SSML <emotion>，phrase 用于复刻2.0 的自然语言 context（这里统一用 SSML）
  const EMOTIONS = {
    neutral: { enum: 'neutral', phrase: '用平静自然的语气朗读' },
    happy: { enum: 'happy', phrase: '用开心轻快的语气朗读' },
    angry: { enum: 'angry', phrase: '用愤怒严厉的语气朗读' },
    sad: { enum: 'sad', phrase: '用悲伤低沉的语气朗读' },
    surprised: { enum: 'surprised', phrase: '用惊讶好奇的语气朗读' },
    fearful: { enum: 'fearful', phrase: '用害怕颤抖的语气朗读' },
  };

  /* ===================== 运行状态 ===================== */
  let sentences = [];      // [{el, text}]
  let idx = 0;
  let playing = false;
  let curAudio = null;
  let renderEl = null;
  let originalContainer = null;
  let rec = null, recChunks = [], recStream = null;
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('nvc_sync') : null;
  if (bc) bc.onmessage = (e) => { if (e.data === 'play' && playing) stopAll(); };

  /* ===================== 工具函数 ===================== */
  function uuid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('nvc_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  }
  function escapeXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function log(msg) {
    const el = document.getElementById('nvcLog');
    if (el) { el.textContent = '· ' + msg; }
    console.log('[青简听书]', msg);
  }
  function splitSentences(text) {
    // 按句切分（不含省略号/换行，避免把"……"拆成空句）
    return text.split(/(?<=[。！？!?；;])/).map(s => s.trim())
      .filter(s => s.length > 0 && s.replace(/[\s。！？!?；;…]/g, '').length >= 1);
  }
  function isAd(s) {
    if (s.length < 8) return /(上一章|下一章|上一页|下一页|目录|首页|返回|书页|章节列表|加入书架)/.test(s);
    return /(记得收藏|收藏网址|推荐朋友|手机阅读|最新网址|52shuku|笔趣阁.*网址|本书首发|公众.*号|微信.*搜索|求订阅|求月票|求推荐票|断更|请假条|作者有话|本章未完|下载APP|app下载)/.test(s);
  }

  /* ===================== 情绪识别 ===================== */
  function matchEmotionWord(w) {
    if (/开心|高兴|喜悦|兴奋|欢喜|欢快/.test(w)) return 'happy';
    if (/怒|愤|生气|生氣|恼/.test(w)) return 'angry';
    if (/悲|伤|哭|泪|凄凉|哀/.test(w)) return 'sad';
    if (/惊|疑|奇|好奇|诧/.test(w)) return 'surprised';
    if (/怕|恐|惧|慌/.test(w)) return 'fearful';
    if (/平静|淡然|祥和|温和/.test(w)) return 'neutral';
    return null;
  }
  function E(k) { return { key: k, phrase: EMOTIONS[k].phrase }; }
  function detectEmotion(text) {
    if (CFG.emotionMode === 'off') return E('neutral');
    if (CFG.emotionMode === 'global') return E(CFG.globalEmotion || 'neutral');
    // auto：1) 标签 〈情绪〉 2) 启发式
    const tag = text.match(/[〈<]([^〉>]{1,8})[〉>]/);
    if (tag) {
      const w = tag[1];
      const key = matchEmotionWord(w);
      if (key) return E(key);
      return { key: 'neutral', phrase: '用' + w + '的语气朗读' }; // 未知标签当自然语言
    }
    if (/[！!]{1,}/.test(text) && /(太好了|哈哈|欢呼|兴奋|激动|爽)/.test(text)) return E('happy');
    if (/[？\?]/.test(text) && /(为什么|怎么|难道|吗|何种|谁)/.test(text)) return E('surprised');
    if (/(怒|吼|骂|愤|狠|滚|畜生|混蛋)/.test(text)) return E('angry');
    if (/(哭|泪|悲|伤|叹|遗憾|凄凉|心碎)/.test(text)) return E('sad');
    if (/[！!]{2,}/.test(text)) return E('angry');
    if (/(……|\.\.\.)/.test(text)) return { key: 'neutral', phrase: '用温柔舒缓的语气朗读' };
    return E('neutral');
  }

  /* ===================== 后端请求（火山引擎豆包 TTS） ===================== */
  function ttsRequest(body) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (CFG.apiKey) headers['X-Api-Key'] = CFG.apiKey;
      else headers['Authorization'] = 'Bearer;' + CFG.token;
      GM_xmlhttpRequest({
        method: 'POST',
        url: CFG.baseUrl,
        headers,
        data: JSON.stringify(body),
        responseType: 'arraybuffer',
        onload: (r) => {
          if (r.status === 200 && r.response) resolve(r.response);
          else reject(new Error('TTS HTTP ' + r.status + (r.responseText ? ' ' + r.responseText.slice(0, 200) : '')));
        },
        onerror: (e) => reject(new Error('TTS 网络错误')),
      });
    });
  }
  function buildBody(text, emKey) {
    const em = EMOTIONS[emKey] || EMOTIONS.neutral;
    const ssml = '<speak><emotion value="' + em.enum + '">' + escapeXml(text) + '</emotion></speak>';
    // 录音自定义声音（即时复刻，参考音频随请求）
    if (CFG.useMyVoice && CFG.myVoice) {
      return {
        app: { appid: CFG.appid, token: CFG.token, cluster: CFG.cluster },
        user: { uid: 'nvc_user' },
        speaker_id: '',
        audios: [{ audio_bytes: CFG.myVoice, audio_format: CFG.myVoiceFmt }],
        text: ssml, text_type: 'ssml',
        source: 2, language: 0, model_type: 5,
        emotion: em.enum, enable_emotion: true,
        request: { reqid: uuid(), operation: 'query' },
      };
    }
    // 官方预设音色
    return {
      app: { appid: CFG.appid, token: CFG.token, cluster: CFG.cluster },
      user: { uid: 'nvc_user' },
      audio: {
        voice_type: CFG.voiceType, encoding: 'mp3',
        speed_ratio: CFG.speed, volume_ratio: CFG.volume, pitch_ratio: 1.0,
        emotion: em.enum, enable_emotion: true,
      },
      request: { reqid: uuid(), text: ssml, text_type: 'ssml', operation: 'query', with_frontend: 1 },
    };
  }

  /* ===================== 音频播放队列 ===================== */
  function highlight(i) {
    sentences.forEach((s, k) => { if (s.el) s.el.classList.toggle('nvc-active', k === i); });
    const el = sentences[i] && sentences[i].el;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function playFrom(i) {
    if (!playing) return;
    if (i >= sentences.length) { autoNextChapter(); return; }
    idx = i;
    highlight(i);
    const em = detectEmotion(sentences[i].text);
    ttsRequest(buildBody(sentences[i].text, em.key))
      .then((buf) => {
        if (!playing) return;
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mp3' }));
        curAudio = new Audio(url);
        curAudio.onended = () => { URL.revokeObjectURL(url); playFrom(i + 1); };
        curAudio.play().catch(() => { /* 自动播放策略：用户已交互，通常可播 */ });
      })
      .catch((err) => {
        log('合成失败：' + err.message + '（去设置填 API 凭证）');
        if (playing) playFrom(i + 1);
      });
  }
  function startPlay() {
    if (!CFG.appid && !CFG.apiKey) { log('未配置豆包凭证，点 ⚙ 设置'); return; }
    if (!sentences.length) { log('未检测到正文'); return; }
    if (bc) bc.postMessage('play'); // 跨标签页互斥
    playing = true;
    document.getElementById('nvcPlay').textContent = '⏸ 暂停';
    playFrom(idx >= sentences.length ? 0 : idx);
  }
  function pausePlay() {
    playing = false;
    if (curAudio) curAudio.pause();
    const b = document.getElementById('nvcPlay'); if (b) b.textContent = '▶ 播放';
  }
  function stopAll() {
    playing = false;
    if (curAudio) { curAudio.pause(); curAudio.src = ''; curAudio = null; }
    sentences.forEach(s => s.el && s.el.classList.remove('nvc-active'));
    idx = 0;
    const b = document.getElementById('nvcPlay'); if (b) b.textContent = '▶ 播放';
  }
  function autoNextChapter() {
    const links = Array.from(document.querySelectorAll('a'));
    const nx = links.find(a => /下一章|下一页|下一张|下一节|下一回/.test(a.textContent) && a.offsetParent !== null);
    if (nx) {
      log('本章读完，自动翻页…');
      stopAll();
      nx.click();
      setTimeout(initContent, 2000);
    } else {
      log('已到最后一章');
      stopAll();
    }
  }

  /* ===================== 正文提取（DOM 实体化） ===================== */
  const CONTENT_SELECTORS = [
    '.content', '#content', '.chapter-content', '.chapterContent', '#chapter-content',
    '.reader-content', '.read-content', '#txt', '.txt', '.book-content', '.novel-content', 'article',
  ];
  function findContainer() {
    for (const sel of CONTENT_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 200) return el;
    }
    const links = Array.from(document.querySelectorAll('a'));
    const next = links.find(a => /下一章|下一页|下一张/.test(a.textContent));
    if (next) {
      let p = next;
      for (let i = 0; i < 6; i++) { p = p.parentElement; if (p && p.innerText && p.innerText.length > 300) return p; }
    }
    return null;
  }
  function initContent() {
    const container = findContainer();
    if (!container) { log('未识别到小说正文'); return; }
    originalContainer = container;
    const rawText = container.innerText;
    const paraTexts = rawText.split(/\n{1,}/).map(s => s.trim()).filter(s => s && s.length > 1 && !isAd(s));
    sentences = [];
    const render = document.createElement('div');
    render.className = 'nvc-render';
    paraTexts.forEach(pt => {
      const p = document.createElement('div');
      p.className = 'nvc-p';
      splitSentences(pt).forEach(st => {
        const sp = document.createElement('span');
        sp.className = 'nvc-s';
        sp.textContent = st;
        p.appendChild(sp);
        p.appendChild(document.createTextNode(' '));
        sentences.push({ el: sp, text: st });
      });
      render.appendChild(p);
    });
    if (!sentences.length) { log('正文中无可朗读句子'); return; }
    container.style.display = 'none';
    container.parentNode.insertBefore(render, container);
    renderEl = render;
    log('已加载 ' + sentences.length + ' 句，点 ▶ 播放');
  }

  /* ===================== 录音 / 上传 → 克隆 ===================== */
  function audioBufferToWav(buffer) {
    const numCh = 1, sr = buffer.sampleRate, samples = buffer.getChannelData(0);
    const len = samples.length * 2;
    const ab = new ArrayBuffer(44 + len);
    const view = new DataView(ab);
    const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); view.setUint32(4, 36 + len, true); ws(8, 'WAVE');
    ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * numCh * 2, true); view.setUint16(32, numCh * 2, true); view.setUint16(34, 16, true);
    ws(36, 'data'); view.setUint32(40, len, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return ab;
  }
  function bufToBase64(buf) {
    let bin = '', bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function saveMyVoiceFromBuffer(audioBuf) {
    const wav = audioBufferToWav(audioBuf);
    const b64 = bufToBase64(wav);
    CFG.myVoice = b64; CFG.myVoiceFmt = 'wav';
    GM_setValue('nvc_myVoice', b64); GM_setValue('nvc_myVoiceFmt', 'wav');
    refreshVoiceOptions();
    log('已保存「我的声音」（wav，' + Math.round(wav.byteLength / 1024) + 'KB）');
  }
  async function handleRecordingStop() {
    const blob = new Blob(recChunks, { type: rec.mimeType });
    try {
      const ab = await blob.arrayBuffer();
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ac.decodeAudioData(ab);
      saveMyVoiceFromBuffer(buf);
    } catch (e) {
      log('录音解码失败，请用「上传参考音频」（需 wav/mp3）');
    }
  }
  function toggleRecord() {
    const btn = document.getElementById('nvcRec');
    if (rec && rec.state === 'recording') {
      rec.stop(); recStream.getTracks().forEach(t => t.stop());
      btn.textContent = '● 录制我的声音'; btn.classList.remove('nvc-rec-on');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      recStream = stream; recChunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = e => recChunks.push(e.data);
      rec.onstop = handleRecordingStop;
      rec.start();
      btn.textContent = '■ 停止录制'; btn.classList.add('nvc-rec-on');
      log('录音中…朗读一段文字（10~30秒最佳）');
    }).catch(() => log('无法访问麦克风（需 https 或 localhost）'));
  }
  function handleUpload(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      ac.decodeAudioData(reader.result.slice(0)).then(saveMyVoiceFromBuffer)
        .catch(() => log('音频解码失败，换 wav/mp3'));
    };
    reader.readAsArrayBuffer(file);
  }

  /* ===================== 面板 UI ===================== */
  function refreshVoiceOptions() {
    const sel = document.getElementById('nvcVoice');
    if (!sel) return;
    sel.innerHTML = '';
    PRESET_VOICES.forEach(v => {
      const o = document.createElement('option'); o.value = v.id; o.textContent = v.name; sel.appendChild(o);
    });
    if (CFG.myVoice) {
      const o = document.createElement('option'); o.value = '__mine__'; o.textContent = '★ 我的声音（录音克隆）'; sel.appendChild(o);
    }
    sel.value = CFG.useMyVoice ? '__mine__' : CFG.voiceType;
  }
  function buildUI() {
    if (document.getElementById('nvcFab')) return;
    GM_addStyle(`
      .nvc-fab{position:fixed;right:16px;bottom:84px;z-index:99999;width:48px;height:48px;border-radius:50%;
        background:#12b3a6;color:#fff;border:none;font-size:20px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}
      .nvc-panel{position:fixed;right:16px;bottom:140px;width:300px;z-index:99999;background:#fff;color:#1f2329;
        border:1px solid #e3e6eb;border-radius:12px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.15)}
      .nvc-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#12b3a6;color:#fff;
        border-radius:12px 12px 0 0;cursor:move;font-weight:500}
      .nvc-bar span{cursor:pointer;opacity:.85}
      .nvc-body{padding:10px 12px;max-height:60vh;overflow:auto}
      .nvc-row{display:flex;gap:8px;margin:8px 0}
      .nvc-row button{flex:1;padding:6px;border:1px solid #d0d3d9;border-radius:8px;background:#f4f5f7;cursor:pointer}
      .nvc-row button:hover{background:#e9eaed}
      .nvc-panel label{display:block;margin:8px 0 2px;color:#5f5e5a;font-size:12px}
      .nvc-panel select,.nvc-panel input[type=text]{width:100%;padding:5px;border:1px solid #d0d3d9;border-radius:8px;box-sizing:border-box}
      .nvc-panel input[type=range]{width:100%}
      .nvc-panel button.nvc-wide{width:100%;margin-top:8px;padding:7px;border:1px solid #d0d3d9;border-radius:8px;background:#f4f5f7;cursor:pointer}
      .nvc-panel button.nvc-wide:hover{background:#e9eaed}
      .nvc-rec-on{background:#e24b4a!important;color:#fff!important}
      .nvc-set-box{margin-top:8px;border-top:1px dashed #e3e6eb;padding-top:8px;display:none}
      .nvc-log{margin-top:8px;font-size:12px;color:#12b3a6;min-height:16px}
      .nvc-render{line-height:1.9;font-size:18px;padding:8px 4px}
      .nvc-p{margin:0 0 6px}
      .nvc-s.nvc-active{background:#12b3a6;color:#fff;border-radius:3px;padding:0 2px}
    `);
    const fab = document.createElement('button');
    fab.id = 'nvcFab'; fab.className = 'nvc-fab'; fab.textContent = '♫';
    fab.title = '青简听书·音色克隆';
    fab.onclick = () => {
      const p = document.getElementById('nvcPanel');
      p.style.display = (p.style.display === 'none') ? 'block' : 'none';
    };
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'nvcPanel'; panel.className = 'nvc-panel';
    panel.innerHTML = `
      <div class="nvc-bar"><span>青简听书·音色克隆</span><span id="nvcHide">—</span></div>
      <div class="nvc-body">
        <div class="nvc-row">
          <button id="nvcPlay">▶ 播放</button>
          <button id="nvcStop">■ 停止</button>
        </div>
        <div class="nvc-row">
          <button id="nvcPrev">⏮ 上句</button>
          <button id="nvcNext">下句 ⏭</button>
        </div>
        <label>音色</label>
        <select id="nvcVoice"></select>
        <label>语速 <span id="nvcSpeedVal"></span></label>
        <input type="range" id="nvcSpeed" min="0.5" max="2" step="0.1">
        <label>音量 <span id="nvcVolVal"></span></label>
        <input type="range" id="nvcVol" min="0.5" max="2" step="0.1">
        <label>情绪模式</label>
        <select id="nvcEmotion">
          <option value="auto">自动识别（标签+启发式）</option>
          <option value="off">关闭（中性）</option>
          <option value="global">全局固定</option>
        </select>
        <label>全局情绪</label>
        <select id="nvcGlobalEmotion">
          <option value="neutral">平静</option><option value="happy">开心</option>
          <option value="angry">愤怒</option><option value="sad">悲伤</option>
          <option value="surprised">惊讶</option><option value="fearful">害怕</option>
        </select>
        <button id="nvcRec" class="nvc-wide">● 录制我的声音</button>
        <label style="margin-top:8px">或上传参考音频（wav/mp3）</label>
        <input type="file" id="nvcUpload" accept="audio/*" style="width:100%">
        <button id="nvcSettings" class="nvc-wide">⚙ 豆包 API 设置</button>
        <div class="nvc-set-box" id="nvcSetBox">
          <label>AppID</label><input type="text" id="nvcAppid">
          <label>Token</label><input type="text" id="nvcToken">
          <label>Cluster</label><input type="text" id="nvcCluster">
          <label>API Key（新版，可选）</label><input type="text" id="nvcApiKey">
          <label>官方预设音色ID</label><input type="text" id="nvcVoiceType">
          <button id="nvcSave" class="nvc-wide" style="background:#12b3a6;color:#fff">保存</button>
        </div>
        <div class="nvc-log" id="nvcLog"></div>
      </div>`
    ;
    document.body.appendChild(panel);

    // 拖拽
    const bar = panel.querySelector('.nvc-bar');
    let drag = false, dx = 0, dy = 0;
    bar.addEventListener('mousedown', e => { if (e.target.id === 'nvcHide') return; drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; });
    document.addEventListener('mousemove', e => { if (drag) { panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; } });
    document.addEventListener('mouseup', () => drag = false);
    document.getElementById('nvcHide').onclick = () => { panel.style.display = 'none'; };

    // 事件
    document.getElementById('nvcPlay').onclick = () => { playing ? pausePlay() : startPlay(); };
    document.getElementById('nvcStop').onclick = stopAll;
    document.getElementById('nvcPrev').onclick = () => { if (idx > 0) playFrom(idx - 1); };
    document.getElementById('nvcNext').onclick = () => playFrom(idx + 1);
    const sp = document.getElementById('nvcSpeed'); sp.value = CFG.speed; document.getElementById('nvcSpeedVal').textContent = CFG.speed;
    sp.oninput = () => { CFG.speed = parseFloat(sp.value); GM_setValue('nvc_speed', CFG.speed); document.getElementById('nvcSpeedVal').textContent = CFG.speed; };
    const vo = document.getElementById('nvcVol'); vo.value = CFG.volume; document.getElementById('nvcVolVal').textContent = CFG.volume;
    vo.oninput = () => { CFG.volume = parseFloat(vo.value); GM_setValue('nvc_volume', CFG.volume); document.getElementById('nvcVolVal').textContent = CFG.volume; };
    document.getElementById('nvcEmotion').value = CFG.emotionMode;
    document.getElementById('nvcEmotion').onchange = e => { CFG.emotionMode = e.target.value; GM_setValue('nvc_emotion', CFG.emotionMode); };
    document.getElementById('nvcGlobalEmotion').value = CFG.globalEmotion;
    document.getElementById('nvcGlobalEmotion').onchange = e => { CFG.globalEmotion = e.target.value; GM_setValue('nvc_globalEmotion', CFG.globalEmotion); };
    document.getElementById('nvcVoice').onchange = e => {
      if (e.target.value === '__mine__') { CFG.useMyVoice = true; GM_setValue('nvc_useMyVoice', true); }
      else { CFG.useMyVoice = false; CFG.voiceType = e.target.value; GM_setValue('nvc_useMyVoice', false); GM_setValue('nvc_voice', CFG.voiceType); }
    };
    document.getElementById('nvcRec').onclick = toggleRecord;
    document.getElementById('nvcUpload').onchange = e => { if (e.target.files[0]) handleUpload(e.target.files[0]); };
    document.getElementById('nvcSettings').onclick = () => {
      const b = document.getElementById('nvcSetBox'); b.style.display = (b.style.display === 'none') ? 'block' : 'none';
      document.getElementById('nvcAppid').value = CFG.appid;
      document.getElementById('nvcToken').value = CFG.token;
      document.getElementById('nvcCluster').value = CFG.cluster;
      document.getElementById('nvcApiKey').value = CFG.apiKey;
      document.getElementById('nvcVoiceType').value = CFG.voiceType;
    };
    document.getElementById('nvcSave').onclick = () => {
      CFG.appid = document.getElementById('nvcAppid').value.trim();
      CFG.token = document.getElementById('nvcToken').value.trim();
      CFG.cluster = document.getElementById('nvcCluster').value.trim() || 'volcano_tts';
      CFG.apiKey = document.getElementById('nvcApiKey').value.trim();
      CFG.voiceType = document.getElementById('nvcVoiceType').value.trim() || 'zh_female_qingxin';
      GM_setValue('nvc_appid', CFG.appid); GM_setValue('nvc_token', CFG.token);
      GM_setValue('nvc_cluster', CFG.cluster); GM_setValue('nvc_apiKey', CFG.apiKey);
      GM_setValue('nvc_voice', CFG.voiceType);
      log('设置已保存');
    };

    refreshVoiceOptions();
  }

  /* ===================== 初始化 / 菜单 ===================== */
  function boot() {
    if (!CFG.enabled) return;
    buildUI();
    initContent();
  }
  function toggleSite() {
    CFG.enabled = !CFG.enabled;
    GM_setValue('nvc_enabled', CFG.enabled);
    log(CFG.enabled ? '已在本站启用' : '已在本站禁用，刷新生效');
    if (CFG.enabled) boot();
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('青简听书·在本站启用/禁用', toggleSite, 'n');
    GM_registerMenuCommand('青简听书·打开设置', () => { const b = document.getElementById('nvcSetBox'); if (b) { b.style.display = 'block'; document.getElementById('nvcSettings').click(); } }, 's');
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(boot, 600);
  else window.addEventListener('DOMContentLoaded', () => setTimeout(boot, 600));
})();
