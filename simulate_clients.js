const { io } = require('socket.io-client');
const argv = require('minimist')(process.argv.slice(2));

const SERVER = argv.server || 'http://localhost:4001';
const COUNT = parseInt(argv.count || '6', 10);

function makeToken(id) {
  // In a prod flow you'd get a JWT from auth; for prototype we pass a dummy token with sub=id
  const payload = { sub: id };
  // encode base64 (no signature) for simple handshake in prototyping
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

for (let i=0;i<COUNT;i++) {
  const token = makeToken('sim-'+i);
  const socket = io(SERVER, { auth: { token } });
  socket.on('connect', () => {
    console.log('sim connected', i, socket.id);
    // join a demo match (ensure it's started via the match server)
    socket.emit('joinMatch', { matchId: argv.match || 'demo-1' });
    setInterval(() => {
      // send random inputs
      const dx = (Math.random()-0.5) * 4;
      const dy = (Math.random()-0.5) * 4;
      const rot = Math.random() * Math.PI * 2;
      socket.emit('input', { matchId: argv.match || 'demo-1', tick: Date.now(), dx, dy, rotation: rot, shoot: Math.random() > 0.97 });
    }, 200);
  });

  socket.on('init', (d) => console.log('init', d.playerId));
  socket.on('gameUpdate', (u) => {});
}
