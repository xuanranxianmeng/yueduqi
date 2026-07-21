import fs from 'fs';
const ENGINE_PATH = 'C:/ProgramData/WorkBuddy/chromium-env/1t4wiva/WorkBuddy/2026-07-20-21-47-15/webapp/engine.js';
(0, eval)(fs.readFileSync(ENGINE_PATH, 'utf-8'));
const E = globalThis.BookEngine;

// 用符合寒武纪年规则结构的样本做确定性验证（绕开外站会话限制）
const sampleInfo = JSON.stringify({
  articlename: '诱捕定律', author: '昆怡', image: 'https://img/x.jpg', articleid: 102525,
  intro: '一段简介', lastchapter: '第10章', presize: '30万', pubtime: '2024-01-01',
});
const sampleToc = JSON.stringify({ data: [
  { chaptername: '第1章 开端', chapterid: 1, chaptertype: '0' },
  { chaptername: '第2章 发展', chapterid: 2, chaptertype: '0' },
  { chaptername: '分卷', chapterid: 3, chaptertype: '1' },
] });
const sampleContent = JSON.stringify({ data: { content: '这是第一章的正文内容。\n第二段落。' } });

const source = {
  ruleBookInfo: {
    name: '$.articlename', author: '$.author', coverUrl: '$.image@put:{a:$.articleid}',
    intro: '&nbsp;最近更新：{{$.pubtime&&$.intro}}', tocUrl: 'https://x/bookmenupage.php?aid={$.articleid}',
  },
  ruleToc: {
    chapterList: '$.data[*]', chapterName: '$.chaptername',
    chapterUrl: 'https://x/read.php?aid=@get:{a}&cid={{$.chapterid}} @js: "{{$.chaptertype}}"=="1"?"":result',
  },
  ruleContent: { content: '$.data.content' },
};

const ctx = { vars: {}, baseUrl: '', source: {} };
console.log('=== 详情 ===');
const info = E.parseBookInfo(sampleInfo, source, ctx);
console.log('  name:', info.name, '| author:', info.author, '| coverUrl:', info.coverUrl);
console.log('  intro(模板+&&):', info.intro);
console.log('  tocUrl:', info.tocUrl);
console.log('  @put 写入 vars.a =', ctx.vars.a);

console.log('=== 目录 ===');
const toc = E.parseToc(sampleToc, source, ctx);
console.log('  章节数:', toc.length);
toc.forEach((c) => console.log('   -', c.name, '|', c.url));
console.log('  （分卷章节 chaptertype=1 应被 @js 过滤掉 → 实际', toc.length, '条，预期 2 条）');

console.log('=== 正文 ===');
const content = E.parseContent(sampleContent, source, ctx);
console.log('  长度:', content.length, '| 内容:', content);

const ok = info.name === '诱捕定律' && info.author === '昆怡' && ctx.vars.a == 102525
  && toc.length === 2 && toc[0].url.includes('aid=102525') && content.startsWith('这是第一章');
console.log('\n' + (ok ? '✅ 引擎四段(JSONPath/模板/&&/@put/@get/@js)全部正确' : '❌ 仍有错误'));
