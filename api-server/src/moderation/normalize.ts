// normalize.ts — turns adversarial user text into comparable forms.
//
// Evasion tricks we undo, in order:
//   1. Unicode compatibility forms (ｆｕｃｋ, 𝐟𝐮𝐜𝐤, ①)        → NFKC
//   2. Invisible characters (zero-width joiners, soft hyphen) → stripped
//   3. Diacritics / zalgo (fück, f̷u̷c̷k̷)                       → combining marks stripped
//   4. Cyrillic / Greek look-alikes (fаck with Cyrillic а)    → Latin
//   5. Leetspeak (sh1t, a$$, @ss, ph)                         → letters
//   6. Elongation (fuuuuuck)                                  → variants with runs collapsed
//   7. Separators (f.u.c.k, f-u-c-k, f u c k)                 → squashed / joined singles
//
// Every function here is pure so the lexicon matcher can be unit-tested.

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
  'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ї': 'i',
  'ј': 'j', 'ԁ': 'd', 'ɡ': 'g', 'һ': 'h', 'ӏ': 'l', 'ո': 'n', 'ս': 'u', 'ԛ': 'q',
  'ԝ': 'w', 'г': 'r', 'п': 'n', 'л': 'n', 'ц': 'u', 'ч': 'y', 'ш': 'w', 'щ': 'w',
  'ь': 'b', 'ъ': 'b', 'я': 'r', 'ф': 'o', 'и': 'n',
  // Greek
  'α': 'a', 'β': 'b', 'γ': 'y', 'δ': 'd', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k',
  'μ': 'u', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'σ': 'o', 'ς': 's', 'τ': 't', 'υ': 'u',
  'χ': 'x', 'ω': 'w', 'θ': 'o',
  // Misc Latin look-alikes NFKC leaves alone
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŧ': 't', 'ß': 'ss', 'æ': 'ae',
  'œ': 'oe', 'þ': 'p', 'ƒ': 'f', 'ɑ': 'a', 'ʀ': 'r', 'ꜱ': 's', 'ᴀ': 'a', 'ʙ': 'b',
  'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ғ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j',
  'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ᴛ': 't',
  'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
};

// Leetspeak substitutions. '1' and '|' are ambiguous (i or l) — see leetVariants.
const LEET: Record<string, string> = {
  '0': 'o', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't',
  '8': 'b', '9': 'g', '6': 'g', '2': 'z', '(': 'c', '<': 'c', '{': 'c', '[': 'c',
  '€': 'e', '£': 'l', '¡': 'i', '!': 'i', '*': '', '#': 'h', '%': 'x',
};

/** NFKC + lowercase + strip invisibles/diacritics + map homoglyphs. Keeps punctuation. */
export function baseNormalize(raw: string): string {
  let s = raw.normalize('NFKC').replace(INVISIBLE, '');
  // Strip combining marks (accents, zalgo) after decomposing.
  s = s.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
  s = s.toLowerCase();
  let out = '';
  for (const ch of s) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

/** Applies leetspeak mapping. Returns both the i-reading and l-reading for '1'/'|'. */
export function leetVariants(s: string): string[] {
  let common = '';
  for (const ch of s) common += LEET[ch] ?? ch;
  if (!/[1|]/.test(common)) return [common];
  return [common.replace(/[1|]/g, 'i'), common.replace(/[1|]/g, 'l')];
}

/** Elongation variants: runs of 3+ identical letters collapsed to 1 and to 2. */
export function elongationVariants(s: string): string[] {
  if (!/([a-z])\1\1/.test(s)) return [s];
  return [s, s.replace(/([a-z])\1{2,}/g, '$1'), s.replace(/([a-z])\1{2,}/g, '$1$1')];
}

/** Removes everything but a–z. "f.u-c_k" → "fuck". */
export function squash(s: string): string {
  return s.replace(/[^a-z]/g, '');
}

/**
 * Splits a single identifier (username, title word) into sub-tokens on
 * camelCase, digits, underscores and punctuation. "xXFuckBoy_99" → [x, x, fuck, boy].
 * Operates on the ORIGINAL casing so camelCase boundaries are visible.
 */
export function splitIdentifier(raw: string): string[] {
  return raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-zÀ-ɏͰ-ϿЀ-ӿ]+/)
    .filter(Boolean)
    .map(t => baseNormalize(t));
}

/** All comparable forms of one whitespace-delimited token. */
// Trailing/leading sentence punctuation is never leetspeak ("lol!!!" must not
// read as "loliii"). Internal symbols ("sh!t", "a$$", "f*ck") still map.
function stripEdgePunct(s: string): string {
  return s.replace(/[!?.,;:'"\)\]\}~]+$/, '').replace(/^['"(\[{~]+/, '');
}

export function tokenForms(rawToken: string): string[] {
  const base = stripEdgePunct(baseNormalize(rawToken));
  const forms = new Set<string>();
  for (const v of leetVariants(base)) {
    const letters = squash(v);
    if (!letters) continue;
    for (const e of elongationVariants(letters)) forms.add(e);
  }
  return [...forms];
}

/** Whitespace tokenization that remembers original spans (for censoring). */
export interface Token { raw: string; start: number; end: number; }
export function tokenize(raw: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** Phrase-level form: normalized, leet-mapped, punctuation → single spaces. */
export function phraseForms(raw: string): string[] {
  const base = baseNormalize(raw).split(/\s+/).map(stripEdgePunct).join(' ');
  return leetVariants(base).map(v =>
    ' ' + v.replace(/[^a-z0-9]+/g, ' ').replace(/([a-z])\1{2,}/g, '$1$1').trim() + ' ');
}
