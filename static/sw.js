/**
 * Self-unregistering Service Worker for Nabka.
 * Automatically purges any legacy CacheStorage caches and unregisters itself
 * so that users always receive fresh HTML and assets from the network.
 */

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.resolve()
            .then(() => {
                if ('caches' in self) {
                    return caches.keys().then((keys) => {
                        return Promise.all(keys.map((key) => caches.delete(key)));
                    });
                }
            })
            .then(() => self.registration.unregister())
            .then(() => self.clients.matchAll({ type: 'window' }))
            .then((clients) => {
                for (const client of clients) {
                    try {
                        client.navigate(client.url);
                    } catch (e) {}
                }
            })
    );
});

// Pass all network fetch requests straight through to the network without caching
self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request));
});
