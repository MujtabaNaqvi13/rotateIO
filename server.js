const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret';
const REFRESH_TOKEN_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

// DB setup (Postgres)
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/rotateio';
const pool = new Pool({ connectionString: DATABASE_URL });
async function run(sql, params=[]) { return (await pool.query(sql, params)); }
async function get(sql, params=[]) { const r=await pool.query(sql, params); return r.rows[0]; }
async function all(sql, params=[]) { const r=await pool.query(sql, params); return r.rows; }

// Note: Run migrations with `npm run migrate` before starting server


// Email transport (dev fallback to Ethereal)
let mailTransport;
(async function setupMail(){
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        mailTransport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: process.env.SMTP_PORT||587, secure:false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    } else {
        const account = await nodemailer.createTestAccount();
        mailTransport = nodemailer.createTransport({ host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure, auth: { user: account.user, pass: account.pass } });
        console.log('Using Ethereal account for email. Preview URL will be logged.');
    }
})();

// Lobby endpoints — proxy to Matchmaker service (Redis-backed)
const MATCHMAKER_URL = process.env.MATCHMAKER_URL || 'http://localhost:3001';

app.post('/api/lobby/create', async (req, res) => {
    const { mode, map, hostId } = req.body;
    try {
        const resp = await fetch(`${MATCHMAKER_URL}/api/lobby/create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode, map, hostId })
        });
        const data = await resp.json();
        return res.json(data);
    } catch (err) {
        console.error('Error calling matchmaker create', err);
        return res.status(500).json({ ok:false, error: 'matchmaker error' });
    }
});

app.post('/api/lobby/join', async (req, res) => {
    const { code, userId } = req.body;
    try {
        const resp = await fetch(`${MATCHMAKER_URL}/api/lobby/join`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, userId })
        });
        const data = await resp.json();
        return res.json(data);
    } catch (err) {
        console.error('Error calling matchmaker join', err);
        return res.status(500).json({ ok:false, error: 'matchmaker error' });
    }
});

app.get('/api/lobby/:code', async (req, res) => {
    const code = req.params.code;
    try {
        const resp = await fetch(`${MATCHMAKER_URL}/api/lobby/${code}`);
        const data = await resp.json();
        return res.json(data);
    } catch (err) {
        console.error('Error fetching lobby', err);
        return res.status(500).json({ ok:false, error: 'matchmaker error' });
    }
});

app.post('/api/lobby/start', async (req, res) => {
    const { code, hostId } = req.body;
    try {
        const resp = await fetch(`${MATCHMAKER_URL}/api/lobby/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, hostId })
        });
        const data = await resp.json();
        return res.json(data);
    } catch (err) {
        console.error('Error starting lobby', err);
        return res.status(500).json({ ok:false, error: 'matchmaker error' });
    }
});

function genToken(size=24) { return crypto.randomBytes(size).toString('hex'); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function now() { return Date.now(); }

async function sendEmail(to, subject, text, html) {
    if (!mailTransport) return console.warn('Mail transport not ready; skipping email.');
    const info = await mailTransport.sendMail({ from: process.env.EMAIL_FROM || 'rotate-io@example.com', to, subject, text, html });
    if (nodemailer.getTestMessageUrl(info)) console.log('Preview URL:', nodemailer.getTestMessageUrl(info));
}

function issueAccessToken(user) {
    return jwt.sign({ sub: user.id, name: user.display_name, email: user.email }, JWT_SECRET, { expiresIn: '5m' });
}

function setRefreshCookie(res, token) {
    const secure = process.env.NODE_ENV === 'production';
    res.cookie('refreshToken', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: secure,
        path: '/',
        maxAge: REFRESH_TOKEN_TTL
    });
}

// --- Auth endpoints ---
app.post('/api/signup', async (req, res) => {
    const { email, password, displayName } = req.body;
    if (!email || !password) return res.status(400).json({ ok:false, error:'email & password required' });
    const existing = await get('SELECT * FROM users WHERE lower(email) = lower($1)', [email.toLowerCase()]);
    if (existing) return res.status(400).json({ ok:false, error:'Email already used' });

    try {
        const hash = await argon2.hash(password);
        const id = uuidv4();
        const verifyToken = genToken(20);
        const verifyExpiry = now() + 1000*60*60*24; // 24h
        await run(`INSERT INTO users (id,email,display_name,password_hash,is_verified,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [id, email.toLowerCase(), displayName||email.split('@')[0], hash, false, new Date()]);
        await run(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked, created_at) VALUES ($1,$2,$3,$4,$5)`, [id, null, 0, true, new Date()]);
        // send verification email
        const verifyUrl = `${req.protocol}://${req.get('host')}/api/verify-email?token=${verifyToken}`;
        await sendEmail(email, 'Verify your ROTATE.IO account', `Verify: ${verifyUrl}`, `<p>Click to verify: <a href="${verifyUrl}">${verifyUrl}</a></p>`);
        return res.json({ ok:true });
    } catch (err) {
        console.error('signup error', err);
        return res.status(500).json({ ok:false, error:'server error' });
    }
});

app.post('/api/verify-email', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok:false, error:'missing' });
    const user = await get('SELECT * FROM users WHERE verify_token = ?', [token]);
    if (!user || user.verify_expiry < now()) return res.status(400).json({ ok:false, error:'invalid or expired' });
    await run('UPDATE users SET is_verified = 1, verify_token = NULL, verify_expiry = NULL WHERE id = ?', [user.id]);
    return res.json({ ok:true });
});

app.post('/api/login', async (req, res) => {
    const { email, password, remember } = req.body;
    if (!email || !password) return res.status(400).json({ ok:false, error:'missing' });
    const user = await get('SELECT * FROM users WHERE lower(email) = lower($1)', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ ok:false, error:'invalid' });
    try {
        if (!await argon2.verify(user.password_hash, password)) return res.status(401).json({ ok:false, error:'invalid' });
    } catch (e) { return res.status(500).json({ ok:false, error:'server' }); }
    // create tokens
    const accessToken = issueAccessToken(user);
    const refreshToken = genToken(32);
    const refreshHash = hashToken(refreshToken);
    const refreshExpiry = now() + REFRESH_TOKEN_TTL;
    await run('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked, created_at) VALUES ($1,$2,$3,$4,$5)', [user.id, refreshHash, refreshExpiry, false, new Date()]);
    setRefreshCookie(res, refreshToken);
    await run('UPDATE users SET last_login = $1 WHERE id = $2', [new Date(), user.id]);
    return res.json({ ok:true, accessToken, user: { id: user.id, email: user.email, displayName: user.display_name, is_verified: !!user.is_verified } });
});

app.post('/api/refresh-token', async (req, res) => {
    const token = req.cookies.refreshToken;
    if (!token) return res.status(401).json({ ok:false, error:'no token' });
    const hash = hashToken(token);
    const user = await get('SELECT * FROM users WHERE refresh_token_hash = ?', [hash]);
    if (!user || user.refresh_expiry < now()) return res.status(401).json({ ok:false, error:'invalid' });
    // rotate
    const newRefresh = genToken(32);
    const newHash = hashToken(newRefresh);
    const refreshExpiry = now() + REFRESH_TOKEN_TTL;
    await run('UPDATE users SET refresh_token_hash = ?, refresh_expiry = ? WHERE id = ?', [newHash, refreshExpiry, user.id]);
    setRefreshCookie(res, newRefresh);
    const accessToken = issueAccessToken(user);
    return res.json({ ok:true, accessToken });
});

app.post('/api/logout', async (req, res) => {
    const token = req.cookies.refreshToken;
    if (token) {
        const hash = hashToken(token);
        await run('UPDATE users SET refresh_token_hash = NULL, refresh_expiry = NULL WHERE refresh_token_hash = ?', [hash]);
        res.clearCookie('refreshToken');
    }
    return res.json({ ok:true });
});

app.post('/api/password-reset-request', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ ok:false });
    const user = await get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.json({ ok:true }); // don't reveal
    const token = genToken(24);
    const expiry = now() + 1000*60*60; // 1 hour
    await run('UPDATE users SET reset_token = ?, reset_expiry = ? WHERE id = ?', [token, expiry, user.id]);
    const url = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
    await sendEmail(user.email, 'Reset your password', `Reset: ${url}`, `<p>Reset your password: <a href="${url}">${url}</a></p>`);
    return res.json({ ok:true });
});

app.post('/api/password-reset', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ ok:false });
    const user = await get('SELECT * FROM users WHERE reset_token = ?', [token]);
    if (!user || user.reset_expiry < now()) return res.status(400).json({ ok:false });
    const hash = await argon2.hash(password);
    await run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expiry = NULL WHERE id = ?', [hash, user.id]);
    return res.json({ ok:true });
});

app.get('/api/me', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ ok:false });
    const token = auth.slice(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await get('SELECT id,email,display_name,is_verified FROM users WHERE id = ?', [decoded.sub]);
        if (!user) return res.status(401).json({ ok:false });
        return res.json({ ok:true, user });
    } catch (e) {
        return res.status(401).json({ ok:false });
    }
});

// --- Game server (socket.io uses accessToken JWT) ---
const arenaSize = { width: 1600, height: 900 };
const players = new Map(); // socket.id -> player
const projectiles = [];
let nextRotation = Date.now() + 10000;
const abilities = ['dash','blink','knockback','shield','speed','gravity','freeze'];
function pickAbility() { return abilities[Math.floor(Math.random()*abilities.length)]; }

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

io.use(async (socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Auth required'));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await get('SELECT id, email, display_name FROM users WHERE id = ?', [decoded.sub]);
        if (!user) return next(new Error('Invalid token'));
        socket.userId = user.id;
        socket.username = user.display_name || user.email;
        next();
    } catch (e) { return next(new Error('Invalid token')); }
});

io.on('connection', (socket) => {
    console.log('player connected', socket.id, socket.username);
    const spawnX = Math.floor(Math.random()* (arenaSize.width-200)) + 100;
    const spawnY = Math.floor(Math.random()* (arenaSize.height-200)) + 100;
    const player = {
        id: socket.id,
        userId: socket.userId,
        name: socket.username,
        x: spawnX,
        y: spawnY,
        rotation: 0,
        vx: 0, vy: 0,
        color: `hsl(${Math.floor(Math.random()*360)},60%,50%)`,
        score: 0,
        alive: true,
        isShielded: false,
        ability: pickAbility(),
        weapon: 'pistol'
    };
    players.set(socket.id, player);

    // send init
    socket.emit('init', {
        playerId: socket.id,
        players: Array.from(players.values()),
        ability: { id: player.ability, name: player.ability },
        nextRotation,
        arenaSize
    });

    socket.broadcast.emit('playerJoined', player);

    socket.on('move', (data) => {
        const p = players.get(socket.id);
        if (!p || !p.alive) return;
        p.vx = data.dx || 0; p.vy = data.dy || 0; p.rotation = data.rotation || p.rotation;
    });

    socket.on('useAbility', (data) => {
        const p = players.get(socket.id);
        if (!p) return;
        io.emit('abilityUsed', { playerId: socket.id, ability: p.ability });
    });

    socket.on('shoot', () => {
        const p = players.get(socket.id);
        if (!p || !p.alive) return;
        const speed = 9;
        const x = p.x + Math.cos(p.rotation) * 18;
        const y = p.y + Math.sin(p.rotation) * 18;
        projectiles.push({ owner: socket.id, x, y, vx: Math.cos(p.rotation)*speed, vy: Math.sin(p.rotation)*speed, born: Date.now(), life: 2000 });
    });

    socket.on('disconnect', () => {
        players.delete(socket.id);
        socket.broadcast.emit('playerLeft', socket.id);
    });
});

// Game loop
setInterval(() => {
    // apply movement
    for (let p of players.values()) {
        if (!p.alive) continue;
        p.x += p.vx; p.y += p.vy;
        p.x = Math.max(30, Math.min(arenaSize.width-30, p.x));
        p.y = Math.max(30, Math.min(arenaSize.height-30, p.y));
    }

    // update projectiles
    for (let i = projectiles.length-1; i>=0; i--) {
        const pr = projectiles[i];
        pr.x += pr.vx; pr.y += pr.vy;
        for (let p of players.values()) {
            if (p.id === pr.owner || !p.alive) continue;
            const dx = p.x - pr.x, dy = p.y - pr.y; if (Math.hypot(dx,dy) < 14) {
                const killer = players.get(pr.owner);
                if (killer) {
                    p.alive = false;
                    killer.score += 100;
                    io.emit('playerKilled', { killer: killer.id, victim: p.id });
                    setTimeout(()=>{
                        p.alive = true; p.x = Math.floor(Math.random()* (arenaSize.width-200)) + 100; p.y = Math.floor(Math.random()* (arenaSize.height-200)) + 100;
                        io.to(p.id).emit('respawn', { x:p.x, y:p.y });
                    }, 2000);
                }
                projectiles.splice(i,1); break;
            }
        }
        if (pr && (Date.now() - pr.born) > pr.life) projectiles.splice(i,1);
    }

    // ability rotation
    if (Date.now() > nextRotation) {
        const oldAbilities = {};
        for (let p of players.values()) { oldAbilities[p.id] = p.ability; p.ability = pickAbility(); }
        const payload = { nextRotation: Date.now()+10000, changes: [] };
        for (let p of players.values()) payload.changes.push({ id: p.id, newAbility: p.ability, oldAbility: oldAbilities[p.id] });
        io.emit('abilityRotated', { newAbility: null, nextRotation: payload.nextRotation, changes: payload.changes });
        nextRotation = Date.now()+10000;
    }

    const snapshot = Array.from(players.values()).map(p => ({ id: p.id, x: p.x, y: p.y, rotation: p.rotation, score: p.score, alive: p.alive, isShielded: p.isShielded, name: p.name }));
    io.emit('gameUpdate', { players: snapshot });
}, 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on', PORT));
