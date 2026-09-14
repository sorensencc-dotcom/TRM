import { searchWeb } from './webSearch';

describe('searchWeb', () => {
  const originalKey = process.env.PARALLEL_API_KEY;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.PARALLEL_API_KEY = 'test-key-123';
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    process.env.PARALLEL_API_KEY = originalKey;
    jest.resetAllMocks();
  });

  it('throws if PARALLEL_API_KEY is not set', async () => {
    delete process.env.PARALLEL_API_KEY;
    await expect(searchWeb('some query')).rejects.toThrow(/PARALLEL_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the Parallel search endpoint with the right shape', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [], search_id: 'search_abc' }),
    });

    await searchWeb('what is the latest release of @octokit/rest');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.parallel.ai/v1beta/search',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'test-key-123', 'content-type': 'application/json' }),
        body: JSON.stringify({ search_queries: ['what is the latest release of @octokit/rest'], excerpts: true }),
      })
    );
  });

  it('maps a successful response into WebSearchResult', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { url: 'https://example.com/a', title: 'Example A', excerpts: ['first excerpt', 'second excerpt'] },
          { url: 'https://example.com/b', title: null, excerpts: null },
        ],
        search_id: 'search_abc',
      }),
    });

    const result = await searchWeb('query text');

    expect(result).toEqual({
      query: 'query text',
      hits: [
        { title: 'Example A', url: 'https://example.com/a', snippet: 'first excerpt' },
        { title: '(untitled)', url: 'https://example.com/b', snippet: '' },
      ],
    });
  });

  it('throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: 'rate limited' }) });
    await expect(searchWeb('query')).rejects.toThrow(/429/);
  });

  it('throws when the response body has no results array', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ search_id: 'x' }) });
    await expect(searchWeb('query')).rejects.toThrow(/results/);
  });

  it('throws on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(searchWeb('query')).rejects.toThrow('ECONNRESET');
  });
});
