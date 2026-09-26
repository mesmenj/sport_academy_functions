import { HttpError, boundedBytes } from './http.mjs';
const path = value => value.split('/').map(encodeURIComponent).join('/');
export function platform(config, fetcher = fetch) {
  const headers = token => ({ apikey: config.anonKey, Authorization: `Bearer ${token}` });
  const service = { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` };
  async function call(url, options) {
    let result;
    try { result = await fetcher(`${config.supabaseUrl}${url}`, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw new HttpError(502, 'UPSTREAM_UNAVAILABLE'); }
    if (!result.ok) {
      // Never forward provider messages, email addresses or credentials to clients.
      throw new HttpError(result.status === 401 || result.status === 403 ? 403 : 502, 'UPSTREAM_REJECTED');
    }
    return result;
  }
  const rpc = async (name, args, token) => (await call(`/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { ...(token ? headers(token) : service), 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  })).json();
  return {
    rpc,
    async user(token) {
      if (!token) throw new HttpError(401, 'AUTH_REQUIRED');
      const user = await (await call('/auth/v1/user', { headers: headers(token) })).json();
      if (!user.id || !user.email_confirmed_at) throw new HttpError(403, 'VERIFIED_EMAIL_REQUIRED');
      return user;
    },
    async generateLink(email, existing) {
      return (await call('/auth/v1/admin/generate_link', { method: 'POST', headers: { ...service, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: existing ? 'magiclink' : 'invite', email }),
      })).json();
    },
    async upload(bucket, objectPath, bytes, mime) {
      // No upsert: retries cannot overwrite a finalized immutable asset.
      const result = await fetcher(`${config.supabaseUrl}/storage/v1/object/${path(bucket)}/${path(objectPath)}`, {
        method: 'POST', headers: { ...service, 'Content-Type': mime, 'x-upsert': 'false' }, body: bytes, signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) {
        const error = await result.json().catch(() => ({}));
        if (!(result.status === 409 || (result.status === 400 && ['Duplicate', '23505'].includes(error.error ?? error.code))))
          throw new HttpError(502, 'UPLOAD_FAILED');
      }
    },
    async download(bucket, objectPath) {
      const res = await call(`/storage/v1/object/authenticated/${path(bucket)}/${path(objectPath)}`, { headers: service });
      return boundedBytes(res, 2000000);
    },
    async sign(bucket, objectPath, expiresIn) {
      const data = await (await call(`/storage/v1/object/sign/${path(bucket)}/${path(objectPath)}`, {
        method: 'POST', headers: { ...service, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn }),
      })).json();
      if (typeof data.signedURL !== 'string' || !data.signedURL.startsWith('/object/sign/')) throw new HttpError(502, 'SIGNING_FAILED');
      return `${config.publicSupabaseUrl}/storage/v1${data.signedURL}`;
    },
    async remove(bucket, objectPath) {
      await call(`/storage/v1/object/${path(bucket)}`, { method: 'DELETE', headers: { ...service, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: [objectPath] }) });
    },
  };
}
