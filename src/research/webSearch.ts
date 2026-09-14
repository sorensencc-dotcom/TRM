export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  hits: WebSearchHit[];
}

const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1beta/search';

interface RawWebSearchResult {
  url: string;
  title?: string | null;
  excerpts?: string[] | null;
}

interface RawSearchResponse {
  results?: RawWebSearchResult[];
}

export async function searchWeb(query: string): Promise<WebSearchResult> {
  const apiKey = process.env.PARALLEL_API_KEY;
  if (!apiKey) {
    throw new Error('PARALLEL_API_KEY is not set');
  }

  const response = await fetch(PARALLEL_SEARCH_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ search_queries: [query], excerpts: true }),
  });

  if (!response.ok) {
    throw new Error(`Parallel search request failed with status ${response.status}`);
  }

  const body = (await response.json()) as RawSearchResponse;
  if (!Array.isArray(body.results)) {
    throw new Error('Parallel search response missing results array');
  }

  const hits: WebSearchHit[] = body.results.map((raw) => ({
    title: raw.title ?? '(untitled)',
    url: raw.url,
    snippet: raw.excerpts && raw.excerpts.length > 0 ? raw.excerpts[0] : '',
  }));

  return { query, hits };
}
