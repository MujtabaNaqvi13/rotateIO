const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const PORT = process.env.MATCH_PORT || 4001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// In-memory state for matches: { matchId: { players: Map(socketId->playerState), replayBuffer: [] }}
const matches = new Map();

// Simple endpoint for starting a match (matchmaker would call this)
app.post('/match/start', express.json(), (req, res) => {
  const { matchId, players } = req.body;
  matches.set(matchId, { players: new Map(), replayBuffer: [] });
  console.log('Match started', matchId, players.length);
  return res.json({ ok:true });
});

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Auth required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.sub;
    next();
  } catch (e) { next(new Error('Invalid token')); }
});

io.on('connection', (socket) => {
  console.log('player connected', socket.id, socket.userId);
  socket.on('joinMatch', ({ matchId }) => {
    if (!matches.has(matchId)) return socket.emit('error', 'match not found');
    const match = matches.get(matchId);
    match.players.set(socket.id, { id: socket.id, userId: socket.userId, x: 100, y: 100, vx:0, vy:0, alive:true });
    socket.join(matchId);
    socket.emit('init', { playerId: socket.id, players: Array.from(match.players.values()) });
  });

  socket.on('input', (data) => {
    // input: { matchId, tick, dx, dy, rotation, shoot }
    const match = matches.get(data.matchId);
    if (!match) return;
    const p = match.players.get(socket.id);
    if (!p) return;
    // simple server-side movement application
    p.x += (data.dx || 0);
    p.y += (data.dy || 0);
    p.rotation = data.rotation || p.rotation;
    // push to replay buffer
    match.replayBuffer.push({ t: Date.now(), p: { id: p.id, x:p.x, y:p.y }, input: data });
    if (match.replayBuffer.length > 2000) match.replayBuffer.shift();
  });

  socket.on('disconnect', () => {
    for (const [matchId, match] of matches) {
      if (match.players.has(socket.id)) {
        match.players.delete(socket.id);
        io.to(matchId).emit('playerLeft', socket.id);
      }
    }
  });
});

// tick loop (30Hz)
setInterval(() => {
  for (const [matchId, match] of matches) {
    // broadcast positions
    const players = Array.from(match.players.values()).map(p => ({ id: p.id, x: p.x, y: p.y, rotation: p.rotation, alive: p.alive }));
    io.to(matchId).emit('gameUpdate', { players });
  }
}, 1000/30);

server.listen(PORT, () => console.log('Match server listening on', PORT));
