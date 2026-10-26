/* Overlay entry point: binds the host's chat stream to the renderer. */
import * as M from './render.js';
import { connect, post } from './net.js';

const QS = new URLSearchParams(location.search);
const OBS = QS.get('obs') === '1';
const SOLO = QS.get('solo') === '1';          // run without a host (local testing)
const SIMULATE = QS.get('bots') !== null || SOLO;
if (OBS) document.documentElement.classList.add('obs');

M.mount(document.getElementById('stage'), {
  lobby: QS.get('lobby') ? +QS.get('lobby') : undefined,
  bots: QS.get('bots') ? +QS.get('bots') : undefined,
  winners: QS.get('winners') ? +QS.get('winners') : undefined,
  min: QS.get('min') ? +QS.get('min') : undefined,
  simulate: SIMULATE,
});

if (SOLO) {
  // No host: expose the controller for the on-page debug console.
  window.Meteor = M;
} else {
  /* ---- host -> overlay ---- */
  const net = connect('overlay', m => {
    switch (m.t) {
      case 'hello':
      case 'resync':
        if (m.session) applySession(m.session);
        break;
      case 'join': {
        const r = M.addPlayer({ key: m.key, display: m.display, platform: m.platform }, m.choice);
        post('/api/report', { type: 'joinResult', key: m.key, ok: !!r, island: r ? r.island : 0 });
        break;
      }
      case 'cmd': runCmd(m); break;
    }
  });

  function applySession(s) {
    if (!s || !s.open) return;
    // Rebuild the lobby from the host's seed so a reloaded overlay lands on the same match.
    M.startLobby({ seed: s.seed, winners: s.winners, lobby: s.lobbyDur, left: s.lobbyLeft, min: s.minPlayers, simulate: s.simulate, bots: s.bots });
    // `island` is the seat the overlay reported earlier; it beats the raw choice
    // so an automatic pick is not re-rolled onto a different island on reload.
    for (const p of s.roster || []) M.addPlayer(p, p.island || p.choice);
  }

  function runCmd(m) {
    switch (m.name) {
      case 'start': M.startLobby({ seed: m.seed, winners: m.winners, lobby: m.lobby, min: m.min, simulate: m.simulate, bots: m.bots }); break;
      case 'go': M.forceStart(); break;
      case 'reset': M.newGame(false); break;
      case 'winners': M.setWinners(m.value); break;
    }
  }

  /* ---- overlay -> host ---- */
  M.onEvent((type, data) => {
    if (type === 'phase' || type === 'win' || type === 'kill' || type === 'newgame') {
      post('/api/report', Object.assign({ type }, data));
    }
  });
  window.addEventListener('beforeunload', () => net.close());
}
