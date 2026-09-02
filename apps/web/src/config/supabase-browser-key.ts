const modernPublishableKeyPattern = /^sb_publishable_[A-Za-z0-9_-]+$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;

const decodeBase64Url = (value: string): string => {
  if (!base64UrlPattern.test(value) || value.length % 4 === 1) {
    throw new Error('The legacy Supabase key is malformed.');
  }
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};

const isLegacyAnonKey = (value: string): boolean => {
  const segments = value.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) return false;
  try {
    const payload = JSON.parse(decodeBase64Url(segments[1] ?? '')) as unknown;
    return (
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload) &&
      'role' in payload &&
      payload.role === 'anon'
    );
  } catch {
    return false;
  }
};

export const isBrowserSafeSupabaseKey = (value: string): boolean =>
  modernPublishableKeyPattern.test(value) || isLegacyAnonKey(value);

export const assertBrowserSafeSupabaseKey = (value: string): void => {
  if (!isBrowserSafeSupabaseKey(value)) {
    throw new Error(
      'VITE_SUPABASE_PUBLISHABLE_KEY must be a browser-safe Supabase publishable or anon key.',
    );
  }
};
