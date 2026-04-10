/**
 * scorer.js — Skool Community Monitor
 * Identičan scoring sistem kao Reddit aktor, ali sa Skool-specifičnim amplifikatorima.
 */

const SKOOL_AMPLIFIERS = [
  { pattern: /\d+\s*members?\s*(left|leaving|gone|churned)/i,   weight: 20 },
  { pattern: /lost\s+\d+\s*members?/i,                          weight: 20 },
  { pattern: /hours?\s+(a\s+)?(week|day)/i,                     weight: 16 },
  { pattern: /nobody\s+(posts?|engages?|responds?)/i,            weight: 18 },
  { pattern: /members\s+aren'?t\s+(posting|engaging)/i,          weight: 18 },
  { pattern: /can'?t\s+(collect|find|get|send|export)\s+email/i, weight: 16 },
  { pattern: /doing\s+(this\s+)?manually/i,                      weight: 14 },
  { pattern: /skool\s+(doesn'?t|can'?t|has\s+no|missing)/i,     weight: 16 },
  { pattern: /wish\s+skool\s+(had|would|could)/i,                weight: 14 },
  { pattern: /not\s+scalable/i,                                  weight: 14 },
  { pattern: /ghost\s+town/i,                                    weight: 18 },
  { pattern: /rented\s+land/i,                                   weight: 18 },
  { pattern: /leaky\s+bucket/i,                                  weight: 16 },
];

export function scorePain(text, userPainWords) {
  if (!text) return { painScore: 0, signal: '🔵 Low', matchedWords: [], matchedPatterns: [] };
  const lower = text.toLowerCase();
  const matchedWords    = userPainWords.filter(w => lower.includes(w.toLowerCase()));
  const matchedPatterns = SKOOL_AMPLIFIERS.filter(a => a.pattern.test(text));
  const patternScore    = matchedPatterns.reduce((s, a) => s + a.weight, 0);
  const bonus =
    (/\$\d+/.test(text)                               ? 12 : 0) +
    (/\d+\s*(members?|hours?|months?|%)/i.test(text)  ? 10 : 0) +
    (text.includes('?')                               ? 6  : 0);
  const score = Math.min(matchedWords.length * 13 + patternScore + bonus, 100);
  return {
    painScore:       score,
    signal:          score >= 50 ? '🔥 High' : score >= 25 ? '🟡 Medium' : '🔵 Low',
    matchedWords:    matchedWords.slice(0, 6),
    matchedPatterns: matchedPatterns.map(a => a.pattern.source).slice(0, 4),
  };
}

export function categorize(text, catKwMap) {
  const lower = text.toLowerCase();
  let best = { cat: 'General / Other', score: 0 };
  for (const [cat, kws] of Object.entries(catKwMap)) {
    const s = kws.filter(kw => lower.includes(kw.toLowerCase())).length;
    if (s > best.score) best = { cat, score: s };
  }
  return best.cat;
}

export function extractVocQuotes(text, userPainWords, max = 5) {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 28 && s.length < 280)
    .filter(s => {
      const lower = s.toLowerCase();
      return userPainWords.some(w => lower.includes(w.toLowerCase())) ||
             SKOOL_AMPLIFIERS.some(a => a.pattern.test(s)) ||
             /skool|members?|community|zapier|email|churn/i.test(s);
    })
    .slice(0, max);
}
