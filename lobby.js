(async function(){
  const params = new URLSearchParams(window.location.search);
  const action = params.get('action');
  const joinCode = params.get('join');
  const base = 'http://localhost:3000';

  const doJoinBtn = document.getElementById('doJoinBtn');
  const doCreateBtn = document.getElementById('doCreateBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const startBtn = document.getElementById('startBtn');
  const lobbyView = document.getElementById('lobbyView');
  const lobbyControls = document.getElementById('lobbyControls');
  const membersEl = document.getElementById('lobbyMembers');
  const codeTitle = document.getElementById('lobbyCodeTitle');
  const lobbyStatus = document.getElementById('lobbyStatus');
  const joinInput = document.getElementById('lobbyJoinCode');

  let pollInterval = null;
  let currentCode = null;
  let currentHostId = null;

  function updateMembers(list){
    membersEl.innerHTML = '';
    list.forEach(m => {
      const d = document.createElement('div'); d.textContent = m; d.className = 'lobby-member'; d.style.marginBottom='6px'; membersEl.appendChild(d);
    });
  }

  async function poll(code){
    try {
      const res = await fetch(`${base}/api/lobby/${code}`);
      const data = await res.json();
      if (!data.ok) { lobbyStatus.textContent = 'Lobby not found'; clearInterval(pollInterval); pollInterval=null; return; }
      currentHostId = data.lobby.hostId;
      codeTitle.textContent = data.lobby.code;
      updateMembers(data.lobby.members || []);
      lobbyStatus.textContent = `Players: ${data.lobby.members.length}`;
      // show start button only for host
      const myId = localStorage.getItem('guest') === 'true' ? ('guest-'+localStorage.getItem('guestId') || 'guest') : (localStorage.getItem('playerId') || 'me');
      startBtn.style.display = (currentHostId === myId) ? 'inline-block' : 'none';
    } catch (err) {
      console.warn('poll error', err);
    }
  }

  async function createLobby(){
    const hostId = localStorage.getItem('playerId') || ('guest-'+Math.random().toString(36).slice(2,8));
    localStorage.setItem('playerId', hostId);
    try {
      const res = await fetch(`${base}/api/lobby/create`, { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ mode:'FFA', map:'city-1', hostId }) });
      const data = await res.json();
      if (!data.ok) return alert('Could not create lobby: '+(data.error||''));
      showLobby(data.lobby);
    } catch (err) { alert('Create lobby failed'); }
  }

  async function joinLobby(code){
    const userId = localStorage.getItem('playerId') || ('guest-'+Math.random().toString(36).slice(2,8));
    localStorage.setItem('playerId', userId);
    try {
      const res = await fetch(`${base}/api/lobby/join`, { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code, userId }) });
      const data = await res.json();
      if (!data.ok) return alert('Join failed: '+(data.error||''));
      showLobby(data.lobby);
    } catch (err) { alert('Join failed'); }
  }

  function showLobby(lobby){
    currentCode = lobby.code;
    lobbyControls.classList.add('hidden');
    lobbyView.classList.remove('hidden');
    codeTitle.textContent = lobby.code;
    updateMembers(lobby.members || []);
    lobbyStatus.textContent = `Players: ${lobby.members.length}`;
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(()=>poll(lobby.code), 2000);
  }

  doCreateBtn.addEventListener('click', (e)=>{
    createLobby();
  });
  doJoinBtn.addEventListener('click', (e)=>{
    const c = (joinInput.value || '').trim().toUpperCase(); if (!c) return alert('Enter code'); joinLobby(c);
  });

  leaveBtn.addEventListener('click', ()=>{
    // simple leave: stop polling and go back
    if (pollInterval) clearInterval(pollInterval);
    window.location.href = 'index.html';
  });

  startBtn.addEventListener('click', async ()=>{
    if (!currentCode) return;
    try {
      const res = await fetch(`${base}/api/lobby/start`, { method: 'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ code: currentCode }) });
      const data = await res.json();
      if (!data.ok) return alert('Start failed: '+(data.error||''));
      lobbyStatus.textContent = 'Match starting — you will be redirected to the match server shortly.';
      // optionally redirect to the match server URL if provided
      if (data.matchServer && data.matchServer.url) {
        window.location.href = data.matchServer.url;
      }
    } catch (err) { alert('Start failed'); }
  });

  // If query asked to create or join, do it automatically
  if (action === 'create') createLobby();
  if (joinCode) joinLobby(joinCode);
})();