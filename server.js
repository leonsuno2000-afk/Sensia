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
