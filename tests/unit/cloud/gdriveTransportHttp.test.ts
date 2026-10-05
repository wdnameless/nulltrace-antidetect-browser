/**
 * The Drive transport against a protocol-level fake.
 *
 * The other cloud tests use an in-memory transport object, which proves the sync logic but never
 * exercises `HttpGDriveTransport` — and that class is where the parts most likely to be wrong live:
 * Drive's pagination, the 308/`Range` resume protocol, and the retry path that decides whether a
 * throttled request is retried or lost.
 *
 * `node-fetch` is mocked, so no network and no Google account are involved, but the fake answers the
 * real request shapes and returns the real response headers Drive sends. If the transport asks for
 * the wrong URL, sends the wrong body, or misreads a status, this fails.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const fetchMock = vi.fn();

// Hoisted mock: the transport imports `node-fetch` directly at module scope.
vi.mock('node-fetch', () => ({ default: (...args: unknown[]) => fetchMock(...args) }));

import {
  setGDriveStorage,
  saveGDriveCredentials,
  saveGDriveRefreshToken,
  setCachedAccessToken,
} from '../../../src/main/cloud/gdriveAuth';
import { HttpGDriveTransport, type DriveFileInfo } from '../../../src/main/cloud/gdriveTransfer';

/** What Drive holds: file/folder id → { name, bytes }. */
let drive: Map<string, { name: string; bytes: Buffer }>;

/** An open resumable upload: the bytes still expected, and what has landed so far. */
interface OpenSession {
  fileId: string;
  name: string;
  total: number;
  received: Buffer;
}

let sessions: Map<string, OpenSession>;
let nextFileId: number;
let nextFolderId: number;

/** Statuses to return before the normal response, e.g. `[429]` makes the first call throttle. */
let pendingThrottles: number[];

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get: (key: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  buffer: () => Promise<Buffer>;
}

function respond(status: number, bytes: Buffer, headers: Record<string, string> = {}): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers[key.toLowerCase()] ?? null },
    text: async () => bytes.toString('utf8'),
    json: async () => JSON.parse(bytes.toString('utf8')) as unknown,
    buffer: async () => bytes,
  };
}

const asJson = (status: number, body: unknown, headers?: Record<string, string>) =>
  respond(status, Buffer.from(JSON.stringify(body), 'utf8'), headers);

const throttle = (): FakeResponse => respond(429, Buffer.from('{"error":"rateLimitExceeded"}'), {
  'retry-after': '0',
});

function bodyBytes(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
}

function fileNameFromMultipart(bytes: Buffer): string {
  return /"name"\s*:\s*"([^"]+)"/.exec(bytes.toString('utf8'))?.[1] ?? 'unnamed';
}

/** Extract the payload part of a `multipart/related` body: header, metadata, content, footer. */
function multipartPayload(envelope: Buffer): Buffer {
  const text = envelope.toString('latin1');
  // The content part begins after the second blank-line separator and ends at the closing boundary.
  const secondSeparator = text.indexOf('\r\n\r\n', text.indexOf('\r\n\r\n') + 4);
  const footer = text.lastIndexOf('\r\n--');
  return Buffer.from(text.slice(secondSeparator + 4, footer), 'latin1');
}

/** Answer one request the way Drive would. */
function handle(url: string, method: string, body: unknown, headers: Record<string, string>): FakeResponse {
  // files.list — Drive pages the result set and returns `nextPageToken`. A transport that ignores the
  // token silently sees only the first page and believes it has seen every file.
  if (url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
    const all = [...drive.entries()].map(([id, file]) => ({
      id,
      name: file.name,
      modifiedTime: '2026-01-01T00:00:00.000Z',
    }));
    if (new URL(url).searchParams.get('pageToken')) return asJson(200, { files: all.slice(2) });
    return asJson(200, { files: all.slice(0, 2), nextPageToken: 'page-2' });
  }

  // Folder creation — a plain JSON POST with no uploadType.
  if (url.startsWith('https://www.googleapis.com/drive/v3/files') && method === 'POST') {
    const { name } = JSON.parse(bodyBytes(body).toString('utf8')) as { name: string };
    const id = `folder-${++nextFolderId}`;
    drive.set(id, { name, bytes: Buffer.alloc(0) });
    return asJson(200, { id });
  }

  // Resumable session creation. The declared length is what lets the server know when the last chunk
  // has landed, so it is read from the init request's own header.
  if (url.includes('uploadType=resumable') && method === 'POST') {
    const meta = JSON.parse(bodyBytes(body).toString('utf8')) as { name?: string };
    const fileId = `file-${++nextFileId}`;
    const sessionUrl = `https://upload.example/session-${fileId}`;
    sessions.set(sessionUrl, {
      fileId,
      name: meta.name ?? 'unnamed',
      total: Number(headers['X-Upload-Content-Length'] ?? 0),
      received: Buffer.alloc(0),
    });
    return asJson(200, {}, { location: sessionUrl });
  }

  // Chunk PUT. Drive answers 308 + `Range` while more bytes are expected, and a final 200 with the
  // file metadata once the declared length has arrived.
  if (url.startsWith('https://upload.example/session-')) {
    const session = sessions.get(url);
    if (!session) return asJson(404, {});
    session.received = Buffer.concat([session.received, bodyBytes(body)]);
    if (session.received.length < session.total) {
      return asJson(308, {}, { range: `bytes=0-${session.received.length - 1}` });
    }
    drive.set(session.fileId, { name: session.name, bytes: session.received });
    sessions.delete(url);
    return asJson(200, { id: session.fileId });
  }

  // Media upload against an existing file.
  if (url.includes('uploadType=media') && method === 'PATCH') {
    const fileId = url.split('/files/')[1].split('?')[0];
    drive.set(fileId, { name: drive.get(fileId)?.name ?? 'unnamed', bytes: bodyBytes(body) });
    return asJson(200, { id: fileId });
  }

  // Multipart create: the body is a `multipart/related` document whose second part is the payload.
  // Drive stores only that part, so the fake has to unwrap it or every read-back would carry the
  // envelope headers.
  if (url.includes('uploadType=multipart') && method === 'POST') {
    const envelope = bodyBytes(body);
    const fileId = `file-${++nextFileId}`;
    drive.set(fileId, {
      name: fileNameFromMultipart(envelope),
      bytes: multipartPayload(envelope),
    });
    return asJson(200, { id: fileId });
  }

  // Download with `alt=media` returns the stored bytes verbatim.
  const fileIdInUrl = /\/drive\/v3\/files\/([^?]+)/.exec(url)?.[1];
  if (fileIdInUrl && url.includes('alt=media')) {
    const file = drive.get(fileIdInUrl);
    return file ? respond(200, file.bytes) : asJson(404, { error: 'notFound' });
  }
  if (fileIdInUrl && method === 'DELETE') {
    drive.delete(fileIdInUrl);
    return asJson(204, {});
  }

  return asJson(404, { error: `unrouted ${method} ${url}` });
}

beforeEach(() => {
  drive = new Map();
  sessions = new Map();
  pendingThrottles = [];
  nextFileId = 0;
  nextFolderId = 0;

  const store = new Map<string, string>();
  setGDriveStorage({
    get: (key) => store.get(key) ?? null,
    set: (key, value) => void store.set(key, value),
    delete: (key) => void store.delete(key),
  });
  saveGDriveCredentials({ clientId: 'operator.apps.googleusercontent.com' });
  saveGDriveRefreshToken('1//refresh');
  setCachedAccessToken('ya29.test-token', 3600);

  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (pendingThrottles.length > 0) {
      pendingThrottles.shift();
      return throttle();
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    return handle(String(url), init.method ?? 'GET', init.body, headers);
  });
});

const transport = new HttpGDriveTransport();

describe('folder discovery', () => {
  it('creates a folder under the canonical name', async () => {
    const id = await transport.createFolder('nulltrace data');
    expect(id).toMatch(/^folder-/);
    expect(drive.get(id)?.name).toBe('nulltrace data');
  });
});

describe('listing', () => {
  it('follows nextPageToken rather than reporting only the first page', async () => {
    for (let i = 0; i < 5; i += 1) drive.set(`f${i}`, { name: `file-${i}`, bytes: Buffer.alloc(0) });

    const files: DriveFileInfo[] = await transport.listFiles('folder-1');

    // The fake only ever hands out two rows per page, so seeing all five proves the token was used.
    expect(files).toHaveLength(5);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('pageToken=page-2'))).toBe(true);
  });
});

describe('uploads', () => {
  it('round-trips a payload byte for byte through a multipart upload', async () => {
    const payload = Buffer.from(JSON.stringify({ tables: { groups: { g1: { name: 'Ünïcødé' } } } }), 'utf8');

    const id = await transport.uploadFile('state-1.ntdata', payload, 'folder-1');

    expect(drive.get(id)?.name).toBe('state-1.ntdata');
    // A latin1 read/write round trip would preserve the length and corrupt every byte above 0x7F,
    // which is exactly what happens to a sealed payload held as text.
    expect(Buffer.compare(await transport.downloadBuffer(id), payload)).toBe(0);
  });

  it('updates an existing file in place instead of creating a duplicate', async () => {
    const first = await transport.uploadFile('manifest.json', Buffer.from('{"a":1}'), 'folder-1');
    const second = await transport.uploadFile('manifest.json', Buffer.from('{"a":2}'), 'folder-1', first);

    expect(second).toBe(first);
    expect(drive.size).toBe(1);
  });

  it('switches to a chunked resumable session above 5 MB and reassembles the exact bytes', async () => {
    // 9 MiB is just over the transport's 8 MiB chunk, so the resume path must actually run.
    const big = Buffer.alloc(9 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 31 + 7) & 0xff;

    const id = await transport.uploadFile('profiles-full.tar.gz', big, 'folder-1');

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('uploadType=resumable'))).toBe(true);
    // More than one chunk PUT means the 308 + `Range` resume path ran rather than a single oversized
    // request, which Drive rejects outright above 5 MB.
    const chunks = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith('https://upload.example/session-')
    );
    expect(chunks.length).toBeGreaterThan(1);

    const back = await transport.downloadBuffer(id);
    expect(back.length).toBe(big.length);
    expect(Buffer.compare(back, big)).toBe(0);
  });
});

describe('retries', () => {
  it('retries a throttled request instead of losing the sync', async () => {
    pendingThrottles = [429];
    drive.set('f1', { name: 'manifest.json', bytes: Buffer.from('{"ok":true}') });

    expect(await transport.downloadFile('f1')).toContain('ok');
    expect(pendingThrottles).toHaveLength(0);
  });
});

describe('downloads', () => {
  it('surfaces a 404 rather than returning an empty string', async () => {
    await expect(transport.downloadBuffer('does-not-exist')).rejects.toThrow(/404/);
  });

  it('treats deleting an already-deleted file as the desired end state', async () => {
    await expect(transport.deleteFile('does-not-exist')).resolves.toBeUndefined();
  });
});