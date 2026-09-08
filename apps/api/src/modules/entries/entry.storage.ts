import { EntryError } from './entry.errors.js';
import { entryId } from './entry.schema.js';

export const entryEvidenceMaxBytes = 5 * 1024 * 1024;
export type EvidenceMediaType = 'image/png' | 'image/jpeg';
export interface EntryEvidenceStorage {
  upload(id: string, token: string, mediaType: EvidenceMediaType, bytes: Uint8Array): Promise<void>;
  download(
    id: string,
    token: string,
  ): Promise<{ readonly mediaType: EvidenceMediaType; readonly bytes: Uint8Array }>;
}
export const validateEvidenceImage = (mediaType: unknown, bytes: Uint8Array): EvidenceMediaType => {
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg =
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217;
  if (
    bytes.length === 0 ||
    bytes.length > entryEvidenceMaxBytes ||
    (mediaType !== 'image/png' && mediaType !== 'image/jpeg') ||
    (mediaType === 'image/png' ? !png : !jpeg)
  ) {
    throw new EntryError('ENTRY_INVALID_INPUT');
  }
  return mediaType;
};
export const createSupabaseEntryStorage = (options: {
  readonly url: string;
  readonly publishableKey: string;
  readonly fetcher?: typeof fetch;
}): EntryEvidenceStorage => {
  const fetcher = options.fetcher ?? fetch;
  const call = async (path: string, token: string, init: RequestInit): Promise<Response> => {
    try {
      const headers = new Headers(init.headers);
      headers.set('apikey', options.publishableKey);
      headers.set('Authorization', `Bearer ${token}`);
      return await fetcher(`${options.url}${path}`, {
        ...init,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new EntryError('ENTRY_STORAGE_UNAVAILABLE');
    }
  };
  return {
    upload: async (id, token, mediaType, bytes) => {
      validateEvidenceImage(mediaType, bytes);
      const response = await call(`/object/entry-evidence/${entryId(id)}`, token, {
        method: 'POST',
        headers: { 'Content-Type': mediaType, 'x-upsert': 'false' },
        body: new Blob([Uint8Array.from(bytes)]),
      });
      // A lost upload response is recoverable by reading and comparing immutable object bytes.
      await response.body?.cancel();
      if (!response.ok && response.status !== 400 && response.status !== 409)
        throw new EntryError('ENTRY_STORAGE_UNAVAILABLE');
    },
    download: async (id, token) => {
      const response = await call(`/object/authenticated/entry-evidence/${entryId(id)}`, token, {
        method: 'GET',
      });
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new EntryError('ENTRY_STORAGE_UNAVAILABLE');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.length;
          if (total > entryEvidenceMaxBytes) throw new EntryError('ENTRY_STORAGE_UNAVAILABLE');
          chunks.push(chunk.value);
        }
      } catch {
        throw new EntryError('ENTRY_STORAGE_UNAVAILABLE');
      } finally {
        await reader.cancel();
      }
      const bytes = Uint8Array.from(Buffer.concat(chunks));
      const mediaType = validateEvidenceImage(
        response.headers.get('content-type')?.split(';')[0],
        bytes,
      );
      return { mediaType, bytes };
    },
  };
};
