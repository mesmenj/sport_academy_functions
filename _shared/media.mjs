import { HttpError, digest } from './http.mjs';
const bad = () => { throw new HttpError(400, 'INVALID_MEDIA'); };
const ascii = (b, a, z) => String.fromCharCode(...b.subarray(a, z));
// Parse dimensions BEFORE any decoder allocation. Animation is deliberately rejected.
export function imageHeader(b) {
  if (b.length < 20 || b.length > 2000000) return bad();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let mime, width, height;
  if (b[0] === 137 && ascii(b, 1, 4) === 'PNG' && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) {
    if (b.length < 33 || ascii(b, 12, 16) !== 'IHDR') return bad();
    mime = 'image/png'; width = v.getUint32(16); height = v.getUint32(20);
    for (let i = 8; i + 12 <= b.length;) {
      const size = v.getUint32(i); if (size > b.length - i - 12 || ascii(b, i + 4, i + 8) === 'acTL') return bad();
      i += size + 12;
    }
  } else if (b[0] === 255 && b[1] === 216) {
    mime = 'image/jpeg'; let i = 2;
    while (i + 4 < b.length) {
      if (b[i++] !== 255) return bad();
      while (b[i] === 255) i++;
      const marker = b[i++]; if (marker === 217 || marker === 218) break;
      const length = v.getUint16(i); if (length < 2 || i + length > b.length) return bad();
      if ([192, 193, 194].includes(marker)) { height = v.getUint16(i + 3); width = v.getUint16(i + 5); break; }
      i += length;
    }
  } else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    mime = 'image/webp'; if (v.getUint32(4, true) + 8 !== b.length) return bad();
    const kind = ascii(b, 12, 16);
    if (kind === 'VP8X') {
      if (b.length < 30 || (b[20] & 2)) return bad();
      width = 1 + b[24] + (b[25] << 8) + (b[26] << 16); height = 1 + b[27] + (b[28] << 8) + (b[29] << 16);
    } else if (kind === 'VP8L') {
      if (b.length < 25 || b[20] !== 47) return bad();
      const bits = v.getUint32(21, true); width = 1 + (bits & 16383); height = 1 + ((bits >>> 14) & 16383);
    } else if (kind === 'VP8 ') {
      if (b.length < 30 || b[23] !== 157 || b[24] !== 1 || b[25] !== 42) return bad();
      width = v.getUint16(26, true) & 16383; height = v.getUint16(28, true) & 16383;
    }
  }
  if (!width || !height || width > 4096 || height > 4096 || width * height > 4000000) return bad();
  return { mime, width, height };
}
export async function validateImage(bytes, claimedMime, decode) {
  const header = imageHeader(bytes);
  if (header.mime !== claimedMime) return bad();
  let decoded;
  try { decoded = await decode(bytes, header.mime); } catch { return bad(); }
  if (decoded.width !== header.width || decoded.height !== header.height || decoded.data.length !== header.width * header.height * 4) return bad();
  return { mime: header.mime, size: bytes.length, sha256: await digest(bytes) };
}
