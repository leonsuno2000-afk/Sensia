/* ============================================================
   SENSIA · Servidor de señalización (zero-knowledge)
   ------------------------------------------------------------
   Hace DOS cosas y nada más:
     1. Sirve la app (sensia2.html) cuando alguien abre la URL.
     2. Conecta a dos teléfonos e intercambia el "apretón de manos"
        (SDP + ICE) para que armen su túnel directo P2P.

   Nunca ve ni guarda datos de la app: swipes, pulsos, video y
   bóveda viajan directo entre los teléfonos, cifrados extremo a
   extremo por el DTLS de WebRTC. El servidor tampoco conoce la
   palabra de encuentro (le llega hasheada con SHA-256).

   Contrato calcado a sensia2.html:
     Cliente → emite:  'join-room' (hash:string)
                       'signal'    ({ room, data })   data = {sdp} | {candidate}
     Servidor → emite: 'joined'    (room)
                       'peer-joined'
                       'room-full'
                       'signal'    (data)   ← reenvía el data tal cual, plano
                       'peer-disconnected'
   ============================================================ */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Señalización: CORS abierto no molesta porque la página y el socket
// salen del MISMO origen (mismo servidor). Es solo por robustez en dev.
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Sirve la app en la raíz "/" y en "/sensia2.html". Un solo archivo,
// un solo servicio, un solo origen → sin mixed-content → cámara OK sobre https.
const CLIENT = path.join(__dirname, 'sensia2.html');
app.get(['/', '/sensia2.html', '/index.html'], (_req, res) => res.sendFile(CLIENT));

/* ── Las letras, desde acá ────────────────────────────────────────
   Antes venían de Google Fonts. Eso significaba que abrir Sensia —antes de
   trazar el gesto, antes de decidir nada— le avisaba a dos servidores ajenos
   que este teléfono la había abierto. Ahora salen del mismo origen que todo
   lo demás, y la app no le habla a nadie al arrancar.

   Cinco archivos, con estos nombres exactos:
     cormorant-garamond.woff2 · cormorant-garamond-italic.woff2
     hanken-grotesk.woff2 · space-mono-400.woff2 · space-mono-700.woff2

   Se buscan primero en ./f y, si no están, en la raíz del repositorio. GitHub
   no deja renombrar binarios desde el móvil, así que exigir una carpeta era
   exigir borrar y volver a subir cinco archivos: el servidor se adapta y el
   HTML no se toca. La URL pública sigue siendo /f/… en los dos casos.

   El regex no es decoración: sin él, /f/../server.js serviría el servidor.
   Solo pasan nombres planos que terminan en .woff2 — ni barras, ni puntos,
   ni nada más. Y un año de caché con immutable: se bajan una vez y no se
   vuelven a pedir nunca. Si todavía no están, 404 y el CSS cae al respaldo:
   la app se ve con Georgia y la del sistema, pero no se rompe nada. */
const FUENTE_OK = /^[a-z0-9-]+\.woff2$/i;
app.get('/f/:nombre', (req, res) => {
  const n = req.params.nombre;
  if (!FUENTE_OK.test(n)) return res.sendStatus(404);
  const enCarpeta = path.join(__dirname, 'f', n);
  const enRaiz    = path.join(__dirname, n);
  const archivo   = fs.existsSync(enCarpeta) ? enCarpeta
                  : fs.existsSync(enRaiz)    ? enRaiz
                  : null;
  if (!archivo) return res.sendStatus(404);
  res.sendFile(archivo, { maxAge: '1y', immutable: true });
});

/* ══════════ EL SERVICE WORKER ══════════
   Sensia dice "funciona aunque el mundo se caiga", y hasta ahora eso no era
   cierto del propio archivo: si Render dormía o la red andaba mal, la app no
   abría. Un Service Worker lo resuelve, y de paso hace que Chrome ofrezca
   instalarla de verdad — el aviso de instalación necesita un manejador de
   fetch, y sin él la tarjeta "Instalar" nunca aparecía en Android.

   Vive acá dentro, como ruta, para no romper la regla del archivo único: el
   cliente sigue siendo un solo HTML.

   Estrategia, y el porqué de cada una:

   · La página va a la RED PRIMERO, con 3,5 s de paciencia, y recién entonces
     cae a la copia. Al revés —copia primero— sería más rápido, pero León
     despliega desde el teléfono varias veces por noche y quedaría mirando una
     versión vieja sin saberlo. Fresco cuando hay red; abre igual cuando no.

   · Las letras, la librería y el ícono van a la COPIA PRIMERO: no cambian, y
     así el arranque no espera a nadie.

   · TODO LO DEMÁS NO SE TOCA. Ni una línea. El sondeo de socket.io, el
     websocket de señalización y cualquier cosa con parámetros salen directo a
     la red, sin pasar por acá. Un Service Worker que se meta con la
     señalización rompe el túnel de maneras imposibles de depurar desde un
     teléfono. */
const APP_VER = 'v5.4';
const SW = `
const CACHE = 'sensia-${APP_VER}';
const FIJOS = ['/', '/manifest.webmanifest', '/icon.svg', '/socket.io/socket.io.js',
  '/f/cormorant-garamond.woff2', '/f/cormorant-garamond-italic.woff2',
  '/f/hanken-grotesk.woff2', '/f/space-mono-400.woff2', '/f/space-mono-700.woff2'];

self.addEventListener('install', e => {
  // addAll es todo-o-nada: si una fuente falta, no se guardaría ni la página.
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(FIJOS.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.search) return;                       // sondeos y señalización: intactos
  if (url.pathname.indexOf('/socket.io/') === 0 &&
      url.pathname !== '/socket.io/socket.io.js') return;

  // La página: red primero, 3,5 s de paciencia, después la copia.
  if (req.mode === 'navigate'){
    e.respondWith(new Promise(resolve => {
      let listo = false;
      const caer = () => { if (listo) return; listo = true;
        caches.match('/').then(r => resolve(r || fetch(req))); };
      const reloj = setTimeout(caer, 3500);
      fetch(req).then(r => {
        clearTimeout(reloj);
        if (r && r.ok) caches.open(CACHE).then(c => c.put('/', r.clone()));
        if (!listo){ listo = true; resolve(r); }
      }).catch(() => { clearTimeout(reloj); caer(); });
    }));
    return;
  }

  // Letras, librería, ícono, manifiesto: copia primero.
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r && r.ok) caches.open(CACHE).then(c => c.put(req, r.clone()));
    return r;
  })));
});
`;
app.get('/sw.js', (_req, res) => {
  res.type('application/javascript')
     .set('Cache-Control', 'no-cache')   // el navegador debe notar cada cambio
     .send(SW);
});

/* El manifiesto se servía como blob: creado en el navegador. Chrome lo trata
   con desconfianza y iOS directamente lo ignora — o sea que la instalación
   dependía de algo que a veces no existía. Ahora sale del servidor, con su
   tipo correcto y un ícono de verdad en /icon.svg. */
const ICONO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2b2e33"/><rect x="128" y="104" width="256" height="304" rx="24" fill="#e9e5dd"/><g fill="#9aa0a6"><rect x="168" y="168" width="176" height="18" rx="9"/><rect x="168" y="222" width="176" height="18" rx="9"/><rect x="168" y="276" width="120" height="18" rx="9"/></g></svg>`;
app.get('/icon.svg', (_req, res) => {
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=31536000, immutable').send(ICONO);
});
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').json({
    name: 'Notas', short_name: 'Notas', description: 'Notas',
    start_url: '/', scope: '/',
    display: 'standalone', orientation: 'portrait',
    background_color: '#050405', theme_color: '#050405',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
    ]
  });
});

/* La librería cliente de socket.io la sirve el propio socket.io en
   /socket.io/socket.io.js (serveClient viene activo por defecto). Por eso el
   HTML ya no carga ningún CDN: misma app, mismo origen, cero terceros. Y como
   efecto lateral bueno, si el script no carga es porque el servidor no está
   —que es información útil— y no un misterio de red. */

const MAX_PER_ROOM = 2; // un santuario es para dos

io.on('connection', (socket) => {
  // Log SOLO a nivel de conexión. Cero contenido.
  console.log(`[+] peer ${socket.id.slice(0, 6)} conectado`);

  socket.on('join-room', (code) => {
    if (typeof code !== 'string' || !code.trim()) return;
    const room = code.trim(); // ya viene hasheado y en minúsculas desde el cliente

    const existing = io.sockets.adapter.rooms.get(room);
    const size = existing ? existing.size : 0;

    if (size >= MAX_PER_ROOM) {
      socket.emit('room-full');
      return;
    }

    socket.join(room);
    socket.data.room = room;
    socket.emit('joined', room);

    // Si ya había alguien, avisale SOLO a él/ella: ahora es el initiator.
    // socket.to(room) excluye al que acaba de entrar → llega solo al que esperaba.
    if (size === 1) {
      socket.to(room).emit('peer-joined');
      console.log(`[=] sala lista (2 peers)`);
    }
  });

  // Relevo ciego de SDP/ICE. El servidor jamás mira dentro de `data`.
  socket.on('signal', (payload) => {
    const room = payload && payload.room;
    const data = payload && payload.data;
    if (!room || !data) return;
    socket.to(room).emit('signal', data);
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) socket.to(room).emit('peer-disconnected');
    console.log(`[-] peer ${socket.id.slice(0, 6)} salió`);
  });
});

// Render (y casi todo host) asigna el puerto por variable de entorno.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nSensia · escuchando en :${PORT}`);
  console.log(`Abrí:  http://localhost:${PORT}/\n`);
});
