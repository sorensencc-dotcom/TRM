// C:\dev\trm\src\ingestion\urlFetch.ts

export interface FetchUrlOptions {
  timeoutMs?: number;
  userAgent?: string;
  maxBytes?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_USER_AGENT = 'TRM-Ingest/1.0 (+https://github.com/sorensencc-dotcom/toolforge)';

/**
 * Strips HTML tags, scripts, styles, and non-content elements,
 * converting HTML documents into clean plain text for extraction.
 */
export function htmlToCleanText(html: string): string {
  if (!html) return '';

  let text = html;

  // Strip script, style, noscript, svg, nav, footer, header, aside, figure tags and their contents
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
  text = text.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ');
  text = text.replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ');
  text = text.replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ');
  text = text.replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ');
  text = text.replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, ' ');
  text = text.replace(/<figure\b[^<]*(?:(?!<\/figure>)<[^<]*)*<\/figure>/gi, ' ');

  // Convert block line breaks and paragraphs to newlines
  text = text.replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr|hr)[^>]*>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n- ');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode numeric entities first (decimal and hex)
  text = text
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Decode common named entities, &amp; last
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&amp;/gi, '&');

  // Normalize whitespace: collapse spaces on lines, collapse multiple empty lines to max 2
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0));

  return lines.join('\n').trim();
}

/**
 * Fetches an HTTP/HTTPS URL and converts its content to clean text.
 */
export async function fetchUrlToText(url: string, options: FetchUrlOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const fetcher = options.fetchFn ?? globalThis.fetch;

  if (typeof fetcher !== 'function') {
    throw new Error('fetch is not available in the current environment');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for URL: ${url}`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > maxBytes) {
      throw new Error(`Response size (${contentLengthHeader} bytes) exceeds limit of ${maxBytes} bytes for URL: ${url}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    if (body.length > maxBytes) {
      throw new Error(`Response body exceeds limit of ${maxBytes} bytes for URL: ${url}`);
    }

    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || /<html/i.test(body)) {
      return htmlToCleanText(body);
    }

    return body.trim();
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms for URL: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
