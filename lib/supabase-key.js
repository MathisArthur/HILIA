/**
 * En-têtes PostgREST adaptés au format de la clé.
 *
 * Les clés `sb_publishable_…` et `sb_secret_…` ne sont pas des JWT : elles se
 * transmettent dans `apikey`. Les anciennes clés `anon` / `service_role` au
 * format JWT utilisent aussi `Authorization: Bearer`.
 */
export function supabaseHeaders(key) {
  const value = String(key || '');
  const headers = { apikey: value };
  if (!/^sb_(publishable|secret)_/i.test(value)) {
    headers.Authorization = `Bearer ${value}`;
  }
  return headers;
}
