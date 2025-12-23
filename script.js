class RotateIOGame {
    constructor() {
        this.socket = null;
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.playerId = null;
        this.players = {};
        this.ability = null;
        this.nextRotation = 0;
        this.abilityCooldown = 0;
        this.keys = {};
        this.mouse = { x: 0, y: 0 };
        this.arenaSize = { width: 1600, height: 900 };
        this.matchTime = 300; // 5 minutes
        this.scoreboard = [];

        // Projectiles (gun) system
        this.projectiles = [];
        this.gun = { cooldown: 400, speed: 9, life: 2000, radius: 6 };

        // Local two-player mode state
        this.twoPlayerLocal = false;
        this.localPlayer2Id = null;    
        this.localTwoPlayerControls = {
            shootKey: 'Enter',
            abilityKey: 'Shift'
        };
        
        // Abilities used in the game
        this.abilities = [
            { id: 'dash', name: 'Dash', cooldown: 1500, duration: 200, range: 120, icon: 'fa-bolt', color: '#4cc9f0' },
            { id: 'blink', name: 'Blink', cooldown: 3000, duration: 0, range: 160, icon: 'fa-location-arrow', color: '#f72585' },
            { id: 'knockback', name: 'Knockback', cooldown: 2500, duration: 0, range: 120, icon: 'fa-expand-alt', color: '#ffd166' },
            { id: 'shield', name: 'Shield', cooldown: 4000, duration: 2000, range: 0, icon: 'fa-shield-alt', color: '#06d6a0' },
            { id: 'speed', name: 'Speed Boost', cooldown: 3500, duration: 1500, range: 0, icon: 'fa-running', color: '#4361ee' },
            { id: 'gravity', name: 'Gravity Flip', cooldown: 5000, duration: 1200, range: 0, icon: 'fa-magnet', color: '#a44afe' },
            { id: 'freeze', name: 'Freeze', cooldown: 4000, duration: 900, range: 100, icon: 'fa-snowflake', color: '#00b4d8' }
        ];

        // Weapons for shop
        this.weapons = {
            pistol: { id: 'pistol', name: 'Pistol', cooldown: 400, speed: 9, life: 2000, radius: 6, bullets: 1, spread: 0, price: 0 },
            shotgun: { id: 'shotgun', name: 'Shotgun', cooldown: 900, speed: 8, life: 800, radius: 6, bullets: 5, spread: 0.6, price: 5 },
            rifle: { id: 'rifle', name: 'Rifle', cooldown: 250, speed: 12, life: 2500, radius: 4, bullets: 1, spread: 0, price: 8 },
            sniper: { id: 'sniper', name: 'Sniper', cooldown: 1400, speed: 18, life: 4000, radius: 5, bullets: 1, spread: 0, price: 12 }
        };

        // Local-only mode (fallback when no server is available)
        this.localMode = false;
        this.bots = [];

        // Map obstacles (rectangles) — x,y,w,h
        this.mapRects = [
            { x: 280, y: 120, w: 200, h: 120 },
            { x: 900, y: 80, w: 300, h: 100 },
            { x: 520, y: 380, w: 160, h: 260 },
            { x: 1200, y: 300, w: 200, h: 200 },
            { x: 100, y: 600, w: 220, h: 140 }
        ];

        // Spawn points (safe positions)
        this.spawnPoints = [
            { x: 80, y: 80 }, { x: 1520, y: 80 }, { x: 80, y: 820 }, { x: 1520, y: 820 }, { x: 800, y: 450 }
        ];

        // Chunk streaming state (map is split into named chunks: map-city-1-chunk0...)
        this.mapChunksLoaded = new Set(); // set of loaded chunk names
        this.mapChunkRects = {}; // map chunk name => array of rects added from chunk (for unloading)
        this.chunkSize = { width: Math.ceil(this.arenaSize.width/3), height: Math.ceil(this.arenaSize.height/1) }; // simple 3-column split by default
        this.chunkLoadRadius = 1; // load current and adjacent chunks

        // Persistent kill feed
        this.killFeed = [];

        this.init();
    }
    
    init() {
        // Scale canvas to fit screen
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // Connect to server
        this.connectToServer();
        
        // Setup input listeners
        this.setupInput();

        // UI handlers (shop, mode buttons)
        setTimeout(() => {
            const openShopBtn = document.getElementById('openShopBtn');
            if (openShopBtn) openShopBtn.addEventListener('click', () => this.openShop());
            const closeShopBtn = document.getElementById('closeShopBtn');
            if (closeShopBtn) closeShopBtn.addEventListener('click', () => this.closeShop());
            document.querySelectorAll('.mode-btn').forEach(b => {
                b.addEventListener('click', (e) => this.setMode(b.dataset.mode || 'FFA'));
            });
        }, 200);
        
        // Start game loop
        this.gameLoop();
        
        // Start match timer
        this.startMatchTimer();

        // Start periodic check to stream map chunks around the player
        this.chunkCheckInterval && clearInterval(this.chunkCheckInterval);
        this.chunkCheckInterval = setInterval(() => this.loadMapChunksAroundPlayer(), 1000);
    }
    
    resizeCanvas() {
        const container = this.canvas.parentElement;
        const scale = Math.min(
            container.clientWidth / this.arenaSize.width,
            container.clientHeight / this.arenaSize.height
        );

        // Set actual drawing buffer to arena logical size
        this.canvas.width = this.arenaSize.width;
        this.canvas.height = this.arenaSize.height;

        // Use CSS scaling to make it responsive
        this.canvas.style.width = `${this.arenaSize.width * scale}px`;
        this.canvas.style.height = `${this.arenaSize.height * scale}px`;
    }
    
    async connectToServer() {
            // If there's no socket.io or no token the client falls back to local demo mode
        if (typeof io === 'undefined') {
            console.warn('Socket.io library not found — starting local demo mode');
            this.startLocalGame();
            return;
        }

        // Try to use stored access token, otherwise attempt refresh.
        // If user selected guest mode, fall back to a local demo instead of forcing login.
        let token = localStorage.getItem('accessToken');
        if (!token) {
            const ok = await this.refreshAccessToken();
            token = localStorage.getItem('accessToken');
            if (!ok || !token) {
                // If guest flag is set, start local demo and don't force login
                if (localStorage.getItem('guest') === 'true') {
                    this.startLocalGame();
                    return;
                }
                // Otherwise show login modal so the user can choose to sign in or play as guest
                this.showLoginModal && this.showLoginModal();
                return;
            }
        }

        try {
            this.socket = io('http://localhost:3000', { auth: { token }, autoConnect: true, withCredentials: true });
        } catch (err) {
            console.warn('Socket connection failed — starting local demo mode', err);
            this.socket = null;
            this.startLocalGame();
            return;
        }

        this.socket.on('connect_error', (err) => {
            console.warn('Could not connect to server — falling back to local mode', err.message || err);
            // if it's an auth error, prefer guest fallback instead of forcing login
            if (err && /auth|invalid/i.test(err.message || '')) {
                if (localStorage.getItem('guest') === 'true') {
                    this.socket && this.socket.close();
                    this.socket = null;
                    this.startLocalGame();
                    return;
                }
                this.showLoginModal();
            }
            this.socket && this.socket.close();
            this.socket = null;
            this.startLocalGame();
        });

        this.socket.on('init', (data) => {
            console.log('Game initialized (server):', data);
            this.playerId = data.playerId;
            this.players = {};
            data.players.forEach(player => {
                this.players[player.id] = player;
            });
            // server ability may be generic; map it
            this.updateAbility({ id: this.players[this.playerId].ability, name: this.players[this.playerId].ability });
            this.nextRotation = data.nextRotation;
            this.arenaSize = data.arenaSize || this.arenaSize;
            this.updateScoreboard();
            // hide login modal
            this.closeLoginModal();
        });

        this.socket.on('gameUpdate', (data) => {
            data.players.forEach(playerData => {
                if (this.players[playerData.id]) {
                    // Smooth interpolation
                    const player = this.players[playerData.id];
                    player.x += (playerData.x - player.x) * 0.3;
                    player.y += (playerData.y - player.y) * 0.3;
                    player.rotation = playerData.rotation;
                    player.isShielded = playerData.isShielded;
                    player.alive = playerData.alive !== false;
                } else {
                    this.players[playerData.id] = playerData;
                }
            });
            this.updateScoreboard();
        });

        this.socket.on('playerJoined', (player) => {
            this.players[player.id] = player;
            this.showMessage(`${player.name} joined the game!`, 'join');
            this.updatePlayerCount();
        });

        this.socket.on('playerLeft', (playerId) => {
            delete this.players[playerId];
            this.showMessage('A player left the game', 'leave');
            this.updatePlayerCount();
        });

        this.socket.on('abilityRotated', (data) => {
            this.updateAbility(data.newAbility);
            this.nextRotation = data.nextRotation;
            this.showMessage(`Ability rotated: ${data.oldAbility} → ${data.newAbility.name}`, 'rotate');
        });

        this.socket.on('abilityUsed', (data) => {
            const player = this.players[data.playerId];
            if (player) {
                // Visual effect for ability use
                this.createAbilityEffect(player, data.ability);
            }
        });

        this.socket.on('abilityActivated', (data) => {
            this.abilityCooldown = data.cooldown;
        });

        this.socket.on('playerKilled', (data) => {
            const killer = this.players[data.killer];
            const victim = this.players[data.victim];

            if (killer && victim) {
                if (data.killer === this.playerId) {
                    this.showMessage(`You killed ${victim.name}! +100`, 'kill');
                } else if (data.victim === this.playerId) {
                    this.showMessage(`You were killed by ${killer.name}`, 'death');
                } else {
                    this.showMessage(`${killer.name} killed ${victim.name}`, 'kill');
                }
            }
        });

        this.socket.on('respawn', (data) => {
            const player = this.players[this.playerId];
            if (player) {
                player.x = data.x;
                player.y = data.y;
                player.isShielded = false;
                player.alive = true;
            }
        });

        this.socket.on('knocked', (data) => {
            const player = this.players[this.playerId];
            if (player) {
                player.x = data.x;
                player.y = data.y;
            }
        });

        this.socket.on('shieldEnd', () => {
            const player = this.players[this.playerId];
            if (player) {
                player.isShielded = false;
            }
        });
    }
    
    setupInput() {
        // Keyboard input
        document.addEventListener('keydown', (e) => {
            this.keys[e.key.toLowerCase()] = true;
            
            // Space for ability
            if (e.code === 'Space' && this.ability && this.abilityCooldown <= Date.now()) {
                this.useAbility();
                e.preventDefault();
            }
        });

        // Play as Guest button (header)
        const guestBtn = document.getElementById('guestPlayBtn');
        if (guestBtn) guestBtn.addEventListener('click', (e) => { e.preventDefault(); this.startGuestMode(); });
        
        document.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
        });
        
        // Mouse input
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const scaleX = this.canvas.width / rect.width;
            const scaleY = this.canvas.height / rect.height;
            
            this.mouse.x = (e.clientX - rect.left) * scaleX;
            this.mouse.y = (e.clientY - rect.top) * scaleY;
        });
        
        // Click to shoot (left-click) — space still uses ability
        this.canvas.addEventListener('click', (e) => {
            const p = this.players[this.playerId];
            if (p) this.shoot(p);
        });
        
        // Touch support: tap to shoot
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            const rect = this.canvas.getBoundingClientRect();
            this.mouse.x = (touch.clientX - rect.left) * (this.canvas.width / rect.width);
            this.mouse.y = (touch.clientY - rect.top) * (this.canvas.height / rect.height);
            const p = this.players[this.playerId];
            if (p) this.shoot(p);
        });

        // Toggle local 2-player with '2'
        document.addEventListener('keydown', (e) => {
            if (e.key === '2') {
                this.toggleLocalTwoPlayer();
                return;
            }

            // Enter to shoot for player 2 (when enabled)
            if (e.key === this.localTwoPlayerControls.shootKey && this.twoPlayerLocal && this.players[this.localPlayer2Id]) {
                this.shoot(this.players[this.localPlayer2Id]);
            }

            // Ability key for player2
            if (e.key === this.localTwoPlayerControls.abilityKey && this.twoPlayerLocal && this.players[this.localPlayer2Id]) {
                const p2 = this.players[this.localPlayer2Id];
                if (p2.ability && (p2.lastAbilityAt || 0) + (p2.ability.cooldown || 1000) <= Date.now()) {
                    this.applyAbilityLocally(p2, p2.ability.id);
                    p2.lastAbilityAt = Date.now();
                }
            }
        });
    }
    
    useAbility() {
        const player = this.players[this.playerId];
        if (!player || !this.ability) return;

        // Calculate rotation based on mouse position
        const dx = this.mouse.x - player.x;
        const dy = this.mouse.y - player.y;
        const rotation = Math.atan2(dy, dx);

        player.rotation = rotation;

        // set cooldown locally
        this.abilityCooldown = Date.now() + (this.ability.cooldown || 1000);

        if (this.localMode) {
            this.applyAbilityLocally(player, this.ability.id);
        } else if (this.socket) {
            this.socket.emit('useAbility', { rotation: rotation });
        }

        // Visual feedback
        this.createAbilityEffect(player, this.ability.id);
    }

    // Shoot a projectile from a player (uses per-player cooldown)
    shoot(actor) {
        if (!actor || !actor.alive) return;
        actor.lastGunAt = actor.lastGunAt || 0;
        const weapon = actor.weapon || this.weapons.pistol;
        if (actor.lastGunAt + weapon.cooldown > Date.now()) return;
        actor.lastGunAt = Date.now();

        for (let b = 0; b < (weapon.bullets || 1); b++) {
            let angle = actor.rotation || 0;
            if (weapon.spread && weapon.bullets > 1) {
                angle += (Math.random() - 0.5) * weapon.spread;
            }
            const x = actor.x + Math.cos(angle) * 18;
            const y = actor.y + Math.sin(angle) * 18;
            const vx = Math.cos(angle) * weapon.speed;
            const vy = Math.sin(angle) * weapon.speed;
            this.projectiles.push({ owner: actor.id, x: x, y: y, vx: vx, vy: vy, born: Date.now(), life: weapon.life, radius: weapon.radius });
        }

        // Visual feedback
        this.createAbilityEffect(actor, 'shoot');
    }

    // Internal: called to apply projectile effects if it hits
    handleProjectileHit(proj, target) {
        if (!target.alive) return false;
        const killer = this.players[proj.owner];
        if (!killer) return false;
        // Friendly fire blocked
        if (killer.team && target.team && killer.team === target.team) return false;
        if (target.isShielded) return false; // projectile blocked
        // Kill via central function (handles score, coins, kills)
        this.killPlayer(killer, target);
        return true;
    }
    
    createAbilityEffect(player, abilityId) {
        // This would create visual effects (particles, etc.)
        // For now, we'll just log it
        console.log(`${player.name} used ${abilityId}`);
    }
    
    updateAbility(ability) {
        this.ability = ability;

        // Update UI
        const currentEl = document.getElementById('currentAbility');
        if (currentEl && ability) {
            currentEl.innerHTML = `
                <i class="fas ${ability.icon || 'fa-question'}"></i>
                <span>${ability.name}</span>
            `;
            currentEl.style.borderColor = ability.color || '#4cc9f0';

            const icon = currentEl.querySelector('i');
            if (icon) {
                icon.style.color = ability.color || '#4cc9f0';
            }
        }
    }
    
    updateScoreboard() {
        this.scoreboard = Object.values(this.players)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10);
        
        const scoreList = document.getElementById('scoreList');
        if (!scoreList) return;
        
        scoreList.innerHTML = '';
        
        this.scoreboard.forEach((player, index) => {
            const scoreItem = document.createElement('div');
            scoreItem.className = 'score-item';
            if (player.id === this.playerId) {
                scoreItem.classList.add('you');
            }
            
            scoreItem.innerHTML = `
                <span class="rank">${index + 1}</span>
                <span class="player-name">${player.name}</span>
                <span class="player-stats"><span class="player-score">${player.score}</span> <span class="player-kills">${player.kills || 0} K</span> <span class="player-coins">💰${player.coins || 0}</span></span>
            `;
            
            scoreList.appendChild(scoreItem);
        });
        
        this.updatePlayerCount();
    }
    
    updatePlayerCount() {
        const count = Object.keys(this.players).length;
        document.getElementById('playerCount').textContent = count;
    }

    updateCoinUI() {
        const p = this.players[this.playerId];
        const el = document.getElementById('coinCount');
        if (el && p) el.textContent = p.coins || 0;
    }

    updateKillUI() {
        const p = this.players[this.playerId];
        const el = document.getElementById('killCount');
        if (el && p) el.textContent = p.kills || 0;
    }

    renderShop() {
        const container = document.getElementById('shopItems');
        if (!container) return;
        container.innerHTML = '';
        Object.keys(this.weapons).forEach(key => {
            const w = this.weapons[key];
            const item = document.createElement('div');
            item.className = 'shop-item';
            item.innerHTML = `<div><strong>${w.name}</strong> <small>(${w.bullets}x, ${w.cooldown}ms)</small></div><div><span>Price: ${w.price}</span> <button data-weapon="${w.id}">Buy</button></div>`;
            const btn = item.querySelector('button');
            btn.addEventListener('click', () => this.buyWeapon(w.id));
            container.appendChild(item);
        });
    }

    openShop() {
        document.getElementById('shopPanel')?.classList.remove('hidden');
        this.renderShop();
    }

    closeShop() {
        document.getElementById('shopPanel')?.classList.add('hidden');
    }

    // --- Login / auth UI (client) ---
    showLoginModal() {
        document.getElementById('loginModal')?.classList.remove('hidden');
    }

    closeLoginModal() {
        document.getElementById('loginModal')?.classList.add('hidden');
    }

    async signup(email, password, displayName) {
        try {
            const res = await fetch('http://localhost:3000/api/signup', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ email, password, displayName }), credentials: 'include' });
            const data = await res.json();
            if (!data.ok) return alert('Signup failed: '+(data.error||''));
            alert('Signup successful — check your email to verify your account. You can now log in.');
            // switch to login view in the form
            document.getElementById('showSignup').disabled = true; document.getElementById('showLogin').disabled = false;
        } catch (e) { alert('Signup error'); }
    }

    async login(email, password) {
        try {
            const res = await fetch('http://localhost:3000/api/login', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ email, password }), credentials: 'include' });
            const data = await res.json();
            if (!data.ok) return alert('Login failed: '+(data.error||''));
            if (data.accessToken) localStorage.setItem('accessToken', data.accessToken);
            this.closeLoginModal();
            this.connectToServer();
        } catch (e) { alert('Login error'); }
    }

    async refreshAccessToken() {
        try {
            const res = await fetch('http://localhost:3000/api/refresh-token', { method: 'POST', credentials: 'include' });
            const data = await res.json();
            if (data.ok && data.accessToken) {
                localStorage.setItem('accessToken', data.accessToken);
                return true;
            }
        } catch (e) {
            // ignore
        }
        return false;
    }

    // Start guest/local demo mode without redirecting user to login
    startGuestMode() {
        localStorage.setItem('guest', 'true');
        if (!localStorage.getItem('guestId')) localStorage.setItem('guestId', 'guest-'+Math.random().toString(36).slice(2,9));
        this.startLocalGame();
    }

    async logout() {
        try { await fetch('http://localhost:3000/api/logout', { method: 'POST', credentials: 'include' }); } catch(e) {}
        localStorage.removeItem('accessToken');
        if (this.socket) { this.socket.disconnect(); this.socket = null; }
        this.showLoginModal();
    }

    async requestPasswordReset(email) {
        try {
            const res = await fetch('http://localhost:3000/api/password-reset-request', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ email }) });
            const data = await res.json();
            if (data.ok) alert('If an account exists, a password reset email has been sent.');
        } catch (e) { alert('Error requesting password reset'); }
    }

    buyWeapon(weaponId) {
        const p = this.players[this.playerId];
        if (!p) return;
        const w = this.weapons[weaponId];
        if (!w) return this.showMessage('Weapon not found', 'warn');
        if ((p.coins || 0) < w.price) return this.showMessage('Not enough coins', 'warn');
        p.coins -= w.price;
        p.weapon = w;
        this.showMessage(`Purchased ${w.name}`, 'info');
        this.updateCoinUI();
        this.renderShop();
    }

    setMode(mode) {
        // If in local mode, restart local game with selected mode
        if (!this.localMode) return this.showMessage('Mode switching only available in local demo', 'warn');
        this.startLocalGame(mode);
    }
    
    showMessage(text, type = 'info') {
        // Transient 'bread' notifications disabled per request: only keep kill feed through addKillFeed
        if (type === 'kill') {
            const parts = text.split(' ');
            // try to extract names
            const maybe = text.match(/(.+) eliminated (.+)!/);
            if (maybe) this.addKillFeed(maybe[1], maybe[2]);
        }
        // else no-op
    }
    
    getMessageColor(type) {
        switch(type) {
            case 'kill': return '#06d6a0';
            case 'death': return '#ef476f';
            case 'rotate': return '#f72585';
            case 'join': return '#4cc9f0';
            case 'leave': return '#ffd166';
            default: return '#4cc9f0';
        }
    }
    
    startMatchTimer() {
        setInterval(() => {
            if (this.matchTime > 0) {
                this.matchTime--;
                const minutes = Math.floor(this.matchTime / 60);
                const seconds = this.matchTime % 60;
                document.getElementById('matchTimer').textContent = 
                    `${minutes}:${seconds.toString().padStart(2, '0')}`;
            }
        }, 1000);
    }
    
    gameLoop() {
        // Clear canvas
        this.ctx.fillStyle = '#0d1b2a';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw arena boundary
        this.ctx.strokeStyle = '#1b3a4b';
        this.ctx.lineWidth = 4;
        this.ctx.strokeRect(20, 20, this.arenaSize.width - 40, this.arenaSize.height - 40);
        
        // Draw grid
        this.ctx.strokeStyle = '#1b3a4b';
        this.ctx.lineWidth = 1;
        const gridSize = 100;
        for (let x = 0; x < this.arenaSize.width; x += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.arenaSize.height);
            this.ctx.stroke();
        }
        for (let y = 0; y < this.arenaSize.height; y += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(this.arenaSize.width, y);
            this.ctx.stroke();
        }
        
        // Draw map obstacles
        this.mapRects.forEach(r => {
            this.ctx.fillStyle = '#0f1720';
            this.ctx.fillRect(r.x, r.y, r.w, r.h);
            this.ctx.strokeStyle = 'rgba(255,255,255,0.04)';
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(r.x, r.y, r.w, r.h);
        });

        // Draw all players
        Object.values(this.players).forEach(player => {
            this.drawPlayer(player);
        });

        // Update and draw projectiles
        for (let i = this.projectiles.length - 1; i >= 0; i--) {
            const p = this.projectiles[i];
            const age = Date.now() - p.born;
            p.x += p.vx;
            p.y += p.vy;

            // Draw projectile
            this.ctx.beginPath();
            this.ctx.fillStyle = '#ffd166';
            this.ctx.arc(p.x, p.y, p.radius || this.gun.radius, 0, Math.PI * 2);
            this.ctx.fill();

            // Check collisions with players
            let removed = false;
            Object.values(this.players).forEach(pl => {
                if (removed) return;
                if (!pl.alive || pl.id === p.owner) return;
                const dx = pl.x - p.x;
                const dy = pl.y - p.y;
                const d = Math.hypot(dx, dy);
                const threshold = (p.radius || this.gun.radius) + 10; // player approx size
                if (d < threshold) {
                    if (this.handleProjectileHit(p, pl)) {
                        removed = true;
                    } else {
                        removed = true; // remove projectile on shield/ignored friendly
                    }
                }
            });

            // Check collisions with map
            if (!removed) {
                for (let m of this.mapRects) {
                    if (p.x > m.x && p.x < m.x + m.w && p.y > m.y && p.y < m.y + m.h) {
                        removed = true; break;
                    }
                }
            }

            // Remove if hit or expired or out of bounds
            if (removed || age > p.life || p.x < -50 || p.y < -50 || p.x > this.arenaSize.width + 50 || p.y > this.arenaSize.height + 50) {
                this.projectiles.splice(i, 1);
            }
        }

        // Update second player (if enabled)
        if (this.twoPlayerLocal) this.updateLocalSecondPlayer();

        // Draw mouse aim line for current player
        const currentPlayer = this.players[this.playerId];
        if (currentPlayer) {
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();
            this.ctx.moveTo(currentPlayer.x, currentPlayer.y);
            
            const dx = this.mouse.x - currentPlayer.x;
            const dy = this.mouse.y - currentPlayer.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const maxDistance = 150;
            const normalizedX = dx / distance * Math.min(distance, maxDistance);
            const normalizedY = dy / distance * Math.min(distance, maxDistance);
            
            this.ctx.lineTo(currentPlayer.x + normalizedX, currentPlayer.y + normalizedY);
            this.ctx.stroke();
            
            // Draw ability range indicator
            if (this.ability) {
                this.ctx.strokeStyle = (this.ability.color || '#4cc9f0') + '40';
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();

                switch(this.ability.id) {
                    case 'dash':
                        this.ctx.arc(currentPlayer.x, currentPlayer.y, 40, 0, Math.PI * 2);
                        break;
                    case 'blink':
                        this.ctx.arc(currentPlayer.x, currentPlayer.y, 30, 0, Math.PI * 2);
                        break;
                    case 'knockback':
                        this.ctx.arc(currentPlayer.x, currentPlayer.y, 120, 0, Math.PI * 2);
                        break;
                    case 'freeze':
                        this.ctx.arc(currentPlayer.x, currentPlayer.y, 100, 0, Math.PI * 2);
                        break;
                }
                this.ctx.stroke();
            }
        }
        
        // Update rotation timer
        const timeUntilRotation = Math.max(0, this.nextRotation - Date.now());
        const seconds = (timeUntilRotation / 1000).toFixed(1);
        document.getElementById('rotationTimer').textContent = `${seconds}s`;
        
        // Update cooldown bar
        const cooldownFill = document.getElementById('cooldownFill');
        if (cooldownFill) {
            const cooldownLeft = Math.max(0, this.abilityCooldown - Date.now());
            const totalCooldown = this.ability ? this.ability.cooldown : 1000;
            const percentage = Math.min(100, (cooldownLeft / totalCooldown) * 100);
            cooldownFill.style.width = `${percentage}%`;
        }
        
        // Send movement input to server
        this.sendMovement();
        
        // Request next frame
        requestAnimationFrame(() => this.gameLoop());
    }
    
    drawPlayer(player) {
        const isCurrentPlayer = player.id === this.playerId;

        if (!player.alive) {
            // Draw faint ghost for dead players
            this.ctx.beginPath();
            this.ctx.arc(player.x, player.y, 12, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(255,255,255,0.06)';
            this.ctx.fill();
            this.ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            this.ctx.stroke();

            this.ctx.fillStyle = '#ffdddd';
            this.ctx.font = '12px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('Respawning...', player.x, player.y - 25);
            return;
        }

        // Draw player body
        this.ctx.save();
        this.ctx.translate(player.x, player.y);
        this.ctx.rotate(player.rotation);

        // Shield effect
        if (player.isShielded) {
            this.ctx.beginPath();
            this.ctx.arc(0, 0, 25, 0, Math.PI * 2);
            this.ctx.fillStyle = '#06d6a040';
            this.ctx.fill();
            this.ctx.strokeStyle = '#06d6a0';
            this.ctx.lineWidth = 3;
            this.ctx.stroke();
        }

        // Player shape (triangle)
        this.ctx.beginPath();
        this.ctx.moveTo(15, 0);
        this.ctx.lineTo(-10, 10);
        this.ctx.lineTo(-10, -10);
        this.ctx.closePath();

        // Fill with player color
        this.ctx.fillStyle = player.color;
        this.ctx.fill();

        // Border
        this.ctx.strokeStyle = isCurrentPlayer ? '#ffffff' : '#cccccc';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();

        // Player name
        this.ctx.restore();
        this.ctx.fillStyle = isCurrentPlayer ? '#ffffff' : '#cccccc';
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(player.name, player.x, player.y - 25);

        // Score
        this.ctx.fillStyle = '#ffd166';
        this.ctx.font = 'bold 10px Arial';
        this.ctx.fillText(player.score.toString(), player.x, player.y - 35);
    }
    
    sendMovement() {
        const currentPlayer = this.players[this.playerId];
        if (!currentPlayer) return;

        // Calculate movement direction from keys
        let dx = 0, dy = 0;

        if (this.keys['w'] || this.keys['arrowup']) dy -= 1;
        if (this.keys['s'] || this.keys['arrowdown']) dy += 1;
        if (this.keys['a'] || this.keys['arrowleft']) dx -= 1;
        if (this.keys['d'] || this.keys['arrowright']) dx += 1;

        // Normalize diagonal movement
        if (dx !== 0 || dy !== 0) {
            const length = Math.sqrt(dx * dx + dy * dy);
            dx /= length;
            dy /= length;
        }

        // Apply speed modifiers
        let speed = 3;
        if (currentPlayer.speedBoostUntil && currentPlayer.speedBoostUntil > Date.now()) speed *= 1.8;
        if (currentPlayer.frozen && currentPlayer.frozen > Date.now()) {
            dx = 0; dy = 0;
        }
        if (currentPlayer.inverted && currentPlayer.inverted > Date.now()) {
            dx = -dx; dy = -dy;
        }

        // Update rotation based on mouse for local player
        if (this.mouse && this.playerId === currentPlayer.id) {
            const mx = this.mouse.x - currentPlayer.x;
            const my = this.mouse.y - currentPlayer.y;
            currentPlayer.rotation = Math.atan2(my, mx);
        }

        if (this.localMode) {
            // Collision-aware movement: attempt X then Y movement
            const moveX = dx * speed;
            const moveY = dy * speed;
            let newX = currentPlayer.x + moveX;
            let newY = currentPlayer.y;
            if (!this.collidesWithMap(newX, newY, 14)) {
                currentPlayer.x = this.clamp(newX, 30, this.arenaSize.width - 30);
            }
            newX = currentPlayer.x; newY = currentPlayer.y + moveY;
            if (!this.collidesWithMap(newX, newY, 14)) {
                currentPlayer.y = this.clamp(newY, 30, this.arenaSize.height - 30);
            }
        } else {
            // Send movement to server
            if (this.socket && (dx !== 0 || dy !== 0)) {
                this.socket.emit('move', {
                    dx: dx * speed,
                    dy: dy * speed,
                    rotation: currentPlayer.rotation
                });
            }
        }
    }

    // --- Local/demo helpers ---
    randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
    randomColor() {
        const r = this.randomInt(60, 220);
        const g = this.randomInt(60, 220);
        const b = this.randomInt(60, 220);
        return `rgb(${r},${g},${b})`;
    }

    pickRandomAbility() {
        const i = Math.floor(Math.random() * this.abilities.length);
        return this.abilities[i];
    }

    // Map collision test (point-in-rect, with buffer)
    collidesWithMap(x, y, buffer = 12) {
        for (let r of this.mapRects) {
            if (x > r.x - buffer && x < r.x + r.w + buffer && y > r.y - buffer && y < r.y + r.h + buffer) return true;
        }
        return false;
    }

    // Choose a spawn point (try random spawn points, fallback to random safe location)
    findSpawnPoint() {
        const shuffled = [...this.spawnPoints].sort(() => Math.random() - 0.5);
        for (let s of shuffled) {
            if (!this.collidesWithMap(s.x, s.y, 20)) return { x: s.x, y: s.y };
        }
        // fallback: random position not in map
        let tries = 0;
        while (tries++ < 50) {
            const x = this.randomInt(80, this.arenaSize.width - 80);
            const y = this.randomInt(80, this.arenaSize.height - 80);
            if (!this.collidesWithMap(x, y, 20)) return { x, y };
        }
        return { x: 100, y: 100 };
    }

    // --- Map chunk streaming ---
    // Load chunk by index (e.g., 0,1,2 maps to manifest names)
    async loadMapChunk(index) {
        const name = `map-city-1-chunk${index}`;
        if (this.mapChunksLoaded.has(name)) return;
        // show a small HUD indicator
        const badge = document.getElementById('bgLoadBadge');
        if (badge) {
            const txt = badge.querySelector('#bgProgressText'); if (txt) txt.textContent = `Loading chunk ${index}...`;
        }
        try {
            const data = await window.AssetLoader.loadAssetByName(name);
            // data expected to be JSON with blocks: [{x,y,w,h}, ...]
            if (data && Array.isArray(data.blocks)) {
                this.mapChunkRects[name] = [];
                data.blocks.forEach(b => {
                    const rect = { x: b.x, y: b.y, w: b.w, h: b.h };
                    this.mapRects.push(rect);
                    this.mapChunkRects[name].push(rect);
                });
            }
            this.mapChunksLoaded.add(name);
        } catch (err) {
            console.warn('Failed to load chunk', name, err);
        } finally {
            if (badge) {
                const txt = badge.querySelector('#bgProgressText'); if (txt) txt.textContent = 'Background loading: in progress';
            }
        }
    }

    unloadChunk(index) {
        const name = `map-city-1-chunk${index}`;
        if (!this.mapChunksLoaded.has(name)) return;
        if (this.mapChunkRects[name]) {
            // remove rects from mapRects
            this.mapRects = this.mapRects.filter(r => !this.mapChunkRects[name].includes(r));
            delete this.mapChunkRects[name];
        }
        this.mapChunksLoaded.delete(name);
    }

    loadMapChunksAroundPlayer() {
        const p = this.players[this.playerId];
        if (!p) return;
        const chunkX = Math.floor(p.x / this.chunkSize.width);
        // load chunks in radius
        const wanted = new Set();
        for (let dx = -this.chunkLoadRadius; dx <= this.chunkLoadRadius; dx++) {
            const idx = chunkX + dx;
            if (idx < 0) continue;
            wanted.add(idx);
            // fire and forget
            this.loadMapChunk(idx);
        }
        // unload chunks not wanted
        Array.from(this.mapChunksLoaded).forEach(name => {
            const m = name.match(/chunk(\d+)$/);
            if (!m) return;
            const idx = parseInt(m[1], 10);
            if (!wanted.has(idx)) this.unloadChunk(idx);
        });
    }

    // Persistent kill feed
    addKillFeed(killerName, victimName) {
        const entry = `${killerName} → ${victimName}`;
        this.killFeed.unshift(entry);
        if (this.killFeed.length > 26) this.killFeed.pop();
        this.updateKillBoard();
    }

    updateKillBoard() {
        const list = document.getElementById('killList');
        if (!list) return;
        list.innerHTML = '';
        this.killFeed.forEach(text => {
            const el = document.createElement('div');
            el.className = 'kill-item';
            el.textContent = text;
            list.appendChild(el);
        });
    }

    startLocalGame(mode = 'FFA') {
        this.localMode = true;
        this.mode = mode;
        this.difficulty = document.getElementById('difficultySelect') ? document.getElementById('difficultySelect').value : 'medium';
        // ensure arena size is set
        this.arenaSize = { width: 1600, height: 900 };

        // create local player
        this.playerId = 'local-' + Math.random().toString(36).slice(2, 9);
        const you = {
            id: this.playerId,
            name: 'You',
            x: this.randomInt(200, this.arenaSize.width - 200),
            y: this.randomInt(200, this.arenaSize.height - 200),
            rotation: 0,
            vx: 0, vy: 0,
            color: this.randomColor(),
            score: 0,
            alive: true,
            isShielded: false,
            lastGunAt: 0,
            lastAbilityAt: 0,
            kills: 0,
            coins: 0,
            weapon: this.weapons.pistol
        };
        you.ability = this.pickRandomAbility();
        this.players = {};
        this.players[this.playerId] = you;

        // Determine bot count by mode and difficulty
        let botCount = 6;
        if (mode === '1v50') botCount = 50;
        else if (mode === '20v20') botCount = 40;
        else if (mode === 'FFA') botCount = 7;
        // difficulty adjustments
        if (this.difficulty === 'easy') botCount = Math.max(3, Math.floor(botCount * 0.6));
        if (this.difficulty === 'hard') botCount = Math.min(80, Math.floor(botCount * 1.6));

        // Add bots
        this.bots = [];
        for (let i = 0; i < botCount; i++) {
            const id = 'bot-' + i;
            const bot = {
                id: id,
                name: `Bot${i+1}`,
                x: this.randomInt(100, this.arenaSize.width - 100),
                y: this.randomInt(100, this.arenaSize.height - 100),
                rotation: 0,
                vx: 0, vy: 0,
                color: this.randomColor(),
                score: 0,
                alive: true,
                isShielded: false,
                nextAction: Date.now() + this.randomInt(300, 1500),
                lastGunAt: 0,
                lastAbilityAt: 0,
                kills: 0,
                coins: 0,
                weapon: this.weapons.pistol,
                team: null
            };

            // Team assignment for team modes
            if (mode === '1v50') {
                bot.team = 1; // bots vs single player
                you.team = 0;
            } else if (mode === '20v20') {
                bot.team = i % 2; // two teams
                you.team = 0;
            }

            bot.ability = this.pickRandomAbility();
            this.players[id] = bot;
            this.bots.push(bot);
        }

        this.nextRotation = Date.now() + 10000;
        this.rotateTimerInterval && clearInterval(this.rotateTimerInterval);
        this.rotateTimerInterval = setInterval(() => this.rotateAbilitiesLocal(), 10000);
        this.botInterval && clearInterval(this.botInterval);
        this.botInterval = setInterval(() => this.simulateBots(), 200);

        this.updateScoreboard();
        this.updatePlayerCount();
        this.updateAbility(this.players[this.playerId].ability);

        // initial next preview
        const nextPreview = this.pickRandomAbility();
        const nextEl = document.getElementById('nextAbility');
        if (nextEl) {
            nextEl.innerHTML = `\n                <i class="fas ${nextPreview.icon}"></i>\n                <span>${nextPreview.name}</span>\n            `;
        }

        this.renderShop();
        this.updateCoinUI();
        this.updateKillUI();

        this.showMessage(`Local demo mode: ${botCount} bots. Mode: ${mode}`, 'info');
    }

    rotateAbilitiesLocal() {
        // Each player gets a new random ability simultaneously
        const newAbilities = {};
        Object.keys(this.players).forEach(pid => {
            const a = this.pickRandomAbility();
            newAbilities[pid] = a;
            this.players[pid].ability = a;
        });
        this.nextRotation = Date.now() + 10000;
        if (this.players[this.playerId]) this.updateAbility(this.players[this.playerId].ability);

        // Update NEXT preview randomly for UI
        const nextPreview = this.pickRandomAbility();
        const nextEl = document.getElementById('nextAbility');
        if (nextEl) {
            nextEl.innerHTML = `\n                <i class="fas ${nextPreview.icon}"></i>\n                <span>${nextPreview.name}</span>\n            `;
        }

        this.showMessage('Abilities rotated!', 'rotate');

        // If connected to server, notify server that rotation happened (server authoritative will broadcast too)
        if (this.socket) this.socket.emit('clientRotateRequest', {});
    }

    simulateBots() {
        // Smarter AI: target nearest vulnerable player, shoot when in range, dodge incoming projectiles, use abilities defensively
        const bots = Object.values(this.players).filter(p => p && p.id.startsWith('bot-') && p.alive);
        const playersArr = Object.values(this.players).filter(p => p && p.alive);

        bots.forEach(bot => {
            // Choose target: nearest non-bot player
            let targets = playersArr.filter(p => p.id !== bot.id);
            if (targets.length === 0) return;
            targets.sort((a,b) => (Math.hypot(a.x - bot.x, a.y - bot.y) - Math.hypot(b.x - bot.x, b.y - bot.y)));
            const target = targets[0];

            // Predictive aiming: estimate target's future position
            const vx = (target.vx || 0);
            const vy = (target.vy || 0);
            const dist = Math.hypot(target.x - bot.x, target.y - bot.y) || 1;
            const travelTime = dist / (this.gun.speed || 8);
            const predictedX = target.x + vx * travelTime * 0.9;
            const predictedY = target.y + vy * travelTime * 0.9;
            // difficulty affects aim jitter
            let aimJitter = 0.12;
            if (this.difficulty === 'easy') aimJitter = 0.32;
            if (this.difficulty === 'hard') aimJitter = 0.02;
            bot.rotation = Math.atan2(predictedY - bot.y, predictedX - bot.x) + (Math.random()-0.5)*aimJitter;

            // Move toward target but keep some spacing
            const desiredDist = 160;
            const speed = 2.2;
            if (dist > desiredDist) {
                const nx = bot.x + Math.cos(bot.rotation) * speed;
                const ny = bot.y + Math.sin(bot.rotation) * speed;
                if (!this.collidesWithMap(nx, ny, 14)) {
                    bot.x = nx; bot.y = ny;
                } else {
                    bot.rotation += (Math.random() > 0.5 ? 1 : -1) * (Math.PI * 0.35);
                }
            } else {
                // strafe around target
                const nx = bot.x + Math.cos(bot.rotation + Math.PI / 2) * (Math.random() * 1.2);
                const ny = bot.y + Math.sin(bot.rotation + Math.PI / 2) * (Math.random() * 1.2);
                if (!this.collidesWithMap(nx, ny, 14)) {
                    bot.x = nx; bot.y = ny;
                } else {
                    bot.rotation += (Math.random() > 0.5 ? 1 : -1) * (Math.PI * 0.35);
                }
            }

            // Dodge incoming projectiles: if a projectile is heading near bot, move perpendicular
            const incoming = this.projectiles.find(pr => {
                const relx = bot.x - pr.x;
                const rely = bot.y - pr.y;
                const projDirDot = (pr.vx * relx + pr.vy * rely);
                const distProj = Math.hypot(relx, rely);
                return projDirDot > 0 && distProj < 160;
            });
            if (incoming) {
                // dodge perpendicular
                bot.x += Math.cos(incoming.vx ? Math.atan2(incoming.vy, incoming.vx) + Math.PI/2 : Math.PI/2) * 4;
                bot.y += Math.sin(incoming.vx ? Math.atan2(incoming.vy, incoming.vx) + Math.PI/2 : Math.PI/2) * 4;
            }

            // Use ability defensively if close and ability available (e.g., shield or blink)
            if (bot.ability && (bot.lastAbilityAt || 0) + (bot.ability.cooldown || 1000) <= Date.now()) {
                // Difficulty affects bot willingness/accuracy
                let useChance = 0.35;
                if (this.difficulty === 'easy') useChance = 0.18;
                if (this.difficulty === 'hard') useChance = 0.65;
                // If target very close, try knockback or freeze; if multiple enemies nearby, shield; random chance
                const closeEnemies = playersArr.filter(p => p.id !== bot.id && Math.hypot(p.x - bot.x, p.y - bot.y) < 120);
                if (closeEnemies.length > 0 && Math.random() < useChance) {
                    this.applyAbilityLocally(bot, bot.ability.id);
                    bot.lastAbilityAt = Date.now();
                } else if (Math.random() < (useChance*0.2)) {
                    this.applyAbilityLocally(bot, bot.ability.id);
                    bot.lastAbilityAt = Date.now();
                }
            }

            // Shoot if in effective range and cooldown ready
            const shootRange = 480;
            if (dist < shootRange && (!bot.lastGunAt || bot.lastGunAt + this.gun.cooldown <= Date.now())) {
                this.shoot(bot);
            }

            // Keep inside arena
            bot.x = this.clamp(bot.x, 30, this.arenaSize.width - 30);
            bot.y = this.clamp(bot.y, 30, this.arenaSize.height - 30);
        });
    }

    applyAbilityLocally(actor, abilityId) {
        const ability = this.abilities.find(a => a.id === abilityId);
        if (!ability) return;

        // Cooldown for actor
        actor.lastUsed = actor.lastUsed || {};
        if (actor.lastUsed[abilityId] && actor.lastUsed[abilityId] + ability.cooldown > Date.now()) return;
        actor.lastUsed[abilityId] = Date.now();

        // Visual
        this.createAbilityEffect(actor, abilityId);

        switch (abilityId) {
            case 'dash': {
                const dx = Math.cos(actor.rotation);
                const dy = Math.sin(actor.rotation);
                actor.x += dx * ability.range;
                actor.y += dy * ability.range;
                break;
            }
            case 'blink': {
                if (actor.id === this.playerId) {
                    // teleport to mouse within range
                    const mx = this.mouse.x || actor.x;
                    const my = this.mouse.y || actor.y;
                    const dx = mx - actor.x;
                    const dy = my - actor.y;
                    const d = Math.hypot(dx, dy) || 1;
                    const max = ability.range;
                    const ratio = Math.min(1, max / d);
                    actor.x += dx * ratio;
                    actor.y += dy * ratio;
                } else {
                    // bot teleports a bit towards a random player
                    const targets = Object.values(this.players).filter(p => p.id !== actor.id && p.alive);
                    if (targets.length) {
                        const t = targets[Math.floor(Math.random() * targets.length)];
                        const dx = t.x - actor.x;
                        const dy = t.y - actor.y;
                        const d = Math.hypot(dx, dy) || 1;
                        const ratio = Math.min(1, ability.range / d);
                        actor.x += dx * ratio;
                        actor.y += dy * ratio;
                    }
                }
                break;
            }
            case 'knockback': {
                const range = ability.range;
                Object.values(this.players).forEach(other => {
                    if (other.id === actor.id || !other.alive) return;
                    const dx = other.x - actor.x;
                    const dy = other.y - actor.y;
                    const d = Math.hypot(dx, dy);
                    if (d <= range) {
                        // push away
                        const push = 120;
                        other.x += (dx / d) * push;
                        other.y += (dy / d) * push;
                        // kill if very close and not shielded
                        if (d < 40 && !other.isShielded) {
                            this.killPlayer(actor, other);
                        }
                    }
                });
                break;
            }
            case 'shield': {
                actor.isShielded = true;
                setTimeout(() => { actor.isShielded = false; }, ability.duration);
                break;
            }
            case 'speed': {
                actor.speedBoostUntil = Date.now() + ability.duration;
                break;
            }
            case 'gravity': {
                // invert controls of nearby players
                Object.values(this.players).forEach(other => {
                    if (other.id === actor.id) return;
                    const dx = other.x - actor.x;
                    const dy = other.y - actor.y;
                    const d = Math.hypot(dx, dy);
                    if (d < 220) {
                        other.inverted = Date.now() + ability.duration;
                    }
                });
                break;
            }
            case 'freeze': {
                Object.values(this.players).forEach(other => {
                    if (other.id === actor.id) return;
                    const dx = other.x - actor.x;
                    const dy = other.y - actor.y;
                    const d = Math.hypot(dx, dy);
                    if (d <= ability.range && !other.isShielded) {
                        other.frozen = Date.now() + ability.duration;
                        // close-range freeze kills
                        if (d < 30) this.killPlayer(actor, other);
                    }
                });
                break;
            }
        }

        // Clamp after effect
        actor.x = this.clamp(actor.x, 30, this.arenaSize.width - 30);
        actor.y = this.clamp(actor.y, 30, this.arenaSize.height - 30);
    }

    killPlayer(killer, victim) {
        if (!victim.alive) return;
        // friendly fire guard
        if (killer.team && victim.team && killer.team === victim.team) {
            this.showMessage(`${killer.name} hit teammate ${victim.name}! No points.`, 'warn');
            return;
        }

        victim.alive = false;
        killer.score = (killer.score || 0) + 100;
        killer.kills = (killer.kills || 0) + 1;
        killer.coins = (killer.coins || 0) + 1;
        this.showMessage(`${killer.name} eliminated ${victim.name}! +100`, 'kill');
        // add persistent kill feed
        this.addKillFeed(killer.name, victim.name);
        // respawn after delay
        setTimeout(() => this.respawnPlayer(victim), 2000);
        this.updateScoreboard();
        this.updateCoinUI();
        this.updateKillUI();
    }

    respawnPlayer(player) {
        player.alive = true;
        const s = this.findSpawnPoint();
        player.x = s.x; player.y = s.y;
        player.isShielded = false;
        player.frozen = 0;
        player.inverted = 0;
        this.showMessage(`${player.name} respawned`, 'info');
    }

    clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
}

// Start the game when page loads and wire up auth UI
window.addEventListener('load', () => {
    const game = new RotateIOGame();

    // Auth UI wiring: simple toggles
    document.getElementById('showLogin').addEventListener('click', () => {
        document.getElementById('showLogin').disabled = true; document.getElementById('showSignup').disabled = false;
    });
    document.getElementById('showSignup').addEventListener('click', () => {
        document.getElementById('showLogin').disabled = false; document.getElementById('showSignup').disabled = true;
    });

    const authForm = document.getElementById('authForm');
    authForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = document.getElementById('authUser').value.trim();
        const pass = document.getElementById('authPass').value.trim();
        if (!user || !pass) return alert('Enter username/password');
        // when showSignup button is NOT disabled, it means Signup is active
        if (!document.getElementById('showSignup').disabled) {
            game.signup(user, pass);
            document.getElementById('showSignup').disabled = true;
            document.getElementById('showLogin').disabled = false;
        } else {
            game.login(user, pass);
            document.getElementById('showLogin').disabled = true;
            document.getElementById('showSignup').disabled = false;
        }
    });

    // difficulty select safer defaults
    const dSel = document.getElementById('difficultySelect');
    if (dSel) {
        dSel.addEventListener('change', () => {
            // if running local, restart with the selected difficulty
            if (game.localMode) game.startLocalGame(game.mode);
        });
    }

    // mode buttons should start local games when clicked (now with difficulty)
    document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => game.startLocalGame(b.dataset.mode || 'FFA')));

    // lobby UI handlers
    const createLobbyBtn = document.getElementById('createLobbyBtn');
    const joinLobbyBtn = document.getElementById('joinLobbyBtn');
    const lobbyCodeInput = document.getElementById('lobbyCodeInput');
    if (createLobbyBtn) createLobbyBtn.addEventListener('click', async () => {
        // Open the dedicated lobby page to create a lobby (server interaction handled there)
        window.location.href = 'lobby.html?action=create';
    });
    if (joinLobbyBtn) joinLobbyBtn.addEventListener('click', async () => {
        const code = (lobbyCodeInput && lobbyCodeInput.value) ? lobbyCodeInput.value.trim().toUpperCase() : '';
        if (code) window.location.href = `lobby.html?join=${encodeURIComponent(code)}`;
        else window.location.href = 'lobby.html';
    });

    // shop buttons
    document.getElementById('openShopBtn').addEventListener('click', () => game.openShop());
    document.getElementById('closeShopBtn').addEventListener('click', () => game.closeShop());

    // forgot password
    const forgot = document.getElementById('forgotPasswordLink');
    if (forgot) forgot.addEventListener('click', (e) => { e.preventDefault(); const email = prompt('Enter your account email'); if (email) game.requestPasswordReset(email); });

    // Lobby overlay handlers
    const lobbyOverlay = document.getElementById('lobbyOverlay');
    const lobbyCodeTitle = document.getElementById('lobbyCodeTitle');
    const lobbyMembers = document.getElementById('lobbyMembers');
    const leaveLobbyBtn = document.getElementById('leaveLobbyBtn');
    const startLobbyBtn = document.getElementById('startLobbyBtn');
    let lobbyPollInterval = null;

    function showLobbyOverlay(lobby) {
        if (!lobbyOverlay) return;
        lobbyOverlay.classList.remove('hidden');
        lobbyCodeTitle.textContent = lobby.code;
        updateLobbyMembers(lobby);
        // only host can start
        const myId = game.playerId || ('guest-'+Math.random().toString(36).slice(2,8));
        startLobbyBtn.style.display = (lobby.hostId === myId) ? 'inline-block' : 'none';
        // start polling
        if (lobbyPollInterval) clearInterval(lobbyPollInterval);
        lobbyPollInterval = setInterval(() => pollLobby(lobby.code), 2000);
    }

    function hideLobbyOverlay() { if (!lobbyOverlay) return; lobbyOverlay.classList.add('hidden'); if (lobbyPollInterval) { clearInterval(lobbyPollInterval); lobbyPollInterval = null; } }

    function updateLobbyMembers(lobby) {
        if (!lobbyMembers) return;
        lobbyMembers.innerHTML = '';
        lobby.members.forEach(m => {
            const el = document.createElement('div'); el.className = 'lobby-member'; el.textContent = m; lobbyMembers.appendChild(el);
        });
    }

    async function pollLobby(code) {
        try {
            const res = await fetch(`http://localhost:3000/api/lobby/${code}`);
            const data = await res.json();
            if (!data.ok) { hideLobbyOverlay(); return; }
            updateLobbyMembers(data.lobby);
        } catch (e) { console.warn('Lobby poll error', e); }
    }

    if (leaveLobbyBtn) leaveLobbyBtn.addEventListener('click', () => { hideLobbyOverlay(); });
    if (startLobbyBtn) startLobbyBtn.addEventListener('click', async () => {
        const code = lobbyCodeTitle.textContent;
        const hostId = game.playerId || ('guest-'+Math.random().toString(36).slice(2,8));
        try {
            const res = await fetch('http://localhost:3000/api/lobby/start', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ code, hostId }) });
            const data = await res.json();
            if (!data.ok) return alert('Start failed: '+(data.error||''));
            hideLobbyOverlay();
            alert('Match started! Connect to ' + data.server.url + ' matchId=' + data.matchId);
            // Optionally auto-connect to match server here
        } catch (e) { alert('Start failed'); }
    });

    // Attempt connection (connectToServer will try refresh and show login if needed)
    game.connectToServer();
});