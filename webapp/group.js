/*
 * group.js — 搜索结果「多书源合并」
 * 借鉴阅读 App（legado）的「换源」机制：
 *   同一本书（同名+作者）往往来自多个书源，搜出来是多条记录。
 *   这里按 书名+作者 合并成一本「合并书」，把所有来源保留在 _sources 里，
 *   供详情页列出让用户手动挑能看 / 非假源的那个。
 * 纯函数，不依赖 DOM / 网络，方便单测（浏览器与 Node 通用）。
 */
(function (root) {
  'use strict';

  // 合并搜索结果。results 中每一项结构：
  //   { name, author, coverUrl, bookUrl, intro, _srcIdx, _srcName, _score }
  // 返回的「合并书」结构：
  //   { name, author, intro, coverUrl, _score, _sources: [ { srcIdx, srcName, coverUrl, bookUrl, intro, author } ] }
  function groupBooks(results) {
    if (!Array.isArray(results)) return [];
    var map = new Map();

    results.forEach(function (b) {
      var name = b.name || '';
      var author = b.author || '';
      var key = name + '\x00' + author;

      if (!map.has(key)) {
        map.set(key, {
          name: name,
          author: author,
          intro: b.intro || '',
          coverUrl: b.coverUrl || '',
          _score: b._score || 0,
          _sources: []
        });
      }
      var g = map.get(key);
      g._sources.push({
        srcIdx: b._srcIdx,
        srcName: b._srcName || '',
        coverUrl: b.coverUrl || '',
        bookUrl: b.bookUrl || '',
        intro: b.intro || '',
        author: author
      });
      // 选最优「代表封面 / 简介」（优先使用有值的源）
      if (!g.coverUrl && b.coverUrl) g.coverUrl = b.coverUrl;
      if (!g.intro && b.intro) g.intro = b.intro;
      if ((b._score || 0) > g._score) g._score = b._score;
    });

    var arr = Array.from(map.values());
    arr.sort(function (a, b) {
      // 第一键：相关度分数
      var ds = (b._score || 0) - (a._score || 0);
      if (ds !== 0) return ds;
      // 第二键：来源数量（多源 = 更多站点有这本书 = 更可能是正版/原版）
      var db = (b._sources ? b._sources.length : 0) - (a._sources ? a._sources.length : 0);
      if (db !== 0) return db;
      // 第三键：有封面优先（信息更完整）
      var da = (a.coverUrl ? 1 : 0) - (b.coverUrl ? 1 : 0);
      return da;
    });
    return arr;
  }

  root.groupBooks = groupBooks;
})(typeof window !== 'undefined' ? window : globalThis);
