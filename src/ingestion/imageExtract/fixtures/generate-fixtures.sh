#!/bin/bash
# Generate image fixtures for testing
# Creates valid images of various sizes for load testing and edge case validation
# Large files (.gitignored) are generated on first test run, not committed

set -e

FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[fixtures] Generating test images in $FIXTURES_DIR"

# 1. Valid PNG (1x1, minimal)
# PNG magic bytes + minimal IHDR chunk
printf '\x89PNG\r\n\x1a\n' > "$FIXTURES_DIR/photo-valid-1x1.png"
printf '\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde' >> "$FIXTURES_DIR/photo-valid-1x1.png"
printf '\x00\x00\x00\x0cIDAT' >> "$FIXTURES_DIR/photo-valid-1x1.png"
printf '\x08\x99c\xf8\xcf\xc0\x00\x00\x03\x01\x01\x00' >> "$FIXTURES_DIR/photo-valid-1x1.png"
printf '\x18\xdd\x8d\xb4\x00\x00\x00\x00IEND\xaeB`\x82' >> "$FIXTURES_DIR/photo-valid-1x1.png"
echo "✓ photo-valid-1x1.png (PNG magic bytes + minimal IHDR)"

# 2. Valid JPEG (small 5KB sample)
# JPEG magic: FF D8 FF E0 (SOI + APP0)
printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00' > "$FIXTURES_DIR/photo-valid-5kb.jpg"
# Add minimal image data to reach ~5KB
for i in {1..200}; do
  printf '\xff\xdb\x00Cblahblahblah' >> "$FIXTURES_DIR/photo-valid-5kb.jpg"
done
# EOI marker
printf '\xff\xd9' >> "$FIXTURES_DIR/photo-valid-5kb.jpg"
echo "✓ photo-valid-5kb.jpg (JPEG magic + minimal image data)"

# 3. Valid GIF
# GIF magic: 47 49 46 (GIF8)
printf 'GIF89a' > "$FIXTURES_DIR/photo-valid.gif"
printf '\x01\x00\x01\x00\xf0\x00\x00\x00\x00\x00\xff\xff\xff' >> "$FIXTURES_DIR/photo-valid.gif"
printf '!' >> "$FIXTURES_DIR/photo-valid.gif"
printf '\xf9\x04\x01\x00\x00\x00\x00' >> "$FIXTURES_DIR/photo-valid.gif"
printf ',' >> "$FIXTURES_DIR/photo-valid.gif"
printf '\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x00\x44' >> "$FIXTURES_DIR/photo-valid.gif"
printf ';' >> "$FIXTURES_DIR/photo-valid.gif"
echo "✓ photo-valid.gif (GIF magic bytes)"

# 4. Valid WebP
# WebP magic: RIFF ... WEBP
printf 'RIFF' > "$FIXTURES_DIR/photo-valid.webp"
printf '\x28\x00\x00\x00WEBP' >> "$FIXTURES_DIR/photo-valid.webp"
# Minimal VP8 chunk
printf 'VP8 \x1c\x00\x00\x00\x9d\x01\x2a\x01\x00\x01\x00\x34\x25\xa4\x00\x03\x70\x00\xfe\xfb\x94\x00\x00' >> "$FIXTURES_DIR/photo-valid.webp"
echo "✓ photo-valid.webp (WebP magic bytes + minimal VP8 chunk)"

# 5. Invalid: corrupt image
# Valid PNG magic but corrupt data
printf '\x89PNG\r\n\x1a\n' > "$FIXTURES_DIR/photo-corrupt.png"
printf 'THISISNOTVALIDIMAGECORRUPTDATAHHHHH' >> "$FIXTURES_DIR/photo-corrupt.png"
echo "✓ photo-corrupt.png (PNG header + corrupt data)"

# 6. Invalid: empty file
touch "$FIXTURES_DIR/photo-empty.bin"
echo "✓ photo-empty.bin (empty file)"

# 7. Edge case: wrong extension but valid magic bytes
# File named .jpg but contains PNG magic
printf '\x89PNG\r\n\x1a\n' > "$FIXTURES_DIR/photo-wrong-ext.jpg"
printf '\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde' >> "$FIXTURES_DIR/photo-wrong-ext.jpg"
echo "✓ photo-wrong-ext.jpg (PNG magic, .jpg extension)"

# 8. Large JPEG (2MB) — NOT committed to git
# Generated only if not present (to prevent repo bloat)
LARGE_JPEG="$FIXTURES_DIR/photo-large.jpg"
if [ ! -f "$LARGE_JPEG" ]; then
  echo "[fixtures] Generating large JPEG (2MB) — this may take a moment..."

  # Use dd to create a large binary file with JPEG header
  printf '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00' > "$LARGE_JPEG"

  # Fill with pseudo-random data (2MB - 32 bytes)
  dd if=/dev/urandom of="$LARGE_JPEG" bs=1M count=2 oflag=append conv=notrunc 2>/dev/null || \
    dd if=/dev/zero of="$LARGE_JPEG" bs=1M count=2 oflag=append conv=notrunc 2>/dev/null

  # Add EOI marker
  printf '\xff\xd9' >> "$LARGE_JPEG"

  # Verify size
  SIZE=$(stat -f%z "$LARGE_JPEG" 2>/dev/null || stat -c%s "$LARGE_JPEG" 2>/dev/null || echo "?")
  echo "✓ photo-large.jpg ($SIZE bytes, generated on first run)"
fi

echo "[fixtures] ✓ All fixtures ready in $FIXTURES_DIR"
echo "[fixtures] Note: photo-large.jpg is .gitignored (generated at test time, not committed)"
