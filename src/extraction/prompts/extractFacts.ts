export const CATEGORY_VOCAB = ['history', 'genealogy', 'industry', 'geopolitics', 'biography'] as const;

export function buildExtractPrompt(sourceTitle: string): string {
  return `You are extracting discrete factual claims from source text piped via stdin below, for a structured research archive.

Source title: ${sourceTitle}

Return ONLY strict JSON, no prose outside the JSON, in this exact shape:
{"facts": [{"text": "...", "confidence": 0.0, "categories": ["..."]}], "summary": "one paragraph human-readable summary"}

Rules:
- Each fact.text is one discrete, verifiable claim from the source text, in your own concise words or a tight quote.
- fact.confidence is a number 0.0-1.0: how directly the source text supports this exact claim.
- fact.categories is an array of zero or more of exactly these five strings, no others: ${CATEGORY_VOCAB.map((c) => `"${c}"`).join(', ')}. Only include a category if the fact genuinely fits it. Leave the array empty if none apply.
- Do not invent facts not present in the source text.
- Do not include an "id" or "source_id" field on each fact -- those will be assigned by the caller.`;
}
