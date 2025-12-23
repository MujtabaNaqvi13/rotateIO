const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redis = new Redis(REDIS_URL);
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/rotateio';
const pool = new Pool({ connectionString: DATABASE_URL });

const QUEUE_KEY_PREFIX = 'queue:'; // queue:mode => list of userIds
const LOBBY_KEY_PREFIX = 'lobby:'; // lobby:code => hash

function shortCode() { return Math.random().toString(36).substring(2,8).toUpperCase(); }

// Quickplay queue
app.post('/api/queue/quickplay', async (req, res) => {
  const { mode, accessToken } = req.body;
  // For simplicity we'll accept userId from body in this prototype (in prod verify token)
  const userId = req.body.userId || ('guest-'+Math.random().toString(36).slice(2,8));
  const key = QUEUE_KEY_PREFIX + (mode || 'default');
  await redis.lpush(key, userId);
  const length = await redis.llen(key);
  // naive matching: when queue >= 6 form a match
  if (length >= 6) {
    const players = [];
    for (let i=0;i<6;i++) players.push(await redis.rpop(key));
    // create match record in DB
    const matchId = uuidv4();
    await pool.query('INSERT INTO matches (id, mode, map, created_at) VALUES ($1,$2,$3,$4)', [matchId, mode||'rotating', 'city-1', new Date()]);
    // create lobby metadata in redis
    const serverInfo = { matchId, serverUrl: 'http://localhost:4001', players };
    // In a real system we'd select an available match server and pass match details
    return res.json({ matched: true, server: serverInfo });
  }
  return res.json({ queued: true, position: length });
});

// Create custom lobby
app.post('/api/lobby/create', async (req, res) => {
  const { mode, map, hostId } = req.body;
  const code = shortCode();
  const lobby = { code, hostId, mode: mode||'rotating', map: map||'city-1', members: [hostId], createdAt: Date.now() };
  await redis.set(LOBBY_KEY_PREFIX + code, JSON.stringify(lobby), 'EX', 60*60);
  return res.json({ ok: true, code, lobby });
});

app.post('/api/lobby/join', async (req, res) => {
  const { code, userId } = req.body;
  const key = LOBBY_KEY_PREFIX + code;
  const raw = await redis.get(key);
  if (!raw) return res.status(404).json({ ok:false, error: 'Lobby not found' });
  const lobby = JSON.parse(raw);
  if (lobby.members.includes(userId)) return res.json({ ok:true, lobby });
  lobby.members.push(userId);
  await redis.set(key, JSON.stringify(lobby), 'EX', 60*60);
  return res.json({ ok:true, lobby });
});

// Get lobby info
app.get('/api/lobby/:code', async (req, res) => {
  const code = req.params.code;
  const key = LOBBY_KEY_PREFIX + code;
  const raw = await redis.get(key);
  if (!raw) return res.status(404).json({ ok:false, error: 'Lobby not found' });
  const lobby = JSON.parse(raw);
  return res.json({ ok:true, lobby });
});

// Start a lobby (host only) -> allocate match server
app.post('/api/lobby/start', async (req, res) => {
  const { code, hostId } = req.body;
  const key = LOBBY_KEY_PREFIX + code;
  const raw = await redis.get(key);
  if (!raw) return res.status(404).json({ ok:false, error: 'Lobby not found' });
  const lobby = JSON.parse(raw);
  if (lobby.hostId !== hostId) return res.status(403).json({ ok:false, error: 'Only host can start' });

  // Simple matchmaking: create match record and call a match server
  const players = lobby.members;
  const matchId = uuidv4();
  await pool.query('INSERT INTO matches (id, mode, map, created_at) VALUES ($1,$2,$3,$4)', [matchId, lobby.mode, lobby.map, new Date()]);

  // pick a match server (for prototype use local server)
  const serverUrl = process.env.MATCH_SERVER_URL || 'http://localhost:4001';
  try {
    const resp = await fetch(`${serverUrl}/match/start`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ matchId, players }) });
    const data = await resp.json();
    // remove the lobby from redis
    await redis.del(key);
    return res.json({ ok:true, matchId, server: { url: serverUrl, info: data } });
  } catch (err) {
    console.error('Error starting match server', err);
    return res.status(500).json({ ok:false, error: 'match server error' });
  }
});

app.listen(process.env.PORT || 3001, () => console.log('Matchmaker running on 3001'));
