import { createHandler } from './handlers.mjs';
export async function serve(name) {
  const env = key => Deno.env.get(key);
  const config = {
    supabaseUrl: env('SUPABASE_URL'), publicSupabaseUrl: env('PUBLIC_SUPABASE_URL'),
    anonKey: env('SUPABASE_ANON_KEY'), serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    allowedOrigins: env('ALLOWED_ORIGINS'), workerSecret: env('WORKER_SECRET'), webhookSecret: env('BREVO_WEBHOOK_SECRET'),
    invitationSecret: env('INVITATION_TOKEN_SECRET'), invitationUrl: env('INVITATION_CALLBACK_URL'),
    brevoKey: env('BREVO_API_KEY'), senderEmail: env('BREVO_SENDER_EMAIL'), assetTtl: env('ASSET_URL_TTL_SECONDS'),
  };
  // Only the uploader loads codecs/WASM; notification workers stay lightweight.
  const decodeImage = name === 'secure-asset-upload' ? (await import('./decode.mjs')).decodeImage : undefined;
  Deno.serve(createHandler(name, config, { decodeImage }));
}
