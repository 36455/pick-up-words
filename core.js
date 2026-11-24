/*
 * 拾词 · 核心纯函数
 * 不依赖 DOM / 浏览器 API，可直接在 Node 中测试。
 * 浏览器通过 window.CihaiCore 访问。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CihaiCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;
  var INTERVALS = [1, 3, 7, 14, 30, 60];
  var DIM_IDS = ['recognize', 'spell', 'meaning'];
  var DIM_LABEL = { recognize: '识别', spell: '拼写', meaning: '释义' };
  var MAX_LEVEL = 6;
  var HISTORY_LIMIT = 30;
  var ACCURACY_WINDOW = 10;

  // SM-2 简易参数：初始难度因子、上下限与最长间隔（天）
  var EASE_START = 2.5;
  var EASE_MIN = 1.3;
  var EASE_MAX = 3.0;
  var MAX_INTERVAL = 365;

  var MODES = {
    spell: { id: 'spell', label: '听音拼写', dim: 'spell', kind: 'spell', needsCn: false },
    cnSpell: { id: 'cnSpell', label: '看中文拼写', dim: 'spell', kind: 'spell', needsCn: true },
    meaningChoice: { id: 'meaningChoice', label: '释义选词', dim: 'recognize', kind: 'choice', needsCn: true },
    listenChoice: { id: 'listenChoice', label: '听音选词', dim: 'recognize', kind: 'choice', needsCn: false },
    writeMeaning: { id: 'writeMeaning', label: '写释义', dim: 'meaning', kind: 'inputCn', needsCn: true },
    cloze: { id: 'cloze', label: '例句填空', dim: 'spell', kind: 'spell', needsCn: false },
    dictation: { id: 'dictation', label: '整句听写', dim: 'spell', kind: 'spell', needsCn: false },
    multiCloze: { id: 'multiCloze', label: '多空填空', dim: 'spell', kind: 'spell', needsCn: false },
    quick: { id: 'quick', label: '速认', dim: 'recognize', kind: 'rate', needsCn: false }
  };
  var MODE_IDS = ['spell', 'cnSpell', 'meaningChoice', 'listenChoice', 'writeMeaning', 'cloze', 'dictation', 'multiCloze', 'quick'];

  var DEFAULT_BOOK_ID = 'book-default';
  var DEFAULT_BOOK_NAME = '默认生词本';

  /* ---------------- 基础工具 ---------------- */

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function normalizeWord(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // 拼写判定：忽略大小写与首尾空白，保留连字符 / 撇号
  function normalizeSpelling(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // 释义判定：去掉空白与常见中英文标点
  function normalizeMeaning(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[\s"'“”‘’.,!?;:、，。！？；：（）()\[\]【】《》<>·…—–\-_/\\|]/g, '');
  }

  function hasCJK(value) {
    return /[\u3400-\u9fff]/.test(String(value || ''));
  }

  function cjkLength(value) {
    var m = String(value || '').match(/[\u3400-\u9fff]/g);
    return m ? m.length : 0;
  }

  /* ---------------- 模糊匹配（LCS） ---------------- */

  function lcsLength(a, b) {
    a = String(a == null ? '' : a);
    b = String(b == null ? '' : b);
    if (!a.length || !b.length) return 0;
    var prev = new Array(b.length + 1).fill(0);
    var cur = new Array(b.length + 1).fill(0);
    for (var i = 1; i <= a.length; i++) {
      for (var j = 1; j <= b.length; j++) {
        cur[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
          ? prev[j - 1] + 1
          : Math.max(prev[j], cur[j - 1]);
      }
      var tmp = prev;
      prev = cur;
      cur = tmp;
      cur.fill(0);
    }
    return prev[b.length];
  }

  // 归一化 LCS 相似度：LCS 长度 / 较短字符串长度
  function lcsSimilarity(a, b) {
    var na = normalizeMeaning(a);
    var nb = normalizeMeaning(b);
    if (!na.length || !nb.length) return 0;
    return lcsLength(na, nb) / Math.min(na.length, nb.length);
  }

  function isFuzzyMatch(input, target, threshold) {
    var t = threshold == null ? 0.75 : threshold;
    if (!normalizeMeaning(target)) return false;
    return lcsSimilarity(input, target) >= t;
  }

  /* ---------------- 干扰项 ---------------- */

  function bigrams(str) {
    var s = String(str || '').toLowerCase().replace(/[^a-z]/g, '');
    var out = [];
    for (var i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  }

  function diceCoefficient(a, b) {
    var ba = bigrams(a);
    var bb = bigrams(b);
    if (!ba.length || !bb.length) return 0;
    var pool = bb.slice();
    var hit = 0;
    ba.forEach(function (g) {
      var idx = pool.indexOf(g);
      if (idx >= 0) {
        hit++;
        pool.splice(idx, 1);
      }
    });
    return (2 * hit) / (ba.length + bb.length);
  }

  function commonPrefixLength(a, b) {
    var n = Math.min(a.length, b.length);
    var i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  function formScore(a, b) {
    var x = String(a || '').toLowerCase();
    var y = String(b || '').toLowerCase();
    if (!x.length || !y.length) return 0;
    var maxLen = Math.max(x.length, y.length);
    var lenScore = 1 - Math.abs(x.length - y.length) / maxLen;
    var prefix = commonPrefixLength(x, y) / Math.min(x.length, y.length);
    return 0.5 * diceCoefficient(x, y) + 0.32 * lenScore + 0.18 * prefix;
  }

  function pickDistractors(target, pool, count, rand) {
    var n = count == null ? 3 : count;
    var rnd = typeof rand === 'function' ? rand : Math.random;
    var targetKey = normalizeWord(target && target.word);
    var candidates = (pool || []).filter(function (w) {
      return w && w.id !== target.id && w.word && normalizeWord(w.word) !== targetKey;
    });
    var scored = candidates.map(function (w) {
      return { word: w, score: formScore(target.word, w.word) + rnd() * 0.15 };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, n).map(function (x) { return x.word; });
  }

  /* ---------------- 掌握度 ---------------- */

  function emptyDim() {
    return {
      right: 0, wrong: 0, level: 0, due: 0, history: [],
      modes: {}, ease: EASE_START, interval: 0, reps: 0, lapses: 0
    };
  }

  // 归一化维度记录：旧数据没有 ease / interval / reps，用 level 推导，保持可用
  function normalizeDim(raw) {
    var d = raw || {};
    var level = clamp(Number(d.level) || 0, 0, MAX_LEVEL);
    var ease = Number(d.ease);
    if (!isFinite(ease) || ease <= 0) ease = EASE_START;
    var reps = Number(d.reps);
    if (!isFinite(reps) || reps < 0) reps = level;
    var interval = Number(d.interval);
    if (!isFinite(interval) || interval < 0) interval = level > 0 ? INTERVALS[level - 1] : 0;
    var modes = {};
    if (d.modes && typeof d.modes === 'object') {
      MODE_IDS.forEach(function (id) {
        var m = d.modes[id];
        if (!m) return;
        modes[id] = {
          right: Number(m.right) || 0,
          wrong: Number(m.wrong) || 0,
          lastAt: Number(m.lastAt) || 0
        };
      });
    }
    return {
      right: Number(d.right) || 0,
      wrong: Number(d.wrong) || 0,
      level: level,
      due: Number(d.due) || 0,
      history: historyOf(d).slice(-HISTORY_LIMIT).map(function (h) {
        return { t: Number(h && h.t) || 0, ok: !!(h && h.ok), mode: String((h && h.mode) || '') };
      }),
      modes: modes,
      ease: ease,
      interval: interval,
      reps: reps,
      lapses: Number(d.lapses) || 0
    };
  }

  function historyOf(dim) {
    return (dim && Array.isArray(dim.history)) ? dim.history : [];
  }

  function dimScore(dim) {
    var history = historyOf(dim);
    if (!history.length) return null;
    var recent = history.slice(-ACCURACY_WINDOW);
    var right = recent.filter(function (h) { return h && h.ok; }).length;
    var accuracy = right / recent.length;
    var level = clamp(Number(dim.level) || 0, 0, MAX_LEVEL);
    return Math.round((0.6 * accuracy + 0.4 * (level / MAX_LEVEL)) * 100);
  }

  function wordScores(word) {
    var dims = (word && word.dims) || {};
    var out = {};
    DIM_IDS.forEach(function (id) {
      out[id] = dimScore(dims[id]);
    });
    return out;
  }

  function wordMastery(word) {
    var scores = wordScores(word);
    var values = DIM_IDS.map(function (id) { return scores[id]; })
      .filter(function (v) { return v !== null; });
    if (!values.length) return null;
    var sum = values.reduce(function (a, b) { return a + b; }, 0);
    return Math.round(sum / values.length);
  }

  function masteryLevel(score) {
    if (score === null || score === undefined) return { key: 'new', label: '未开始' };
    if (score < 40) return { key: 'weak', label: '薄弱' };
    if (score < 70) return { key: 'fair', label: '一般' };
    if (score < 90) return { key: 'good', label: '良好' };
    return { key: 'mastered', label: '已掌握' };
  }

  function hasAnyHistory(word) {
    var dims = (word && word.dims) || {};
    return DIM_IDS.some(function (id) { return historyOf(dims[id]).length > 0; });
  }

  function isDue(dim, now) {
    if (!dim) return true;
    if (!historyOf(dim).length) return true;
    return (Number(dim.due) || 0) <= (now == null ? Date.now() : now);
  }

  function hasDueDim(word, now) {
    var dims = (word && word.dims) || {};
    return DIM_IDS.some(function (id) {
      var d = dims[id];
      return d && historyOf(d).length > 0 && isDue(d, now);
    });
  }

  // SM-2 简易排期：答对按难度因子拉长间隔，答错重置为 1 天并降低难度因子。
  // 同时按考查方式累计 right / wrong，供「每种测试方式错了多少次」展示。
  function applyAnswer(dim, correct, mode, now) {
    var t = now == null ? Date.now() : now;
    var base = dim ? JSON.parse(JSON.stringify(dim)) : emptyDim();
    base.history = historyOf(base).slice(-(HISTORY_LIMIT - 1));
    base.history.push({ t: t, ok: !!correct, mode: mode || '' });

    var ease = Number(base.ease);
    if (!isFinite(ease) || ease <= 0) ease = EASE_START;
    var reps = Number(base.reps);
    if (!isFinite(reps) || reps < 0) reps = clamp(Number(base.level) || 0, 0, MAX_LEVEL);
    var interval = Number(base.interval);
    if (!isFinite(interval) || interval < 0) {
      var lvNow = clamp(Number(base.level) || 0, 0, MAX_LEVEL);
      interval = lvNow > 0 ? INTERVALS[lvNow - 1] : 0;
    }

    var modes = (base.modes && typeof base.modes === 'object') ? base.modes : {};
    var modeKey = String(mode || '');
    var m = modes[modeKey] || { right: 0, wrong: 0, lastAt: 0 };

    if (correct) {
      base.right = (base.right || 0) + 1;
      m.right = (Number(m.right) || 0) + 1;
      reps += 1;
      if (reps === 1) interval = 1;
      else if (reps === 2) interval = 3;
      else interval = Math.round(Math.max(interval, 1) * ease);
      interval = clamp(interval, 1, MAX_INTERVAL);
      ease = clamp(ease + 0.1, EASE_MIN, EASE_MAX);
      base.level = clamp((Number(base.level) || 0) + 1, 0, MAX_LEVEL);
    } else {
      base.wrong = (base.wrong || 0) + 1;
      m.wrong = (Number(m.wrong) || 0) + 1;
      reps = 0;
      interval = 1;
      ease = clamp(ease - 0.2, EASE_MIN, EASE_MAX);
      base.lapses = (Number(base.lapses) || 0) + 1;
      base.level = 0;
    }

    if (modeKey) {
      m.lastAt = t;
      modes[modeKey] = m;
    }
    base.modes = modes;
    base.ease = ease;
    base.interval = interval;
    base.reps = reps;
    base.due = t + interval * DAY;
    return base;
  }

  // 累计错误次数（历史最多保留 30 条/维度，较早的错误会自然淡出）
  function mistakeCount(word) {
    var dims = (word && word.dims) || {};
    var n = 0;
    DIM_IDS.forEach(function (id) {
      historyOf(dims[id]).forEach(function (h) {
        if (h && !h.ok) n++;
      });
    });
    return n;
  }

  function isMistakeWord(word) {
    return mistakeCount(word) > 0;
  }

  // 顽固词：合并各维度历史，最近连续答错的次数达到阈值
  var LEECH_STREAK = 3;

  function wrongStreak(word) {
    var dims = (word && word.dims) || {};
    var merged = [];
    DIM_IDS.forEach(function (id) {
      historyOf(dims[id]).forEach(function (h) {
        if (!h) return;
        merged.push({ t: Number(h.t) || 0, ok: !!h.ok });
      });
    });
    merged.sort(function (a, b) { return a.t - b.t; });
    var n = 0;
    for (var i = merged.length - 1; i >= 0; i--) {
      if (merged[i].ok) break;
      n++;
    }
    return n;
  }

  function isLeech(word, threshold) {
    var need = Number(threshold) > 0 ? Number(threshold) : LEECH_STREAK;
    return wrongStreak(word) >= need;
  }

  // 每种考查方式的累计对/错次数，按错误数从多到少排序
  function wordModeStats(word) {
    var dims = (word && word.dims) || {};
    var out = [];
    DIM_IDS.forEach(function (dimId) {
      var modes = (dims[dimId] && dims[dimId].modes) || {};
      MODE_IDS.forEach(function (modeId) {
        var s = modes[modeId];
        if (!s) return;
        var right = Number(s.right) || 0;
        var wrong = Number(s.wrong) || 0;
        if (!right && !wrong) return;
        out.push({
          mode: modeId,
          dim: dimId,
          label: MODES[modeId].label,
          right: right,
          wrong: wrong,
          total: right + wrong,
          lastAt: Number(s.lastAt) || 0
        });
      });
    });
    out.sort(function (a, b) {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong;
      return b.total - a.total;
    });
    return out;
  }

  /* ---------------- 例句填空（cloze） ---------------- */

  // 在句子中定位目标词（忽略大小写，要求前后不是字母/数字）
  function findWordInSentence(sentence, word) {
    var s = String(sentence || '');
    var w = String(word || '').trim();
    if (!s || !w) return -1;
    var lower = s.toLowerCase();
    var target = w.toLowerCase();
    var from = 0;
    while (from <= lower.length - target.length) {
      var idx = lower.indexOf(target, from);
      if (idx < 0) return -1;
      var before = idx === 0 ? '' : lower.charAt(idx - 1);
      var after = lower.charAt(idx + target.length);
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return idx;
      from = idx + 1;
    }
    return -1;
  }

  // 找到可用于填空的例句；没有例句或例句中不含目标词时返回 null
  function clozeFor(word) {
    var examples = (word && Array.isArray(word.examples)) ? word.examples : [];
    for (var i = 0; i < examples.length; i++) {
      var ex = examples[i] || {};
      var en = String(ex.en || '');
      if (!en) continue;
      var idx = findWordInSentence(en, word.word);
      if (idx < 0) continue;
      var answer = en.slice(idx, idx + String(word.word).length);
      return {
        before: en.slice(0, idx),
        after: en.slice(idx + answer.length),
        answer: answer,
        cn: String(ex.cn || ''),
        exampleId: ex.id || ''
      };
    }
    return null;
  }

  /* ---------------- 一词多义 / 整句听写 / 多空填空 ---------------- */

  // 释义分条：支持 | ｜ 与中英文分号分隔；每条可带词性前缀，如「n. 焦虑」
  function parseSenses(text) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return [];
    var out = [];
    raw.split(/\s*[|｜]\s*|\s*[；;]\s*/).forEach(function (part) {
      var s = String(part || '').trim();
      if (!s) return;
      var pos = '';
      var m = s.match(/^([A-Za-z]{1,6}\.)\s*(.*)$/);
      if (m) {
        var parsed = parsePos(m[1]);
        if (parsed) {
          pos = parsed;
          s = m[2].trim();
        }
      }
      if (!s) return;
      out.push({ id: '', pos: pos, cn: s });
    });
    return out;
  }

  // 归一化分条列表；没有分条时从中文释义回填
  function normalizeSenses(list, cnFallback) {
    var out = [];
    if (Array.isArray(list)) {
      list.forEach(function (raw) {
        if (!raw) return;
        var cn = String(raw.cn || '').trim();
        if (!cn) return;
        out.push({
          id: String(raw.id || ''),
          pos: String(raw.pos || '').trim(),
          cn: cn
        });
      });
    }
    if (!out.length) out = parseSenses(cnFallback);
    return out;
  }

  // 分条合并为展示用中文释义
  function sensesText(senses) {
    return (senses || []).map(function (s) { return String((s && s.cn) || '').trim(); })
      .filter(Boolean).join('；');
  }

  // 释义判定：任一分条匹配即算对
  function meaningMatch(input, word) {
    var senses = (word && Array.isArray(word.senses)) ? word.senses : [];
    for (var i = 0; i < senses.length; i++) {
      if (senses[i] && senses[i].cn && isFuzzyMatch(input, senses[i].cn, 0.75)) return true;
    }
    return isFuzzyMatch(input, (word && word.cn) || '', 0.75);
  }

  // 整句判定：忽略大小写、空格与标点，按 LCS 相似度判定（以较长句为分母，漏词会被扣分）
  function isSentenceMatch(input, target, threshold) {
    var t = threshold == null ? 0.85 : threshold;
    var a = normalizeMeaning(input);
    var b = normalizeMeaning(target);
    if (!a.length || !b.length) return false;
    return lcsLength(a, b) / Math.max(a.length, b.length) >= t;
  }

  // 整句听写：取第一条词数不少于 3 的英文例句
  function dictationFor(word) {
    var examples = (word && Array.isArray(word.examples)) ? word.examples : [];
    for (var i = 0; i < examples.length; i++) {
      var ex = examples[i] || {};
      var en = String(ex.en || '').trim();
      if (!en || wordCount(en) < 3) continue;
      return { en: en, cn: String(ex.cn || ''), exampleId: ex.id || '' };
    }
    return null;
  }

  var CLOZE_STOPWORDS = {
    the: 1, and: 1, for: 1, with: 1, that: 1, this: 1, from: 1, they: 1, them: 1, their: 1,
    there: 1, these: 1, those: 1, have: 1, has: 1, had: 1, was: 1, were: 1, are: 1, been: 1,
    his: 1, her: 1, him: 1, she: 1, you: 1, your: 1, our: 1, its: 1, not: 1, but: 1, what: 1,
    when: 1, where: 1, which: 1, who: 1, will: 1, would: 1, can: 1, could: 1, should: 1, about: 1
  };

  // 目标词在例句中可能以变形出现（abandon → abandoned），按词干前缀匹配
  function isWordForm(token, target) {
    var t = String(token || '').toLowerCase();
    var g = String(target || '').toLowerCase();
    if (!t || !g) return false;
    if (t === g) return true;
    if (g.length >= 4 && t.indexOf(g) === 0) return true;
    if (t.length >= 4 && g.indexOf(t) === 0) return true;
    return false;
  }

  // 多空填空：在含目标词的例句中挖 2~3 个空，返回分段与答案
  function multiClozeFor(word) {
    var examples = (word && Array.isArray(word.examples)) ? word.examples : [];
    var target = String((word && word.word) || '').trim();
    if (!target) return null;
    for (var i = 0; i < examples.length; i++) {
      var ex = examples[i] || {};
      var en = String(ex.en || '').trim();
      if (!en) continue;
      var tokens = [];
      var re = /[A-Za-z][A-Za-z'’-]*/g;
      var m;
      while ((m = re.exec(en))) {
        tokens.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      }
      if (tokens.length < 4) continue;
      var targetIdx = -1;
      tokens.forEach(function (tk, idx) {
        if (targetIdx < 0 && isWordForm(tk.text, target)) targetIdx = idx;
      });
      if (targetIdx < 0) continue;
      var chosen = [targetIdx];
      tokens.forEach(function (tk, idx) {
        if (chosen.length >= 3) return;
        if (idx === targetIdx) return;
        if (tk.text.length < 4) return;
        if (CLOZE_STOPWORDS[tk.text.toLowerCase()]) return;
        chosen.push(idx);
      });
      if (chosen.length < 2) continue;
      chosen.sort(function (a, b) { return a - b; });
      var segments = [];
      var answers = [];
      var cursor = 0;
      chosen.forEach(function (ti) {
        var tk = tokens[ti];
        if (tk.start > cursor) segments.push({ text: en.slice(cursor, tk.start) });
        segments.push({ blank: true, index: answers.length });
        answers.push(tk.text);
        cursor = tk.end;
      });
      if (cursor < en.length) segments.push({ text: en.slice(cursor) });
      return { segments: segments, answers: answers, cn: String(ex.cn || ''), exampleId: ex.id || '' };
    }
    return null;
  }

  /* ---------------- 学习报告 ---------------- */

  // 周 / 月学习报告：读取每日汇总与逐题历史，返回趋势、方式对错与错词 TOP
  function reportData(words, rows, days, now) {
    var n = Number(days) === 30 ? 30 : 7;
    var endKey = todayKey(now);
    var startKey = shiftDayKey(endKey, -(n - 1));
    var startDate = dayKeyToDate(startKey);
    var endDate = dayKeyToDate(endKey);
    var startTs = startDate ? startDate.getTime() : 0;
    var endTs = endDate ? endDate.getTime() + DAY : Infinity;

    var byDate = {};
    (rows || []).forEach(function (r) {
      if (r && r.date) byDate[r.date] = r;
    });

    // 先按每日汇总统计新词 / 复习，并记录汇总口径的答题数
    var statsTotal = 0;
    var statsRight = 0;
    var newWords = 0;
    var reviews = 0;
    for (var i = 0; i < n; i++) {
      var k = shiftDayKey(endKey, -i);
      var r = byDate[k] || {};
      statsTotal += Number(r.total) || 0;
      statsRight += Number(r.right) || 0;
      newWords += Number(r.newWords) || 0;
      reviews += Number(r.reviews) || 0;
    }

    var modeMap = {};
    var mistakeMap = {};
    var dayHistory = {};
    var historyTotal = 0;
    var historyRight = 0;
    (words || []).forEach(function (w) {
      if (!w) return;
      var dims = w.dims || {};
      var wordWrong = 0;
      var wordTotal = 0;
      DIM_IDS.forEach(function (dimId) {
        historyOf(dims[dimId]).forEach(function (h) {
          var t = Number(h && h.t) || 0;
          if (t < startTs || t >= endTs) return;
          var day = todayKey(t);
          var bucket = dayHistory[day] || { total: 0, right: 0 };
          bucket.total++;
          if (h.ok) bucket.right++;
          dayHistory[day] = bucket;
          historyTotal++;
          if (h.ok) historyRight++;
          wordTotal++;
          if (!h.ok) wordWrong++;
          var modeId = String((h && h.mode) || '');
          if (!modeId) return;
          var info = MODES[modeId] || { label: modeId, dim: dimId };
          var m = modeMap[modeId] || {
            mode: modeId,
            label: info.label,
            dim: info.dim || dimId,
            right: 0,
            wrong: 0,
            total: 0
          };
          if (h.ok) m.right++;
          else m.wrong++;
          m.total++;
          modeMap[modeId] = m;
        });
      });
      if (wordWrong > 0) {
        mistakeMap[w.id] = { wordId: w.id, word: w.word, wrong: wordWrong, total: wordTotal };
      }
    });

    // 备份恢复等场景下每日汇总可能缺失，逐题历史更完整时以历史为准，避免总数与方式明细对不上
    var useHistory = statsTotal < historyTotal;
    var total = useHistory ? historyTotal : statsTotal;
    var right = useHistory ? historyRight : statsRight;
    var trend = [];
    var activeDays = 0;
    for (var j = n - 1; j >= 0; j--) {
      var key = shiftDayKey(endKey, -j);
      var row = byDate[key] || {};
      var hist = dayHistory[key];
      var t = useHistory ? (hist ? hist.total : 0) : (Number(row.total) || 0);
      var rt = useHistory ? (hist ? hist.right : 0) : (Number(row.right) || 0);
      var nw = Number(row.newWords) || 0;
      if (t > 0) activeDays++;
      trend.push({ date: key, total: t, right: rt, newWords: nw });
    }

    var modeList = Object.keys(modeMap).map(function (k) { return modeMap[k]; });
    modeList.sort(function (a, b) {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong;
      return b.total - a.total;
    });

    var mistakes = Object.keys(mistakeMap).map(function (k) { return mistakeMap[k]; });
    mistakes.sort(function (a, b) {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong;
      return b.total - a.total;
    });

    return {
      days: n,
      start: startKey,
      end: endKey,
      total: total,
      right: right,
      accuracy: total ? Math.round(right / total * 100) : 0,
      newWords: newWords,
      reviews: reviews,
      activeDays: activeDays,
      trend: trend,
      modes: modeList,
      mistakes: mistakes.slice(0, 8)
    };
  }

  /* ---------------- 会话选词 / 组卷 ---------------- */

  function earliestDue(word) {
    var dims = (word && word.dims) || {};
    var list = DIM_IDS.map(function (id) { return dims[id]; })
      .filter(function (d) { return d && historyOf(d).length; })
      .map(function (d) { return Number(d.due) || 0; });
    return list.length ? Math.min.apply(null, list) : Infinity;
  }

  function selectSessionWords(words, newLimit, reviewLimit, now) {
    var t = now == null ? Date.now() : now;
    var nLimit = Math.max(0, Number(newLimit) || 0);
    var rLimit = Math.max(0, Number(reviewLimit) || 0);
    var newWords = (words || [])
      .filter(function (w) { return !hasAnyHistory(w); })
      .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); })
      .slice(0, nLimit);
    var reviewWords = (words || [])
      .filter(function (w) { return hasAnyHistory(w) && hasDueDim(w, t); })
      .sort(function (a, b) { return earliestDue(a) - earliestDue(b); })
      .slice(0, rLimit);
    return { newWords: newWords, reviewWords: reviewWords };
  }

  function resolveMode(word, modeId, pool) {
    var info = MODES[modeId];
    if (!info) return 'spell';
    if (modeId === 'cloze' && !clozeFor(word)) return 'spell';
    if (modeId === 'dictation' && !dictationFor(word)) {
      return resolveMode(word, clozeFor(word) ? 'cloze' : 'spell', pool);
    }
    if (modeId === 'multiCloze' && !multiClozeFor(word)) {
      return resolveMode(word, clozeFor(word) ? 'cloze' : 'spell', pool);
    }
    var others = (pool || []).filter(function (w) {
      return w && w.id !== word.id && w.word;
    }).length;
    var hasCn = !!(word.cn && String(word.cn).trim());
    if (info.kind === 'choice' && others < 3) {
      return resolveMode(word, hasCn ? 'writeMeaning' : 'spell', pool);
    }
    if (info.needsCn && !hasCn) return 'spell';
    return modeId;
  }

  function mixModesFor(word, pool, now, rand) {
    var rnd = typeof rand === 'function' ? rand : Math.random;
    var dims = (word && word.dims) || {};
    var dueDims = DIM_IDS.filter(function (id) {
      return isDue(dims[id], now);
    });
    if (!dueDims.length) dueDims = DIM_IDS.slice();
    var modes = [];
    dueDims.forEach(function (id) {
      if (id === 'recognize') {
        modes.push(rnd() < 0.5 ? 'meaningChoice' : 'listenChoice');
      } else if (id === 'spell') {
        if (multiClozeFor(word) && rnd() < 0.2) modes.push('multiCloze');
        else if (dictationFor(word) && rnd() < 0.2) modes.push('dictation');
        else if (clozeFor(word) && rnd() < 0.3) modes.push('cloze');
        else modes.push(rnd() < 0.5 ? 'cnSpell' : 'spell');
      } else {
        modes.push('writeMeaning');
      }
    });
    return modes;
  }

  function buildSession(options) {
    var opts = options || {};
    var newWords = opts.newWords || [];
    var reviewWords = opts.reviewWords || [];
    var pool = opts.pool || newWords.concat(reviewWords);
    var modeList = opts.modes || ['mix'];
    var now = opts.now == null ? Date.now() : opts.now;
    var rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
    var useMix = modeList.indexOf('mix') >= 0;
    var selected = MODE_IDS.filter(function (m) { return modeList.indexOf(m) >= 0; });
    if (useMix) selected = [];
    var tasks = [];
    var plan = [];
    var groups = [];

    newWords.concat(reviewWords).forEach(function (word) {
      if (!word || !word.id) return;
      var modes = useMix
        ? mixModesFor(word, pool, now, rand)
        : selected.slice();
      modes = modes.map(function (m) { return resolveMode(word, m, pool); });
      // 去重：降级后可能重合（例如没有中文时两个模式都降级为听音拼写）
      var seen = {};
      modes = modes.filter(function (m) {
        if (!m || seen[m]) return false;
        seen[m] = true;
        return true;
      });
      if (!modes.length) return;
      plan.push({ wordId: word.id, modes: modes.slice() });
      groups.push({ wordId: word.id, modes: modes });
    });

    // 交错排列：先出每个词的第 1 种方式，再第 2 种……避免同一单词的
    // 多种考查方式挤在一起，配合 createQueue 保证至少间隔 gap 个其他单词。
    var maxCols = groups.reduce(function (n, g) { return Math.max(n, g.modes.length); }, 0);
    for (var col = 0; col < maxCols; col++) {
      groups.forEach(function (g) {
        var mode = g.modes[col];
        if (!mode) return;
        tasks.push({
          id: g.wordId + '::' + mode + '::' + col,
          wordId: g.wordId,
          mode: mode,
          dim: MODES[mode].dim,
          repeats: 0,
          passed: false
        });
      });
    }

    return { tasks: tasks, plan: plan, mixed: useMix };
  }

  /**
   * 任务队列：保证同一单词的两次考查之间至少隔 gap 个其他单词。
   * requeue 最多两次（repeats 上限 2），防止死循环。
   */
  function createQueue(tasks, gap, saved) {
    var q = saved && Array.isArray(saved.q) ? saved.q.slice() : (tasks || []).slice();
    var recent = saved && Array.isArray(saved.recent) ? saved.recent.slice() : [];
    var gapSize = gap == null ? 4 : gap;

    return {
      size: function () { return q.length; },
      next: function () {
        if (!q.length) return null;
        var idx = -1;
        for (var i = 0; i < q.length; i++) {
          if (recent.indexOf(q[i].wordId) === -1) { idx = i; break; }
        }
        if (idx === -1) {
          // 可用词不足时退化为「最久没出现过」的词，尽量拉开同一单词的距离
          var bestDist = -1;
          for (var j = 0; j < q.length; j++) {
            var lastIdx = recent.lastIndexOf(q[j].wordId);
            var dist = lastIdx === -1 ? recent.length + 1 : recent.length - lastIdx;
            if (dist > bestDist) {
              bestDist = dist;
              idx = j;
            }
          }
        }
        if (idx === -1) idx = 0;
        var task = q.splice(idx, 1)[0];
        recent.push(task.wordId);
        if (recent.length > gapSize) recent.shift();
        return task;
      },
      requeue: function (task) {
        if (!task) return false;
        if ((task.repeats || 0) >= 2) return false;
        task.repeats = (task.repeats || 0) + 1;
        q.push(task);
        return true;
      },
      remaining: function () { return q.slice(); },
      snapshot: function () { return { q: q.slice(), recent: recent.slice() }; }
    };
  }

  /* ---------------- 词表解析 ---------------- */

  function splitPipeRow(line) {
    var s = String(line).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (x) { return x.trim(); });
  }

  function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every(function (c) {
      return !c || /^:?-{2,}:?$/.test(c.replace(/\s/g, ''));
    });
  }

  function isHeaderRow(cells) {
    if (!cells || !cells.length) return false;
    var first = String(cells[0] || '').trim();
    var joined = cells.join(' ');
    if (/^(单词|词汇|词条|序号|word|words|english|vocabulary|term)$/i.test(first.replace(/\*+/g, ''))) {
      return /中文|释义|英文|例句|meaning|definition|example|translation/i.test(joined) ||
        /^(word|words|english|vocabulary|term)$/i.test(first);
    }
    return false;
  }

  function cleanLine(raw) {
    var s = String(raw == null ? '' : raw).replace(/\u00a0/g, ' ').trim();
    s = s.replace(/^\s*(?:[-*+]\s+|\d{1,4}[.、)]\s*)/, '');
    s = s.replace(/\*\*|__|`/g, '');
    return s.trim();
  }

  var CJK_RUN = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff60]+|[^\u3400-\u9fff\u3000-\u303f\uff01-\uff60]+/g;

  function trimSegment(seg) {
    return String(seg == null ? '' : seg)
      .replace(/^[\s,;，；、|/\\–—-]+/, '')
      .replace(/[\s,;，；、|/\\–—-]+$/, '')
      .trim();
  }

  function splitMixedSegments(text) {
    var raw = String(text || '').match(CJK_RUN) || [];
    var out = [];
    raw.forEach(function (part) {
      var seg = trimSegment(part);
      if (seg) out.push(seg);
    });
    return out;
  }

  function splitLatinSentences(seg) {
    var parts = String(seg || '').split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
    return parts.map(function (p) { return p.trim(); }).filter(Boolean);
  }

  function wordCount(seg) {
    return String(seg || '').split(/\s+/).filter(Boolean).length;
  }

  function parseLineCells(line) {
    if (line.indexOf('\t') >= 0) {
      return line.split('\t').map(function (x) { return x.trim(); }).filter(Boolean);
    }
    if (/^\|.*\|$/.test(line)) return splitPipeRow(line).filter(Boolean);

    // 「单词 - 中文」 / 「单词——中文」
    var dash = line.match(/^([A-Za-z][A-Za-z'’.\- ]{0,40}?)\s*[–—-]{1,2}\s*([\u3400-\u9fff（(].*)$/);
    if (dash) return [dash[1].trim(), dash[2].trim()];

    // 两个及以上空格视为列分隔
    if (/\S {2,}\S/.test(line)) {
      return line.split(/ {2,}/).map(function (x) { return x.trim(); }).filter(Boolean);
    }

    // 单词 + 中文（单空格）
    var head = line.match(/^([A-Za-z][A-Za-z'’.\-]*(?: [A-Za-z][A-Za-z'’.\-]*){0,2})(?=\s|$)/);
    if (head) {
      var rest = line.slice(head[0].length).trim();
      if (!rest) return [head[1]];
      return [head[1]].concat(splitMixedSegments(rest));
    }
    return null;
  }

  function pickZhSegments(zh) {
    if (!zh.length) return { cn: '', exCn: '' };
    if (zh.length === 1) return { cn: zh[0], exCn: '' };
    var idx = -1;
    var best = -1;
    zh.forEach(function (s, i) {
      if (/[。！？!?…]$/.test(s)) {
        var len = cjkLength(s);
        if (len > best) { best = len; idx = i; }
      }
    });
    if (idx === -1) {
      var longestIdx = 0;
      zh.forEach(function (s, i) { if (s.length > zh[longestIdx].length) longestIdx = i; });
      if (zh[longestIdx].length >= 8) idx = longestIdx;
    }
    if (idx === -1) return { cn: zh.join('；'), exCn: '' };
    return {
      cn: zh.filter(function (_, i) { return i !== idx; }).join('；'),
      exCn: zh[idx]
    };
  }

  function pickEnSegments(en) {
    if (!en.length) return { en: '', exEn: '' };
    if (en.length === 1) {
      var one = en[0];
      if (/[.!?]$/.test(one) && wordCount(one) >= 4) return { en: '', exEn: one };
      return { en: one, exEn: '' };
    }
    var idx = -1;
    var best = -1;
    en.forEach(function (s, i) {
      if (/[.!?]$/.test(s)) {
        var wc = wordCount(s);
        if (wc >= 4 && wc > best) { best = wc; idx = i; }
      }
    });
    if (idx === -1) {
      var longestIdx = 0;
      en.forEach(function (s, i) { if (wordCount(s) > wordCount(en[longestIdx])) longestIdx = i; });
      if (wordCount(en[longestIdx]) >= 6) idx = longestIdx;
    }
    if (idx === -1) return { en: en.join('; '), exEn: '' };
    return {
      en: en.filter(function (_, i) { return i !== idx; }).join('; '),
      exEn: en[idx]
    };
  }

  var POS_ALIASES = {
    'n': 'n.', 'noun': 'n.', '名词': 'n.',
    'v': 'v.', 'verb': 'v.', '动词': 'v.',
    'vt': 'vt.', '及物动词': 'vt.',
    'vi': 'vi.', '不及物动词': 'vi.',
    'adj': 'adj.', 'adjective': 'adj.', '形容词': 'adj.',
    'adv': 'adv.', 'adverb': 'adv.', '副词': 'adv.',
    'prep': 'prep.', 'preposition': 'prep.', '介词': 'prep.',
    'pron': 'pron.', 'pronoun': 'pron.', '代词': 'pron.',
    'conj': 'conj.', 'conjunction': 'conj.', '连词': 'conj.',
    'num': 'num.', 'numeral': 'num.', '数词': 'num.',
    'art': 'art.', 'article': 'art.', '冠词': 'art.',
    'interj': 'interj.', 'interjection': 'interj.', '感叹词': 'interj.',
    'aux': 'aux.', 'auxiliary': 'aux.', '助动词': 'aux.',
    'phr': 'phr.', 'phrase': 'phr.', '短语': 'phr.'
  };

  function parsePos(text) {
    var raw = String(text == null ? '' : text).trim()
      .replace(/[（(\[【]/g, '')
      .replace(/[）)\]】]/g, '')
      .replace(/．/g, '.')
      .trim();
    if (!raw) return '';
    var parts = raw.split(/\s*(?:[\/&,，、+；;]|\band\b)\s*/i).filter(Boolean);
    if (!parts.length) return '';
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var key = parts[i].toLowerCase().replace(/\.+$/, '').trim();
      var mapped = POS_ALIASES[key];
      if (!mapped) return '';
      if (out.indexOf(mapped) === -1) out.push(mapped);
    }
    return out.join('/');
  }

  function buildEntry(cells) {
    var list = (cells || []).map(function (s) { return String(s == null ? '' : s).trim(); })
      .filter(Boolean);
    if (!list.length) return null;

    // 词性：优先取单词单元格中的括号标注，其次取末尾独立词性标记
    var pos = '';
    var firstCell = list[0];
    var leadPos = firstCell.match(/^\s*[（(\[【]\s*([^）)\]】]{1,30})\s*[）)\]】]\s*/);
    if (leadPos && parsePos(leadPos[1])) {
      pos = parsePos(leadPos[1]);
      firstCell = firstCell.slice(leadPos[0].length);
    }
    var posInParen = firstCell.match(/[（(\[【]\s*([^）)\]】]{1,30})\s*[）)\]】]/);
    if (posInParen && !pos) {
      var parenPos = parsePos(posInParen[1]);
      if (parenPos) pos = parenPos;
    }
    var wordCell = firstCell
      .replace(/[（(].*$/, '')
      .replace(/[\[【].*$/, '')
      .trim();
    var wordBits = wordCell.split(/\s+/);
    if (wordBits.length > 1) {
      var tailPos = parsePos(wordBits[wordBits.length - 1]);
      if (tailPos) {
        if (!pos) pos = tailPos;
        wordBits.pop();
        wordCell = wordBits.join(' ');
      }
    }

    var word = wordCell
      .replace(/^[\s\-–—|:：]+/, '')
      .replace(/[\s,;，；:：]+$/, '')
      .trim();
    if (!/^[A-Za-z][A-Za-z'’ .\-]{0,59}$/.test(word)) return null;
    if (!word.replace(/[^A-Za-z]/g, '')) return null;

    var segs = [];
    list.slice(1).forEach(function (cell) {
      var cellPos = parsePos(cell);
      if (cellPos) {
        if (!pos) pos = cellPos;
        return;
      }
      if (hasCJK(cell) && /[A-Za-z]/.test(cell)) {
        segs = segs.concat(splitMixedSegments(cell));
      } else if (hasCJK(cell)) {
        segs.push(cell.trim());
      } else {
        segs = segs.concat(splitLatinSentences(cell));
      }
    });

    var key = normalizeWord(word);
    var seen = {};
    var uniq = [];
    segs.forEach(function (s) {
      var v = trimSegment(s);
      if (!v) return;
      if (normalizeWord(v) === key) return;
      if (seen[v]) return;
      seen[v] = true;
      uniq.push(v);
    });

    var zh = uniq.filter(hasCJK);
    var en = uniq.filter(function (s) { return !hasCJK(s); });
    var zhPick = pickZhSegments(zh);
    var enPick = pickEnSegments(en);

    return {
      word: word,
      pos: pos,
      cn: zhPick.cn,
      en: enPick.en,
      exampleEn: enPick.exEn,
      exampleCn: zhPick.exCn
    };
  }

  function parseImportText(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    var lines = src.split('\n');
    var entries = [];
    var seen = {};
    var inFence = false;

    lines.forEach(function (raw) {
      var trimmedLine = raw.trim();
      if (!trimmedLine) return;
      if (/^```/.test(trimmedLine)) { inFence = !inFence; return; }
      if (inFence) return;
      if (/^#{1,6}\s/.test(trimmedLine)) return;
      var line = cleanLine(trimmedLine);
      if (!line) return;
      if (/^[-*_]{3,}$/.test(line)) return;

      var cells = null;
      if (/^\|.*\|$/.test(line)) {
        cells = splitPipeRow(line);
        if (isSeparatorRow(cells) || isHeaderRow(cells)) return;
      } else {
        cells = parseLineCells(line);
        if (!cells || isHeaderRow(cells)) return;
      }

      var entry = buildEntry(cells);
      if (!entry) return;
      var key = normalizeWord(entry.word);
      if (seen[key]) return;
      seen[key] = true;
      entries.push(entry);
    });

    return entries;
  }

  /* ---------------- 列表处理 / 统计 ---------------- */

  // 归属缺失（旧数据）归入默认本；显式空数组表示「未分类」，保持不变
  function normalizeBookIds(value, validIds, defaultId) {
    var fallback = defaultId || DEFAULT_BOOK_ID;
    if (!Array.isArray(value)) return [fallback];
    var out = [];
    value.forEach(function (id) {
      if (typeof id === 'string' && id && out.indexOf(id) < 0) out.push(id);
    });
    if (validIds) {
      out = out.filter(function (id) { return validIds.indexOf(id) >= 0; });
    }
    return out;
  }

  function bookIdsOf(word) {
    return (word && Array.isArray(word.bookIds)) ? word.bookIds : [];
  }

  // 范围：{ mode: 'all' | 'books' | 'uncategorized', bookIds: [] }
  function wordInScope(word, scope, validIds) {
    var ids = bookIdsOf(word);
    if (validIds) ids = ids.filter(function (id) { return validIds.indexOf(id) >= 0; });
    var mode = (scope && scope.mode) || 'all';
    if (mode === 'mistakes') return isMistakeWord(word);
    if (mode === 'uncategorized') return ids.length === 0;
    if (mode === 'books') {
      var wanted = (scope && scope.bookIds) || [];
      return ids.some(function (id) { return wanted.indexOf(id) >= 0; });
    }
    return true;
  }

  // 生词本归属变更；返回新的 bookIds 数组，不修改原对象
  // op: 'remove' 从指定本移出 / 'add' 加入目标本 / 'copy' 复制到目标本
  //     'move' 从指定本移入目标本 / 'clear' 移出全部（进入未分类）
  function applyBookChange(word, op, bookId, targetId) {
    var ids = bookIdsOf(word).slice();
    function add(id) {
      if (id && ids.indexOf(id) < 0) ids.push(id);
    }
    function drop(id) {
      var i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1);
    }
    if (op === 'remove') drop(bookId);
    else if (op === 'add' || op === 'copy') add(targetId);
    else if (op === 'move') {
      drop(bookId);
      add(targetId);
    } else if (op === 'clear') {
      ids = [];
    }
    return ids;
  }

  // 统计每个生词本的词数（同一词属于多个本时分别计数），未分类单列
  function countByBook(words, books) {
    var map = {};
    var valid = [];
    (books || []).forEach(function (b) {
      if (!b || !b.id) return;
      map[b.id] = 0;
      valid.push(b.id);
    });
    map.uncategorized = 0;
    (words || []).forEach(function (w) {
      var ids = bookIdsOf(w).filter(function (id) { return valid.indexOf(id) >= 0; });
      if (!ids.length) map.uncategorized++;
      ids.forEach(function (id) { map[id]++; });
    });
    return map;
  }

  // 导入计划：新词 / 已存在但可加入目标本 / 已在目标本跳过
  function importPlan(existingWords, entries, targetBookId) {
    var byKey = {};
    (existingWords || []).forEach(function (w) {
      if (!w || !w.word) return;
      var key = normalizeWord(w.word);
      if (!byKey[key]) byKey[key] = w;
    });
    var rows = [];
    var counts = { new: 0, join: 0, skip: 0 };
    (entries || []).forEach(function (e) {
      var hit = e && e.word ? byKey[normalizeWord(e.word)] : null;
      if (!hit) {
        counts.new++;
        rows.push({ entry: e, word: null, status: 'new' });
      } else if (bookIdsOf(hit).indexOf(targetBookId) >= 0) {
        counts.skip++;
        rows.push({ entry: e, word: hit, status: 'skip' });
      } else {
        counts.join++;
        rows.push({ entry: e, word: hit, status: 'join' });
      }
    });
    return { rows: rows, counts: counts };
  }

  // 备份合并生词本：同 id 或同名视为同一本，返回新增列表与 id 映射
  function mergeBooks(existingBooks, incomingBooks, defaultId) {
    var fallback = defaultId || DEFAULT_BOOK_ID;
    var byId = {};
    var byName = {};
    (existingBooks || []).forEach(function (b) {
      if (!b || !b.id) return;
      byId[b.id] = b;
      byName[String(b.name || '').trim().toLowerCase()] = b.id;
    });
    var idMap = {};
    var added = [];
    (incomingBooks || []).forEach(function (raw) {
      if (!raw || !raw.id) return;
      if (byId[raw.id]) {
        idMap[raw.id] = raw.id;
        return;
      }
      var name = String(raw.name || '').trim();
      var nameKey = name.toLowerCase();
      if (name && byName[nameKey]) {
        idMap[raw.id] = byName[nameKey];
        return;
      }
      var book = {
        id: raw.id === fallback ? uid() : raw.id,
        name: name || '导入生词本',
        createdAt: Number(raw.createdAt) || 0
      };
      idMap[raw.id] = book.id;
      byId[book.id] = book;
      byName[book.name.toLowerCase()] = book.id;
      added.push(book);
    });
    return { added: added, idMap: idMap };
  }

  function uid() {
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // 备份中的归属映射：旧备份没有该字段则归入默认本；显式空数组保持未分类
  function remapBookIds(value, idMap, validIds, defaultId) {
    var fallback = defaultId || DEFAULT_BOOK_ID;
    if (!Array.isArray(value)) return [fallback];
    var out = [];
    value.forEach(function (id) {
      var mapped = (idMap && idMap[id]) || id;
      if (mapped && out.indexOf(mapped) < 0) out.push(mapped);
    });
    if (validIds) {
      out = out.filter(function (id) { return validIds.indexOf(id) >= 0; });
    }
    return out;
  }

  // 保证生词本名称唯一，重复时自动加序号
  function uniqueBookName(books, name, ignoreId) {
    var base = String(name || '').trim() || '未命名生词本';
    var taken = {};
    (books || []).forEach(function (b) {
      if (!b || b.id === ignoreId) return;
      taken[String(b.name || '').trim().toLowerCase()] = true;
    });
    if (!taken[base.toLowerCase()]) return base;
    var n = 2;
    while (taken[(base + ' ' + n).toLowerCase()]) n++;
    return base + ' ' + n;
  }

  function filterWords(words, filter, query, scope, validIds) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    return (words || []).filter(function (w) {
      if (!wordInScope(w, scope, validIds)) return false;
      if (q) {
        var hay = (w.word + ' ' + (w.pos || '') + ' ' + w.cn + ' ' + w.en).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (filter === 'new') return !hasAnyHistory(w);
      if (filter === 'weak') {
        var s = wordMastery(w);
        return s !== null && s < 40;
      }
      return true;
    });
  }

  function sortWords(words, sort) {
    var list = (words || []).slice();
    if (sort === 'cn') {
      list.sort(function (a, b) {
        return String(a.cn || a.word).localeCompare(String(b.cn || b.word), 'zh-Hans-CN');
      });
    } else if (sort === 'weak') {
      list.sort(function (a, b) {
        var sa = wordMastery(a);
        var sb = wordMastery(b);
        if (sa === null && sb === null) return (b.createdAt || 0) - (a.createdAt || 0);
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sa - sb;
      });
    } else if (sort === 'star') {
      list.sort(function (a, b) {
        if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    } else if (sort === 'mistakes') {
      list.sort(function (a, b) {
        var diff = mistakeCount(b) - mistakeCount(a);
        if (diff) return diff;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    } else {
      list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    }
    return list;
  }

  function overallStats(words) {
    var list = words || [];
    var out = {
      total: list.length,
      learned: 0,
      mastered: 0,
      starred: 0,
      avg: { recognize: null, spell: null, meaning: null },
      mastery: null
    };
    var sums = { recognize: 0, spell: 0, meaning: 0 };
    var counts = { recognize: 0, spell: 0, meaning: 0 };
    list.forEach(function (w) {
      if (hasAnyHistory(w)) out.learned++;
      if (w.starred) out.starred++;
      var score = wordMastery(w);
      if (score !== null && score >= 90) out.mastered++;
      var scores = wordScores(w);
      DIM_IDS.forEach(function (id) {
        if (scores[id] !== null) {
          sums[id] += scores[id];
          counts[id]++;
        }
      });
    });
    DIM_IDS.forEach(function (id) {
      out.avg[id] = counts[id] ? Math.round(sums[id] / counts[id]) : null;
    });
    var vals = DIM_IDS.map(function (id) { return out.avg[id]; })
      .filter(function (v) { return v !== null; });
    if (vals.length) {
      out.mastery = Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
    }
    return out;
  }

  function todayKey(ts) {
    var d = new Date(ts == null ? Date.now() : ts);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function freshDailyStats(ts) {
    return { date: todayKey(ts), newWords: 0, reviews: 0, right: 0, total: 0 };
  }

  function dayKeyToDate(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function shiftDayKey(key, delta) {
    var d = dayKeyToDate(key);
    if (!d) return String(key || '');
    d.setDate(d.getDate() + (Number(delta) || 0));
    return todayKey(d.getTime());
  }

  // 连续打卡：今天有答题则从今天算，否则从昨天算（当天还没学不打断连击）
  function streakDays(rows, today) {
    var key = today || todayKey();
    var active = {};
    (rows || []).forEach(function (r) {
      if (r && r.date && (Number(r.total) || 0) > 0) active[r.date] = true;
    });
    if (!active[key]) key = shiftDayKey(key, -1);
    var n = 0;
    while (active[key]) {
      n++;
      key = shiftDayKey(key, -1);
    }
    return n;
  }

  // 近 N 天热力数据（含今天），按日期升序
  function heatmap(rows, days, today) {
    var n = Math.max(1, Number(days) || 28);
    var end = today || todayKey();
    var byDate = {};
    (rows || []).forEach(function (r) {
      if (r && r.date) byDate[r.date] = r;
    });
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var key = shiftDayKey(end, -i);
      var r = byDate[key] || {};
      out.push({
        date: key,
        total: Number(r.total) || 0,
        newWords: Number(r.newWords) || 0,
        reviews: Number(r.reviews) || 0,
        right: Number(r.right) || 0
      });
    }
    return out;
  }

  function mergeWords(existing, incoming) {
    var keys = {};
    (existing || []).forEach(function (w) { keys[normalizeWord(w.word)] = true; });
    var added = [];
    var skipped = 0;
    (incoming || []).forEach(function (w) {
      if (!w || !w.word) { skipped++; return; }
      var key = normalizeWord(w.word);
      if (keys[key]) { skipped++; return; }
      keys[key] = true;
      added.push(w);
    });
    return { added: added, skipped: skipped };
  }

  function mergeSentences(existing, incoming) {
    var keys = {};
    (existing || []).forEach(function (s) {
      keys[normalizeWord(s.text) + '|' + (s.wordId || '')] = true;
    });
    var added = [];
    var skipped = 0;
    (incoming || []).forEach(function (s) {
      if (!s || !s.text) { skipped++; return; }
      var key = normalizeWord(s.text) + '|' + (s.wordId || '');
      if (keys[key]) { skipped++; return; }
      keys[key] = true;
      added.push(s);
    });
    return { added: added, skipped: skipped };
  }

  return {
    DAY: DAY,
    INTERVALS: INTERVALS,
    DIM_IDS: DIM_IDS,
    DIM_LABEL: DIM_LABEL,
    MODES: MODES,
    MODE_IDS: MODE_IDS,
    DEFAULT_BOOK_ID: DEFAULT_BOOK_ID,
    DEFAULT_BOOK_NAME: DEFAULT_BOOK_NAME,
    MAX_LEVEL: MAX_LEVEL,
    EASE_START: EASE_START,
    clamp: clamp,
    normalizeWord: normalizeWord,
    normalizeSpelling: normalizeSpelling,
    normalizeMeaning: normalizeMeaning,
    hasCJK: hasCJK,
    lcsLength: lcsLength,
    lcsSimilarity: lcsSimilarity,
    isFuzzyMatch: isFuzzyMatch,
    formScore: formScore,
    pickDistractors: pickDistractors,
    emptyDim: emptyDim,
    normalizeDim: normalizeDim,
    dimScore: dimScore,
    wordScores: wordScores,
    wordMastery: wordMastery,
    masteryLevel: masteryLevel,
    hasAnyHistory: hasAnyHistory,
    hasDueDim: hasDueDim,
    isDue: isDue,
    applyAnswer: applyAnswer,
    mistakeCount: mistakeCount,
    isMistakeWord: isMistakeWord,
    wrongStreak: wrongStreak,
    isLeech: isLeech,
    LEECH_STREAK: LEECH_STREAK,
    wordModeStats: wordModeStats,
    findWordInSentence: findWordInSentence,
    clozeFor: clozeFor,
    parseSenses: parseSenses,
    normalizeSenses: normalizeSenses,
    sensesText: sensesText,
    meaningMatch: meaningMatch,
    isSentenceMatch: isSentenceMatch,
    dictationFor: dictationFor,
    multiClozeFor: multiClozeFor,
    reportData: reportData,
    selectSessionWords: selectSessionWords,
    resolveMode: resolveMode,
    mixModesFor: mixModesFor,
    buildSession: buildSession,
    createQueue: createQueue,
    parseImportText: parseImportText,
    parsePos: parsePos,
    buildEntry: buildEntry,
    filterWords: filterWords,
    normalizeBookIds: normalizeBookIds,
    wordInScope: wordInScope,
    applyBookChange: applyBookChange,
    countByBook: countByBook,
    importPlan: importPlan,
    mergeBooks: mergeBooks,
    remapBookIds: remapBookIds,
    uniqueBookName: uniqueBookName,
    sortWords: sortWords,
    overallStats: overallStats,
    todayKey: todayKey,
    freshDailyStats: freshDailyStats,
    dayKeyToDate: dayKeyToDate,
    shiftDayKey: shiftDayKey,
    streakDays: streakDays,
    heatmap: heatmap,
    mergeWords: mergeWords,
    mergeSentences: mergeSentences
  };
});
