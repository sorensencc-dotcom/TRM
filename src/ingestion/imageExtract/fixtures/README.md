# Image Fixtures for Testing

Test fixtures used in imageAnalyzer integration tests and load tests.

## Files

### Valid Images (Committed)
- **photo-valid-1x1.png** — Minimal PNG (1x1 pixel), valid magic bytes + IHDR chunk
- **photo-valid-5kb.jpg** — JPEG sample (~5KB), valid JPEG structure
- **photo-valid.gif** — GIF sample, valid GIF87a header
- **photo-valid.webp** — WebP sample, valid RIFF + WEBP header

### Invalid Images (Committed)
- **photo-corrupt.png** — Valid PNG header + corrupt data (tests robustness)
- **photo-empty.bin** — Empty file (tests null handling)
- **photo-wrong-ext.jpg** — PNG magic bytes in .jpg file (tests format detection)

### Large Images (Generated, .gitignore'd)
- **photo-large.jpg** — 2MB JPEG (not committed to git)
  - Generated on first test run via `generate-fixtures.sh`
  - Used for load testing and SLA validation (p99 latency <500ms)

## Usage

### Generating Fixtures
```bash
bash generate-fixtures.sh
```

This creates all valid/invalid test images. The large JPEG is only generated if missing (prevents repo bloat).

### In Tests
```typescript
import { readFileSync } from 'fs';
import { join } from 'path';

const fixturesDir = join(__dirname, 'fixtures');
const pngBuffer = readFileSync(join(fixturesDir, 'photo-valid-1x1.png'));

const result = await analyzer.extract(pngBuffer);
```

### Load Testing
Use `photo-large.jpg` for concurrency tests:
```bash
# Test 50 concurrent requests with large JPEG
k6 run load-test.js
```

## Format Detection Strategy

Tests verify magic-byte detection (not extension):
- PNG: `89 50 4E 47` (first 4 bytes)
- JPEG: `FF D8 FF` (first 3 bytes)
- GIF: `47 49 46` (ASCII "GIF")
- WebP: `RIFF` ... `WEBP` (at offset 8-12)

The `photo-wrong-ext.jpg` file ensures service handles format correctly despite wrong extension.

## Maintenance

- **Small fixtures**: Committed to git, fast to generate
- **Large fixtures**: Generated at runtime, not committed, recreated as needed
- **Regenerate all**: `bash generate-fixtures.sh` (safe to run repeatedly)

## SLA & Load Testing Constraints

- Service SLA: p99 latency <500ms (end-to-end)
- Network co-location assumed: one-way latency <100ms
- Load test: 50 concurrent requests with photo-large.jpg
- Regression check: p99 ≤ baseline * 1.1 (10% margin)

See `docs/meta/specs/2026-07-18-trm-harvester-test-data-strategy.md` for full details.
