export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const uuid = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, 'INVALID_UUID');
  return value;
};
export async function boundedBytes(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export async function jsonBody(request, limit = 16384) {
  try { return JSON.parse(new TextDecoder().decode(await boundedBytes(request, limit))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'INVALID_JSON'); }
}
export const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export const digest = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
export async function equalSecret(actual, expected) {
  if (!actual || !expected || expected.length < 32) return false;
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(actual)));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)));
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});
