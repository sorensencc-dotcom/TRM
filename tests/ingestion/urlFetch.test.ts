// C:\dev\trm\tests\ingestion\urlFetch.test.ts
import { htmlToCleanText, fetchUrlToText } from '../../src/ingestion/urlFetch';

describe('urlFetch', () => {
  describe('htmlToCleanText', () => {
    it('strips scripts, styles, and tags while preserving readable text', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <style>body { color: red; }</style>
            <script>console.log('secret');</script>
          </head>
          <body>
            <nav><a href="/home">Home</a></nav>
            <h1>Topic Title</h1>
            <p>First paragraph with &amp; entity and &quot;quotes&quot;.</p>
            <ul>
              <li>Item 1</li>
              <li>Item 2</li>
            </ul>
            <footer>Footer content</footer>
          </body>
        </html>
      `;
      const clean = htmlToCleanText(html);
      expect(clean).toContain('Topic Title');
      expect(clean).toContain('First paragraph with & entity and "quotes".');
      expect(clean).toContain('- Item 1');
      expect(clean).toContain('- Item 2');
      expect(clean).not.toContain('color: red');
      expect(clean).not.toContain('console.log');
      expect(clean).not.toContain('Footer content');
      expect(clean).not.toContain('Home');
    });

    it('handles empty or malformed strings gracefully', () => {
      expect(htmlToCleanText('')).toBe('');
      expect(htmlToCleanText('Just plain text with no tags')).toBe('Just plain text with no tags');
    });
  });

  describe('fetchUrlToText', () => {
    it('fetches and converts HTML successfully using custom fetch', async () => {
      const mockHtml = '<html><body><h1>Justice Department</h1><p>Claim details here.</p></body></html>';
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
        },
        text: async () => mockHtml,
      });

      const text = await fetchUrlToText('https://www.justice.gov/fcsc/cuba-index', { fetchFn: mockFetch as any });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://www.justice.gov/fcsc/cuba-index',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.any(String),
          }),
        })
      );
      expect(text).toContain('Justice Department');
      expect(text).toContain('Claim details here.');
    });

    it('throws informative error on non-ok HTTP response', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
        text: async () => 'Not Found',
      });

      await expect(
        fetchUrlToText('https://example.com/missing', { fetchFn: mockFetch as any })
      ).rejects.toThrow('HTTP 404 Not Found');
    });

    it('rejects payloads exceeding maxBytes limit', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (n: string) => (n === 'content-length' ? '20000000' : null) },
        text: async () => 'huge payload',
      });

      await expect(
        fetchUrlToText('https://example.com/huge', { maxBytes: 1000, fetchFn: mockFetch as any })
      ).rejects.toThrow('exceeds limit');
    });

    it('strips aside, figure, and header tags while properly decoding entities in order', () => {
      const html = `
        <header>Site Header</header>
        <aside>Sidebar Ads</aside>
        <figure><img src="pic.jpg"><figcaption>Caption</figcaption></figure>
        <article>
          <p>Claims &amp; &#35;123 and &#x23;456 &amp; Co.</p>
        </article>
      `;
      const clean = htmlToCleanText(html);
      expect(clean).not.toContain('Site Header');
      expect(clean).not.toContain('Sidebar Ads');
      expect(clean).not.toContain('Caption');
      expect(clean).toContain('Claims & #123 and #456 & Co.');
    });
  });
});
