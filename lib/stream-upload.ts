import busboy from 'busboy';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getStorageRoot } from './storage';

export class UploadError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export interface UploadedPart { name: string; type: string; path: string; size: number; field: string }
const state = globalThis as typeof globalThis & { archiveUploadsActive?: number };

/** Bounded memory, disk staging on the storage filesystem, and backpressure throughout. */
export async function receiveUpload(req: Request, limits: { files: number; fileBytes: number; totalBytes: number; fileField: string }) {
  if ((state.archiveUploadsActive || 0) >= 2) throw new UploadError('Uploads busy. Try again shortly.', 503);
  const declaredLength = Number(req.headers.get('content-length'));
  const maxBodyBytes = limits.totalBytes + 16 * 1024 * 1024;
  if (declaredLength > maxBodyBytes) throw new UploadError('Upload is too large', 413);
  if (!req.body) throw new UploadError('Missing upload body');
  state.archiveUploadsActive = (state.archiveUploadsActive || 0) + 1;
  let dir: string | undefined;
  const controller = new AbortController();
  let failure: Error | undefined;
  const fail = (error: Error) => { failure ??= error; queueMicrotask(() => controller.abort(error)); };
  const onAbort = () => fail(new UploadError('Upload cancelled'));
  req.signal.addEventListener('abort', onAbort, { once: true });
  if (req.signal.aborted) onAbort();
  const timer = setTimeout(() => fail(new UploadError('Upload timed out', 408)), 10 * 60 * 1000);
  const writes: Promise<void>[] = [];
  try {
    fs.mkdirSync(getStorageRoot(), { recursive: true });
    dir = fs.mkdtempSync(path.join(getStorageRoot(), '.incoming-'));
    const cleanup = () => { try { fs.rmSync(dir!, { recursive: true, force: true }); } catch (error) { console.error('Upload staging cleanup failed', error); } };
    const fields = new Map<string, string>();
    const files: UploadedPart[] = [];
    const parser = busboy({ headers: Object.fromEntries(req.headers), defParamCharset: 'utf8', limits: {
      files: limits.files, fileSize: limits.fileBytes, fields: 210, fieldSize: 64 * 1024, parts: limits.files + 210,
    } });
    for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const) parser.on(event, () => fail(new UploadError('Too many upload parts', 413)));
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || info.nameTruncated) fail(new UploadError('Upload metadata is too large', 413));
      else if (fields.has(name)) fail(new UploadError('Duplicate upload metadata'));
      else fields.set(name, value);
    });
    let totalFiles = 0;
    parser.on('file', (field, stream, info) => {
      if (field !== limits.fileField) { stream.resume(); fail(new UploadError('Unexpected upload field')); return; }
      const part: UploadedPart = { field, name: info.filename, type: info.mimeType, size: 0, path: path.join(dir!, randomUUID()) };
      files.push(part);
      stream.on('limit', () => fail(new UploadError('Upload file is too large', 413)));
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        part.size += chunk.length; totalFiles += chunk.length;
        callback(totalFiles > limits.totalBytes ? new UploadError('Upload is too large', 413) : null, chunk);
      } });
      const write = pipeline(stream, counter, fs.createWriteStream(part.path, { flags: 'wx', mode: 0o600 }), { signal: controller.signal }).catch(error => { fail(error); });
      writes.push(write);
    });
    let bodyBytes = 0;
    const bodyLimit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bodyBytes += chunk.length;
      callback(bodyBytes > maxBodyBytes ? new UploadError('Upload body is too large', 413) : null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(req.body as import('node:stream/web').ReadableStream), bodyLimit, parser, { signal: controller.signal });
    } catch (error) { failure ??= error as Error; controller.abort(); }
    await Promise.all(writes);
    if (failure) throw failure;
    return { files, fields, cleanup };
  } catch (error) {
    controller.abort();
    await Promise.all(writes);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (error instanceof UploadError) throw error;
    if ((error as NodeJS.ErrnoException).code) throw error;
    throw new UploadError('Invalid multipart upload');
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onAbort);
    state.archiveUploadsActive = Math.max(0, (state.archiveUploadsActive || 1) - 1);
  }
}

export function readUploadHeader(file: UploadedPart) {
  const fd = fs.openSync(file.path, 'r');
  try { const bytes = Buffer.alloc(64); const length = fs.readSync(fd, bytes, 0, bytes.length, 0); return bytes.subarray(0, length); }
  finally { fs.closeSync(fd); }
}
