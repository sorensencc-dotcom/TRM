import { EPub } from 'epub2';

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts plain text from an EPUB file, in spine (reading) order.
 * Chapters are concatenated with a blank line between them. No chapter
 * offset/heading metadata is captured (Phase A: text extraction only).
 */
export async function extractEpub(filePath: string): Promise<string> {
  const epub = await EPub.createAsync(filePath);
  const chapters: string[] = [];

  for (const item of epub.flow) {
    if (!item.id) continue;
    const html = await epub.getChapterAsync(item.id);
    const text = stripHtml(html);
    if (text) chapters.push(text);
  }

  return chapters.join('\n\n');
}
