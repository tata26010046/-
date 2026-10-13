// オフライン対応：アプリ本体をキャッシュ（データ同期は Firebase 側が端末内キャッシュで処理）
const CACHE = "kakei-note-v1";   // ファイルを更新したら番号を上げると全端末に反映されます
const SHELL = ["./", "index.html", "css/style.css", "js/app.js", "js/ocr.js", "js/firebase-config.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CACHE + "-cdn").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Firebase の通信はキャッシュしない
  if (/googleapis\.com$|firebaseio|identitytoolkit|securetoken/.test(url.hostname) && !/fonts\.googleapis/.test(url.hostname)) return;
  // 自分のファイル：ネット優先（最新を取得）→ だめならキャッシュ
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return res; }).catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
    return;
  }
  // CDN（Firebase SDK・フォント・OCR）：キャッシュ優先
  if (/gstatic\.com|fonts\.googleapis\.com|cdn\.jsdelivr\.net/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const cp = res.clone(); caches.open(CACHE + "-cdn").then(c => c.put(req, cp)); }
      return res;
    })));
  }
});
