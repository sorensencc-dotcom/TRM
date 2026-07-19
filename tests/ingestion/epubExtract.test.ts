import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { extractEpub } from '../../src/ingestion/epubExtract';

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:test-book-0001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
    <itemref idref="chapter3"/>
  </spine>
</package>`;

const TOC_NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:test-book-0001"/></head>
  <docTitle><text>Test Book</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
    <navPoint id="navpoint-2" playOrder="2">
      <navLabel><text>Chapter Two</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
    <navPoint id="navpoint-3" playOrder="3">
      <navLabel><text>Chapter Three</text></navLabel>
      <content src="chapter3.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

const CHAPTER1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter One</title></head>
<body>
<h1>Chapter One</h1>
<p>It was the &quot;best&quot; of times, down the rabbit hole.</p>
</body>
</html>`;

const CHAPTER2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter Two</title></head>
<body>
<script type="text/javascript">alert("should not appear");</script>
<h1>Chapter Two</h1>
<p>Alice &amp; the White Rabbit met again.</p>
</body>
</html>`;

const CHAPTER3 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter Three</title></head>
<body>
<h1>Chapter Three</h1>
<p>The final chapter, in order.</p>
</body>
</html>`;

function makeTestEpub(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-epubextract-'));
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf-8'));
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER_XML, 'utf-8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(CONTENT_OPF, 'utf-8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(TOC_NCX, 'utf-8'));
  zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(CHAPTER1, 'utf-8'));
  zip.addFile('OEBPS/chapter2.xhtml', Buffer.from(CHAPTER2, 'utf-8'));
  zip.addFile('OEBPS/chapter3.xhtml', Buffer.from(CHAPTER3, 'utf-8'));
  const file = path.join(dir, 'book.epub');
  zip.writeZip(file);
  return file;
}

describe('extractEpub', () => {
  it('extracts chapter text from the spine in reading order', async () => {
    const file = makeTestEpub();
    const text = await extractEpub(file);

    const idx1 = text.indexOf('Chapter One');
    const idx2 = text.indexOf('Chapter Two');
    const idx3 = text.indexOf('Chapter Three');

    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it('strips HTML tags and script blocks, leaving readable text', async () => {
    const file = makeTestEpub();
    const text = await extractEpub(file);

    expect(text).not.toMatch(/<[a-z][\s\S]*>/i);
    expect(text).not.toContain('should not appear');
    expect(text).toContain('down the rabbit hole');
  });

  it('decodes HTML entities without corrupting text', async () => {
    const file = makeTestEpub();
    const text = await extractEpub(file);

    expect(text).toContain('"best" of times');
    expect(text).toContain('Alice & the White Rabbit');
  });
});
