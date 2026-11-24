/* 拾词 · 界面与交互 */
(function () {
  'use strict';

  var C = window.CihaiCore;
  var DB = window.CihaiDB;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var state = {
    words: [],
    books: [],
    sentences: [],
    settings: null,
    stats: null,
    statsHistory: [],
    tab: 'words',
    wordQuery: '',
    wordSort: 'recent',
    wordFilter: 'all',
    scope: { mode: 'all', bookIds: [] },
    studyScope: { mode: 'all', bookIds: [] },
    batchMode: false,
    selectedIds: {},
    pendingBatchOp: '',
    favTab: 'words',
    sentQuery: '',
    modes: ['mix'],
    newLimit: 10,
    reviewLimit: 20,
    session: null,
    importTab: 'file',
    importEntries: [],
    importPlan: null,
    importBookId: '',
    importSource: '',
    reportDays: 7
  };

  var pendingConfirm = null;
  var toastTimer = null;
  var voices = [];
  var syncTimer = null;
  var syncChannel = null;
  try {
    if ('BroadcastChannel' in window) {
      syncChannel = new BroadcastChannel('cihai-sync');
      syncChannel.onmessage = function (event) {
        if (event.data && event.data.type === 'cihai-change') scheduleExternalReload();
      };
    }
  } catch (err) { syncChannel = null; }

  var ICONS = {
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.2L11.5 6v12L7.2 14.5H4z"/><path d="M15.2 8.4a5 5 0 0 1 0 7.2"/><path d="M17.8 5.8a8.5 8.5 0 0 1 0 12.4"/></svg>',
    star: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.8 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9 7V4.8h6V7M7 7l.8 12.2h8.4L17 7"/><path d="M10.5 11v4.5M13.5 11v4.5"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
  };

  /* ---------------- 工具 ---------------- */

  function posOptionsHtml() {
    return '<datalist id="pos-options">' +
      ['n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'pron.', 'conj.', 'num.', 'art.', 'interj.', 'phr.'].map(function (p) {
        return '<option value="' + p + '"></option>';
      }).join('') + '</datalist>';
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function splitWordList(value) {
    return String(value == null ? '' : value)
      .split(/[,，、;；|｜]+/)
      .map(function (x) { return String(x || '').trim(); })
      .filter(Boolean);
  }

  function toast(message, isError) {
    var el = $('#toast');
    el.textContent = message;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-show'); }, 2400);
  }

  function getWord(id) {
    for (var i = 0; i < state.words.length; i++) {
      if (state.words[i].id === id) return state.words[i];
    }
    return null;
  }

  function ensureToday() {
    var key = C.todayKey();
    if (!state.stats || state.stats.date !== key) {
      state.stats = C.freshDailyStats();
    }
  }

  function saveStats() {
    var row = state.stats;
    var list = state.statsHistory || [];
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].date === row.date) { idx = i; break; }
    }
    if (idx >= 0) list[idx] = row;
    else list.push(row);
    state.statsHistory = list;
    return DB.saveStats(row).catch(function () {});
  }

  // 今天可能还没写入 stats 存储，展示时用当前内存行兜底
  function statsRows() {
    var today = C.todayKey();
    var rows = (state.statsHistory || []).filter(function (r) {
      return r && r.date && r.date !== today;
    });
    if (state.stats) rows.push(state.stats);
    return rows;
  }

  /* ---------------- 多标签页同步 / 存储持久化 ---------------- */

  function notifyChange() {
    if (!syncChannel) return;
    try { syncChannel.postMessage({ type: 'cihai-change', at: Date.now() }); } catch (err) { /* 忽略 */ }
  }

  function scheduleExternalReload() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(reloadExternal, 150);
  }

  function reloadExternal() {
    if (!state.settings) return;
    Promise.all([
      DB.getAllWords(),
      DB.getAllSentences(),
      DB.getSettings(),
      DB.getStats(C.todayKey()),
      DB.getAllBooks(),
      DB.getAllStats()
    ]).then(function (result) {
      if (!state.settings) return;
      state.words = (result[0] || []).map(normalizeWordRecord);
      state.sentences = (result[1] || []).map(normalizeSentenceRecord);
      var settingsRow = (result[2] || []).filter(function (row) { return row && row.id === 'settings'; })[0];
      state.books = (result[4] || []).map(normalizeBookRecord);
      state.settings = normalizeSettings(settingsRow);
      state.stats = result[3] || C.freshDailyStats();
      state.statsHistory = (result[5] || []).filter(function (r) { return r && r.date; });
      ensureBookLinks();
      state.scope = pruneScope(state.scope);
      state.studyScope = pruneScope(state.studyScope);
      if (state.session) {
        if (!state.session.current || !getWord(state.session.current.wordId)) {
          endSession();
          toast('词库已在其他标签页更新，本轮背诵已结束', true);
        }
        return;
      }
      render();
    }).catch(function () { /* 静默失败，等下一次同步 */ });
  }

  function requestPersistence() {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') return;
    var check = typeof navigator.storage.persisted === 'function'
      ? navigator.storage.persisted()
      : Promise.resolve(false);
    check.then(function (already) {
      if (!already) return navigator.storage.persist();
    }).catch(function () { /* 浏览器不允许时静默忽略 */ });
  }

  function defaultSettings() {
    return {
      id: 'settings',
      dailyNew: 10,
      dailyReview: 20,
      defaultModes: ['mix'],
      defaultBookId: C.DEFAULT_BOOK_ID,
      rate: 1,
      accent: 'en-US',
      show: { cn: false, en: true, exEn: true, exCn: false },
      lastBackupAt: 0
    };
  }

  function normalizeSettings(row) {
    var base = defaultSettings();
    var s = Object.assign(base, row || {});
    s.show = Object.assign(base.show, (row && row.show) || {});
    if (!Array.isArray(s.defaultModes) || !s.defaultModes.length) s.defaultModes = ['mix'];
    if ([0.5, 0.75, 1, 1.2].indexOf(Number(s.rate)) < 0) s.rate = 1;
    s.rate = Number(s.rate);
    if (s.accent !== 'en-GB' && s.accent !== 'en-US') s.accent = 'en-US';
    s.defaultBookId = String(s.defaultBookId || C.DEFAULT_BOOK_ID);
    s.dailyNew = Math.max(0, Number(s.dailyNew) || 0);
    s.dailyReview = Math.max(0, Number(s.dailyReview) || 0);
    s.lastBackupAt = Math.max(0, Number(s.lastBackupAt) || 0);
    s.id = 'settings';
    return s;
  }

  function normalizeBookRecord(raw) {
    var b = raw || {};
    return {
      id: b.id || uid(),
      name: String(b.name || '').trim() || '生词本',
      createdAt: Number(b.createdAt) || Date.now()
    };
  }

  function normalizeWordRecord(raw) {
    var w = raw || {};
    var dims = w.dims || {};
    w.id = w.id || uid();
    w.word = String(w.word || '').trim();
    w.pos = String(w.pos || '').trim();
    w.phonetic = String(w.phonetic || '').trim();
    w.roots = String(w.roots || '').trim();
    w.cn = String(w.cn || '');
    w.senses = C.normalizeSenses(w.senses, w.cn).map(function (s) {
      return { id: s.id || uid(), pos: s.pos || '', cn: s.cn };
    });
    if (w.senses.length) w.cn = C.sensesText(w.senses);
    w.en = String(w.en || '');
    w.starred = !!w.starred;
    w.bookIds = C.normalizeBookIds(w.bookIds);
    w.examples = Array.isArray(w.examples) ? w.examples.filter(function (ex) {
      return ex && (ex.en || ex.cn);
    }).map(function (ex) {
      return { id: ex.id || uid(), en: String(ex.en || ''), cn: String(ex.cn || '') };
    }) : [];
    w.phrases = Array.isArray(w.phrases) ? w.phrases.filter(function (p) {
      return p && (p.en || p.cn);
    }).map(function (p) {
      return { id: p.id || uid(), en: String(p.en || ''), cn: String(p.cn || '') };
    }) : [];
    w.synonyms = Array.isArray(w.synonyms) ? w.synonyms.map(function (x) {
      return String(x || '').trim();
    }).filter(Boolean) : [];
    w.antonyms = Array.isArray(w.antonyms) ? w.antonyms.map(function (x) {
      return String(x || '').trim();
    }).filter(Boolean) : [];
    w.createdAt = Number(w.createdAt) || Date.now();
    w.startedAt = Number(w.startedAt) || null;
    w.dims = {};
    C.DIM_IDS.forEach(function (id) {
      w.dims[id] = C.normalizeDim(dims[id]);
    });
    return w;
  }

  function normalizeSentenceRecord(raw) {
    var s = raw || {};
    return {
      id: s.id || uid(),
      text: String(s.text || '').trim(),
      cn: String(s.cn || ''),
      wordId: s.wordId || null,
      word: String(s.word || ''),
      createdAt: Number(s.createdAt) || Date.now()
    };
  }

  function shuffle(list) {
    var arr = list.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate());
  }

  function dimColor(id) {
    if (id === 'recognize') return '#5d7f68';
    if (id === 'spell') return '#b98a4e';
    return '#6a7e97';
  }

  function dimBarHtml(id, score) {
    var label = C.DIM_LABEL[id] + ' ' + (score === null ? '未测' : score + ' 分');
    return '<span class="dim dim-' + id + '" title="' + label + '"><span style="width:' +
      (score || 0) + '%"></span></span>';
  }

  /* ---------------- 生词本 ---------------- */

  function validBookIds() {
    return state.books.map(function (b) { return b.id; });
  }

  function bookById(id) {
    for (var i = 0; i < state.books.length; i++) {
      if (state.books[i].id === id) return state.books[i];
    }
    return null;
  }

  function bookName(id) {
    var b = bookById(id);
    return b ? b.name : '未知生词本';
  }

  function isDefaultBook(id) {
    return !!state.settings && state.settings.defaultBookId === id;
  }

  function bookOptionLabel(book) {
    return book.name + (isDefaultBook(book.id) ? '（默认）' : '');
  }

  function bookOptionsHtml(selectedId) {
    return state.books.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === selectedId ? ' selected' : '') + '>' +
        esc(bookOptionLabel(b)) + '</option>';
    }).join('');
  }

  function scopeLabel(scope) {
    if (!scope || scope.mode === 'all') return '全部生词本';
    if (scope.mode === 'uncategorized') return '未分类';
    if (scope.mode === 'mistakes') return '错词本';
    var ids = scope.bookIds || [];
    if (ids.length === 1) return bookName(ids[0]);
    return ids.length + ' 个生词本';
  }

  function pruneScope(scope) {
    if (!scope || scope.mode !== 'books') return scope || { mode: 'all', bookIds: [] };
    var valid = validBookIds();
    var ids = (scope.bookIds || []).filter(function (id) { return valid.indexOf(id) >= 0; });
    if (!ids.length) return { mode: 'all', bookIds: [] };
    return { mode: 'books', bookIds: ids };
  }

  function scopeChipsHtml(scope, prefix) {
    var counts = C.countByBook(state.words, state.books);
    var mistakes = state.words.filter(function (w) { return C.mistakeCount(w) > 0; }).length;
    var html = '<button class="book-chip' + (scope.mode === 'all' ? ' is-active' : '') +
      '" data-action="' + prefix + '-all" type="button">全部<span class="book-count">' + state.words.length + '</span></button>';
    state.books.forEach(function (b) {
      var active = scope.mode === 'books' && scope.bookIds.indexOf(b.id) >= 0;
      html += '<button class="book-chip' + (active ? ' is-active' : '') + '" data-action="' + prefix + '-book" data-id="' +
        esc(b.id) + '" type="button"><span class="book-chip-name">' + esc(b.name) + '</span>' +
        (isDefaultBook(b.id) ? '<span class="default-tag">默认</span>' : '') +
        '<span class="book-count">' + (counts[b.id] || 0) + '</span></button>';
    });
    html += '<button class="book-chip danger-chip' + (scope.mode === 'mistakes' ? ' is-active' : '') +
      '" data-action="' + prefix + '-mistakes" type="button">错词<span class="book-count">' +
      mistakes + '</span></button>';
    html += '<button class="book-chip' + (scope.mode === 'uncategorized' ? ' is-active' : '') +
      '" data-action="' + prefix + '-uncat" type="button">未分类<span class="book-count">' +
      (counts.uncategorized || 0) + '</span></button>';
    return '<div class="book-bar"><div class="book-scroll">' + html + '</div>' +
      '<button class="book-manage" data-action="book-manage" type="button">管理</button></div>';
  }

  function ensureBookLinks() {
    var tasks = [];
    if (!state.books.some(function (b) { return b.id === C.DEFAULT_BOOK_ID; })) {
      var def = { id: C.DEFAULT_BOOK_ID, name: C.DEFAULT_BOOK_NAME, createdAt: Date.now() };
      state.books.push(def);
      tasks.push(DB.putBook(def));
    }
    var valid = validBookIds();
    if (valid.indexOf(state.settings.defaultBookId) < 0) {
      state.settings.defaultBookId = C.DEFAULT_BOOK_ID;
    }
    var touched = [];
    state.words.forEach(function (w) {
      var next = C.normalizeBookIds(w.bookIds, valid, state.settings.defaultBookId);
      if (JSON.stringify(next) !== JSON.stringify(w.bookIds)) {
        w.bookIds = next;
        touched.push(w);
      }
    });
    if (touched.length) tasks.push(DB.putWords(touched));
    tasks.push(DB.saveSettings(state.settings));
    return Promise.all(tasks).catch(function () { /* 静默忽略，界面仍可用 */ });
  }

  function createBookRecord(name) {
    var book = {
      id: uid(),
      name: C.uniqueBookName(state.books, name),
      createdAt: Date.now()
    };
    state.books.push(book);
    return DB.putBook(book).then(function () {
      notifyChange();
      return book;
    });
  }

  function selectedCount() {
    return Object.keys(state.selectedIds).filter(function (id) { return state.selectedIds[id]; }).length;
  }

  function selectedWords() {
    return state.words.filter(function (w) { return !!state.selectedIds[w.id]; });
  }

  function exitBatch() {
    state.batchMode = false;
    state.selectedIds = {};
    document.body.classList.remove('in-batch');
    render();
  }

  /* ---------------- 语音 ---------------- */

  function loadVoices() {
    try {
      voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    } catch (err) {
      voices = [];
    }
  }

  function pickVoice(accent) {
    if (!voices.length) loadVoices();
    var lang = accent === 'en-GB' ? 'en-GB' : 'en-US';
    var tag = lang.replace('-', '[-_]');
    var re = new RegExp('^' + tag, 'i');
    var v = voices.filter(function (x) { return re.test(x.lang); })[0];
    if (!v && lang === 'en-GB') {
      v = voices.filter(function (x) { return /^en[-_]GB/i.test(x.lang); })[0];
    }
    if (!v) v = voices.filter(function (x) { return /^en/i.test(x.lang); })[0];
    return v || null;
  }

  function speak(text) {
    var value = String(text == null ? '' : text).trim();
    if (!value || !('speechSynthesis' in window)) return;
    var accent = state.settings && state.settings.accent === 'en-GB' ? 'en-GB' : 'en-US';
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(value);
      u.lang = accent;
      u.rate = Number(state.settings.rate) || 1;
      var voice = pickVoice(accent);
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    } catch (err) {
      // 浏览器不支持语音时静默降级
    }
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    loadVoices();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
    DB.open().then(function () {
      return Promise.all([
        DB.getAllWords(),
        DB.getAllSentences(),
        DB.getSettings(),
        DB.getStats(C.todayKey()),
        DB.getAllBooks(),
        DB.getAllStats()
      ]);
    }).then(function (result) {
      state.words = (result[0] || []).map(normalizeWordRecord);
      state.sentences = (result[1] || []).map(normalizeSentenceRecord);
      var settingsRow = (result[2] || []).filter(function (row) { return row && row.id === 'settings'; })[0];
      state.books = (result[4] || []).map(normalizeBookRecord);
      state.settings = normalizeSettings(settingsRow);
      state.stats = result[3] || C.freshDailyStats();
      state.statsHistory = (result[5] || []).filter(function (r) { return r && r.date; });
      state.modes = state.settings.defaultModes.slice();
      state.newLimit = state.settings.dailyNew;
      state.reviewLimit = state.settings.dailyReview;
      state.importBookId = state.settings.defaultBookId;
      return ensureBookLinks();
    }).then(function () {
      bindEvents();
      render();
      requestPersistence();
      restoreActiveSession();
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) scheduleExternalReload();
      });
    }).catch(function (err) {
      $('#boot-error-msg').textContent = (err && err.message) ? err.message : '浏览器阻止了本地数据存储。';
      $('#boot-error').hidden = false;
    });
  }

  /* ---------------- 渲染入口 ---------------- */

  function render() {
    ensureToday();
    var view = $('#view');
    if (state.tab === 'words') view.innerHTML = wordsViewHtml();
    else if (state.tab === 'study') view.innerHTML = studyViewHtml();
    else if (state.tab === 'favorites') view.innerHTML = favoritesViewHtml();
    else view.innerHTML = settingsViewHtml();
    renderTabs();
    renderBar();
  }

  function renderTabs() {
    $$('.tab').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.tab === state.tab);
    });
  }

  function renderBar() {
    var now = Date.now();
    var due = 0;
    state.words.forEach(function (w) {
      if (C.hasAnyHistory(w) && C.hasDueDim(w, now)) due++;
    });
    var el = $('#bar-right');
    if (due > 0) {
      el.innerHTML = '待复习 <strong>' + due + '</strong> 词';
    } else {
      el.innerHTML = '共 <strong>' + state.words.length + '</strong> 词';
    }
  }

  function switchTab(tab) {
    if (!tab || tab === state.tab) {
      if (tab) window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    state.tab = tab;
    if (state.batchMode) {
      state.batchMode = false;
      state.selectedIds = {};
      document.body.classList.remove('in-batch');
    }
    window.scrollTo({ top: 0 });
    render();
  }

  /* ---------------- 词书 ---------------- */

  function mottoHtml() {
    return '<div class="motto" role="note" aria-label="拾词标语">' +
      '<p class="motto-en">Pick up words. <em>Unlock the world.</em></p>' +
      '<p class="motto-cn">拾起单词，打开世界</p>' +
      '</div>';
  }

  function wordsViewHtml() {
    var stats = C.overallStats(state.words);
    var valid = validBookIds();
    var filtered = C.sortWords(
      C.filterWords(state.words, state.wordFilter, state.wordQuery, state.scope, valid),
      state.wordSort
    );
    var head = '<div class="view-head">' +
      '<div><h1>词书</h1><p class="sub">' + state.words.length + ' 词 · ' + state.books.length + ' 个生词本 · 已掌握 ' +
      stats.mastered + ' · 标星 ' + stats.starred + '</p></div>' +
      '<div class="head-actions">' +
      '<button class="btn btn-ghost btn-sm' + (state.batchMode ? ' is-active' : '') +
      '" data-action="batch-toggle" type="button">' + (state.batchMode ? '完成' : '批量') + '</button>' +
      '<button class="btn btn-ghost btn-sm" data-action="import-open" type="button">导入</button>' +
      '<button class="btn btn-primary btn-sm" data-action="add-word" type="button">添加</button>' +
      '</div></div>';
    var bar = scopeChipsHtml(state.scope, 'word-scope');
    var motto = mottoHtml();

    if (!state.words.length) return motto + head + bar + emptyWordsHtml();

    var chips = ['all', 'new', 'weak'].map(function (f) {
      var label = { all: '全部', new: '未开始', weak: '薄弱' }[f];
      return '<button class="chip' + (state.wordFilter === f ? ' is-active' : '') +
        '" data-action="word-filter" data-filter="' + f + '" type="button">' + label + '</button>';
    }).join('');

    var sortOptions = [
      ['recent', '最近添加'],
      ['cn', '按中文'],
      ['weak', '薄弱优先'],
      ['mistakes', '错词优先'],
      ['star', '星标在前']
    ].map(function (o) {
      return '<option value="' + o[0] + '"' + (state.wordSort === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');

    return motto + head + bar +
      '<div class="toolbar">' +
      '<div class="search-wrap"><span class="search-icon">' + ICONS.search + '</span>' +
      '<input class="input" id="word-search" type="search" placeholder="搜索单词或中文释义" value="' + esc(state.wordQuery) + '" autocomplete="off"></div>' +
      '<p class="scope-line">搜索范围：<b>' + esc(scopeLabel(state.scope)) + '</b>' +
      '<span class="scope-tip">点击上方生词本可多选</span></p>' +
      '<div class="filter-row"><div class="chips">' + chips + '</div>' +
      '<select class="select" id="word-sort" aria-label="排序">' + sortOptions + '</select></div>' +
      '</div>' +
      '<div id="word-list">' + wordListHtml(filtered) + '</div>' +
      (state.batchMode ? batchBarHtml() : '');
  }

  function batchBarHtml() {
    var n = selectedCount();
    var disabled = n ? '' : ' disabled';
    return '<div class="batch-bar">' +
      '<div class="batch-info">已选 <b>' + n + '</b> 词</div>' +
      '<div class="batch-actions">' +
      '<button class="batch-btn" data-action="batch-select-all" type="button">全选</button>' +
      '<button class="batch-btn" data-action="batch-remove" type="button"' + disabled + '>移出</button>' +
      '<button class="batch-btn" data-action="batch-move" type="button"' + disabled + '>移入</button>' +
      '<button class="batch-btn" data-action="batch-copy" type="button"' + disabled + '>复制</button>' +
      '<button class="batch-btn ghost" data-action="batch-clear" type="button">完成</button>' +
      '</div></div>';
  }

  function emptyWordsHtml() {
    return '<div class="empty card">' +
      '<div class="empty-mark">拾</div>' +
      '<h2>拾词还是空的</h2>' +
      '<p>添加第一个单词，或导入现成的词表。所有数据只保存在当前浏览器，不会上传。</p>' +
      '<div class="empty-actions">' +
      '<button class="btn btn-primary" data-action="add-word" type="button">添加单词</button>' +
      '<button class="btn btn-ghost" data-action="import-open" type="button">导入词表</button>' +
      '</div></div>';
  }

  function wordListHtml(list) {
    if (!list.length) {
      var hint = state.words.length && state.scope.mode !== 'all'
        ? '当前生词本范围里没有匹配的词条。换个词或切换范围试试。'
        : '没有匹配的词条。换个关键词或筛选条件试试。';
      return '<div class="empty card" style="padding:28px 18px">' +
        '<p style="margin-bottom:0">' + hint + '</p></div>';
    }
    return '<div class="word-list">' + list.map(wordRowHtml).join('') + '</div>';
  }

  function bookMembershipText(w) {
    var ids = (w.bookIds || []).filter(function (id) { return !!bookById(id); });
    if (!ids.length) return '未分类';
    var names = ids.slice(0, 2).map(bookName);
    return names.join(' · ') + (ids.length > 2 ? ' +' + (ids.length - 2) : '');
  }

  function wordRowHtml(w) {
    var scores = C.wordScores(w);
    var level = C.masteryLevel(C.wordMastery(w));
    var misses = C.mistakeCount(w);
    var picked = state.batchMode && !!state.selectedIds[w.id];
    var lead = state.batchMode
      ? '<button class="pick-btn' + (picked ? ' is-on' : '') + '" data-action="word-pick" data-id="' + w.id +
        '" type="button" aria-pressed="' + picked + '" aria-label="选择单词">' + (picked ? ICONS.check : '') + '</button>'
      : '<button class="star-btn' + (w.starred ? ' is-on' : '') + '" data-action="toggle-star" data-id="' + w.id +
        '" type="button" aria-label="' + (w.starred ? '取消收藏' : '收藏单词') + '">' + ICONS.star + '</button>';
    return '<div class="word-item' + (picked ? ' is-picked' : '') + '">' + lead +
      '<button class="word-open" data-action="' + (state.batchMode ? 'word-pick' : 'word-detail') +
      '" data-id="' + w.id + '" type="button">' +
      '<span class="word-line"><span class="word">' + esc(w.word) + '</span>' +
      (w.pos ? '<span class="pos-tag">' + esc(w.pos) + '</span>' : '') +
      (misses ? '<span class="wrong-tag">错 ' + misses + '</span>' : '') +
      (C.isLeech(w) ? '<span class="leech-tag">顽固</span>' : '') +
      '<span class="badge badge-' + level.key + '">' + level.label + '</span></span>' +
      '<span class="word-cn">' + esc(w.cn || w.en || '暂无释义') + '</span>' +
      '<span class="word-books">' + esc(bookMembershipText(w)) + '</span>' +
      '<span class="dims">' + dimBarHtml('recognize', scores.recognize) +
      dimBarHtml('spell', scores.spell) + dimBarHtml('meaning', scores.meaning) + '</span>' +
      '</button>' +
      (state.batchMode ? '' :
        '<button class="icon-btn speak" data-action="speak" data-text="' + esc(w.word) + '" type="button" aria-label="朗读单词">' + ICONS.speaker + '</button>') +
      '</div>';
  }

  function refreshWordList() {
    var box = $('#word-list');
    if (!box) return;
    var list = C.sortWords(
      C.filterWords(state.words, state.wordFilter, state.wordQuery, state.scope, validBookIds()),
      state.wordSort
    );
    box.innerHTML = wordListHtml(list);
  }

  /* ---------------- 背诵 ---------------- */

  function studyScopedWords() {
    var valid = validBookIds();
    return state.words.filter(function (w) { return C.wordInScope(w, state.studyScope, valid); });
  }

  function dueCount() {
    var now = Date.now();
    var valid = validBookIds();
    return state.words.filter(function (w) {
      return C.wordInScope(w, state.studyScope, valid) && C.hasAnyHistory(w) && C.hasDueDim(w, now);
    }).length;
  }

  function studyViewHtml() {
    var scoped = studyScopedWords();
    var newCount = scoped.filter(function (w) { return !C.hasAnyHistory(w); }).length;
    var due = dueCount();
    var scopeMistakes = scoped.filter(function (w) { return C.mistakeCount(w) > 0; }).length;
    var scopeLeech = scoped.filter(function (w) { return C.isLeech(w); }).length;
    var rows = statsRows();
    var streak = C.streakDays(rows);
    var goal = Math.max(1, (state.settings.dailyNew || 0) + (state.settings.dailyReview || 0));
    var done = state.stats ? state.stats.total : 0;
    var goalPct = Math.min(100, Math.round(done / goal * 100));
    var goalDone = done >= goal;
    var goalHint = goalDone ? '今日目标已完成，继续保持' : '还差 ' + (goal - done) + ' 题完成今日目标';
    var heatCells = C.heatmap(rows, 28, C.todayKey()).map(function (d) {
      var lv = 0;
      if (d.total >= 40) lv = 4;
      else if (d.total >= 20) lv = 3;
      else if (d.total >= 10) lv = 2;
      else if (d.total > 0) lv = 1;
      return '<span class="heat-cell lv-' + lv + '" title="' + d.date + ' · ' + d.total + ' 题"></span>';
    }).join('');
    var modeChips = C.MODE_IDS.map(function (id) {
      var info = C.MODES[id];
      var active = state.modes.indexOf(id) >= 0;
      return '<button class="mode-chip' + (active ? ' is-active' : '') + '" data-action="mode-toggle" data-mode="' + id + '" type="button">' +
        '<span>' + info.label + '</span><small>' + C.DIM_LABEL[info.dim] + '</small></button>';
    }).join('');
    var mixActive = state.modes.indexOf('mix') >= 0;

    return '<div class="view-head study-head"><div><h1>背诵</h1>' +
      '<p class="sub">范围 ' + scoped.length + ' 词 · 待复习 ' + due + ' 词 · 未开始 ' + newCount + ' 词 · 错词 ' + scopeMistakes + ' 词 · 顽固 ' + scopeLeech + ' 词</p></div></div>' +
      scopeChipsHtml(state.studyScope, 'study-scope') +
      '<p class="scope-line">抽词范围：<b>' + esc(scopeLabel(state.studyScope)) + '</b>' +
      '<span class="scope-tip">点击上方生词本可多选</span></p>' +
      '<div class="card loop-card">' +
      '<div class="loop-head"><div class="t-label">学习闭环</div>' +
      '<div class="streak">连续打卡 <b>' + streak + '</b> 天</div></div>' +
      '<div class="goal-box">' +
      '<div class="goal-ring' + (goalDone ? ' is-done' : '') + '" style="--pct:' + goalPct + '%"><span>' + goalPct + '%</span></div>' +
      '<div class="goal-info">' +
      '<div class="goal-row"><span>今日目标</span><b>' + done + ' / ' + goal + ' 题</b></div>' +
      '<div class="goal-bar"><span style="width:' + goalPct + '%"></span></div>' +
      '<div class="goal-hint' + (goalDone ? ' is-done' : '') + '">' + goalHint + '</div>' +
      '</div></div>' +
      '<div class="heatmap">' + heatCells + '</div>' +
      '<div class="heat-legend">近 4 周 · 格子越深当天答题越多</div>' +
      '<button class="btn btn-ghost btn-block report-btn" data-action="open-report" type="button">查看学习报告</button>' +
      '</div>' +
      '<div class="card plan-card">' +
      '<h2>本轮设置</h2><p class="hint">可同时选择多种抽查方式；一个词必须通过本轮所有已选方式，才算完成。</p>' +
      '<div class="mode-grid">' + modeChips +
      '<button class="mode-chip wide' + (mixActive ? ' is-active' : '') + '" data-action="mode-toggle" data-mode="mix" type="button">' +
      '<span>混合</span><small>按词的到期维度自动轮换，不能与其他方式同选</small></button>' +
      '</div>' +
      '<div class="number-row">' +
      '<div class="number-field"><label for="limit-new">本次新词数</label>' +
      '<input id="limit-new" type="number" min="0" inputmode="numeric" value="' + state.newLimit + '"></div>' +
      '<div class="number-field"><label for="limit-review">本次复习数</label>' +
      '<input id="limit-review" type="number" min="0" inputmode="numeric" value="' + state.reviewLimit + '"></div>' +
      '</div>' +
      '<button class="btn btn-primary btn-block start-btn" data-action="start-session" type="button">开始背诵</button>' +
      '<button class="btn btn-ghost btn-block mistake-btn" data-action="start-mistakes" type="button"' +
      (scopeMistakes ? '' : ' disabled') + '>错词专练' + (scopeMistakes ? ' · ' + scopeMistakes + ' 词' : ' · 暂无错词') + '</button>' +
      '<button class="btn btn-ghost btn-block leech-btn" data-action="start-leech" type="button"' +
      (scopeLeech ? '' : ' disabled') + '>顽固词专练' + (scopeLeech ? ' · ' + scopeLeech + ' 词' : ' · 暂无顽固词') + '</button>' +
      '<p class="hint" style="margin-top:10px">没有中文释义的词会自动改用听音拼写；词库不足 4 个词时，选择题会自动降级。例句填空只对有例句的词出题，速认是自评模式。</p>' +
      '</div>' +
      '<div class="card today-card">' +
      '<div class="t-label">今日</div>' +
      '<div class="today-nums">' +
      '<div><b>' + state.stats.newWords + '</b><span>新词</span></div>' +
      '<div><b>' + state.stats.reviews + '</b><span>复习</span></div>' +
      '<div><b>' + (state.stats.total ? Math.round(state.stats.right / state.stats.total * 100) + '%' : '—') + '</b><span>正确率</span></div>' +
      '</div></div>' +
      '<p class="study-note">同一单词的不同考查方式之间，至少间隔 4 个其他单词；答错的题会在本轮末尾重出，最多 2 次。复习间隔按 SM-2 自动拉长。</p>';
  }

  function toggleMode(mode) {
    if (mode === 'mix') {
      state.modes = ['mix'];
    } else {
      var modes = state.modes.filter(function (m) { return m !== 'mix'; });
      var idx = modes.indexOf(mode);
      if (idx >= 0) modes.splice(idx, 1);
      else modes.push(mode);
      if (!modes.length) {
        toast('至少保留一种抽查方式');
        return;
      }
      state.modes = modes;
    }
    render();
  }

  function sessionSnapshot(s) {
    return {
      queue: s.queue.snapshot(),
      plan: s.plan,
      total: s.total,
      answered: s.answered,
      correct: s.correct,
      newSet: s.newSet,
      passed: s.passed,
      current: s.current,
      revealed: s.revealed,
      lastResult: s.lastResult,
      finished: false
    };
  }

  function persistSession() {
    var s = state.session;
    if (!s) return;
    if (s.finished) {
      clearPersistedSession();
      return;
    }
    DB.saveActiveSession(sessionSnapshot(s)).catch(function () { /* 静默失败 */ });
  }

  function clearPersistedSession() {
    DB.clearActiveSession().catch(function () { /* 静默失败 */ });
  }

  function restoreActiveSession() {
    DB.getActiveSession().then(function (row) {
      var snap = row && row.session;
      if (!snap || snap.finished) {
        if (snap) clearPersistedSession();
        return;
      }
      var tasks = (snap.queue && Array.isArray(snap.queue.q) ? snap.queue.q : []).filter(function (t) {
        return t && t.wordId && t.mode && getWord(t.wordId);
      });
      var current = snap.current && snap.current.wordId && getWord(snap.current.wordId)
        ? snap.current
        : null;
      if (!tasks.length && !current) {
        clearPersistedSession();
        return;
      }
      var plan = (snap.plan || []).filter(function (p) { return p && getWord(p.wordId); });
      var s = {
        queue: C.createQueue([], 4, { q: tasks, recent: snap.queue && snap.queue.recent }),
        plan: plan,
        total: Math.max(Number(snap.total) || 0, Number(snap.answered) || 0),
        answered: Number(snap.answered) || 0,
        correct: Number(snap.correct) || 0,
        newSet: snap.newSet || {},
        passed: snap.passed || {},
        current: current,
        revealed: !!snap.revealed,
        lastResult: snap.lastResult || null,
        finished: false
      };
      state.session = s;
      document.body.classList.add('in-session');
      var root = $('#session-root');
      root.hidden = false;
      if (current) {
        if (C.MODES[current.mode] && C.MODES[current.mode].kind === 'choice' &&
            (!current.options || current.options.length < 2)) {
          var word = getWord(current.wordId);
          current.options = shuffle([word].concat(C.pickDistractors(word, state.words, 3)));
        }
        renderSession();
      } else {
        advance();
      }
      toast('已恢复上次未完成的背诵');
    }).catch(function () { /* 无快照或读取失败时忽略 */ });
  }

  function startSession() {
    ensureToday();
    var newEl = $('#limit-new');
    var revEl = $('#limit-review');
    var newLimit = Math.max(0, parseInt(newEl && newEl.value, 10) || 0);
    var reviewLimit = Math.max(0, parseInt(revEl && revEl.value, 10) || 0);
    state.newLimit = newLimit;
    state.reviewLimit = reviewLimit;

    if (!state.words.length) {
      toast('词库为空，先添加或导入单词', true);
      return;
    }
    if (newLimit + reviewLimit === 0) {
      toast('请至少设置新词数或复习数', true);
      return;
    }
    var scoped = studyScopedWords();
    if (!scoped.length) {
      toast('当前生词本范围里没有单词', true);
      return;
    }
    var now = Date.now();
    var picked = C.selectSessionWords(scoped, newLimit, reviewLimit, now);
    if (!picked.newWords.length && !picked.reviewWords.length) {
      toast('范围内没有可背诵的词：可增加数量、切换范围，或等复习到期', true);
      return;
    }
    var built = C.buildSession({
      newWords: picked.newWords,
      reviewWords: picked.reviewWords,
      modes: state.modes,
      pool: state.words,
      now: now
    });
    if (!built.tasks.length) {
      toast('这些词暂时无法出题，请调整抽查方式', true);
      return;
    }

    var newSet = {};
    picked.newWords.forEach(function (w) {
      newSet[w.id] = true;
      if (!w.startedAt) w.startedAt = now;
      DB.putWord(w).then(notifyChange);
    });
    state.stats.newWords += picked.newWords.length;
    saveStats();
    beginSession(built, newSet);
  }

  function beginSession(built, newSet) {
    state.session = {
      queue: C.createQueue(built.tasks, 4),
      plan: built.plan,
      total: built.tasks.length,
      answered: 0,
      correct: 0,
      newSet: newSet || {},
      passed: {},
      current: null,
      revealed: false,
      lastResult: null,
      finished: false
    };
    document.body.classList.add('in-session');
    $('#session-root').hidden = false;
    advance();
  }

  function mistakeWordsInScope() {
    var valid = validBookIds();
    return state.words.filter(function (w) {
      return C.wordInScope(w, state.studyScope, valid) && C.mistakeCount(w) > 0;
    });
  }

  // 错词专练：不等复习到期，直接把当前范围内的错词拉出来重练
  function startMistakeSession() {
    ensureToday();
    var list = mistakeWordsInScope();
    if (!list.length) {
      toast('当前范围没有错词', true);
      return;
    }
    var built = C.buildSession({
      newWords: [],
      reviewWords: list,
      modes: ['mix'],
      pool: state.words,
      now: Date.now()
    });
    if (!built.tasks.length) {
      toast('错词暂时无法出题，请调整抽查方式', true);
      return;
    }
    beginSession(built, {});
  }

  // 顽固词专练：最近连续答错达到阈值的词，单独集中攻克
  function leechWordsInScope() {
    var valid = validBookIds();
    return state.words.filter(function (w) {
      return C.wordInScope(w, state.studyScope, valid) && C.isLeech(w);
    });
  }

  function startLeechSession() {
    ensureToday();
    var list = leechWordsInScope();
    if (!list.length) {
      toast('当前范围没有顽固词', true);
      return;
    }
    var built = C.buildSession({
      newWords: [],
      reviewWords: list,
      modes: ['mix'],
      pool: state.words,
      now: Date.now()
    });
    if (!built.tasks.length) {
      toast('顽固词暂时无法出题，请调整抽查方式', true);
      return;
    }
    beginSession(built, {});
  }

  function advance() {
    var s = state.session;
    if (!s) return;
    if (s.current && !s.revealed) return;
    var task = s.queue.next();
    if (!task) {
      s.finished = true;
      clearPersistedSession();
      renderSession();
      return;
    }
    s.current = task;
    s.revealed = false;
    s.lastResult = null;
    if (C.MODES[task.mode].kind === 'choice') {
      var word = getWord(task.wordId);
      task.options = shuffle([word].concat(C.pickDistractors(word, state.words, 3)));
    }
    renderSession();
    persistSession();
    var mode = C.MODES[task.mode];
    if (mode.id === 'spell' || mode.id === 'listenChoice') {
      setTimeout(function () { speak(getWord(task.wordId).word); }, 160);
    } else if (mode.id === 'dictation') {
      var dictWord = getWord(task.wordId);
      var dict = dictWord ? C.dictationFor(dictWord) : null;
      if (dict) setTimeout(function () { speak(dict.en); }, 160);
    }
  }

  function sessionProgressHtml(s) {
    var pct = s.total ? Math.min(100, Math.round(s.answered / s.total * 100)) : 0;
    var label = C.MODES[s.current.mode].label;
    return '<div class="session-top">' +
      '<button class="icon-btn" data-action="session-exit" type="button" aria-label="退出背诵">' + ICONS.close + '</button>' +
      '<div class="progress-text">' + s.answered + ' / ' + s.total + '</div>' +
      '<div class="mode-tag">' + label + '</div>' +
      '</div><div class="session-bar"><span style="width:' + pct + '%"></span></div>';
  }

  function renderSession() {
    var s = state.session;
    var root = document.getElementById('session-root');
    if (!s) {
      root.hidden = true;
      root.innerHTML = '';
      document.body.classList.remove('in-session');
      return;
    }
    if (s.finished) {
      root.innerHTML = summaryHtml(s);
      return;
    }
    if (!s.current) return;
    var word = getWord(s.current.wordId);
    if (!word) {
      s.finished = true;
      renderSession();
      return;
    }
    var body = s.revealed ? revealHtml(s, word) : questionHtml(s, word);
    root.innerHTML = '<div class="session">' + sessionProgressHtml(s) +
      '<div class="session-body">' + body + '</div></div>';
    if (!s.revealed) {
      var input = document.getElementById('answer-input');
      if (input) {
        try { input.focus({ preventScroll: true }); } catch (err) { input.focus(); }
      }
    }
  }

  function optionsHtml(task, s) {
    return task.options.map(function (opt, idx) {
      var cls = 'option';
      if (s.revealed) {
        if (opt.id === task.wordId) cls += ' is-correct';
        else if (s.lastResult && s.lastResult.selectedId === opt.id) cls += ' is-wrong';
      }
      return '<button class="' + cls + '" data-action="choose-option" data-id="' + opt.id + '"' +
        (s.revealed ? ' disabled' : '') + ' type="button">' +
        '<span class="opt-key">' + 'ABCD'[idx] + '</span>' +
        '<span class="opt-word">' + esc(opt.word) + '</span></button>';
    }).join('');
  }

  function questionHtml(s, word) {
    var task = s.current;
    var mode = C.MODES[task.mode];
    var inner = '';

    if (task.mode === 'spell') {
      inner = '<div class="q-card">' +
        '<div class="q-kicker">听音拼写</div>' +
        '<button class="speaker-big" data-action="replay" type="button">' + ICONS.speaker + '<span>点击重听</span></button>' +
        '<p class="q-hint">听发音，写出你听到的单词</p>' +
        '<input class="input answer-input" id="answer-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="输入单词">' +
        '<button class="btn btn-primary btn-block" data-action="submit-answer" type="button">确认拼写</button>' +
        '</div>';
    } else if (task.mode === 'cnSpell') {
      inner = '<div class="q-card">' +
        '<div class="q-kicker">看中文拼写</div>' +
        '<div class="q-cn">' + esc(word.cn || '（无中文释义）') + '</div>' +
        '<p class="q-hint">根据中文释义拼写单词</p>' +
        '<input class="input answer-input" id="answer-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="输入单词">' +
        '<button class="btn btn-primary btn-block" data-action="submit-answer" type="button">确认拼写</button>' +
        '</div>';
    } else if (task.mode === 'meaningChoice') {
      inner = '<div class="q-card">' +
        '<div class="q-kicker">释义选词</div>' +
        '<div class="q-cn">' + esc(word.cn || '（无中文释义）') + '</div>' +
        '<p class="q-hint">选择对应的英文单词</p>' +
        '<div class="options">' + optionsHtml(task, s) + '</div>' +
        '</div>';
    } else if (task.mode === 'listenChoice') {
      inner = '<div class="q-card">' +
        '<div class="q-kicker">听音选词</div>' +
        '<button class="speaker-big" data-action="replay" type="button">' + ICONS.speaker + '<span>点击重听</span></button>' +
        '<p class="q-hint">听发音，选择对应的单词</p>' +
        '<div class="options">' + optionsHtml(task, s) + '</div>' +
        '</div>';
    } else if (task.mode === 'writeMeaning') {
      inner = '<div class="q-card">' +
        '<div class="q-kicker">写释义</div>' +
        '<div class="q-word-row"><span class="q-word">' + esc(word.word) + '</span>' +
        '<button class="icon-btn" data-action="speak" data-text="' + esc(word.word) + '" type="button" aria-label="朗读">' + ICONS.speaker + '</button></div>' +
        '<p class="q-hint">写出中文释义，近似即可</p>' +
        '<input class="input answer-input cn-input" id="answer-input" type="text" autocomplete="off" placeholder="输入中文释义">' +
        '<button class="btn btn-primary btn-block" data-action="submit-answer" type="button">确认释义</button>' +
        '</div>';
    } else if (task.mode === 'cloze') {
      var cloze = C.clozeFor(word);
      var blank = cloze ? new Array(Math.max(3, cloze.answer.length) + 1).join('_') : '____';
      inner = '<div class="q-card">' +
        '<div class="q-kicker">例句填空</div>' +
        (cloze
          ? '<div class="q-cloze">' + esc(cloze.before) + '<span class="cloze-blank">' + blank + '</span>' +
            esc(cloze.after) + '</div>' +
            (cloze.cn ? '<p class="q-cloze-cn">' + esc(cloze.cn) + '</p>' : '')
          : '<div class="q-cn">' + esc(word.cn || '（无例句）') + '</div>') +
        '<p class="q-hint">根据例句填入缺少的单词</p>' +
        '<input class="input answer-input" id="answer-input" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="输入单词">' +
        '<button class="btn btn-primary btn-block" data-action="submit-answer" type="button">确认拼写</button>' +
        '</div>';
    } else if (task.mode === 'dictation') {
      var dict = C.dictationFor(word) || { en: '', cn: '' };
      inner = '<div class="q-card">' +
        '<div class="q-kicker">整句听写</div>' +
        '<button class="speaker-big" data-action="replay" type="button">' + ICONS.speaker + '<span>点击重听</span></button>' +
        '<p class="q-hint">听整句，写出你听到的句子（标点可忽略）</p>' +
        '<textarea class="textarea answer-input dictation-input" id="answer-input" rows="3" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="输入整句英文"></textarea>' +
        (dict.cn ? '<p class="q-cloze-cn">' + esc(dict.cn) + '</p>' : '') +
        '<button class="btn btn-primary btn-block" data-action="submit-answer" type="button">确认句子</button>' +
        '</div>';
    } else if (task.mode === 'multiCloze') {
      var mc = C.multiClozeFor(word);
      var mcHtml = mc
        ? '<div class="q-cloze multi-cloze">' + mc.segments.map(function (seg) {
          if (seg.blank) {
            return '<input class="mc-input answer-input" id="answer-input-' + seg.index + '" data-blank="' + seg.index +
              '" type="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="第 ' +
              (seg.index + 1) + ' 空">';
          }
          return esc(seg.text);
        }).join('') + '</div>' +
          (mc.cn ? '<p class="q-cloze-cn">' + esc(mc.cn) + '</p>' : '')
        : '<div class="q-cn">' + esc(word.cn || '（无合适例句）') + '</div>';
      inner = '<div class="q-card">' +
        '<div class="q-kicker">多空填空</div>' + mcHtml +
        '<p class="q-hint">根据例句填写所有空缺，全部正确才算通过</p>' +
        '<button class="btn btn-primary btn-block" data-action="submit-answer" type="button">确认填空</button>' +
        '</div>';
    } else {
      inner = '<div class="q-card">' +
        '<div class="q-kicker">速认</div>' +
        '<div class="q-word-row"><span class="q-word">' + esc(word.word) + '</span>' +
        '<button class="icon-btn" data-action="speak" data-text="' + esc(word.word) + '" type="button" aria-label="朗读">' + ICONS.speaker + '</button></div>' +
        '<p class="q-hint">看到单词，凭第一反应判断是否认识</p>' +
        '<div class="quick-actions">' +
        '<button class="btn btn-ghost" data-action="quick-rate" data-rate="unknown" type="button">不认识</button>' +
        '<button class="btn btn-primary" data-action="quick-rate" data-rate="know" type="button">认识</button>' +
        '</div></div>';
    }
    return inner + '<p class="session-footnote">' + C.DIM_LABEL[mode.dim] + '维度 · 本题答错会在本轮末尾重出</p>';
  }

  function extraAnswerHtml(task, word) {
    if (task.mode === 'dictation') {
      var d = C.dictationFor(word);
      if (!d) return '';
      return '<div class="answer-sentence"><span class="k">原句</span><span class="v">' + esc(d.en) + '</span>' +
        '<button class="icon-btn ex-speak" data-action="speak" data-text="' + esc(d.en) + '" type="button" aria-label="朗读原句">' +
        ICONS.speaker + '</button></div>';
    }
    if (task.mode === 'multiCloze') {
      var mc = C.multiClozeFor(word);
      if (!mc) return '';
      var plain = '';
      var html = mc.segments.map(function (seg) {
        if (seg.blank) {
          var ans = mc.answers[seg.index] || '';
          plain += ans;
          return '<b class="mc-filled">' + esc(ans) + '</b>';
        }
        plain += seg.text;
        return esc(seg.text);
      }).join('');
      return '<div class="answer-sentence"><span class="k">原句</span><span class="v">' + html + '</span>' +
        '<button class="icon-btn ex-speak" data-action="speak" data-text="' + esc(plain) + '" type="button" aria-label="朗读原句">' +
        ICONS.speaker + '</button></div>';
    }
    return '';
  }

  function revealHtml(s, word) {
    var task = s.current;
    var result = s.lastResult || { correct: false };
    var show = state.settings.show;
    var forceCn = task.mode === 'writeMeaning' || task.mode === 'quick';
    var rows = '';

    if ((show.cn || forceCn) && word.cn) {
      rows += '<div class="def-row cn"><span class="k">中文</span><span class="v">' + esc(word.cn) + '</span></div>';
    }
    if (show.en && word.en) {
      rows += '<div class="def-row"><span class="k">英文</span><span class="v">' + esc(word.en) + '</span></div>';
    }
    var examples = (word.examples || []).slice(0, 3);
    examples.forEach(function (ex) {
      if (show.exEn && ex.en) {
        rows += '<div class="def-row example"><span class="k">例句</span><span class="v def-example">' +
          '<span>' + esc(ex.en) + '</span>' +
          '<button class="icon-btn ex-speak" data-action="speak" data-text="' + esc(ex.en) + '" type="button" aria-label="朗读例句">' + ICONS.speaker + '</button>' +
          '</span></div>';
      }
      if (show.exCn && ex.cn) {
        rows += '<div class="def-row example-cn"><span class="k">翻译</span><span class="v">' + esc(ex.cn) + '</span></div>';
      }
    });

    var wrongAnswer = '';
    if (!result.correct) {
      var shown = '';
      if (task.mode === 'meaningChoice' || task.mode === 'listenChoice') {
        var picked = result.selectedId ? getWord(result.selectedId) : null;
        shown = picked ? picked.word : '（未选择）';
      } else if (task.mode === 'quick') {
        shown = result.value === 'know' ? '认识' : '不认识';
      } else {
        shown = Array.isArray(result.value) ? result.value.join(' / ') : (result.value || '（空）');
      }
      wrongAnswer = '<div class="your-answer">你的答案：<b>' + esc(shown) + '</b></div>';
    }

    return '<div class="q-card reveal">' +
      '<div class="result-line ' + (result.correct ? 'ok' : 'no') + '"><span class="dot"></span>' +
      (result.correct ? '答对了' : '答错了') + '</div>' +
      '<div class="reveal-word"><span class="w">' + esc(word.word) + '</span>' +
      (word.phonetic ? '<span class="phonetic">' + esc(word.phonetic) + '</span>' : '') +
      (word.pos ? '<span class="pos-tag">' + esc(word.pos) + '</span>' : '') +
      '<button class="icon-btn" data-action="speak" data-text="' + esc(word.word) + '" type="button" aria-label="朗读单词">' + ICONS.speaker + '</button></div>' +
      extraAnswerHtml(task, word) +
      (rows ? '<div class="reveal-defs">' + rows + '</div>' : '') +
      wrongAnswer +
      '<button class="btn btn-primary btn-block next-btn" data-action="next-task" type="button">' +
      (s.queue.size() ? '下一题' : '查看结果') + '</button>' +
      '</div>' +
      '<p class="session-footnote">' + C.DIM_LABEL[C.MODES[task.mode].dim] + '维度 · 正确率按最近 10 次计算</p>';
  }

  function submitAnswer() {
    var s = state.session;
    if (!s || !s.current || s.revealed) return;
    var task = s.current;
    var word = getWord(task.wordId);
    if (!word) return;
    if (C.MODES[task.mode].kind === 'choice') return;
    if (task.mode === 'multiCloze') {
      var blanks = $$('.mc-input');
      var values = blanks.map(function (el) { return el.value; });
      if (!values.length) return;
      for (var i = 0; i < values.length; i++) {
        if (!String(values[i]).trim()) {
          toast('先把所有空都填上');
          if (blanks[i]) blanks[i].focus();
          return;
        }
      }
      finishAnswer(values, null, word, task);
      return;
    }
    var input = document.getElementById('answer-input');
    var value = input ? input.value : '';
    if (!String(value).trim()) {
      toast('先写下答案');
      if (input) input.focus();
      return;
    }
    finishAnswer(value, null, word, task);
  }

  function chooseOption(id) {
    var s = state.session;
    if (!s || !s.current || s.revealed) return;
    var task = s.current;
    var word = getWord(task.wordId);
    if (!word || C.MODES[task.mode].kind !== 'choice') return;
    finishAnswer(id, id, word, task);
  }

  function rateQuick(rating) {
    var s = state.session;
    if (!s || !s.current || s.revealed) return;
    var task = s.current;
    if (task.mode !== 'quick') return;
    var word = getWord(task.wordId);
    if (!word) return;
    finishAnswer(String(rating || 'unknown'), null, word, task);
  }

  function finishAnswer(value, selectedId, word, task) {
    var s = state.session;
    var correct = false;
    if (task.mode === 'spell' || task.mode === 'cnSpell' || task.mode === 'cloze') {
      correct = C.normalizeSpelling(value) === C.normalizeSpelling(word.word);
    } else if (task.mode === 'dictation') {
      var dict = C.dictationFor(word);
      correct = !!dict && C.isSentenceMatch(value, dict.en);
    } else if (task.mode === 'multiCloze') {
      var mc = C.multiClozeFor(word);
      correct = !!mc && Array.isArray(value) && value.length === mc.answers.length &&
        mc.answers.every(function (ans, idx) {
          return C.normalizeSpelling(value[idx]) === C.normalizeSpelling(ans);
        });
    } else if (task.mode === 'writeMeaning') {
      correct = C.meaningMatch(value, word);
    } else if (task.mode === 'quick') {
      correct = String(value) === 'know';
    } else {
      correct = String(value) === String(word.id);
    }

    var now = Date.now();
    word.dims[task.dim] = C.applyAnswer(word.dims[task.dim], correct, task.mode, now);
    if (!word.startedAt) word.startedAt = now;
    DB.putWord(word).then(notifyChange);

    s.answered++;
    if (correct) s.correct++;
    ensureToday();
    state.stats.total += 1;
    if (correct) state.stats.right += 1;
    if (!s.newSet[word.id]) state.stats.reviews += 1;
    saveStats();

    if (correct) {
      s.passed[word.id] = s.passed[word.id] || {};
      s.passed[word.id][task.mode] = true;
    } else if (s.queue.requeue(task)) {
      s.total += 1;
    }

    s.lastResult = { correct: correct, selectedId: selectedId, value: value };
    s.revealed = true;
    renderSession();
    persistSession();
    speak(word.word);
  }

  function summaryHtml(s) {
    var mastered = s.plan.filter(function (p) {
      var got = s.passed[p.wordId] || {};
      return p.modes.every(function (m) { return got[m]; });
    }).length;
    var rate = s.answered ? Math.round(s.correct / s.answered * 100) : 0;
    return '<div class="session"><div class="session-body">' +
      '<div class="summary-card">' +
      '<div class="summary-kicker">SESSION COMPLETE</div>' +
      '<h2>本轮完成</h2>' +
      '<div class="summary-stats">' +
      '<div><b>' + s.answered + '</b><span>题数</span></div>' +
      '<div><b>' + s.correct + '</b><span>答对</span></div>' +
      '<div><b>' + rate + '%</b><span>正确率</span></div>' +
      '</div>' +
      '<p class="summary-note">' + (mastered ? '有 ' + mastered + ' 个词通过了本轮全部抽查方式。' : '本轮尚未有词通过全部抽查方式，答错的题会留待下次复习。') + '</p>' +
      '<button class="btn btn-primary btn-block" data-action="session-done" type="button">返回</button>' +
      '</div></div></div>';
  }

  function endSession() {
    state.session = null;
    clearPersistedSession();
    document.body.classList.remove('in-session');
    var root = document.getElementById('session-root');
    root.hidden = true;
    root.innerHTML = '';
    render();
  }

  function askExitSession() {
    confirmDialog({
      title: '退出本轮背诵？',
      message: '已经作答的记录会保留，本轮剩余题目不会继续。',
      confirmText: '退出',
      danger: true,
      onConfirm: endSession
    });
  }

  /* ---------------- 收藏 ---------------- */

  function favoritesViewHtml() {
    var starred = state.words.filter(function (w) { return w.starred; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    var seg = '<div class="segmented">' +
      '<button class="' + (state.favTab === 'words' ? 'is-active' : '') + '" data-action="fav-tab" data-fav="words" type="button">单词收藏</button>' +
      '<button class="' + (state.favTab === 'sentences' ? 'is-active' : '') + '" data-action="fav-tab" data-fav="sentences" type="button">句子收藏</button>' +
      '</div>';

    var body = state.favTab === 'words' ? favoritesWordsHtml(starred) : favoritesSentencesHtml();
    return '<div class="view-head"><div><h1>收藏</h1>' +
      '<p class="sub">星标单词 ' + starred.length + ' 个 · 句子 ' + state.sentences.length + ' 条</p></div></div>' +
      seg + body;
  }

  function favoritesWordsHtml(starred) {
    if (!starred.length) {
      return '<div class="empty card"><div class="empty-mark">★</div>' +
        '<h2>还没有星标单词</h2><p>在词书里点单词左侧的星标，就会出现在这里。</p>' +
        '<div class="empty-actions"><button class="btn btn-ghost" data-action="go-words" type="button">去词书看看</button></div></div>';
    }
    return '<div class="word-list">' + starred.map(wordRowHtml).join('') + '</div>';
  }

  function favoritesSentencesHtml() {
    var datalist = '<datalist id="word-options">' + state.words.slice(0, 300).map(function (w) {
      return '<option value="' + esc(w.word) + '"></option>';
    }).join('') + '</datalist>';

    return '<div class="card card-pad sentence-add">' +
      '<form id="sentence-form">' +
      '<textarea class="textarea" name="text" placeholder="输入英文句子" required></textarea>' +
      '<input class="input" name="cn" placeholder="中文翻译（选填）" autocomplete="off">' +
      '<div class="sentence-tools">' +
      '<input class="input" name="word" list="word-options" placeholder="关联单词（选填）" autocomplete="off">' +
      '<button class="btn btn-primary" type="submit">添加</button>' +
      '</div></form>' + datalist + '</div>' +
      '<div style="margin-bottom:12px"><input class="input" id="sent-search" type="search" placeholder="搜索句子、翻译或关联单词" value="' + esc(state.sentQuery) + '" autocomplete="off"></div>' +
      '<div id="sentence-list-slot">' + sentencesListOnlyHtml() + '</div>';
  }

  function sentencesListOnlyHtml() {
    var query = state.sentQuery.trim().toLowerCase();
    var list = state.sentences.slice().sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    }).filter(function (s) {
      if (!query) return true;
      return (s.text + ' ' + s.cn + ' ' + (s.word || '')).toLowerCase().indexOf(query) >= 0;
    });

    if (!state.sentences.length) {
      return '<div class="empty card" style="padding:26px 18px"><p style="margin-bottom:0">还没有句子收藏。可以手动输入，或在单词详情的例句上点 ★ 加入。</p></div>';
    }
    if (!list.length) {
      return '<div class="empty card" style="padding:26px 18px"><p style="margin-bottom:0">没有匹配的句子。</p></div>';
    }
    return '<div class="sentence-list">' + list.map(function (s) {
      var meta = s.word ? '<span class="tag">' + esc(s.word) + '</span>' : '';
      return '<div class="sentence-item">' +
        '<div class="sentence-body" data-action="speak" data-text="' + esc(s.text) + '" role="button" tabindex="0" aria-label="朗读句子">' +
        '<div class="sentence-text">' + esc(s.text) + '</div>' +
        (s.cn ? '<div class="sentence-cn">' + esc(s.cn) + '</div>' : '') +
        (meta ? '<div class="sentence-meta">' + meta + '</div>' : '') +
        '</div>' +
        '<div class="sentence-actions">' +
        '<button class="icon-btn" data-action="speak" data-text="' + esc(s.text) + '" type="button" aria-label="朗读">' + ICONS.speaker + '</button>' +
        '<button class="icon-btn" data-action="delete-sentence" data-id="' + s.id + '" type="button" aria-label="删除句子">' + ICONS.trash + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
  }

  /* ---------------- 设置 ---------------- */

  function settingsViewHtml() {
    var stats = C.overallStats(state.words);
    var rateChips = [0.5, 0.75, 1, 1.2].map(function (r) {
      return '<button class="rate-chip' + (Number(state.settings.rate) === r ? ' is-active' : '') +
        '" data-action="rate-set" data-rate="' + r + '" type="button">' + r + 'x</button>';
    }).join('');

    var defaultModeChips = C.MODE_IDS.map(function (id) {
      var active = state.settings.defaultModes.indexOf(id) >= 0;
      return '<button class="chip' + (active ? ' is-active' : '') + '" data-action="default-mode" data-mode="' + id + '" type="button">' +
        C.MODES[id].label + '</button>';
    }).join('');
    var mixActive = state.settings.defaultModes.indexOf('mix') >= 0;
    defaultModeChips += '<button class="chip' + (mixActive ? ' is-active' : '') + '" data-action="default-mode" data-mode="mix" type="button">混合</button>';

    var showRows = [
      ['cn', '中文释义', '背诵答完题后显示'],
      ['en', '英文释义', '背诵答完题后显示'],
      ['exEn', '英文例句', '显示单词的例句'],
      ['exCn', '例句翻译', '显示例句的中文翻译']
    ].map(function (item) {
      return '<div class="setting-row"><div><div class="s-label">' + item[1] + '</div>' +
        '<div class="s-sub">' + item[2] + '</div></div>' +
        '<div class="s-control"><label class="switch">' +
        '<input type="checkbox" data-show="' + item[0] + '"' + (state.settings.show[item[0]] ? ' checked' : '') + ' aria-label="' + item[1] + '">' +
        '<span class="track"></span></label></div></div>';
    }).join('');

    var dimRows = C.DIM_IDS.map(function (id) {
      var v = stats.avg[id];
      return '<div class="dim-stat-row"><span class="dim-name">' + C.DIM_LABEL[id] + '</span>' +
        '<span class="dim-line"><span style="width:' + (v || 0) + '%;background:' + dimColor(id) + '"></span></span>' +
        '<b>' + (v === null ? '—' : v) + '</b></div>';
    }).join('');

    return '<div class="view-head"><div><h1>设置</h1><p class="sub">学习计划、显示与数据管理</p></div></div>' +

      '<div class="card settings-card"><h2>学习计划</h2>' +
      '<div class="setting-row"><div><div class="s-label">每日新词数</div><div class="s-sub">作为背诵页的默认值</div></div>' +
      '<div class="s-control"><input class="num-input" id="daily-new" type="number" min="0" inputmode="numeric" value="' + state.settings.dailyNew + '"></div></div>' +
      '<div class="setting-row"><div><div class="s-label">每日复习数</div><div class="s-sub">到期复习词的默认数量</div></div>' +
      '<div class="s-control"><input class="num-input" id="daily-review" type="number" min="0" inputmode="numeric" value="' + state.settings.dailyReview + '"></div></div>' +
      '<div class="setting-row row-wide"><div><div class="s-label">默认抽查方式</div><div class="s-sub">可多选；「混合」按到期维度轮换</div></div>' +
      '<div class="s-control"><div class="mode-chips-sm">' + defaultModeChips + '</div></div></div>' +
      '<div class="setting-row row-wide"><div><div class="s-label">朗读速度</div><div class="s-sub">全部使用浏览器内置英文语音</div></div>' +
      '<div class="s-control"><div class="rate-row">' + rateChips + '</div></div></div>' +
      '<div class="setting-row row-wide"><div><div class="s-label">发音口音</div><div class="s-sub">单词与例句朗读使用所选口音</div></div>' +
      '<div class="s-control"><div class="rate-row">' +
      '<button class="rate-chip' + (state.settings.accent === 'en-US' ? ' is-active' : '') +
      '" data-action="accent-set" data-accent="en-US" type="button">美音</button>' +
      '<button class="rate-chip' + (state.settings.accent === 'en-GB' ? ' is-active' : '') +
      '" data-action="accent-set" data-accent="en-GB" type="button">英音</button>' +
      '</div></div></div>' +
      '</div>' +

      '<div class="card settings-card"><h2>答案显示</h2>' + showRows +
      '<p class="hint" style="padding:0 0 14px">背诵答完题后，按这里的开关显示信息；拼写题必须给出的答案不受影响。</p></div>' +

      '<div class="card settings-card"><h2>掌握度</h2>' +
      '<div class="stats-grid">' +
      '<div class="stat-box"><b>' + stats.total + '</b><span>总词数</span></div>' +
      '<div class="stat-box"><b>' + stats.learned + '</b><span>已学习</span></div>' +
      '<div class="stat-box"><b>' + stats.mastered + '</b><span>已掌握</span></div>' +
      '<div class="stat-box"><b>' + stats.starred + '</b><span>标星</span></div>' +
      '</div>' +
      '<div style="padding:0 0 16px">' +
      '<div class="s-sub" style="margin-bottom:6px">全局三维平均分' + (stats.mastery === null ? '（暂无数据）' : ' · 总掌握度 ' + stats.mastery) + '</div>' +
      dimRows + '</div>' +
      '<div class="setting-row"><div><div class="s-label">今日统计</div><div class="s-sub">新词 ' + state.stats.newWords +
      ' · 复习 ' + state.stats.reviews + ' · 正确率 ' + (state.stats.total ? Math.round(state.stats.right / state.stats.total * 100) + '%' : '—') + '</div></div></div>' +
      '</div>' +

      '<div class="card settings-card"><h2>数据</h2>' +
      '<div class="data-actions">' +
      '<button class="btn btn-ghost" data-action="export-backup" type="button">导出 JSON 备份</button>' +
      '<button class="btn btn-ghost" data-action="import-backup" type="button">导入 JSON 备份</button>' +
      '<button class="btn btn-danger" data-action="clear-all" type="button">清空全部数据</button>' +
      '</div>' +
      '<input type="file" id="backup-file" accept=".json,application/json" hidden>' +
      '<div class="notice"><b>数据只存在当前浏览器</b>（IndexedDB）。换设备、换浏览器或清理缓存前，请先导出备份。应用不上传任何数据，也不需要账号。</div>' +
      backupNoteHtml() +
      '<div style="height:16px"></div></div>';
  }

  function backupNoteHtml() {
    var last = state.settings.lastBackupAt || 0;
    if (!last) {
      return '<div class="backup-note is-warn">还没有导出过备份，建议先导出一份。</div>';
    }
    var days = Math.floor((Date.now() - last) / 86400000);
    var text = '上次导出：' + formatDateTime(last);
    if (days >= 7) {
      return '<div class="backup-note is-warn">' + text + ' · 已超过 7 天，建议尽快再导出一次。</div>';
    }
    return '<div class="backup-note">' + text + '</div>';
  }

  function formatDateTime(ts) {
    var d = new Date(ts);
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toggleDefaultMode(mode) {
    var modes = state.settings.defaultModes.slice();
    if (mode === 'mix') {
      modes = ['mix'];
    } else {
      modes = modes.filter(function (m) { return m !== 'mix'; });
      var idx = modes.indexOf(mode);
      if (idx >= 0) modes.splice(idx, 1);
      else modes.push(mode);
      if (!modes.length) {
        toast('默认方式至少保留一种');
        return;
      }
    }
    state.settings.defaultModes = modes;
    DB.saveSettings(state.settings).then(notifyChange);
    render();
  }

  function setRate(rate) {
    state.settings.rate = Number(rate);
    DB.saveSettings(state.settings).then(notifyChange);
    render();
    toast('朗读速度已设为 ' + rate + 'x');
  }

  function setAccent(accent) {
    state.settings.accent = accent === 'en-GB' ? 'en-GB' : 'en-US';
    DB.saveSettings(state.settings).then(notifyChange);
    render();
    toast(state.settings.accent === 'en-GB' ? '已切换为英音' : '已切换为美音');
  }

  /* ---------------- 弹窗 ---------------- */

  function openModal(html, wide) {
    var root = $('#modal-root');
    root.innerHTML = '<div class="modal-backdrop" data-action="modal-backdrop"><div class="modal' +
      (wide ? ' modal-wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div></div>';
    document.body.classList.add('has-modal');
  }

  function closeModal() {
    var root = $('#modal-root');
    root.innerHTML = '';
    document.body.classList.remove('has-modal');
    pendingConfirm = null;
  }

  function confirmDialog(opts) {
    pendingConfirm = opts.onConfirm || null;
    openModal(
      '<div class="confirm-body"><h2>' + esc(opts.title) + '</h2><p>' + esc(opts.message) + '</p></div>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" data-action="confirm-no" type="button">取消</button>' +
      '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-action="confirm-yes" type="button">' +
      esc(opts.confirmText || '确认') + '</button></div>'
    );
  }

  /* ---------------- 生词本管理 ---------------- */

  function modalHead(title) {
    return '<div class="modal-head"><h2>' + esc(title) + '</h2>' +
      '<button class="icon-btn" data-action="modal-close" type="button" aria-label="关闭">' + ICONS.close + '</button></div>';
  }

  function openBookManager() {
    var counts = C.countByBook(state.words, state.books);
    var rows = state.books.map(function (b) {
      var isDefault = b.id === state.settings.defaultBookId;
      return '<div class="book-row">' +
        '<div class="book-row-main"><div class="book-row-name">' + esc(b.name) +
        (isDefault ? '<span class="default-tag">默认</span>' : '') + '</div>' +
        '<div class="book-row-sub">' + (counts[b.id] || 0) + ' 词' +
        (isDefault ? ' · 新词默认进入' : '') + '</div></div>' +
        '<div class="book-row-actions">' +
        '<button class="btn btn-ghost btn-sm" data-action="book-rename-open" data-id="' + esc(b.id) + '" type="button">重命名</button>' +
        (isDefault ? '' :
          '<button class="btn btn-ghost btn-sm" data-action="book-set-default" data-id="' + esc(b.id) + '" type="button">设为默认</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="book-delete" data-id="' + esc(b.id) + '" type="button">删除</button>') +
        '</div></div>';
    }).join('');
    openModal(
      modalHead('管理生词本') +
      '<div class="book-create-row"><input class="input" id="book-create-name" maxlength="30" autocomplete="off" placeholder="新书名称，例如 雅思核心">' +
      '<button class="btn btn-primary btn-sm" data-action="book-create" type="button">新建</button></div>' +
      '<p class="hint book-manage-hint">默认生词本不可删除；删除其他生词本后，失去全部归属的单词会进入「未分类」，单词与掌握度不受影响。</p>' +
      '<div class="book-manage-list">' + rows + '</div>' +
      '<p class="hint">未分类：' + (counts.uncategorized || 0) + ' 词</p>',
      true
    );
  }

  function openBookRename(id) {
    var b = bookById(id);
    if (!b) return;
    openModal(
      modalHead('重命名生词本') +
      '<form id="book-rename-form" data-book-id="' + esc(b.id) + '">' +
      '<label class="field"><span>名称</span><input class="input" name="name" value="' + esc(b.name) +
      '" maxlength="30" required autocomplete="off"></label>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-close" type="button">取消</button>' +
      '<button class="btn btn-primary" type="submit">保存</button></div></form>'
    );
  }

  function renameBook(id, name) {
    var b = bookById(id);
    if (!b) return;
    b.name = C.uniqueBookName(state.books, name, id);
    DB.putBook(b).then(function () {
      notifyChange();
      openBookManager();
      render();
      toast('已重命名为「' + b.name + '」');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function setDefaultBook(id) {
    if (!bookById(id)) return;
    state.settings.defaultBookId = id;
    DB.saveSettings(state.settings).then(function () {
      notifyChange();
      openBookManager();
      render();
      toast('已设为默认生词本');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function deleteBookRecord(id) {
    var b = bookById(id);
    if (!b) return;
    if (b.id === state.settings.defaultBookId) {
      toast('默认生词本不能删除，可先把其他生词本设为默认', true);
      return;
    }
    var affected = state.words.filter(function (w) {
      return (w.bookIds || []).indexOf(id) >= 0;
    });
    confirmDialog({
      title: '删除「' + b.name + '」？',
      message: '这个生词本会消失；其中 ' + affected.length + ' 个词若没有其他归属，会进入「未分类」。单词与掌握度不会删除。',
      confirmText: '删除',
      danger: true,
      onConfirm: function () {
        affected.forEach(function (w) {
          w.bookIds = (w.bookIds || []).filter(function (x) { return x !== id; });
        });
        var tasks = [DB.deleteBook(id)];
        if (affected.length) tasks.push(DB.putWords(affected));
        Promise.all(tasks).then(function () {
          state.books = state.books.filter(function (x) { return x.id !== id; });
          state.scope = pruneScope(state.scope);
          state.studyScope = pruneScope(state.studyScope);
          notifyChange();
          openBookManager();
          render();
          toast('已删除生词本「' + b.name + '」');
        }).catch(function (err) {
          toast('删除失败：' + (err && err.message ? err.message : '未知错误'), true);
        });
      }
    });
  }

  function createBookFromInput(inputId, after) {
    var el = $('#' + inputId);
    var name = el ? el.value.trim() : '';
    if (!name) {
      toast('请填写生词本名称', true);
      return;
    }
    createBookRecord(name).then(function (book) {
      if (after) after(book);
      else openBookManager();
      toast('已创建「' + book.name + '」');
    }).catch(function (err) {
      toast('创建失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function openBookPicker(op) {
    if (!selectedCount()) return;
    state.pendingBatchOp = op;
    var title = op === 'move' ? '移入生词本' : '复制到生词本';
    var rows = state.books.map(function (b) {
      return '<label class="book-pick-row"><input type="radio" name="target-book" value="' + esc(b.id) + '"' +
        (b.id === state.settings.defaultBookId ? ' checked' : '') + '>' +
        '<span class="book-pick-name">' + esc(b.name) +
        (isDefaultBook(b.id) ? '<span class="default-tag">默认</span>' : '') + '</span></label>';
    }).join('');
    openModal(
      modalHead(title) +
      '<p class="hint">已选 ' + selectedCount() + ' 个词。' +
      (op === 'move'
        ? (state.scope.mode === 'books'
          ? '移入后会从当前范围选中的生词本中移除。'
          : '移入后这些词将只属于目标生词本。')
        : '复制不会影响原有归属。') + '</p>' +
      '<div class="book-pick-list">' + rows + '</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-close" type="button">取消</button>' +
      '<button class="btn btn-primary" data-action="batch-target-confirm" type="button">' + title + '</button></div>'
    );
  }

  function performBatchOp(op, targetId) {
    var target = bookById(targetId);
    if (op !== 'remove' && !target) {
      toast('请选择生词本', true);
      return;
    }
    var words = selectedWords();
    if (!words.length) return;
    var scopeBookIds = state.scope.mode === 'books' ? state.scope.bookIds.slice() : [];
    words.forEach(function (w) {
      if (op === 'copy') {
        w.bookIds = C.applyBookChange(w, 'copy', null, target.id);
      } else if (op === 'move') {
        var ids;
        if (scopeBookIds.length) {
          ids = (w.bookIds || []).filter(function (id) { return scopeBookIds.indexOf(id) < 0; });
          if (ids.indexOf(target.id) < 0) ids.push(target.id);
        } else {
          ids = [target.id];
        }
        w.bookIds = ids;
      } else if (op === 'remove') {
        w.bookIds = [];
      }
    });
    DB.putWords(words).then(function () {
      notifyChange();
      closeModal();
      var msg = op === 'remove'
        ? '已移出到「未分类」'
        : (op === 'move' ? '已移入「' : '已复制到「') + target.name + '」';
      state.batchMode = false;
      state.selectedIds = {};
      state.pendingBatchOp = '';
      document.body.classList.remove('in-batch');
      render();
      toast(msg + '（' + words.length + ' 词）');
    }).catch(function (err) {
      toast('操作失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function setScope(kind, action, id) {
    var key = kind === 'study' ? 'studyScope' : 'scope';
    var scope = state[key];
    if (action === 'all') {
      scope = { mode: 'all', bookIds: [] };
    } else if (action === 'uncat') {
      scope = { mode: 'uncategorized', bookIds: [] };
    } else if (action === 'mistakes') {
      scope = { mode: 'mistakes', bookIds: [] };
    } else if (scope.mode !== 'books') {
      scope = { mode: 'books', bookIds: [id] };
    } else {
      var ids = scope.bookIds.slice();
      var idx = ids.indexOf(id);
      if (idx >= 0) ids.splice(idx, 1);
      else ids.push(id);
      scope = ids.length ? { mode: 'books', bookIds: ids } : { mode: 'all', bookIds: [] };
    }
    state[key] = scope;
    if (kind === 'words' && state.batchMode) state.selectedIds = {};
    render();
  }

  function toggleDetailBook(wordId, bookId) {
    var w = getWord(wordId);
    if (!w) return;
    var on = (w.bookIds || []).indexOf(bookId) >= 0;
    w.bookIds = on
      ? C.applyBookChange(w, 'remove', bookId)
      : C.applyBookChange(w, 'copy', null, bookId);
    DB.putWord(w).then(function () {
      notifyChange();
      openWordDetail(wordId);
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  /* ---------------- 添加 / 详情 ---------------- */

  function openAddWord() {
    openModal(
      '<div class="modal-head"><h2>添加单词</h2>' +
      '<button class="icon-btn" data-action="modal-close" type="button" aria-label="关闭">' + ICONS.close + '</button></div>' +
      '<form id="add-form" class="form-grid">' +
      '<label class="field"><span>单词或短语 *</span><input class="input" name="word" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="例如 abandon"></label>' +
      '<label class="field"><span>词性（选填）</span><input class="input" name="pos" list="pos-options" autocomplete="off" placeholder="例如 n. / v. / adj."></label>' + posOptionsHtml() +
      '<label class="field"><span>中文释义</span><input class="input" name="cn" autocomplete="off" placeholder="例如 放弃；抛弃"></label>' +
      '<label class="field"><span>英文释义</span><textarea class="textarea" name="en" rows="2" placeholder="例如 to leave somebody behind"></textarea></label>' +
      '<label class="field"><span>生词本</span><select class="select" name="bookId">' +
      bookOptionsHtml(state.settings.defaultBookId) + '</select></label>' +
      '<div class="field"><span>例句（选填）</span>' +
      '<input class="input" name="exEn" autocomplete="off" placeholder="英文例句">' +
      '<input class="input" name="exCn" autocomplete="off" placeholder="例句中文翻译（选填）" style="margin-top:8px"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-close" type="button">取消</button>' +
      '<button class="btn btn-primary" type="submit">保存</button></div></form>'
    );
  }

  function openWordDetail(id) {
    var w = getWord(id);
    if (!w) return;
    var scores = C.wordScores(w);
    var level = C.masteryLevel(C.wordMastery(w));
    var rows = C.DIM_IDS.map(function (dim) {
      var v = scores[dim];
      return '<div class="mastery-row"><span class="m-name">' + C.DIM_LABEL[dim] + '</span>' +
        '<span class="m-bar"><span style="width:' + (v || 0) + '%;background:' + dimColor(dim) + '"></span></span>' +
        '<b>' + (v === null ? '未测' : v + ' 分') + '</b></div>';
    }).join('');
    var exs = (w.examples || []).map(function (ex) {
      return '<div class="ex-row">' +
        '<div class="ex-main">' +
        '<div class="ex-en">' + esc(ex.en || ex.cn) + '</div>' +
        (ex.en && ex.cn ? '<div class="ex-cn">' + esc(ex.cn) + '</div>' : '') +
        '</div>' +
        '<button class="icon-btn" data-action="speak" data-text="' + esc(ex.en || ex.cn) + '" type="button" aria-label="朗读例句">' + ICONS.speaker + '</button>' +
        '<button class="icon-btn" data-action="ex-to-sentence" data-id="' + w.id + '" data-ex="' + ex.id + '" type="button" aria-label="加入句子收藏">★</button>' +
        '<button class="icon-btn" data-action="ex-delete" data-id="' + w.id + '" data-ex="' + ex.id + '" type="button" aria-label="删除例句">' + ICONS.close + '</button>' +
        '</div>';
    }).join('');
    var senseRows = (w.senses || []).map(function (sense) {
      return '<div class="sense-row">' +
        (sense.pos ? '<span class="pos-tag">' + esc(sense.pos) + '</span>' : '') +
        '<span class="sense-cn">' + esc(sense.cn) + '</span></div>';
    }).join('');
    var phraseRows = (w.phrases || []).map(function (p) {
      return '<div class="phrase-row"><span class="phrase-en">' + esc(p.en || p.cn) + '</span>' +
        (p.en && p.cn ? '<span class="phrase-cn">' + esc(p.cn) + '</span>' : '') +
        (p.en ? '<button class="icon-btn" data-action="speak" data-text="' + esc(p.en) + '" type="button" aria-label="朗读搭配">' + ICONS.speaker + '</button>' : '') +
        '</div>';
    }).join('');
    var synChips = (w.synonyms || []).map(function (s) {
      return '<span class="tag">' + esc(s) + '</span>';
    }).join('');
    var antChips = (w.antonyms || []).map(function (s) {
      return '<span class="tag">' + esc(s) + '</span>';
    }).join('');
    var extraBlock = '<div class="detail-extra">' +
      (w.roots ? '<div class="extra-row"><span class="extra-k">词根词缀</span><span class="extra-v">' + esc(w.roots) + '</span></div>' : '') +
      (phraseRows ? '<div class="extra-row"><span class="extra-k">常见搭配</span><div class="extra-v">' + phraseRows + '</div></div>' : '') +
      (synChips || antChips ? '<div class="extra-row"><span class="extra-k">同义 / 反义</span><div class="extra-v"><div class="tag-line">' +
        (synChips ? '<span class="tag-label">同</span>' + synChips : '') +
        (antChips ? '<span class="tag-label">反</span>' + antChips : '') + '</div></div></div>' : '') +
      '</div>';
    var phraseLines = (w.phrases || []).map(function (p) {
      return [p.en, p.cn].filter(Boolean).join(' | ');
    }).join('\n');
    var bookChips = state.books.map(function (b) {
      var on = (w.bookIds || []).indexOf(b.id) >= 0;
      return '<button class="book-chip' + (on ? ' is-active' : '') + '" data-action="detail-book-toggle" data-id="' + w.id +
        '" data-book="' + b.id + '" type="button">' + esc(b.name) +
        (isDefaultBook(b.id) ? '<span class="default-tag">默认</span>' : '') + '</button>';
    }).join('');
    var totalWrong = 0;
    var modeRows = C.wordModeStats(w).map(function (stat) {
      totalWrong += stat.wrong;
      return '<div class="mode-stat-row"><span class="ms-name">' + esc(stat.label) + '</span>' +
        '<span class="ms-dim">' + C.DIM_LABEL[stat.dim] + '</span>' +
        '<span class="ms-num' + (stat.wrong ? ' is-wrong' : '') + '">错 ' + stat.wrong + '</span>' +
        '<span class="ms-num">对 ' + stat.right + '</span></div>';
    }).join('');
    var modeBlock = modeRows
      ? '<div class="mode-stat-block"><div class="mode-stat-head"><span class="section-title">各考查方式错误次数</span>' +
        '<span class="hint">累计错 ' + totalWrong + ' 次</span></div>' + modeRows + '</div>'
      : '';

    openModal(
      '<div class="modal-head"><h2>单词详情</h2>' +
      '<button class="icon-btn" data-action="modal-close" type="button" aria-label="关闭">' + ICONS.close + '</button></div>' +
      '<div class="detail-word">' + esc(w.word) +
      (w.phonetic ? '<span class="phonetic">' + esc(w.phonetic) + '</span>' : '') +
      (w.pos ? '<span class="pos-tag">' + esc(w.pos) + '</span>' : '') +
      '<span class="badge badge-' + level.key + '">' + level.label + '</span>' +
      '<button class="icon-btn" data-action="speak" data-text="' + esc(w.word) + '" type="button" aria-label="朗读单词">' + ICONS.speaker + '</button></div>' +
      '<div class="detail-meta">添加于 ' + fmtDate(w.createdAt) + ' · 开始学习 ' + fmtDate(w.startedAt) +
      ' · 星标 ' + (w.starred ? '是' : '否') + '</div>' +
      (senseRows ? '<div class="sense-block"><div class="sense-head">释义分条<span class="hint">共 ' +
        (w.senses || []).length + ' 条</span></div>' + senseRows + '</div>' : '') +
      extraBlock +
      '<div class="detail-books"><div class="detail-books-head">所属生词本<span class="hint">点击切换归属</span></div>' +
      '<div class="book-wrap">' + bookChips + '</div>' +
      ((w.bookIds || []).length ? '' : '<p class="hint">当前未分类</p>') + '</div>' +
      modeBlock +
      '<div class="mastery-block">' + rows + '</div>' +
      '<form id="detail-form" data-word-id="' + w.id + '">' +
      '<label class="field"><span>单词或短语</span><input class="input" name="word" value="' + esc(w.word) + '" required autocomplete="off"></label>' +
      '<label class="field"><span>词性</span><input class="input" name="pos" list="pos-options" value="' + esc(w.pos) + '" autocomplete="off" placeholder="例如 n. / v. / adj."></label>' + posOptionsHtml() +
      '<label class="field"><span>中文释义</span><input class="input" name="cn" value="' + esc(w.cn) + '" autocomplete="off">' +
      '<span class="field-hint">多个义项用 | 或 ；分隔，可带词性前缀，如：n. 焦虑 | v. 使焦虑</span></label>' +
      '<label class="field"><span>音标</span><input class="input" name="phonetic" value="' + esc(w.phonetic) + '" autocomplete="off" placeholder="例如 /əˈbændən/"></label>' +
      '<label class="field"><span>词根词缀</span><input class="input" name="roots" value="' + esc(w.roots) + '" autocomplete="off" placeholder="例如 ab-（离开）+ andon（控制）"></label>' +
      '<label class="field"><span>常见搭配</span><textarea class="textarea" name="phrases" rows="2" placeholder="每行一条，例如：abandon oneself to | 沉溺于">' + esc(phraseLines) + '</textarea></label>' +
      '<label class="field"><span>同义词</span><input class="input" name="synonyms" value="' + esc((w.synonyms || []).join('，')) + '" autocomplete="off" placeholder="用逗号分隔"></label>' +
      '<label class="field"><span>反义词</span><input class="input" name="antonyms" value="' + esc((w.antonyms || []).join('，')) + '" autocomplete="off" placeholder="用逗号分隔"></label>' +
      '<label class="field"><span>英文释义</span><textarea class="textarea" name="en" rows="2">' + esc(w.en) + '</textarea></label>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-close" type="button">取消</button>' +
      '<button class="btn btn-primary" type="submit">保存修改</button></div></form>' +
      '<div class="ex-block"><div class="ex-block-head"><span class="section-title">例句</span>' +
      '<span class="hint">点 ★ 加入句子收藏</span></div>' +
      (exs || '<p class="hint" style="padding-bottom:6px">还没有例句。</p>') +
      '<div class="ex-add">' +
      '<input class="input" id="new-ex-en" placeholder="英文例句" autocomplete="off">' +
      '<input class="input" id="new-ex-cn" placeholder="中文翻译（选填）" autocomplete="off">' +
      '<div class="ex-add-row"><span class="hint">例句可点朗读</span>' +
      '<button class="btn btn-ghost btn-sm" data-action="ex-add" data-id="' + w.id + '" type="button">添加例句</button></div>' +
      '</div></div>' +
      '<div class="detail-danger"><button class="btn btn-danger btn-block" data-action="delete-word" data-id="' + w.id + '" type="button">删除这个单词</button></div>',
      true
    );
  }

  /* ---------------- 学习报告 ---------------- */

  function openReport(days) {
    state.reportDays = Number(days) === 30 ? 30 : 7;
    var data = C.reportData(state.words, statsRows(), state.reportDays);
    var streak = C.streakDays(statsRows());
    var maxTotal = data.trend.reduce(function (max, d) { return Math.max(max, d.total); }, 0);
    var chart = data.trend.map(function (d) {
      var h = maxTotal ? Math.round((d.total / maxTotal) * 100) : 0;
      var label = state.reportDays === 7 ? d.date.slice(5) : '';
      return '<div class="report-bar-wrap" title="' + d.date + ' · ' + d.total + ' 题">' +
        '<div class="report-bar-track"><div class="report-bar-fill" style="height:' + h + '%"></div></div>' +
        '<span class="report-bar-label">' + esc(label) + '</span></div>';
    }).join('');
    var modeRows = data.modes.length ? data.modes.map(function (m) {
      var acc = m.total ? Math.round((m.right / m.total) * 100) : 0;
      return '<div class="report-mode-row"><div class="rm-head"><span class="rm-name">' + esc(m.label) + '</span>' +
        '<span class="rm-num">对 ' + m.right + ' · 错 ' + m.wrong + ' · ' + acc + '%</span></div>' +
        '<div class="rm-track"><div class="rm-fill" style="width:' + acc + '%"></div></div></div>';
    }).join('') : '<p class="hint">这段时间还没有答题记录。</p>';
    var mistakeRows = data.mistakes.length ? data.mistakes.map(function (m, idx) {
      return '<div class="report-mistake-row"><span class="rm-rank">' + (idx + 1) + '</span>' +
        '<button class="rm-word" data-action="detail" data-id="' + m.wordId + '" type="button">' + esc(m.word) + '</button>' +
        '<span class="rm-count">错 ' + m.wrong + ' 次 / 共 ' + m.total + ' 次</span>' +
        '<button class="icon-btn" data-action="speak" data-text="' + esc(m.word) + '" type="button" aria-label="朗读">' + ICONS.speaker + '</button></div>';
    }).join('') : '<p class="hint">这段时间没有错题，保持住。</p>';

    openModal(
      '<div class="modal-head"><h2>学习报告</h2>' +
      '<button class="icon-btn" data-action="modal-close" type="button" aria-label="关闭">' + ICONS.close + '</button></div>' +
      '<div class="report-tabs">' +
      '<button class="report-tab' + (state.reportDays === 7 ? ' is-active' : '') + '" data-action="report-days" data-days="7" type="button">近 7 天</button>' +
      '<button class="report-tab' + (state.reportDays === 30 ? ' is-active' : '') + '" data-action="report-days" data-days="30" type="button">近 30 天</button>' +
      '</div>' +
      '<div class="report-range">' + fmtDate(C.dayKeyToDate(data.start)) + ' — ' + fmtDate(C.dayKeyToDate(data.end)) + '</div>' +
      '<div class="report-grid">' +
      '<div class="report-stat"><b>' + data.total + '</b><span>答题总数</span></div>' +
      '<div class="report-stat"><b>' + data.accuracy + '%</b><span>正确率</span></div>' +
      '<div class="report-stat"><b>' + data.newWords + '</b><span>新学单词</span></div>' +
      '<div class="report-stat"><b>' + data.reviews + '</b><span>复习次数</span></div>' +
      '<div class="report-stat"><b>' + data.activeDays + '</b><span>活跃天数</span></div>' +
      '<div class="report-stat"><b>' + streak + '</b><span>连续打卡</span></div>' +
      '</div>' +
      '<div class="report-section"><h3>每日答题</h3><div class="report-chart">' + chart + '</div></div>' +
      '<div class="report-section"><h3>各考查方式</h3>' + modeRows + '</div>' +
      '<div class="report-section"><h3>错词 TOP</h3>' + mistakeRows + '</div>',
      true
    );
  }

  /* ---------------- 导入 ---------------- */

  function openImport() {
    state.importEntries = [];
    state.importPlan = null;
    state.importSource = '';
    state.importTab = 'file';
    state.importBookId = bookById(state.settings.defaultBookId) ? state.settings.defaultBookId : (state.books[0] && state.books[0].id);
    openModal(
      '<div class="modal-head"><h2>导入词表</h2>' +
      '<button class="icon-btn" data-action="modal-close" type="button" aria-label="关闭">' + ICONS.close + '</button></div>' +
      '<div class="import-tabs">' +
      '<button data-action="import-tab" data-import-tab="file" class="is-active" type="button">文件</button>' +
      '<button data-action="import-tab" data-import-tab="paste" type="button">粘贴文本</button>' +
      '</div>' +
      '<div id="import-file-pane">' +
      '<label class="file-drop" for="import-file">' +
      '<strong>选择 .md / .txt / .docx / .pdf 文件</strong>' +
      '<span>docx 与 pdf 在浏览器内解析，pdf 仅保证文本型</span></label>' +
      '<input class="import-file-input" id="import-file" type="file" accept=".md,.markdown,.txt,.docx,.pdf">' +
      '<p class="hint" style="margin-top:10px">每行一条，列序：单词 · 词性（选填）· 中文释义 · 英文释义 · 例句。支持制表符、Markdown 表格、「单词 - 中文」等格式。</p>' +
      '</div>' +
      '<div id="import-paste-pane" hidden>' +
      '<div class="import-paste"><textarea class="textarea" id="import-text" placeholder="每行一条，例如：&#10;abandon\tv.\t放弃；抛弃\tto leave somebody behind\tHe abandoned his car.\t他把车丢在了雪地里。"></textarea></div>' +
      '<p class="hint" style="margin-top:8px">无法上传文件时，可直接粘贴文本。列之间用制表符或多个空格分隔。</p>' +
      '</div>' +
      '<div class="import-book">' +
      '<label class="field"><span>导入到生词本</span><select class="select" id="import-book">' +
      bookOptionsHtml(state.importBookId) + '</select></label>' +
      '<button class="btn btn-ghost btn-sm" data-action="import-new-book" type="button">新建生词本</button>' +
      '</div>' +
      '<div class="import-new-book" id="import-new-book" hidden>' +
      '<input class="input" id="import-book-name" maxlength="30" autocomplete="off" placeholder="新书名称，例如 考研核心">' +
      '<button class="btn btn-primary btn-sm" data-action="import-create-book" type="button">创建并选择</button>' +
      '</div>' +
      '<div class="import-status" id="import-status"></div>' +
      '<div id="import-preview"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="import-parse" type="button">解析预览</button>' +
      '<button class="btn btn-primary" data-action="import-confirm" id="import-confirm-btn" type="button" disabled>确认导入</button></div>'
    );
  }

  function setImportStatus(text, isError) {
    var el = $('#import-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  function parseImport(sourceText, sourceName) {
    state.importSource = sourceName || '';
    state.importEntries = C.parseImportText(sourceText || '');
    updateImportPreview(true);
  }

  function updateImportPreview(announce) {
    var previewEl = $('#import-preview');
    var confirmBtn = $('#import-confirm-btn');
    if (!previewEl || !confirmBtn) return;
    var target = bookById(state.importBookId) || bookById(state.settings.defaultBookId) || state.books[0];
    if (!target) {
      setImportStatus('还没有生词本，请先新建一个。', true);
      previewEl.innerHTML = '';
      confirmBtn.disabled = true;
      return;
    }
    state.importBookId = target.id;
    var entries = state.importEntries;
    if (!entries.length) {
      if (announce) {
        setImportStatus('没有解析到有效词条。请确认每条记录以英文单词开头，并包含中文释义或英文释义。', true);
      }
      previewEl.innerHTML = '';
      confirmBtn.disabled = true;
      confirmBtn.textContent = '确认导入';
      return;
    }
    var plan = C.importPlan(state.words, entries, target.id);
    state.importPlan = plan;
    var total = plan.counts.new + plan.counts.join;
    if (announce) {
      setImportStatus((state.importSource ? '已读取：' + state.importSource + '。' : '') +
        '将导入到「' + target.name + '」；新词 ' + plan.counts.new + ' 个，已存在并加入本 ' +
        plan.counts.join + ' 个，已在本中跳过 ' + plan.counts.skip + ' 个。');
    }
    previewEl.innerHTML = previewHtml(plan);
    confirmBtn.disabled = total === 0;
    confirmBtn.textContent = total
      ? '确认导入（新增 ' + plan.counts.new + ' · 加入 ' + plan.counts.join + '）'
      : '没有需要导入的词';
  }

  function previewHtml(plan) {
    var statusLabel = { new: '新词', join: '加入本', skip: '已在本' };
    var rows = plan.rows.slice(0, 30).map(function (r) {
      var e = r.entry || {};
      return '<tr><td><span class="preview-status is-' + r.status + '">' + statusLabel[r.status] + '</span></td>' +
        '<td>' + esc(e.word) + '</td><td>' + esc(e.pos) + '</td><td>' + esc(e.cn) + '</td><td>' + esc(e.en) +
        '</td><td>' + esc(e.exampleEn || e.exampleCn) + '</td></tr>';
    }).join('');
    return '<div class="preview-summary"><span>共 <b>' + plan.rows.length + '</b> 条</span>' +
      '<span>新词 <b>' + plan.counts.new + '</b></span>' +
      '<span>加入本 <b>' + plan.counts.join + '</b></span>' +
      '<span>已在本跳过 <b>' + plan.counts.skip + '</b></span></div>' +
      '<div class="preview-wrap"><table class="preview-table"><thead><tr>' +
      '<th>状态</th><th>单词</th><th>词性</th><th>中文</th><th>英文</th><th>例句</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      (plan.rows.length > 30 ? '<div class="preview-more">仅显示前 30 条，导入时会包含全部 ' + plan.rows.length + ' 条。</div>' : '') +
      '</div>';
  }

  function confirmImport() {
    var plan = state.importPlan;
    var target = bookById(state.importBookId);
    if (!plan || !target) return;
    if (!plan.counts.new && !plan.counts.join) return;
    var now = Date.now();
    var fresh = [];
    var joins = [];
    plan.rows.forEach(function (r) {
      if (r.status === 'new') {
        var e = r.entry || {};
        var examples = [];
        if (e.exampleEn || e.exampleCn) {
          examples.push({ id: uid(), en: e.exampleEn || '', cn: e.exampleCn || '' });
        }
        fresh.push(normalizeWordRecord({
          id: uid(),
          word: e.word,
          pos: e.pos || '',
          cn: e.cn || '',
          en: e.en || '',
          bookIds: [target.id],
          examples: examples,
          createdAt: now,
          startedAt: null,
          dims: {}
        }));
      } else if (r.status === 'join' && r.word) {
        r.word.bookIds = C.applyBookChange(r.word, 'copy', null, target.id);
        joins.push(r.word);
      }
    });
    var tasks = [];
    if (fresh.length) tasks.push(DB.putWords(fresh));
    if (joins.length) tasks.push(DB.putWords(joins));
    Promise.all(tasks).then(function () {
      state.words = state.words.concat(fresh);
      notifyChange();
      closeModal();
      state.tab = 'words';
      state.scope = { mode: 'books', bookIds: [target.id] };
      render();
      toast('已导入 ' + fresh.length + ' 个新词，' + joins.length + ' 个加入「' + target.name + '」');
    }).catch(function (err) {
      setImportStatus('写入本地数据库失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function handleImportFile(file) {
    if (!file) return;
    setImportStatus('正在读取并解析 ' + file.name + ' ...');
    $('#import-preview').innerHTML = '';
    $('#import-confirm-btn').disabled = true;
    readFileText(file).then(function (text) {
      parseImport(text, file.name);
    }).catch(function (err) {
      setImportStatus(err && err.message ? err.message : '文件解析失败，请改用「粘贴文本」。', true);
    });
  }

  function readFileText(file) {
    var name = String(file.name || '').toLowerCase();
    if (/\.(txt|md|markdown)$/.test(name)) {
      return file.text();
    }
    if (/\.docx$/.test(name)) {
      return loadMammoth().then(function (mammoth) {
        return file.arrayBuffer().then(function (buf) {
          return mammoth.extractRawText({ arrayBuffer: buf });
        });
      }).then(function (result) {
        return result.value || '';
      });
    }
    if (/\.pdf$/.test(name)) {
      return loadPdfJs().then(function (pdfjs) {
        return pdfToText(pdfjs, file);
      });
    }
    return Promise.reject(new Error('不支持的文件类型，请选择 .md / .txt / .docx / .pdf，或使用「粘贴文本」。'));
  }

  /* ---------------- CDN 加载 ---------------- */

  var MAMMOTH_CDNS = [
    'https://cdn.jsdelivr.net/npm/mammoth@1.6.0/mammoth.browser.min.js',
    'https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js',
    'https://cdn.bootcdn.net/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js'
  ];

  var PDF_CDNS = [
    {
      js: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
      worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
    },
    {
      js: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
      worker: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
    },
    {
      js: 'https://cdn.bootcdn.net/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      worker: 'https://cdn.bootcdn.net/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    }
  ];

  function loadScript(url, timeout) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        script.remove();
        reject(new Error('加载超时'));
      }, timeout || 12000);
      script.src = url;
      script.async = true;
      script.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      script.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        script.remove();
        reject(new Error('加载失败'));
      };
      document.head.appendChild(script);
    });
  }

  function loadMammoth() {
    if (window.mammoth) return Promise.resolve(window.mammoth);
    var chain = Promise.reject(new Error('init'));
    MAMMOTH_CDNS.forEach(function (url) {
      chain = chain.catch(function () {
        return loadScript(url).then(function () {
          if (!window.mammoth) throw new Error('mammoth 未就绪');
          return window.mammoth;
        });
      });
    });
    return chain.catch(function () {
      throw new Error('docx 解析库加载失败（已尝试 jsdelivr / unpkg / bootcdn）。请检查网络，或改用「粘贴文本」。');
    });
  }

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    var chain = Promise.reject(new Error('init'));
    PDF_CDNS.forEach(function (cdn) {
      chain = chain.catch(function () {
        return loadScript(cdn.js).then(function () {
          if (!window.pdfjsLib) throw new Error('pdfjs 未就绪');
          try {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = cdn.worker;
          } catch (err) { /* 忽略 worker 设置失败，pdf.js 会自行降级 */ }
          return window.pdfjsLib;
        });
      });
    });
    return chain.catch(function () {
      throw new Error('PDF 解析库加载失败（已尝试 jsdelivr / unpkg / bootcdn）。请检查网络，或改用「粘贴文本」。');
    });
  }

  function pdfToText(pdfjs, file) {
    return file.arrayBuffer().then(function (buffer) {
      return pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    }).then(function (doc) {
      var lines = [];
      var pageChain = Promise.resolve();
      var total = doc.numPages;
      for (var p = 1; p <= total; p++) {
        (function (pageNumber) {
          pageChain = pageChain.then(function () {
            return doc.getPage(pageNumber).then(function (page) {
              return page.getTextContent().then(function (content) {
                var rows = {};
                content.items.forEach(function (item) {
                  if (!item || !item.str || !item.str.trim()) return;
                  var y = Math.round(item.transform[5] / 3) * 3;
                  rows[y] = rows[y] || [];
                  rows[y].push({
                    x: item.transform[4],
                    w: item.width || 0,
                    s: item.str
                  });
                });
                Object.keys(rows).map(Number).sort(function (a, b) { return b - a; }).forEach(function (y) {
                  var parts = rows[y].sort(function (a, b) { return a.x - b.x; });
                  var line = '';
                  var prevEnd = null;
                  parts.forEach(function (part) {
                    if (prevEnd !== null) {
                      var gap = part.x - prevEnd;
                      if (gap > 14) line += '\t';
                      else if (gap > 1.6) line += ' ';
                    }
                    line += part.s;
                    prevEnd = part.x + part.w;
                  });
                  line = line.replace(/[ \t]+$/, '');
                  if (line.trim()) lines.push(line);
                });
              });
            });
          });
        })(p);
      }
      return pageChain.then(function () { return lines.join('\n'); });
    });
  }

  /* ---------------- 数据备份 ---------------- */

  function exportBackup() {
    state.settings.lastBackupAt = Date.now();
    var payload = {
      app: '拾词',
      version: 2,
      exportedAt: new Date().toISOString(),
      books: state.books,
      words: state.words,
      sentences: state.sentences,
      settings: state.settings
    };
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '拾词备份-' + C.todayKey() + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      DB.saveSettings(state.settings).then(notifyChange);
      render();
      toast('备份已导出');
    } catch (err) {
      toast('导出失败：' + (err && err.message ? err.message : '未知错误'), true);
    }
  }

  function handleBackupFile(file) {
    if (!file) return;
    file.text().then(function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        toast('备份文件不是有效的 JSON', true);
        return;
      }
      var incomingWords = Array.isArray(data.words) ? data.words : [];
      var incomingSentences = Array.isArray(data.sentences) ? data.sentences : [];
      var incomingBooks = Array.isArray(data.books) ? data.books : [];
      if (!incomingWords.length && !incomingSentences.length) {
        toast('备份里没有可导入的数据', true);
        return;
      }
      var wordMerge = C.mergeWords(state.words, incomingWords);
      var bookAdded = C.mergeBooks(state.books, incomingBooks, C.DEFAULT_BOOK_ID).added.length;
      confirmDialog({
        title: '导入这份备份？',
        message: '备份包含 ' + incomingWords.length + ' 个单词、' + incomingSentences.length +
          ' 条句子收藏、' + incomingBooks.length + ' 个生词本。将新增 ' + wordMerge.added.length +
          ' 个单词、' + bookAdded + ' 个生词本，已存在的 ' + wordMerge.skipped + ' 个单词会自动跳过。',
        confirmText: '合并导入',
        onConfirm: function () { mergeBackup(incomingWords, incomingSentences, incomingBooks); }
      });
    }).catch(function (err) {
      toast('读取备份失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function mergeBackup(incomingWords, incomingSentences, incomingBooks) {
    var bookMerge = C.mergeBooks(state.books, incomingBooks || [], C.DEFAULT_BOOK_ID);
    var nextBooks = state.books.concat(bookMerge.added);
    var validIds = nextBooks.map(function (b) { return b.id; });
    var wordMerge = C.mergeWords(state.words, incomingWords);
    var sentenceMerge = C.mergeSentences(state.sentences, incomingSentences);
    var usedIds = {};
    state.words.forEach(function (w) { usedIds[w.id] = true; });
    var addedWords = wordMerge.added.map(function (raw) {
      var w = normalizeWordRecord(raw);
      w.bookIds = C.remapBookIds(raw && raw.bookIds, bookMerge.idMap, validIds, state.settings.defaultBookId);
      if (usedIds[w.id]) w.id = uid();
      usedIds[w.id] = true;
      return w;
    });
    var addedSentences = sentenceMerge.added.map(function (raw) {
      var s = normalizeSentenceRecord(raw);
      var used = state.sentences.some(function (x) { return x.id === s.id; });
      if (used) s.id = uid();
      return s;
    });
    Promise.all([
      DB.putBooks(bookMerge.added),
      DB.putWords(addedWords),
      DB.putSentences(addedSentences)
    ]).then(function () {
      state.books = nextBooks;
      state.words = state.words.concat(addedWords);
      state.sentences = state.sentences.concat(addedSentences);
      notifyChange();
      render();
      toast('已合并 ' + addedWords.length + ' 个单词、' + addedSentences.length + ' 条句子、' +
        bookMerge.added.length + ' 个生词本');
    }).catch(function (err) {
      toast('导入失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function clearAllData() {
    confirmDialog({
      title: '清空全部数据？',
      message: '所有单词、例句、句子收藏和学习记录都会被删除，无法恢复。建议先导出备份。',
      confirmText: '继续',
      danger: true,
      onConfirm: function () {
        confirmDialog({
          title: '再次确认',
          message: '这一步不可撤销。确定要清空全部数据吗？',
          confirmText: '确认清空',
          danger: true,
          onConfirm: function () {
            DB.clearAll().then(function () {
              state.words = [];
              state.sentences = [];
              state.settings = normalizeSettings(null);
              state.stats = C.freshDailyStats();
              state.statsHistory = [];
              state.modes = state.settings.defaultModes.slice();
              state.newLimit = state.settings.dailyNew;
              state.reviewLimit = state.settings.dailyReview;
              state.scope = { mode: 'all', bookIds: [] };
              state.studyScope = { mode: 'all', bookIds: [] };
              state.batchMode = false;
              state.selectedIds = {};
              state.importBookId = state.settings.defaultBookId;
              document.body.classList.remove('in-batch');
              state.books = [{ id: C.DEFAULT_BOOK_ID, name: C.DEFAULT_BOOK_NAME, createdAt: Date.now() }];
              return Promise.all([DB.saveSettings(state.settings), DB.putBook(state.books[0])]);
            }).then(function () {
              notifyChange();
              render();
              toast('已清空全部数据');
            }).catch(function (err) {
              toast('清空失败：' + (err && err.message ? err.message : '未知错误'), true);
            });
          }
        });
      }
    });
  }

  /* ---------------- 事件 ---------------- */

  function addWordFromForm(form) {
    var data = new FormData(form);
    var word = String(data.get('word') || '').trim();
    var cn = String(data.get('cn') || '').trim();
    var en = String(data.get('en') || '').trim();
    var posRaw = String(data.get('pos') || '').trim();
    var pos = C.parsePos(posRaw) || posRaw;
    var exEn = String(data.get('exEn') || '').trim();
    var exCn = String(data.get('exCn') || '').trim();
    var bookId = String(data.get('bookId') || '') || state.settings.defaultBookId;
    if (!bookById(bookId)) bookId = state.settings.defaultBookId;
    if (!word) {
      toast('请填写单词', true);
      return;
    }
    var existing = state.words.filter(function (w) {
      return C.normalizeWord(w.word) === C.normalizeWord(word);
    })[0];
    if (existing) {
      if ((existing.bookIds || []).indexOf(bookId) >= 0) {
        toast('「' + bookName(bookId) + '」里已经有这个词了', true);
        return;
      }
      existing.bookIds = C.applyBookChange(existing, 'copy', null, bookId);
      DB.putWord(existing).then(function () {
        notifyChange();
        closeModal();
        render();
        toast('已加入「' + bookName(bookId) + '」');
      }).catch(function (err) {
        toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
      });
      return;
    }
    var now = Date.now();
    var record = normalizeWordRecord({
      id: uid(),
      word: word,
      pos: pos,
      cn: cn,
      en: en,
      bookIds: [bookId],
      examples: (exEn || exCn) ? [{ id: uid(), en: exEn, cn: exCn }] : [],
      createdAt: now,
      startedAt: null,
      dims: {}
    });
    DB.putWord(record).then(function () {
      state.words.unshift(record);
      notifyChange();
      closeModal();
      state.tab = 'words';
      render();
      toast('已添加「' + record.word + '」');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function saveDetail(id, form) {
    var w = getWord(id);
    if (!w) return;
    var data = new FormData(form);
    var word = String(data.get('word') || '').trim();
    if (!word) {
      toast('单词不能为空', true);
      return;
    }
    var duplicate = state.words.some(function (other) {
      return other.id !== w.id && C.normalizeWord(other.word) === C.normalizeWord(word);
    });
    if (duplicate) {
      toast('词库里已经有这个词了', true);
      return;
    }
    w.word = word;
    var posRaw = String(data.get('pos') || '').trim();
    w.pos = C.parsePos(posRaw) || posRaw;
    w.cn = String(data.get('cn') || '').trim();
    w.senses = C.parseSenses(w.cn).map(function (s) {
      return { id: uid(), pos: s.pos, cn: s.cn };
    });
    w.phonetic = String(data.get('phonetic') || '').trim();
    w.roots = String(data.get('roots') || '').trim();
    w.phrases = String(data.get('phrases') || '').split('\n').map(function (line) {
      var text = String(line || '').trim();
      if (!text) return null;
      var parts = text.split(/\s*[|｜]\s*/);
      var en = String(parts[0] || '').trim();
      var cn = String(parts.slice(1).join(' ') || '').trim();
      if (!en && !cn) return null;
      return { id: uid(), en: en, cn: cn };
    }).filter(Boolean);
    w.synonyms = splitWordList(data.get('synonyms'));
    w.antonyms = splitWordList(data.get('antonyms'));
    w.en = String(data.get('en') || '').trim();
    DB.putWord(w).then(function () {
      notifyChange();
      closeModal();
      render();
      toast('已保存修改');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function addSentence(form) {
    var data = new FormData(form);
    var text = String(data.get('text') || '').trim();
    var cn = String(data.get('cn') || '').trim();
    var link = String(data.get('word') || '').trim();
    if (!text) {
      toast('句子不能为空', true);
      return;
    }
    var linked = state.words.filter(function (w) {
      return C.normalizeWord(w.word) === C.normalizeWord(link);
    })[0];
    var sentence = {
      id: uid(),
      text: text,
      cn: cn,
      wordId: linked ? linked.id : null,
      word: link,
      createdAt: Date.now()
    };
    DB.putSentence(sentence).then(function () {
      state.sentences.unshift(sentence);
      notifyChange();
      render();
      toast('已加入句子收藏');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function deleteSentence(id) {
    DB.deleteSentence(id).then(function () {
      state.sentences = state.sentences.filter(function (s) { return s.id !== id; });
      notifyChange();
      render();
      toast('已删除句子');
    }).catch(function (err) {
      toast('删除失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function addExample(wordId) {
    var w = getWord(wordId);
    if (!w) return;
    var enEl = $('#new-ex-en');
    var cnEl = $('#new-ex-cn');
    var en = enEl ? enEl.value.trim() : '';
    var cn = cnEl ? cnEl.value.trim() : '';
    if (!en && !cn) {
      toast('先写一句例句');
      return;
    }
    w.examples = w.examples || [];
    w.examples.push({ id: uid(), en: en, cn: cn });
    DB.putWord(w).then(function () {
      notifyChange();
      openWordDetail(w.id);
      toast('已添加例句');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function deleteExample(wordId, exampleId) {
    var w = getWord(wordId);
    if (!w) return;
    w.examples = (w.examples || []).filter(function (ex) { return ex.id !== exampleId; });
    DB.putWord(w).then(function () {
      notifyChange();
      openWordDetail(w.id);
      toast('已删除例句');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function exampleToSentence(wordId, exampleId) {
    var w = getWord(wordId);
    if (!w) return;
    var ex = (w.examples || []).filter(function (e) { return e.id === exampleId; })[0];
    if (!ex) return;
    var sentence = {
      id: uid(),
      text: ex.en || ex.cn,
      cn: ex.en && ex.cn ? ex.cn : '',
      wordId: w.id,
      word: w.word,
      createdAt: Date.now()
    };
    DB.putSentence(sentence).then(function () {
      state.sentences.unshift(sentence);
      notifyChange();
      toast('已加入句子收藏');
    }).catch(function (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  }

  function deleteWord(id) {
    var w = getWord(id);
    if (!w) return;
    confirmDialog({
      title: '删除「' + w.word + '」？',
      message: '这个单词的例句和掌握度记录也会一起删除，无法恢复。',
      confirmText: '删除',
      danger: true,
      onConfirm: function () {
        DB.deleteWord(id).then(function () {
          state.words = state.words.filter(function (x) { return x.id !== id; });
          notifyChange();
          closeModal();
          render();
          toast('已删除');
        }).catch(function (err) {
          toast('删除失败：' + (err && err.message ? err.message : '未知错误'), true);
        });
      }
    });
  }

  function bindEvents() {
    document.addEventListener('click', function (event) {
      var tabBtn = event.target.closest('.tab[data-tab]');
      if (tabBtn) {
        switchTab(tabBtn.dataset.tab);
        return;
      }
      if (event.target.closest('#brand-home')) {
        switchTab('words');
        return;
      }
      var el = event.target.closest('[data-action]');
      if (!el) return;
      var action = el.dataset.action;
      var id = el.dataset.id;

      switch (action) {
        case 'modal-close':
          closeModal();
          break;
        case 'modal-backdrop':
          if (event.target === el) closeModal();
          break;
        case 'confirm-no':
          closeModal();
          break;
        case 'confirm-yes': {
          var cb = pendingConfirm;
          pendingConfirm = null;
          closeModal();
          if (cb) cb();
          break;
        }
        case 'word-filter':
          state.wordFilter = el.dataset.filter;
          render();
          break;
        case 'word-scope-all':
          setScope('words', 'all');
          break;
        case 'word-scope-book':
          setScope('words', 'book', id);
          break;
        case 'word-scope-uncat':
          setScope('words', 'uncat');
          break;
        case 'word-scope-mistakes':
          setScope('words', 'mistakes');
          break;
        case 'study-scope-all':
          setScope('study', 'all');
          break;
        case 'study-scope-book':
          setScope('study', 'book', id);
          break;
        case 'study-scope-uncat':
          setScope('study', 'uncat');
          break;
        case 'study-scope-mistakes':
          setScope('study', 'mistakes');
          break;
        case 'batch-toggle':
          state.batchMode = !state.batchMode;
          state.selectedIds = {};
          document.body.classList.toggle('in-batch', state.batchMode);
          render();
          break;
        case 'batch-select-all': {
          var visible = C.filterWords(state.words, state.wordFilter, state.wordQuery, state.scope, validBookIds());
          visible.forEach(function (w) { state.selectedIds[w.id] = true; });
          render();
          break;
        }
        case 'batch-clear':
          exitBatch();
          break;
        case 'batch-remove':
          performBatchOp('remove');
          break;
        case 'batch-move':
          openBookPicker('move');
          break;
        case 'batch-copy':
          openBookPicker('copy');
          break;
        case 'batch-target-confirm': {
          var checked = document.querySelector('input[name="target-book"]:checked');
          performBatchOp(state.pendingBatchOp, checked ? checked.value : '');
          break;
        }
        case 'word-pick': {
          if (!state.batchMode) {
            openWordDetail(id);
            break;
          }
          if (state.selectedIds[id]) delete state.selectedIds[id];
          else state.selectedIds[id] = true;
          render();
          break;
        }
        case 'book-manage':
          openBookManager();
          break;
        case 'book-create':
          createBookFromInput('book-create-name');
          break;
        case 'book-rename-open':
          openBookRename(id);
          break;
        case 'book-set-default':
          setDefaultBook(id);
          break;
        case 'book-delete':
          deleteBookRecord(id);
          break;
        case 'detail-book-toggle':
          toggleDetailBook(id, el.dataset.book);
          break;
        case 'import-new-book': {
          var nbRow = $('#import-new-book');
          if (nbRow) nbRow.hidden = !nbRow.hidden;
          var nbInput = $('#import-book-name');
          if (nbRow && !nbRow.hidden && nbInput) nbInput.focus();
          break;
        }
        case 'import-create-book':
          createBookFromInput('import-book-name', function (book) {
            state.importBookId = book.id;
            var sel = $('#import-book');
            if (sel) {
              sel.innerHTML = bookOptionsHtml(book.id);
              sel.value = book.id;
            }
            var nbr = $('#import-new-book');
            if (nbr) nbr.hidden = true;
            updateImportPreview();
            setImportStatus('已新建并选择「' + book.name + '」；当前 ' + state.importEntries.length + ' 条待导入。');
          });
          break;
        case 'fav-tab':
          state.favTab = el.dataset.fav;
          render();
          break;
        case 'go-words':
          switchTab('words');
          break;
        case 'toggle-star': {
          var w = getWord(id);
          if (!w) break;
          w.starred = !w.starred;
          DB.putWord(w).then(notifyChange);
          render();
          toast(w.starred ? '已加入单词收藏' : '已取消收藏');
          break;
        }
        case 'speak':
          speak(el.dataset.text);
          break;
        case 'word-detail':
          openWordDetail(id);
          break;
        case 'add-word':
          openAddWord();
          break;
        case 'import-open':
          openImport();
          break;
        case 'import-tab': {
          state.importTab = el.dataset.importTab;
          $$('[data-action="import-tab"]').forEach(function (b) {
            b.classList.toggle('is-active', b === el);
          });
          var filePane = $('#import-file-pane');
          var pastePane = $('#import-paste-pane');
          if (filePane) filePane.hidden = state.importTab !== 'file';
          if (pastePane) pastePane.hidden = state.importTab !== 'paste';
          break;
        }
        case 'import-parse': {
          var txt = $('#import-text');
          parseImport(txt ? txt.value : '', '粘贴文本');
          break;
        }
        case 'import-confirm':
          confirmImport();
          break;
        case 'mode-toggle':
          toggleMode(el.dataset.mode);
          break;
        case 'start-session':
          startSession();
          break;
        case 'start-mistakes':
          startMistakeSession();
          break;
        case 'start-leech':
          startLeechSession();
          break;
        case 'replay': {
          var cur = state.session && state.session.current;
          if (cur) {
            var curWord = getWord(cur.wordId);
            if (cur.mode === 'dictation' && curWord) {
              var dict = C.dictationFor(curWord);
              speak(dict ? dict.en : curWord.word);
            } else {
              speak(curWord ? curWord.word : '');
            }
          }
          break;
        }
        case 'submit-answer':
          submitAnswer();
          break;
        case 'choose-option':
          chooseOption(el.dataset.id);
          break;
        case 'quick-rate':
          rateQuick(el.dataset.rate);
          break;
        case 'next-task':
          advance();
          break;
        case 'session-exit':
          askExitSession();
          break;
        case 'session-done':
          endSession();
          break;
        case 'delete-sentence':
          deleteSentence(id);
          break;
        case 'default-mode':
          toggleDefaultMode(el.dataset.mode);
          break;
        case 'rate-set':
          setRate(el.dataset.rate);
          break;
        case 'accent-set':
          setAccent(el.dataset.accent);
          break;
        case 'open-report':
          openReport(state.reportDays);
          break;
        case 'report-days':
          openReport(el.dataset.days);
          break;
        case 'export-backup':
          exportBackup();
          break;
        case 'import-backup': {
          var fileInput = $('#backup-file');
          if (fileInput) fileInput.click();
          break;
        }
        case 'clear-all':
          clearAllData();
          break;
        case 'ex-add':
          addExample(id);
          break;
        case 'ex-delete':
          deleteExample(id, el.dataset.ex);
          break;
        case 'ex-to-sentence':
          exampleToSentence(id, el.dataset.ex);
          break;
        case 'delete-word':
          deleteWord(id);
          break;
        default:
          break;
      }
    });

    document.addEventListener('submit', function (event) {
      var form = event.target;
      if (form.id === 'add-form') {
        event.preventDefault();
        addWordFromForm(form);
      } else if (form.id === 'detail-form') {
        event.preventDefault();
        var wordId = form.dataset.wordId;
        if (wordId) saveDetail(wordId, form);
      } else if (form.id === 'sentence-form') {
        event.preventDefault();
        addSentence(form);
      } else if (form.id === 'book-rename-form') {
        event.preventDefault();
        var renameData = new FormData(form);
        renameBook(form.dataset.bookId, String(renameData.get('name') || ''));
      }
    });

    document.addEventListener('input', function (event) {
      var target = event.target;
      if (target.id === 'word-search') {
        state.wordQuery = target.value;
        refreshWordList();
      } else if (target.id === 'sent-search') {
        state.sentQuery = target.value;
        var container = document.getElementById('sentence-list-slot');
        if (container) container.innerHTML = sentencesListOnlyHtml();
      } else if (target.id === 'limit-new' || target.id === 'limit-review') {
        // 输入值在开始背诵时读取
      } else if (target.id === 'daily-new' || target.id === 'daily-review') {
        var v = Math.max(0, parseInt(target.value, 10) || 0);
        if (target.id === 'daily-new') {
          state.settings.dailyNew = v;
          state.newLimit = v;
        } else {
          state.settings.dailyReview = v;
          state.reviewLimit = v;
        }
        DB.saveSettings(state.settings).then(notifyChange);
      }
    });

    document.addEventListener('change', function (event) {
      var target = event.target;
      if (target.id === 'word-sort') {
        state.wordSort = target.value;
        render();
      } else if (target.id === 'import-file') {
        handleImportFile(target.files && target.files[0]);
      } else if (target.id === 'import-book') {
        state.importBookId = target.value;
        updateImportPreview();
        var tb = bookById(state.importBookId);
        if (tb) setImportStatus('已切换导入目标：「' + tb.name + '」。');
      } else if (target.id === 'backup-file') {
        handleBackupFile(target.files && target.files[0]);
        target.value = '';
      } else if (target.dataset && target.dataset.show) {
        state.settings.show[target.dataset.show] = !!target.checked;
        DB.saveSettings(state.settings).then(notifyChange);
        toast('显示设置已更新');
      }
    });

    document.addEventListener('keydown', function (event) {
      var modalOpen = !!document.querySelector('.modal-backdrop');
      if (event.key === 'Escape') {
        if (modalOpen) closeModal();
        return;
      }
      if (modalOpen && event.key === 'Enter' && (event.target.id === 'book-create-name' || event.target.id === 'import-book-name')) {
        event.preventDefault();
        if (event.target.id === 'book-create-name') {
          createBookFromInput('book-create-name');
        } else {
          var createBtn = document.querySelector('[data-action="import-create-book"]');
          if (createBtn) createBtn.click();
        }
        return;
      }
      var s = state.session;
      if (!s || s.finished || modalOpen) return;
      if (!s.revealed && (event.key === '1' || event.key === '2' || event.key === '3' || event.key === '4')) {
        var options = s.current && s.current.options;
        if (options) {
          var idx = Number(event.key) - 1;
          if (options[idx]) chooseOption(options[idx].id);
        }
        return;
      }
      if (event.key === 'Enter') {
        if (s.revealed) {
          event.preventDefault();
          advance();
        } else {
          var input = document.getElementById('answer-input');
          if (input && !event.isComposing) {
            event.preventDefault();
            submitAnswer();
          }
        }
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  init();
})();
