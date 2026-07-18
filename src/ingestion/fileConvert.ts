import * as fs from 'node:fs';
import * as path from 'node:path';
import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export interface FileConverters {
  extractDocx: (filePath: string) => Promise<string>;
  extractPdf: (buffer: Buffer) => Promise<string>;
}

const defaultConverters: FileConverters = {
  extractDocx: async (filePath) => (await mammoth.extractRawText({ path: filePath })).value,
  extractPdf: async (buffer) => {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  },
};

const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.docx', '.pdf'];

export async function convertFileToText(
  filePath: string,
  converters: FileConverters = defaultConverters
): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  let text: string;

  if (ext === '.txt' || ext === '.md') {
    text = fs.readFileSync(filePath, 'utf-8');
  } else if (ext === '.docx') {
    text = await converters.extractDocx(filePath);
  } else if (ext === '.pdf') {
    text = await converters.extractPdf(fs.readFileSync(filePath));
  } else {
    throw new Error(
      `trm ingest --file: unsupported file extension "${ext}" (supported: ${SUPPORTED_EXTENSIONS.join(', ')})`
    );
  }

  if (text.trim().length === 0) {
    throw new Error(`trm ingest --file: "${filePath}" produced no extractable text`);
  }

  return text;
}
