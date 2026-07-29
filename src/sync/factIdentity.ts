import * as crypto from 'node:crypto';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'he', 'her', 'his', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'she', 'that',
  'the', 'their', 'they', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your',
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of normalize(text).split(' ')) {
    if (!token || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

export function factKey(fact: { source_id: string; text: string }): string {
  return crypto.createHash('sha256').update(`${fact.source_id}|${normalize(fact.text)}`).digest('hex');
}
