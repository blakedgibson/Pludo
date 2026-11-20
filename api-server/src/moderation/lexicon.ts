// lexicon.ts — the term lists the matcher uses.
//
// Each single-word term has a category + severity. `sub` controls whether it
// may be matched as a SUBSTRING of a squashed string (needed for usernames
// like "xxshitlordxx" and for "n.i.g.g.e.r"-style evasion). Short or
// ambiguous terms are token-only so "class", "cocktail", "Sussex",
// "therapist" and "method" stay clean (the Scunthorpe problem).
//
// Phrases are matched against the space-normalized phrase form with word
// boundaries on both ends.
//
// Admins can add terms at runtime (see store.ts → custom terms); those are
// merged in through addCustomTerm().

export type Category =
  | 'csam' | 'sexual' | 'hate' | 'extremism' | 'threat' | 'self_harm'
  | 'harassment' | 'grooming' | 'profanity' | 'drugs' | 'scam'
  | 'pii' | 'off_platform' | 'link' | 'impersonation' | 'spam' | 'format' | 'ai';

/** low = mild (hell, crap) · medium = profanity/drugs · high = never allowed anywhere */
export type Severity = 'low' | 'medium' | 'high';

export interface Term {
  term: string;
  category: Category;
  severity: Severity;
  sub: boolean;
}

type Def = [term: string, sub?: boolean];

function defs(category: Category, severity: Severity, list: Array<string | Def>): Term[] {
  return list.map(d => {
    const [term, sub] = typeof d === 'string' ? [d, undefined] : d;
    return { term, category, severity, sub: sub ?? term.length >= 5 };
  });
}

// ── Single-word terms ────────────────────────────────────────────────────────

const WORDS: Term[] = [
  ...defs('csam', 'high', [
    ['loli', true], 'lolicon', 'lolis', ['shota', true], 'shotacon', ['pedo', true], 'pedos',
    'pedophile', 'paedophile', 'pedophilia', 'jailbait', 'childporn', 'kiddieporn', 'cheesepizza',
  ]),
  ...defs('sexual', 'high', [
    ['porn', true], 'porno', 'pornhub', 'hentai', 'xvideos', 'xhamster', 'onlyfans', 'nudes',
    'nude', 'naked', 'blowjob', 'handjob', 'rimjob', 'footjob', 'dildo', 'vibrator', 'orgasm',
    'masturbate', 'masturbating', 'jerkoff', 'horny', 'boner', 'erection', 'penis', 'vagina',
    'clitoris', ['clit', false], 'titties', ['tits', false], 'boobs', 'boobies', ['cum', false],
    'cumming', 'cumshot', 'creampie', 'gangbang', 'threesome', ['milf', true], ['dilf', true],
    'bdsm', 'fetish', 'bondage', ['nsfw', true], 'erotic', 'stripper', ['rape', true], 'raped',
    'raping', 'rapist', 'molest', 'molester', 'molested', 'incest', 'bestiality', 'zoophile',
    'sexting', ['esex', true], 'cybersex', ['anal', false], ['jizz', true], ['semen', false], 'spunk',
    'pussies', ['thot', false], ['xxx', false], ['coomer', true], ['sex', false],
    ['seggs', true], ['secks', false], ['smut', false], 'ahegao', 'futanari', ['yiff', true],
  ]),
  ...defs('sexual', 'low', [['sexy', false], ['hottie', false], ['booty', false]]),
  ...defs('hate', 'high', [
    ['nigger', true], 'niggers', ['nigga', true], 'niggas', ['nigg', true], ['niga', false],
    ['faggot', true], 'faggots', ['fag', false], ['fags', false], ['fagg', true],
    ['tranny', true], 'trannies', ['kike', true], 'kikes', ['spic', false], ['spics', false],
    ['chink', true], 'chinks', 'wetback', 'wetbacks', ['gook', true], 'gooks', 'raghead',
    'towelhead', 'beaner', 'beaners', ['coon', false], ['coons', false], 'sandnigger',
    'porchmonkey', 'junglebunny', ['paki', false], ['pakis', false], ['kyke', true],
    ['zipperhead', true], ['shemale', true], ['heeb', false],
  ]),
  ...defs('hate', 'medium', [
    ['retard', true], 'retarded', 'retards', ['dyke', true], ['homo', false], ['tard', false],
    ['spaz', false], ['mongoloid', true], ['gypo', false],
  ]),
  ...defs('extremism', 'high', [
    ['nazi', true], 'nazis', 'hitler', 'heilhitler', 'siegheil', ['heil', false],
    ['kkk', false], 'swastika', ['isis', false], 'alqaeda', 'jihadi', 'jihadist',
    'whitepower', 'whitepride', 'gasthejews', 'holohoax',
    ['1488', false], ['1488s', false], 'aryan', ['waffenss', true], 'neonazi',
  ]),
  ...defs('threat', 'high', [['kys', false], 'killyourself', 'killurself', 'kysnow']),
  ...defs('self_harm', 'high', [['kms', false], 'killmyself', 'suicide', 'suicidal']),
  ...defs('profanity', 'medium', [
    ['fuck', true], 'fucker', 'fuckers', 'fucking', 'fucked', 'fuckin', 'fucks', ['fuk', false],
    ['fuc', false], ['fck', false], ['fcking', true], ['fking', false], ['fuq', false],
    ['phuck', true], ['phuk', true], 'motherfucker', 'mofo', ['mf', false], ['stfu', false],
    ['gtfo', false], ['shit', true], 'shits', 'shitty', 'bullshit', ['sht', false],
    ['shite', false], 'bitch', 'bitches', 'bitchy', ['biatch', true], ['btch', false],
    'bastard', 'asshole', 'assholes', ['arsehole', true], ['dick', true], ['dicks', true],
    'dickhead', ['cock', false], ['cocks', false], 'cocksucker', ['pussy', true], ['cunt', true],
    'cunts', ['twat', false], ['wank', true], 'wanker', ['prick', false], ['slut', true],
    'sluts', ['whore', true], 'whores', ['skank', true], 'douche', 'douchebag', 'jackass',
    'dumbass', 'dipshit', 'shithead', 'bollocks', ['piss', true], 'pissed', ['bugger', false],
    ['tosser', false], ['nutsack', true], ['ballsack', true], ['scrotum', true],
  ]),
  ...defs('profanity', 'low', [
    ['ass', false], ['arse', false], ['damn', false], ['dammit', false], ['hell', false],
    ['crap', false], ['crappy', false], ['wtf', false], ['ffs', false], ['hoe', false],
    ['hoes', false], ['butt', false], ['frick', false], ['freaking', false], ['sucks', false],
    ['pissy', false], ['bloody', false], ['omfg', false], ['lmfao', false],
  ]),
  ...defs('drugs', 'medium', [
    'cocaine', ['coke', false], 'heroin', ['meth', false], 'methamphetamine', ['crack', false],
    ['lsd', false], 'ecstasy', ['mdma', true], 'fentanyl', 'ketamine', 'xanax', 'oxycodone',
    'oxycontin', ['opium', true], 'shrooms', ['molly', false], ['dmt', false], ['pcp', false],
  ]),
  ...defs('drugs', 'low', [['weed', false], ['blunt', false], ['bong', false], ['stoned', false], ['vape', false], ['420', false]]),
];

// ── Phrases (matched with word boundaries on the phrase form) ────────────────

export interface Phrase { phrase: string; category: Category; severity: Severity; }

function phrases(category: Category, severity: Severity, list: string[]): Phrase[] {
  return list.map(phrase => ({ phrase, category, severity }));
}

const PHRASES: Phrase[] = [
  ...phrases('csam', 'high', ['child porn', 'kiddie porn', 'cheese pizza', 'underage sex', 'cp links', 'trade cp', 'sell cp']),
  ...phrases('sexual', 'high', [
    'send nudes', 'send nude', 'sexual assault', 'have sex', 'having sex', 'sex with', 'oral sex',
    'blow job', 'hand job', 'jerk off', 'jack off', 'suck my', 'lick my', 'touch yourself',
    'my dick', 'your dick', 'my cock', 'show me your body', 'take off your clothes', 'e sex',
    'cyber sex', 'strip club', 'sex game', 'sex dungeon', 'make out with me', 'wanna bang',
  ]),
  ...phrases('grooming', 'high', [
    'send pics', 'send a pic', 'send me a pic', 'send me pics', 'send pictures', 'send me a picture',
    'send me your pic', 'are you alone', 'r u alone', 'is anyone home with you', 'parents home',
    'keep this secret', 'keep it a secret', 'our little secret', 'dont tell your parents',
    'don t tell your parents', 'dont tell your mom', 'dont tell your dad', 'dont tell anyone',
    'what is your address', 'whats your address', 'what s your address', 'where do you live',
    'where u live', 'meet up irl', 'meet in real life', 'meet in person', 'come to my house',
    'i ll pick you up', 'ill pick you up', 'turn on your camera', 'turn your camera on', 'video call me',
  ]),
  ...phrases('threat', 'high', [
    'kill yourself', 'kill urself', 'kill ur self', 'kill your self', 'neck yourself', 'hang yourself',
    'go die', 'go kill yourself', 'drink bleach', 'i will kill you', 'ill kill you', 'i ll kill you',
    'i m going to kill you', 'im going to kill you', 'im gonna kill you', 'i m gonna kill you',
    'i will find you', 'i know where you live', 'shoot up the school', 'shoot up my school',
    'school shooting', 'bomb the school', 'blow up the school', 'kill all', 'death to',
    'kill trump', 'kill biden', 'kill obama', 'kill putin', 'kill musk', 'kill elon', 'kill zuckerberg',
  ]),
  ...phrases('self_harm', 'high', [
    'kill myself', 'killing myself', 'want to die', 'wanna die', 'end my life', 'suicide',
    'suicidal', 'cut myself', 'cutting myself', 'self harm', 'hurt myself', 'kms',
  ]),
  ...phrases('extremism', 'high', [
    'heil hitler', 'sieg heil', 'white power', 'white pride', 'gas the jews', 'third reich',
    'ethnic cleansing', 'race war', 'final solution', '14 88', 'al qaeda', 'great replacement',
  ]),
  ...phrases('threat', 'high', ['genocide', 'mass murder', 'mass shooting', 'torture porn']),
  ...phrases('harassment', 'medium', [
    'you re ugly', 'youre ugly', 'ur ugly', 'you are ugly', 'nobody likes you', 'no one likes you',
    'everyone hates you', 'you should die', 'go away loser', 'you re worthless', 'youre worthless',
    'ur worthless', 'you are worthless', 'kill urslf', 'uninstall life',
  ]),
  ...phrases('scam', 'high', [
    'free robux', 'free vbucks', 'free v bucks', 'free coins', 'free credits', 'free gems',
    'free pludo', 'give me your password', 'what s your password', 'whats your password',
    'tell me your password', 'send me your password', 'login details', 'account details',
    'gift card code', 'verify your account', 'claim your prize', 'double your coins',
  ]),
  ...phrases('off_platform', 'high', [
    'add me on snap', 'add me on snapchat', 'add me on insta', 'add me on instagram',
    'add me on discord', 'add me on tiktok', 'add me on whatsapp', 'add me on kik',
    'add me on telegram', 'my snap is', 'my snapchat is', 'my insta is', 'my ig is',
    'my discord is', 'my tiktok is', 'my number is', 'my phone number', 'text me at',
    'call me at', 'dm me on', 'hmu on', 'snap me', 'join my discord', 'discord gg',
  ]),
];

// ── Allowlist: benign words that contain a substring-matchable term ──────────
// Masked out of squashed strings before substring scanning.

export const ALLOWLIST: string[] = [
  'scunthorpe', 'therapist', 'therapists', 'grape', 'grapes', 'drape', 'drapes', 'scrape',
  'scraped', 'scraper', 'trapeze', 'rapeseed', 'cockpit', 'cocktail', 'cocktails', 'peacock',
  'hancock', 'woodcock', 'shuttlecock', 'cockatoo', 'cockroach', 'cockerel', 'cockney',
  'shiitake', 'shitake', 'dickens', 'dickinson', 'benedick', 'analysis', 'analyst', 'analog',
  'analogue', 'analyze', 'analyse', 'analytic', 'analytics', 'banal', 'canal', 'canals',
  'spice', 'spicy', 'spices', 'conspicuous', 'auspicious', 'despicable', 'suspicious',
  'heroine', 'heroines', 'snigger', 'sniggering', 'niger', 'nigeria', 'nigerian', 'chinking',
  'grapefruit', 'skyscraper', 'cumulus', 'cucumber', 'circumstance', 'document', 'scuttle',
  'pussycat', 'pussywillow', 'cocky', 'cockle', 'hitchcock', 'babcock', 'glasscock',
  'shotgun', 'shotguns', 'shotput', 'shotaro', 'nazareth', 'nazarene', 'pornpong', 'prickly',
  'pricklypear', 'retardant', 'fireretardant', 'flameretardant', 'pedometer', 'pedometers',
  'pedestal', 'pedestrian', 'pedestrians', 'pedal', 'pedals', 'encyclopedia', 'torpedo',
  'torpedoes', 'orthopedic', 'expedition', 'lolipop', 'lollipop', 'lollipops',
  'loliwood', 'pistol', 'scrapes', 'grapevine', 'parapet', 'pishit', 'mishit', 'kumite',
  'wankel', 'swankier', 'swanky', 'clitheroe', 'assassin', 'assassins', 'assassinate',
  'classic', 'bass', 'passionate', 'sextant', 'sextet', 'sussex', 'essex', 'middlesex',
  'butterfly', 'buttercup', 'hello', 'shell', 'shellfish', 'michelle', 'hellen', 'helena',
  'manuscript', 'spectacular', 'dyker', 'fagin', 'raccoon', 'tycoon', 'cocoon', 'pakistan',
  'cockatiel', 'niggle', 'niggling', 'niggled', 'dickey', 'dickie', 'dickson', 'pricked',
  'arsenal', 'arsenic', 'parse', 'sparse', 'trapezoid', 'enrapture', 'scrapbook',
  'bitchute', 'shitzu', 'shihtzu', 'matsushita', 'kishita', 'yamashita', 'morishita',
  'hospice', 'aspic', 'spick', 'pissarro', 'snaked', 'thorny', 'basement', 'basements',
  'casement', 'vagabond', 'gobbledygook', 'pussyfoot', 'carbonero', 'ribboner', 'therap', 'trape', 'crape', 'swank', 'twank', 'europium', 'niggard', 'draped', 'draping', 'scraping', 'badminton', 'tycoons', 'cocoons', 'raccoons', 'penistone', 'clitheroe', 'sextants',
];

// ── Impersonation / reserved names ───────────────────────────────────────────

export const RESERVED_SUBSTRINGS = ['admin', 'moderator', 'pludo', 'official', 'helpdesk', 'customerservice', 'trustandsafety'];
export const RESERVED_TOKENS     = ['mod', 'mods', 'staff', 'support', 'dev', 'devs', 'system', 'owner', 'ceo', 'founder', 'root', 'sysop', 'gm', 'security', 'verified'];

// ── Runtime-extendable index ─────────────────────────────────────────────────

const exact = new Map<string, Term>();
let subTerms: Term[] = [];
let phraseList: Phrase[] = [...PHRASES];

function rebuild(all: Term[]) {
  exact.clear();
  for (const t of all) {
    const prev = exact.get(t.term);
    if (!prev || rank(t.severity) > rank(prev.severity)) exact.set(t.term, t);
  }
  subTerms = [...exact.values()].filter(t => t.sub).sort((a, b) => b.term.length - a.term.length);
}

let customWords: Term[] = [];
rebuild(WORDS);

export function rank(s: Severity): number { return s === 'high' ? 3 : s === 'medium' ? 2 : 1; }

export function lookupToken(token: string): Term | undefined { return exact.get(token); }
export function substringTerms(): readonly Term[] { return subTerms; }

// In free-form prose (chat, comments, descriptions) substring matching is
// limited to these unambiguous stems — enough to catch "fuckface",
// "shitposting", "n1ggerz" without flagging "advertisement" or "therapeutic".
const PROSE_SUB = new Set(['fuck', 'nigger', 'nigga', 'faggot', 'cunt', 'shit', 'bitch', 'porn', 'hentai',
  'pedophile', 'motherfucker', 'tranny', 'whore', 'dickhead', 'asshole', 'jizz', 'cumshot', 'blowjob']);
export function isProseSubstringTerm(t: Term): boolean { return PROSE_SUB.has(t.term) || t.category === 'csam' && t.term.length >= 6; }
export function allPhrases(): readonly Phrase[] { return phraseList; }

/** Adds an admin-defined term. Multi-word terms become phrases. */
export function addCustomTerm(term: string, category: Category, severity: Severity): void {
  const clean = term.toLowerCase().trim();
  if (!clean) return;
  if (/\s/.test(clean)) {
    phraseList = phraseList.filter(p => p.phrase !== clean);
    phraseList.push({ phrase: clean.replace(/[^a-z0-9]+/g, ' ').trim(), category, severity });
    return;
  }
  const t: Term = { term: clean.replace(/[^a-z0-9]/g, ''), category, severity, sub: clean.length >= 5 };
  customWords = customWords.filter(w => w.term !== t.term).concat(t);
  rebuild([...WORDS, ...customWords]);
}

export function removeCustomTerm(term: string): void {
  const clean = term.toLowerCase().trim();
  customWords = customWords.filter(w => w.term !== clean.replace(/[^a-z0-9]/g, ''));
  phraseList = phraseList.filter(p => !(p.phrase === clean.replace(/[^a-z0-9]+/g, ' ').trim() && !PHRASES.includes(p)));
  rebuild([...WORDS, ...customWords]);
}

export function listCustomTerms(): Array<{ term: string; category: Category; severity: Severity }> {
  const customPhrases = phraseList.filter(p => !PHRASES.includes(p)).map(p => ({ term: p.phrase, category: p.category, severity: p.severity }));
  return [...customWords.map(w => ({ term: w.term, category: w.category, severity: w.severity })), ...customPhrases];
}
