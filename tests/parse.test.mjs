/* Parser unit tests, using real Twitch IRC lines so the read path is verified
   without waiting for a live channel. */
import { parseIrc, rolesFromBadges } from '../server/adapters/twitch.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); };

const LINES = [
  ['plain viewer',
   '@badge-info=;badges=;color=#1E90FF;display-name=SomeViewer;emotes=;first-msg=0;flags=;id=abc-123;mod=0;returning-chatter=0;room-id=12826;subscriber=0;tmi-sent-ts=1700000000000;turbo=0;user-id=98765;user-type= :someviewer!someviewer@someviewer.tmi.twitch.tv PRIVMSG #twitch :!join 2',
   { userId: '98765', display: 'SomeViewer', text: '!join 2', mod: false, sub: false, broadcaster: false }],
  ['moderator',
   '@badge-info=subscriber/12;badges=moderator/1,subscriber/12;display-name=ModPerson;mod=1;subscriber=1;user-id=11111;user-type=mod :modperson!modperson@modperson.tmi.twitch.tv PRIVMSG #twitch :!meteor go',
   { userId: '11111', display: 'ModPerson', text: '!meteor go', mod: true, sub: true, broadcaster: false }],
  ['broadcaster',
   '@badges=broadcaster/1;display-name=TheStreamer;mod=0;subscriber=0;user-id=22222 :thestreamer!thestreamer@thestreamer.tmi.twitch.tv PRIVMSG #twitch :!meteor winners 3',
   { userId: '22222', display: 'TheStreamer', text: '!meteor winners 3', mod: false, sub: false, broadcaster: true }],
  ['message containing a colon',
   '@display-name=Colon;user-id=333 :colon!colon@colon.tmi.twitch.tv PRIVMSG #twitch :time is 12:30 lol',
   { userId: '333', display: 'Colon', text: 'time is 12:30 lol', mod: false, sub: false, broadcaster: false }],
  ['cyrillic display name',
   '@display-name=ХолодныйКот;user-id=444 :kot!kot@kot.tmi.twitch.tv PRIVMSG #twitch :!join',
   { userId: '444', display: 'ХолодныйКот', text: '!join', mod: false, sub: false, broadcaster: false }],
];

for (const [name, line, want] of LINES) {
  const got = parseIrc(line);
  const ok = got && got.userId === want.userId && got.display === want.display && got.text === want.text
    && got.roles.mod === want.mod && got.roles.sub === want.sub && got.roles.broadcaster === want.broadcaster;
  check(name, ok, ok ? '' : JSON.stringify(got));
}

check('non-PRIVMSG lines are ignored', parseIrc(':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!') === null);
check('JOIN lines are ignored', parseIrc(':justinfan1!justinfan1@justinfan1.tmi.twitch.tv JOIN #twitch') === null);

const r = rolesFromBadges([{ set_id: 'vip' }, { set_id: 'subscriber' }], false);
check('eventsub badges map to roles', r.vip && r.sub && !r.mod && !r.broadcaster);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
