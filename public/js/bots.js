/* Synthetic chat participants, used to exercise the game without a live chat. */
const NA = ['Dark', 'Kot', 'Shadow', 'Neko', 'Ghost', 'Lazy', 'Pixel', 'Toxic', 'Moon', 'Ice', 'Vortex', 'Panda', 'Sanya', 'Lyoha', 'Kirill', 'Vasya', 'Dimon', 'Mr', 'Zloy', 'Tihiy', 'Crazy', 'Sleepy', 'Turbo', 'Mega', 'Night', 'Frost', 'Lucky', 'Old', 'Baby', 'Red', 'Blue', 'Silent', 'Danya', 'Artem', 'Masha', 'Katya', 'Nastya', 'Igor', 'Borsch', 'Pelmen'];
const NB = ['Wolf', 'Cat', 'Gamer', 'Hunter', 'Fox', 'Ninja', 'Bear', 'Pro', 'Slayer', 'Potato', 'Goose', 'Knight', 'Sniper', 'Dragon', 'Owl', 'Rider', 'Boss', 'Kid', 'Lord', 'Shark', 'Pirate', 'Mage', 'Chill', 'Bober', 'Enot'];

export function makeBots(n) {
  const out = new Set();
  while (out.size < n) {
    const a = NA[Math.floor(Math.random() * NA.length)], b = NB[Math.floor(Math.random() * NB.length)], r = Math.random();
    out.add(r < 0.3 ? a + b : r < 0.55 ? a + '_' + b : r < 0.75 ? a.toLowerCase() + b + Math.floor(Math.random() * 999) : r < 0.88 ? 'xX' + b + 'Xx' : b.toLowerCase() + '_' + a.toLowerCase() + Math.floor(Math.random() * 99));
  }
  return [...out].map((name, i) => {
    const r = Math.random();
    return { key: 'bot:' + i, display: name, platform: Math.random() < 0.5 ? 'twitch' : 'kick', choice: r < 0.42 ? 1 : r < 0.65 ? 2 : r < 0.9 ? 3 : 0 };
  });
}
