// very small offline cache
const CACHE = "loto7-buddy-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./base_draws.js",
  "./base_draws.json",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache)=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => (k===CACHE)?null:caches.delete(k)))).then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  event.respondWith(
    caches.match(req).then((cached)=>{
      if(cached) return cached;
      return fetch(req).then((res)=>{
        const copy = res.clone();
        caches.open(CACHE).then((cache)=>cache.put(req, copy)).catch(()=>{});
        return res;
      }).catch(()=>cached);
    })
  );
});
