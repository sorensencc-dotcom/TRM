// One-time generator for tests/fixtures/scanned-sample.pdf.
// Run manually: npx ts-node scripts/generate-scanned-pdf-fixture.ts
// Produces a 2-page PDF with a rasterized PNG on each page and NO text
// layer -- exercises the real render boundary the same way an actual
// scanned document would.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';

// 4x4 red PNG, smallest valid raster that still round-trips through
// pdfjs-dist/@napi-rs/canvas rendering.
const RED_SQUARE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEUlEQVR42mNk+M9QDwABKAECBnFa3AAAAABJRU5ErkJggg==';

async function main() {
  const pdfDoc = await PDFDocument.create();
  const pngBytes = Buffer.from(RED_SQUARE_PNG_BASE64, 'base64');
  const pngImage = await pdfDoc.embedPng(pngBytes);

  for (let i = 0; i < 2; i++) {
    const page = pdfDoc.addPage([200, 200]);
    page.drawImage(pngImage, { x: 50, y: 50, width: 100, height: 100 });
    // Deliberately no page.drawText() call anywhere -- this PDF has image
    // content only, matching a scanned document with no text layer.
  }

  const pdfBytes = await pdfDoc.save();
  const outPath = path.join(__dirname, '..', 'tests', 'fixtures', 'scanned-sample.pdf');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pdfBytes);
  console.log(`Wrote ${outPath} (${pdfBytes.length} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
