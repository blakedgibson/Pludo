// moderation.test.ts — run with: npm run test:moderation
// Pure, offline tests for the lexicon/PII/policy engine (no network, no AI).

import assert from 'node:assert/strict';
import { moderateText, safeDisplayName, type ModerationContext } from './engine.js';
import { filterContent, moderateChat } from '../prompt-validation.js';
import { StrikeTracker, DuplicateTracker } from './store.js';

let pass = 0, fail = 0;
const failures: string[] = [];
function t(name: string, fn: () => void) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(`✗ ${name}\n    ${(e as Error).message.split('\n')[0]}`); }
}
const blocked = (ctx: ModerationContext, s: string) => t(`[${ctx}] blocks ${JSON.stringify(s)}`, () => {
  const r = moderateText(s, ctx);
  assert.equal(r.ok, false, `expected reject, got ${r.action} ${JSON.stringify(r.violations)}`);
});
const allowed = (ctx: ModerationContext, s: string) => t(`[${ctx}] allows ${JSON.stringify(s)}`, () => {
  const r = moderateText(s, ctx);
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r.violations)}`);
  assert.equal(r.text, s.trim(), `text changed to ${JSON.stringify(r.text)}`);
});
const censored = (s: string, expect: string) => t(`[chat] censors ${JSON.stringify(s)}`, () => {
  const r = moderateText(s, 'chat');
  assert.equal(r.ok, true, `rejected: ${JSON.stringify(r.violations)}`);
  assert.equal(r.text, expect);
});

// ── Usernames ────────────────────────────────────────────────────────────────
for (const u of ['CoolGamer99', 'blake_builds', 'DragonSlayer', 'xXNinjaXx', 'Hancock', 'peacock_fan',
  'Dickens1812', 'ScunthorpeUnited', 'therapist_amy', 'grape_juice', 'BassPlayer', 'classic_cars',
  'Cocktail', 'analytics_nerd', 'spicy_taco', 'Sussex_Lad', 'HellKnight', 'BadAss_Bob', 'pedal_pusher',
  'torpedo', 'skyscraper', 'basement_dweller', 'thorny_rose', 'cockpit_ace', 'Shotgun', 'Raccoon',
  'Tycoon42', 'hospice_nurse', 'heroine', 'badminton_pro', 'NightOwl', 'Nigeria_fan']) allowed('username', u);
for (const u of ['FuckBoy', 'xX_sh1t_Xx', 'n1gg3r', 'NiGgA_420', 'f_u_c_k', 'PornKing', 'h1tl3r',
  'Admin', 'PludoStaff', 'Official_Pludo', 'Mod_Bob', 'loli_lover', 'pedo_bear', 'cumshot',
  'ab', 'has space', 'emoji😀', 'Fuuuuuck', 'SexyBoy', 'WeedLord', 'phuck', 'b1tch', 'KYS_now',
  'ｆｕｃｋ', 'fаck_ass', 'rapist', 'xxxShitxxx', 'nazi_gamer', 'retard', 'admin123', 'support']) blocked('username', u);

// ── Display names (unicode allowed) ─────────────────────────────────────────
allowed('display_name', 'José García');
allowed('display_name', 'Ana Łukasz');
blocked('display_name', 'Fück you');
blocked('display_name', 'Pludo Moderator');
blocked('display_name', 'f u c k');
t('safeDisplayName falls back', () => assert.match(safeDisplayName('Fuckface', 'abc'), /^Player\d{4}$/));
t('safeDisplayName keeps clean', () => assert.equal(safeDisplayName('Sky Racer'), 'Sky Racer'));

// ── Game titles / descriptions ───────────────────────────────────────────────
for (const s of ['Zombie Apocalypse Survival', 'Lava Parkour', 'Assassin Academy', 'Raccoon Racing',
  'Grape Escape', 'Canal Boat Simulator', 'Kill the Dragon', 'Hell Dungeon', 'Shotgun Showdown',
  'The Analyst', 'Spice Market Tycoon']) allowed('game_title', s);
for (const s of ['Fuck Fest', 'Sex Island', 'N.I.G.G.E.R Run', 'Nazi Simulator', 'Free Robux Giveaway',
  'Play at coolgames.com', 'Shit Simulator', 'P0rn Quest', 'Hitler Party']) blocked('game_title', s);
allowed('game_description', 'Jump across floating islands, collect coins, and avoid the lava! Defeat the evil wizard.');
blocked('game_description', 'Join my discord: discord.gg/abc123 for free stuff');
blocked('game_description', 'Call 555-123-4567 to win');
blocked('game_description', 'A shitty game');
blocked('game_description', 'email me at kid (at) gmail (dot) com');

// ── Chat ─────────────────────────────────────────────────────────────────────
allowed('chat', 'gg everyone, nice jump!');
allowed('chat', 'that was a great analysis of the canal level');
allowed('chat', 'wanna team up and kill the boss?');
allowed('chat', 'I scored 450 points');
allowed('chat', 'the class assassin is op');
allowed('chat', 'how do I get past level 3');
allowed('chat', 'lol!!! that was close');
allowed('chat', 'wait... what?!');
censored('this is shit', 'this is ****');
censored('what the fuuuuck!', 'what the *******!');
censored('f u c k this level', '* * * * this level');
censored('sh1t man', '**** man');
censored('damn that hurt', '**** that hurt');   // strict chat censors low
blocked('chat', 'kill yourself noob');
blocked('chat', 'kys');
blocked('chat', 'k y s');
blocked('chat', 'you n1gg3r');
blocked('chat', 'send nudes');
blocked('chat', 'send me a pic of you');
blocked('chat', 'are you alone right now?');
blocked('chat', 'dont tell your parents ok');
blocked('chat', 'add me on snap: coolkid22');
blocked('chat', 'my number is 555 123 4567');
blocked('chat', 'call me five five five one two three four five six seven');
blocked('chat', 'ig: cool_kid_22');
blocked('chat', 'free robux at robux.gg');
blocked('chat', 'whats your password');
blocked('chat', 'I live at 123 Maple Street');
blocked('chat', 'i want to kill myself');
blocked('chat', 'heil hitler');
blocked('chat', 'a'.repeat(250));
t('chat self-harm gets resources message', () => {
  const r = moderateText('i want to die', 'chat');
  assert.equal(r.ok, false); assert.match(r.userMessage ?? '', /988/);
});
t('chat link censored (not rejected)', () => {
  const r = moderateText('check www.example.com/x', 'chat');
  assert.equal(r.ok, true); assert.equal(r.text, 'check [link removed]');
});
t('chat flood collapsed', () => assert.equal(moderateText('lol!!!!!!!!!!!!!!', 'chat').text, 'lol!!!'));
t('chat zero-width evasion', () => assert.equal(moderateText('f​u​c​k', 'chat').text, '****'));
t('chat non-strict allows low', () => assert.equal(moderateText('damn', 'chat', { strict: false }).text, 'damn'));

// ── Prompts / 3D asset prompts ───────────────────────────────────────────────
allowed('prompt', 'a zombie shooter where you defend a base from waves of undead');
allowed('prompt', 'a cop game where you stop drug dealers');
allowed('prompt', 'Un juego de plataformas donde saltas sobre lava');
blocked('prompt', 'a game featuring rape');
blocked('prompt', 'a nazi concentration camp game');
blocked('prompt', 'a fucking racing game');
allowed('asset_prompt', 'a golden crown with purple crystals, fantasy style');
allowed('asset_prompt', 'a medieval sword with a leather grip');
blocked('asset_prompt', 'a naked woman statue');
blocked('asset_prompt', 'a bag of cocaine');
blocked('asset_prompt', 'a swastika flag');
blocked('asset_prompt', 'a s w a s t i k a armband');
allowed('chat', 'i a m here');

// ── Back-compat wrappers ─────────────────────────────────────────────────────
t('filterContent blocks hate', () => assert.equal(filterContent('a game where you shoot niggers').ok, false));
t('filterContent passes normal', () => assert.equal(filterContent('a platformer with lava').ok, true));
t('moderateChat censors', () => { const r = moderateChat('oh shit'); assert.ok(r.ok && r.censored && r.text === 'oh ****'); });
t('moderateChat rejects', () => assert.equal(moderateChat('kill yourself').ok, false));

// ── Strikes / duplicates ─────────────────────────────────────────────────────
t('strikes escalate to mute', () => {
  const s = new StrikeTracker();
  let now = 1_000_000;
  for (let i = 0; i < 2; i++) assert.equal(s.record('k', 'medium', now += 1000).mutedUntil, 0);
  const third = s.record('k', 'medium', now += 1000);
  assert.ok(third.mutedUntil > now, 'third strike mutes');
  assert.ok(s.mutedFor('k', now + 1000) > 0);
  assert.equal(s.mutedFor('k', third.mutedUntil + 1), 0);
});
t('high severity strikes count double', () => {
  const s = new StrikeTracker();
  s.record('h', 'high', 1); assert.ok(s.record('h', 'high', 2).mutedUntil > 0);
});
t('duplicate tracker', () => {
  const d = new DuplicateTracker();
  assert.equal(d.isRepeat('k', 'hello', 0), false);
  assert.equal(d.isRepeat('k', 'Hello!', 1000), false);
  assert.equal(d.isRepeat('k', 'hello', 2000), true);
  assert.equal(d.isRepeat('k', 'hello', 60_000), false);
});

console.log(`\nmoderation: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
