import { HttpError, uuid, boundedBytes, jsonBody, digest, hex, equalSecret, response } from './http.mjs';
import { validateImage } from './media.mjs';
import { platform } from './platform.mjs';
const required = value => { if (!value) throw new HttpError(503, 'CONFIG_REQUIRED'); return value; };
const ttl = value => { const n = Number(value); if (!Number.isInteger(n) || n < 30 || n > 300) throw new HttpError(503, 'ASSET_TTL_REQUIRED'); return n; };
export function renderEmail(d) {
  const fr = d.language === 'FR';
  if (d.template === 'MEMBERSHIP_INVITED' || d.template === 'INVITATION_RESENT') return {
    subject: fr ? 'Invitation Sport Connect Academy' : 'Sport Connect Academy invitation',
    textContent: `${fr ? 'Acceptez votre invitation' : 'Accept your invitation'} :\n${required(d.body.invitation_url)}`,
  };
  const names = {
    BOOKING_REQUESTED: ['Demande de réservation', 'Booking requested'], BOOKING_SCHEDULED: ['Réservation planifiée', 'Booking scheduled'],
    BOOKING_APPROVED: ['Réservation confirmée', 'Booking approved'], BOOKING_REJECTED: ['Réservation refusée', 'Booking rejected'],
    BOOKING_CANCELLED: ['Réservation annulée', 'Booking cancelled'], BOOKING_REMINDER: ['Rappel de séance', 'Session reminder'],
  };
  const subject = names[d.template]?.[fr ? 0 : 1]; if (!subject) throw new HttpError(400, 'UNKNOWN_TEMPLATE');
  const date = new Intl.DateTimeFormat(fr ? 'fr-FR' : 'en-GB', { timeZone: d.body.timezone, dateStyle: 'long', timeStyle: 'short' }).format(new Date(d.body.starts_at));
  return { subject, textContent: `${d.body.academy}\n${subject}\n${date} (${d.body.timezone})` };
}
export function createHandler(name, config, { fetcher = fetch, db = platform(config, fetcher), decodeImage } = {}) {
  const workers = ['provision-invitation', 'expand-email-outbox', 'deliver-email', 'schedule-notifications', 'cleanup-assets-and-content'];
  return async request => {
    const origin = request.headers.get('origin');
    const origins = (config.allowedOrigins ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const cors = origin && origins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
      'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-academy-id,x-asset-usage,x-tournament-id,x-operation-key',
      'Access-Control-Allow-Methods': 'POST,OPTIONS' } : {};
    try {
      if (origin && !origins.includes(origin)) throw new HttpError(403, 'ORIGIN_FORBIDDEN');
      if (request.method === 'OPTIONS' && !workers.includes(name) && name !== 'brevo-webhook') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      if (workers.includes(name) && !await equalSecret(request.headers.get('x-worker-secret'), config.workerSecret)) throw new HttpError(401, 'WORKER_AUTH_REQUIRED');
      if (name === 'brevo-webhook' && !await equalSecret(request.headers.get('x-webhook-secret'), config.webhookSecret)) throw new HttpError(401, 'WEBHOOK_AUTH_REQUIRED');
      let result;
      if (name === 'secure-asset-upload') {
        const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
        const user = await db.user(token);
        const academy = uuid(request.headers.get('x-academy-id'));
        const key = uuid(request.headers.get('x-operation-key'));
        const tournament = request.headers.get('x-tournament-id');
        const usage = request.headers.get('x-asset-usage');
        const bytes = await boundedBytes(request, 2000000);
        const media = await validateImage(bytes, request.headers.get('content-type'), decodeImage);
        const asset = await db.rpc('prepare_asset', { p_academy: academy, p_usage: usage, p_tournament: tournament ? uuid(tournament) : null,
          p_mime: media.mime, p_size: media.size, p_sha256: media.sha256, p_operation_key: key }, token);
        await db.upload(asset.bucket, asset.path, bytes, media.mime);
        // Do not trust the request after a duplicate upload or an uncertain HTTP response.
        const stored = await db.download(asset.bucket, asset.path);
        const proof = await validateImage(stored, media.mime, decodeImage);
        result = await db.rpc('svc_finalize_asset', { p_asset: asset.asset_id, p_actor: user.id, p_mime: proof.mime,
          p_size: proof.size, p_sha256: proof.sha256 });
      } else if (name === 'read-asset-url') {
        const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]; await db.user(token);
        const body = await jsonBody(request);
        const duration = ttl(config.assetTtl);
        const asset = await db.rpc('authorize_asset_read', { p_academy: uuid(body.academy_id), p_asset: uuid(body.asset_id) }, token);
        result = { url: await db.sign(asset.bucket, asset.path, duration), expires_in: duration };
      } else if (name === 'provision-invitation') {
        const base = new URL(required(config.invitationUrl));
        if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new HttpError(503, 'INVALID_CALLBACK');
        const secret = required(config.invitationSecret); if (secret.length < 32) throw new HttpError(503, 'CONFIG_REQUIRED');
        const invitation = await db.rpc('svc_claim_invitation', {});
        if (!invitation) result = { outcome: 'IDLE' };
        else {
          const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const token = hex(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${invitation.id}/${invitation.lease_token}`)));
          const auth = await db.generateLink(invitation.email, invitation.existing_user);
          // GoTrue REST returns flattened fields, unlike the JS SDK wrapper.
          if (!auth.id || !auth.hashed_token || !['invite', 'magiclink'].includes(auth.verification_type)) throw new HttpError(502, 'AUTH_PROVISIONING_FAILED');
          base.hash = new URLSearchParams({ invitation: invitation.id, token, token_hash: auth.hashed_token, type: auth.verification_type }).toString();
          result = await db.rpc('svc_finish_invitation', { p_invitation: invitation.id, p_lease: invitation.lease_token,
            p_user: uuid(auth.id), p_digest: await digest(new TextEncoder().encode(token)), p_link: base.toString() });
        }
      } else if (name === 'expand-email-outbox') {
        result = await db.rpc('svc_expand_notification', {}) ?? { outcome: 'IDLE' };
      } else if (name === 'schedule-notifications') {
        result = await db.rpc('svc_queue_reminders', {});
      } else if (name === 'deliver-email') {
        // Validate configuration before taking a delivery lease.
        const apiKey = required(config.brevoKey), sender = required(config.senderEmail);
        const d = await db.rpc('svc_claim_delivery', {});
        if (!d || d.skipped) result = { outcome: d ? 'SKIPPED' : 'IDLE' };
        else {
          let outcome = 'UNKNOWN', messageId = null;
          // Any network/5xx/invalid response can follow an actual send. Only explicit 429 is retryable.
          try {
            const res = await fetcher('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: AbortSignal.timeout(15000),
              headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ sender: { email: sender, name: 'Sport Connect Academy' }, to: [{ email: d.email }], ...renderEmail(d),
                headers: { 'X-Mailin-custom': `delivery_id:${d.id}`, idempotencyKey: d.idempotency_key } }),
            });
            if (res.ok) {
              const body = await res.json();
              if (typeof body.messageId === 'string' && body.messageId.length <= 500) { outcome = 'ACCEPTED'; messageId = body.messageId; }
            } else if (res.status === 429) outcome = 'RETRY';
            else if ([400, 401, 403, 404, 422].includes(res.status)) outcome = 'FAILED';
          } catch { /* No logs: provider responses can contain recipient data or tokens. */ }
          result = await db.rpc('svc_record_delivery', { p_delivery: d.id, p_lease: d.lease_token, p_outcome: outcome, p_message_id: messageId });
        }
      } else if (name === 'brevo-webhook') {
        const body = await jsonBody(request, 65536);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_WEBHOOK');
        const id = typeof body['X-Mailin-custom'] === 'string' ? body['X-Mailin-custom'].match(/^delivery_id:([0-9a-f-]{36})$/i)?.[1] : null;
        const stamp = Number(body.ts_event);
        if (!id || !Number.isFinite(stamp) || stamp <= 0 || typeof body['message-id'] !== 'string' || typeof body.event !== 'string') throw new HttpError(400, 'INVALID_WEBHOOK');
        result = await db.rpc('svc_apply_email_webhook', { p_delivery: uuid(id), p_message_id: body['message-id'],
          p_event: body.event, p_occurred_at: new Date(stamp * 1000).toISOString() });
      } else if (name === 'cleanup-assets-and-content') {
        const body = await jsonBody(request);
        let deleted = 0;
        if (body.asset_before !== undefined) {
          // Retention is an explicit operator decision, not a default cleanup policy.
          if (!Number.isFinite(Date.parse(body.asset_before))) throw new HttpError(400, 'INVALID_RETENTION');
          const asset = await db.rpc('svc_claim_asset_cleanup', { p_before: body.asset_before });
          if (asset) { await db.remove(asset.bucket, asset.path); await db.rpc('svc_finish_asset_cleanup', { p_asset: asset.asset_id }); deleted = 1; }
        }
        result = { ...await db.rpc('svc_purge_notification_content', {}), assets_deleted: deleted };
      } else throw new HttpError(404, 'NOT_FOUND');
      return response(result, 200, cors);
    } catch (error) {
      return response({ error: error instanceof HttpError ? error.code : 'INTERNAL_ERROR' }, error instanceof HttpError ? error.status : 500, cors);
    }
  };
}
