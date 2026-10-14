import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { ensureDir, getDataFilePath } from './storage';

/** Replace a JSON file without ever truncating the last committed copy. */
export const writeJsonAtomic = (filePath: string, value: unknown) => {
  const contents = JSON.stringify(value, null, 2);
  if (contents === undefined) throw new Error('Cannot persist undefined JSON');
  ensureDir(path.dirname(filePath));
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
};

export const readArchive = <T,>(): T[] => {
  const filePath = getDataFilePath();
  if (!fs.existsSync(filePath)) return [];
  const records: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(records)) throw new Error('Archive metadata must be an array');
  return records as T[];
};

/**
 * Commit against the latest snapshot after asynchronous work has finished.
 * The callback and write must remain synchronous: this protects one Node process,
 * not multiple processes or independently running replicas.
 */
export const updateArchive = <T,>(update: (records: T[]) => T[] | undefined) => {
  const records = update(readArchive<T>());
  if (records === undefined) return;
  if (!Array.isArray(records)) throw new Error('Archive update must synchronously return an array');
  writeJsonAtomic(getDataFilePath(), records);
};
