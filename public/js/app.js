/* Overlay entry point: binds the host's chat stream to the renderer. */
import * as M from './render.js';
import { connect, post } from './net.js';

const QS = new URLSearchParams(location.search);
const OBS = QS.get('obs') === '1';
const SOLO = QS.get('solo') === '1';          // run without a host (local testing)
// Боты оверлея — только без хоста: с хостом в матче играет лишь его состав.
const SIMULATE = SOLO;
if (OBS) document.documentElement.classList.add('obs');

M.mount(document.getElementById('stage'), {
  lobby: QS.get('lobby') ? +QS.get('lobby') : undefined,
  bots: QS.get('bots') ? +QS.get('bots') : undefined,
  winners: QS.get('winners') ? +QS.get('winners') : undefined,
  min: QS.get('min') ? +QS.get('min') : undefined,
  simulate: SIMULATE,
  host: !SOLO,
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
      case 'phase': M.syncLobby(m.session); break;
      // Остров уже выбран хостом: оверлей рассаживает ровно так же.
      case 'join': M.addPlayer({ key: m.key, display: m.display, platform: m.platform }, m.island || m.choice); break;
      case 'cmd': runCmd(m); break;
    }
  });

  function applySession(s) {
    if (!s) return;
    const lobby = () => {
      M.startLobby({ seed: s.seed, winners: s.winners, lobby: s.lobbyDur, left: s.lobbyLeft, min: s.minPlayers });
      for (const p of s.roster || []) M.addPlayer(p, p.island || p.choice);
    };
    // Перезагрузка посреди матча: тот же матч, догнанный до шага хоста.
    if (s.match) { M.playMatch(s.match.params, s.draw, s.match.steps); return; }
    if (s.phase === 'lobby' || s.phase === 'sealing') lobby();
    if (s.phase === 'sealing' && s.draw) M.seal(s.draw);
  }

  function runCmd(m) {
    switch (m.name) {
      case 'start': M.startLobby({ seed: m.seed, winners: m.winners, lobby: m.lobby, min: m.min }); break;
      case 'seal': M.seal(m); break;
      case 'match': M.playMatch(m.params, m.draw, 0); break;
      case 'annul': M.annul(m); break;
      case 'reset': M.newGame(false); break;
      case 'winners': M.setWinners(m.value); break;
    }
  }

  /* ---- overlay -> host ----
     Исход считает хост; победителей оверлей отправляет только для сверки. */
  M.onEvent((type, data) => {
    if (type === 'win') post('/api/report', Object.assign({ type }, data));
  });
  window.addEventListener('beforeunload', () => net.close());
}
