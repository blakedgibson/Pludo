// pii.ts — personal-information and off-platform-contact detection.
//
// On a platform with minors the biggest real-world risk in chat is not
// swearing, it is someone extracting a phone number / address / social handle
// and moving the conversation somewhere unmoderated. These detectors run on
// the base-normalized text (homoglyphs + full-width digits already folded).

import { baseNormalize } from './normalize.js';

export type PiiKind = 'email' | 'phone' | 'url' | 'address' | 'handle';

export interface PiiHit { kind: PiiKind; start: number; end: number; }

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

const PATTERNS: Array<{ kind: PiiKind; re: RegExp }> = [
  // name@domain.tld, name (at) domain (dot) com, name at domain dot com
  { kind: 'email', re: /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\]|\sat\s)\s*[a-z0-9-]+(?:\s*(?:\.|\(dot\)|\[dot\]|\sdot\s)\s*[a-z0-9-]+)*\s*(?:\.|\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,6}\b/gi },
  // URLs and bare domains on common TLDs (incl. discord.gg invites)
  { kind: 'url', re: /\b(?:https?:\/\/|www\.)[^\s]+/gi },
  { kind: 'url', re: /\b[a-z0-9][a-z0-9-]{1,62}\s*(?:\.|\(dot\)|\[dot\]|\sdot\s)\s*(?:com|net|org|gg|io|co|xyz|tv|me|ly|app|dev|link|site|online|info|ru|uk|us|ca|de|fr|biz|club|live|shop|store|fun|top|vip|cc)\b(?:\/[^\s]*)?/gi },
  // 7+ digits with optional separators: 555-123-4567, +44 20 7946 0958, 5551234567
  { kind: 'phone', re: /(?:\+?\d[\s().-]{0,3}){7,15}\d/g },
  // Street addresses: "123 Maple Street", "42 n main st"
  { kind: 'address', re: /\b\d{1,6}\s+(?:[a-z]+\s+){0,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl|terrace|circle|cir|highway|hwy|parkway|pkwy)\b\.?/gi },
  // Social handles with an explicit platform: "ig: cool_kid", "snap - name", "discord name#1234"
  { kind: 'handle', re: /\b(?:snap(?:chat)?|sc|insta(?:gram)?|ig|discord|dc|tiktok|tt|kik|telegram|tg|whats\s?app|wa|twitter|x\.com|skype|venmo|cash\s?app|paypal|steam|psn|xbox|roblox|youtube|yt|twitch)\b\s*(?:[:=@-]|is|id|user(?:name)?)\s*@?[a-z0-9._#-]{3,}/gi },
  { kind: 'handle', re: /\b[a-z0-9._]{2,32}#\d{4}\b/gi },
];

/** Rewrites spelled-out digits ("five five five") so phone detection sees them. */
function digitsFromWords(s: string): string {
  return s.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, w => NUMBER_WORDS[w]);
}

export function detectPii(raw: string): PiiHit[] {
  // Base normalization can change string length (NFKC/invisible removal), so
  // spans are only reliable when lengths match; otherwise mark whole string.
  const norm = baseNormalize(raw);
  const sameLength = norm.length === raw.length;
  const hits: PiiHit[] = [];
  const seen = new Set<string>();
  const scan = (text: string, spanOk: boolean) => {
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (kind === 'phone' && (m[0].replace(/\D/g, '').length < 7 || /^\d{4}\s*-\s*\d{4}$/.test(m[0].trim()))) continue; // skip "2019-2024"
        const start = spanOk ? m.index : 0;
        const end   = spanOk ? m.index + m[0].length : raw.length;
        const key = `${kind}:${start}:${end}`;
        if (!seen.has(key)) { seen.add(key); hits.push({ kind, start, end }); }
      }
    }
  };
  scan(norm, sameLength);
  const worded = digitsFromWords(norm);
  if (worded !== norm) scan(worded, false);
  return hits.sort((a, b) => a.start - b.start);
}

/** Replaces each hit span with a placeholder. Whole-string hits blank the text. */
export function maskPii(raw: string, hits: PiiHit[]): string {
  // Merge overlapping spans (an email also matches the bare-domain URL rule).
  const merged: PiiHit[] = [];
  for (const h of [...hits].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end) { last.end = Math.max(last.end, h.end); if (h.kind !== 'url') last.kind = h.kind; }
    else merged.push({ ...h });
  }
  let out = raw;
  for (const h of merged.reverse()) {
    out = out.slice(0, h.start) + (h.kind === 'url' ? '[link removed]' : '[removed]') + out.slice(h.end);
  }
  return out;
}
