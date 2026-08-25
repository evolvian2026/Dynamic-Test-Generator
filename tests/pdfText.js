/**
 * Minimal PDF text extractor for tests.
 *
 * pdfkit writes subsetted fonts, so the visible text lives in hex-encoded TJ
 * arrays inside Flate-compressed content streams. Decoding them lets the test
 * suite assert on what the document actually says rather than only that the
 * bytes start with "%PDF".
 */

import zlib from 'node:zlib';

export function extractPdfText(buffer) {
  const parts = [];
  let position = 0;

  while (true) {
    const start = buffer.indexOf('stream', position);
    if (start === -1) break;

    let from = start + 6;
    if (buffer[from] === 0x0d) from += 1;
    if (buffer[from] === 0x0a) from += 1;

    const end = buffer.indexOf('endstream', from);
    if (end === -1) break;
    position = end + 9;

    let content;
    try {
      content = zlib.inflateSync(buffer.subarray(from, end)).toString('latin1');
    } catch {
      continue; // fonts, images and other non-Flate streams
    }

    for (const match of content.matchAll(/\[((?:\s*<[0-9a-fA-F]*>|\s*-?\d+)*)\s*\]\s*TJ/g)) {
      const text = [...match[1].matchAll(/<([0-9a-fA-F]*)>/g)]
        .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1'))
        .join('');
      if (text.trim()) parts.push(text);
    }
  }

  return parts.join('\n');
}
