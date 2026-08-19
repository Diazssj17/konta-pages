/*
 * sw.js - Service worker de Konta.
 * Permite que la app funcione sin conexión y se pueda instalar en el celular.
 */

const CACHE_NOMBRE = "konta-v13";
const ARCHIVOS_PARA_CACHE = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/app.js",
  "./js/db.js",
  "./js/auth.js",
  "./js/analytics.js",
  "./js/charts.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
];

// Instalación: guardamos todos los archivos de la app en el caché.
self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE_NOMBRE).then((cache) => {
      return cache.addAll(ARCHIVOS_PARA_CACHE);
    })
  );
  self.skipWaiting();
});

// Activación: eliminamos cachés antiguos.
self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys().then((claves) => {
      return Promise.all(
        claves
          .filter((clave) => clave !== CACHE_NOMBRE)
          .map((clave) => caches.delete(clave))
      );
    })
  );
  self.clients.claim();
});

// Solicitudes: respondemos desde el caché y actualizamos en segundo plano.
self.addEventListener("fetch", (evento) => {
  if (evento.request.method !== "GET") return;

  evento.respondWith(
    caches.match(evento.request).then((enCache) => {
      const desdeRed = fetch(evento.request)
        .then((respuesta) => {
          if (respuesta && respuesta.status === 200) {
            const copia = respuesta.clone();
            caches.open(CACHE_NOMBRE).then((cache) => cache.put(evento.request, copia));
          }
          return respuesta;
        })
        .catch(() => enCache);
      return enCache || desdeRed;
    })
  );
});