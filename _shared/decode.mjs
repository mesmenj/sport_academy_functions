import { Buffer } from 'node:buffer';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import decodeWebp, { init } from '@jsquash/webp/decode.js';
let ready;
async function webpReady() {
  const url = new URL('./codecs/webp_dec.wasm', import.meta.url);
  const bytes = typeof Deno !== 'undefined' ? await Deno.readFile(url) : await (await import('node:fs/promises')).readFile(url);
  await init(await WebAssembly.compile(bytes));
}
export async function decodeImage(bytes, mime) {
  if (mime === 'image/png') return PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
  if (mime === 'image/jpeg') return jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64, tolerantDecoding: false });
  ready ??= webpReady(); await ready;
  return decodeWebp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
