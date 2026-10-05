/**
 * Google Drive standard and multipart upload endpoints abort on files exceeding 5 MB.
 * Resumable chunked upload transfers large profile bundles and archives in 8 MiB slices,
 * allowing recovery from interrupted connections without restarting the entire transfer.
 */

import fetch from 'node-fetch';
import { ensureValidAccessToken } from './gdriveClient';
import { withRetry } from './retry';

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB per Google Drive chunked upload protocol

export async function uploadResumable(args: {
  name: string;
  data: Buffer;
  folderId: string;
  existingFileId?: string;
  contentType?: string;
}): Promise<string> {
  const token = await ensureValidAccessToken();
  const contentType = args.contentType || 'application/octet-stream';
  const totalSize = args.data.length;
  const isUpdate = Boolean(args.existingFileId);

  // Large sync archives (>5 MB) fail Drive multipart uploads; initiating a resumable session
  // prevents payload truncation and memory exhaustion during transmission.
  const initUrl = isUpdate
    ? `https://www.googleapis.com/upload/drive/v3/files/${args.existingFileId}?uploadType=resumable`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';

  const initHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': contentType,
    'X-Upload-Content-Length': String(totalSize),
  };

  const initBody = isUpdate
    ? JSON.stringify({})
    : JSON.stringify({ name: args.name, parents: [args.folderId] });

  const initRes = await withRetry(() =>
    fetch(initUrl, {
      method: isUpdate ? 'PATCH' : 'POST',
      headers: initHeaders,
      body: initBody,
    })
  );

  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => '');
    throw new Error(`Drive resumable session init error (${initRes.status}): ${errText}`);
  }

  const sessionUrl = initRes.headers.get('location');
  if (!sessionUrl) {
    throw new Error('Google Drive resumable upload failed: missing Location header in session initiation response');
  }

  let offset = 0;
  let finalBody: unknown = undefined;

  // Chunked upload loop transfers data in 8 MiB slices so dropped connections do not lose
  // already-transmitted blocks and can resume from the last committed offset.
  while (offset < totalSize || (totalSize === 0 && finalBody === undefined)) {
    const chunkEnd = totalSize === 0 ? 0 : Math.min(offset + CHUNK_SIZE, totalSize);
    const chunk = totalSize === 0 ? Buffer.alloc(0) : args.data.subarray(offset, chunkEnd);
    const contentRange = totalSize === 0
      ? 'bytes */0'
      : `bytes ${offset}-${chunkEnd - 1}/${totalSize}`;

    const chunkRes = await withRetry(() =>
      fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': contentRange,
          'Content-Length': String(chunk.length),
        },
        body: chunk,
      })
    );

    if (chunkRes.status === 200 || chunkRes.status === 201) {
      try {
        finalBody = await chunkRes.json();
      } catch {
        finalBody = {};
      }
      break;
    }

    if (chunkRes.status === 308) {
      // 308 Resume Incomplete signals partial chunk commitment; inspect Range header
      // to advance offset accurately without duplicating already-written bytes.
      const rangeHeader = chunkRes.headers.get('range');
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=0-(\d+)/);
        if (match) {
          offset = parseInt(match[1], 10) + 1;
        } else {
          offset = chunkEnd;
        }
      } else {
        offset = chunkEnd;
      }
      continue;
    }

    const errText = await chunkRes.text().catch(() => '');
    throw new Error(`Drive resumable chunk upload error (${chunkRes.status}): ${errText}`);
  }

  let fileId: string | undefined;

  if (
    finalBody &&
    typeof finalBody === 'object' &&
    'id' in finalBody &&
    typeof finalBody.id === 'string' &&
    finalBody.id.trim().length > 0
  ) {
    fileId = finalBody.id.trim();
  }

  // Pre-existing file updates preserve the known remote identity if the provider omits body fields
  if (!fileId && args.existingFileId) {
    fileId = args.existingFileId;
  }

  // Re-derive file id by querying Drive to avoid corrupting sync manifests when completion responses drop metadata
  if (!fileId) {
    try {
      const freshToken = await ensureValidAccessToken();
      const sanitizedName = args.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      let q = `trashed = false and name = '${sanitizedName}'`;
      if (args.folderId) {
        q += ` and '${args.folderId}' in parents`;
      }
      const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        q
      )}&fields=files(id,name)&pageSize=1&supportsAllDrives=true`;
      const searchRes = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${freshToken}` },
      });
      if (searchRes.ok) {
        const searchData: unknown = await searchRes.json();
        if (
          searchData &&
          typeof searchData === 'object' &&
          'files' in searchData &&
          Array.isArray(searchData.files) &&
          searchData.files.length > 0
        ) {
          const first = searchData.files[0];
          if (first && typeof first === 'object' && 'id' in first && typeof first.id === 'string') {
            fileId = first.id;
          }
        }
      }
    } catch {
      // Ignored: falling through triggers the missing ID safety check below
    }
  }

  if (!fileId) {
    throw new Error(
      `Resumable upload completed for "${args.name}", but the file id could not be determined`
    );
  }

  return fileId;
}
