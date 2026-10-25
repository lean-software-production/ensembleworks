/**
 * Test images.
 *
 * `jpegBytes` builds a STRUCTURALLY VALID JPEG — SOI, APP0/JFIF, SOF0, DHT,
 * SOS, entropy-coded bytes, EOI — because `isJpeg` walks the marker structure
 * rather than sniffing the first and last few bytes. A fixture that is only
 * "0xffd8 … 0xffd9" is exactly the marker-shaped garbage the store must refuse,
 * so it cannot double as the happy path.
 *
 * `realJpeg()` / `realPng()` read files produced by Chromium
 * (`page.screenshot({ type })`), so the validator is also checked against an
 * image no test wrote.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOI = [0xff, 0xd8];
/** APP0 / JFIF, length 16. */
const APP0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
/** SOF0: 8-bit, 1×1, one component (id 1, sampling 1×1, quant table 0). */
const SOF0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00];
/** DHT with an empty code-length table. */
const DHT = [0xff, 0xc4, 0x00, 0x13, 0x00, ...new Array<number>(16).fill(0)];
/** SOS: one component, then entropy-coded data until EOI. */
const SOS = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
const EOI = [0xff, 0xd9];

/** The shortest image `jpegBytes` can produce. */
export const MIN_JPEG_BYTES = SOI.length + APP0.length + SOF0.length + DHT.length + SOS.length + EOI.length;

export function jpegBytes(length = 128): Uint8Array {
  if (length < MIN_JPEG_BYTES) throw new Error(`a JPEG needs at least ${MIN_JPEG_BYTES} bytes`);
  const scan = new Array<number>(length - MIN_JPEG_BYTES).fill(0x42);
  return new Uint8Array([...SOI, ...APP0, ...SOF0, ...DHT, ...SOS, ...scan, ...EOI]);
}

export function jpegBase64(length = 128): string {
  return Buffer.from(jpegBytes(length)).toString("base64");
}

export function realJpeg(): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL("../fixtures/portrait.jpg", import.meta.url))));
}

export function realPng(): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL("../fixtures/portrait.png", import.meta.url))));
}
