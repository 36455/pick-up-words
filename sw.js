/* 拾词 · 离线缓存（网络优先，离线时回退到缓存） */
'use strict';

var CACHE_NAME = 'cihai-shell-v1';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './core.js',
  './db.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { /* 单个资源失败不影响整体安装 */ });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === CACHE_NAME ? null : caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        return caches.open(CACHE_NAME).then(function (cache) {
          return cache.put(request, copy);
        }).then(function () {
          return response;
        }).catch(function () {
          return response;
        });
      }
      return response;
    }).catch(function () {
      return caches.match(request).then(function (hit) {
        if (hit) return hit;
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return Response.error();
      });
    })
  );
});
