import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertFileToText, FileConverters } from '../../src/ingestion/fileConvert';

const mockDestroy = jest.fn().mockResolvedValue(undefined);
const mockGetText = jest.fn().mockRejectedValue(new Error('malformed pdf'));

jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({
    getText: mockGetText,
    destroy: mockDestroy,
  })),
}));

function makeFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-fileconvert-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

const fakeConverters: FileConverters = {
  extractDocx: async () => 'docx extracted text',
  extractPdf: async () => 'pdf extracted text',
};

describe('convertFileToText', () => {
  it('reads a .txt file as-is', async () => {
    const file = makeFile('note.txt', 'plain text content');
    const text = await convertFileToText(file);
    expect(text).toBe('plain text content');
  });

  it('reads a .md file as-is', async () => {
    const file = makeFile('note.md', '# Heading\n\nBody text');
    const text = await convertFileToText(file);
    expect(text).toBe('# Heading\n\nBody text');
  });

  it('routes .docx through the injected extractDocx converter', async () => {
    const file = makeFile('doc.docx', 'ignored binary placeholder');
    const text = await convertFileToText(file, fakeConverters);
    expect(text).toBe('docx extracted text');
  });

  it('routes .pdf through the injected extractPdf converter', async () => {
    const file = makeFile('doc.pdf', 'ignored binary placeholder');
    const text = await convertFileToText(file, fakeConverters);
    expect(text).toBe('pdf extracted text');
  });

  it('throws on an unsupported extension, naming the extension and supported list', async () => {
    const file = makeFile('image.png', 'binary placeholder');
    await expect(convertFileToText(file)).rejects.toThrow(/\.png.*\.txt.*\.md.*\.docx.*\.pdf/s);
  });

  it('throws when the extracted text is empty', async () => {
    const file = makeFile('empty.docx', 'ignored binary placeholder');
    const emptyConverters: FileConverters = { extractDocx: async () => '   ', extractPdf: async () => '' };
    await expect(convertFileToText(file, emptyConverters)).rejects.toThrow(/no extractable text/);
  });

  it('calls parser.destroy() even when getText() throws (default pdf-parse path)', async () => {
    const file = makeFile('bad.pdf', 'binary placeholder');
    await expect(convertFileToText(file)).rejects.toThrow('malformed pdf');
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });
});
