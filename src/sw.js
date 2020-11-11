const cacheName = '::cacheName::';
const immutablePaths = ['::immutablePaths::'];
const htmlPaths = ['/'];
const iconPaths = ['::iconPaths::'];
const _404Html = '::404Html::';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(cacheName).then((cache) => {
            const addNecessaryPathsP = cache.addAll(
                immutablePaths.concat(htmlPaths),
            );
            cache.addAll(iconPaths);
            cache.add('/manifest.webmanifest');
            return addNecessaryPathsP;
        }),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((cacheNames) =>
                Promise.all(
                    cacheNames
                        .filter((name) => name !== cacheName)
                        .map((name) => caches.delete(name)),
                ),
            ),
    );
});

function isResponseSuccessful(response) {
    return response && response.status === 200 && response.type === 'basic';
}

function cacheResponse(request, response) {
    const responseClone = response.clone();
    return caches
        .open(cacheName)
        .then((cache) => cache.put(request, responseClone));
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const { origin, pathname } = new URL(request.url);
    const cacheMatchOptions =
        origin === location.origin
            ? {
                  ignoreSearch: true,
              }
            : undefined;

    function trySend404(error) {
        if (
            request.method === 'GET' &&
            request.headers.get('accept').indexOf('text/html') !== -1
        ) {
            return new Response(_404Html, {
                status: 404,
                headers: {
                    'Content-Type': 'text/html',
                },
            });
        }
        return Promise.reject(error);
    }

    if (
        htmlPaths.indexOf(pathname) !== -1 ||
        iconPaths.indexOf(pathname) !== -1
    ) {
        event.respondWith(
            fetch(request).then(
                (response) => {
                    if (isResponseSuccessful(response)) {
                        event.waitUntil(cacheResponse(pathname, response));
                    }
                    return response;
                },
                (error) =>
                    caches
                        .match(request, cacheMatchOptions)
                        .then((response) => {
                            if (response) {
                                return response;
                            }
                            return trySend404(error);
                        }),
            ),
        );
        return;
    }

    event.respondWith(
        caches.match(request, cacheMatchOptions).then((response) => {
            if (response) {
                return response;
            }
            return fetch(request).catch(trySend404);
        }),
    );
});
