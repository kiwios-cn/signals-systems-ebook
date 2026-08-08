const CACHE_VERSION = "20260808-signals-systems-v8";
const SHELL_CACHE = `signals-systems-ebook-shell-${CACHE_VERSION}`;
const PAGE_CACHE = `signals-systems-ebook-pages-${CACHE_VERSION}`;
const ACTIVE_CACHES = new Set([SHELL_CACHE, PAGE_CACHE]);

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=20260808-signals-systems-v8",
  "./data.js?v=20260808-signals-systems-v8",
  "./app.js?v=20260808-signals-systems-v8",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name.startsWith("signals-systems-ebook-") && !ACTIVE_CACHES.has(name))
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isPageImageRequest(url)) {
    event.respondWith(cacheFirst(request, PAGE_CACHE));
    return;
  }

  if (isShellRequest(url)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

function isPageImageRequest(url) {
  return url.pathname.includes("/rendered-pages/") && /\.(webp|png|jpe?g)$/i.test(url.pathname);
}

function isShellRequest(url) {
  if (!url.pathname.includes("/ebook/")) {
    return false;
  }
  return url.pathname.endsWith("/ebook/") || url.pathname.endsWith("/ebook/index.html") || /\.(js|css|json)$/i.test(url.pathname);
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  const networkResponse = await fetch(request);
  if (networkResponse.ok) {
    cache.put(request, networkResponse.clone());
  }
  return networkResponse;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await cache.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    throw error;
  }
}
