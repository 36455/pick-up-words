/* 拾词 · IndexedDB 数据层 */
(function () {
  'use strict';

  var DB_NAME = 'cihai-db';
  var VERSION = 2;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持 IndexedDB，无法保存数据。'));
        return;
      }
      var req;
      try {
        req = indexedDB.open(DB_NAME, VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('words')) {
          var words = db.createObjectStore('words', { keyPath: 'id' });
          words.createIndex('word', 'word', { unique: false });
        }
        if (!db.objectStoreNames.contains('sentences')) {
          db.createObjectStore('sentences', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('stats')) {
          db.createObjectStore('stats', { keyPath: 'date' });
        }
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('无法打开本地数据库。')); };
      req.onblocked = function () { reject(new Error('本地数据库被其他标签页占用，请关闭其他页面后重试。')); };
    });
    return dbPromise;
  }

  function getAll(storeName) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function get(storeName, key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function put(storeName, value) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = function () { resolve(value); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('保存失败')); };
      });
    });
  }

  function putMany(storeName, values) {
    if (!values || !values.length) return Promise.resolve();
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        values.forEach(function (v) { store.put(v); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('批量保存失败')); };
      });
    });
  }

  function remove(storeName, key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function clearAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(['words', 'sentences', 'stats', 'settings', 'books'], 'readwrite');
        ['words', 'sentences', 'stats', 'settings', 'books'].forEach(function (name) {
          tx.objectStore(name).clear();
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  window.CihaiDB = {
    open: open,
    getAllWords: function () { return getAll('words'); },
    getAllSentences: function () { return getAll('sentences'); },
    getAllBooks: function () { return getAll('books'); },
    getSettings: function () { return getAll('settings'); },
    getAllStats: function () { return getAll('stats'); },
    getStats: function (date) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = db.transaction('stats', 'readonly').objectStore('stats').get(date);
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { reject(req.error); };
        });
      });
    },
    putWord: function (w) { return put('words', w); },
    putWords: function (list) { return putMany('words', list); },
    deleteWord: function (id) { return remove('words', id); },
    putSentence: function (s) { return put('sentences', s); },
    putSentences: function (list) { return putMany('sentences', list); },
    deleteSentence: function (id) { return remove('sentences', id); },
    putBook: function (b) { return put('books', b); },
    putBooks: function (list) { return putMany('books', list); },
    deleteBook: function (id) { return remove('books', id); },
    saveSettings: function (s) { return put('settings', s); },
    saveStats: function (s) { return put('stats', s); },
    getActiveSession: function () { return get('settings', 'activeSession'); },
    saveActiveSession: function (snapshot) {
      return put('settings', { id: 'activeSession', updatedAt: Date.now(), session: snapshot });
    },
    clearActiveSession: function () { return remove('settings', 'activeSession'); },
    clearAll: clearAll
  };
})();
