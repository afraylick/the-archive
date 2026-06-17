import fs from 'fs';
import path from 'path';

export const getStorageRoot = () => process.env.ARCHIVE_STORAGE_DIR || path.join(process.cwd(), 'data');

export const getDataFilePath = () => path.join(getStorageRoot(), 'data.json');
export const getUploadsDir = () => path.join(getStorageRoot(), 'uploads');
export const getStemsDir = () => path.join(getStorageRoot(), 'stems');
export const getTranscodedDir = () => path.join(getStorageRoot(), 'transcoded');

export const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

export const ensureStorageDirs = () => {
  ensureDir(getStorageRoot());
  ensureDir(getUploadsDir());
  ensureDir(getStemsDir());
  ensureDir(getTranscodedDir());
};

export const getUploadPath = (id: string) => path.join(getUploadsDir(), id);
export const getStemPath = (id: string) => path.join(getStemsDir(), id);

export const isSafeStorageId = (id: string) => (
  Boolean(id) &&
  path.basename(id) === id &&
  !id.includes('..') &&
  !id.includes('/') &&
  !id.includes('\\')
);

export const getAllowedImportRoots = () => (
  (process.env.ARCHIVE_IMPORT_ROOTS || '')
    .split(path.delimiter)
    .map(root => root.trim())
    .filter(Boolean)
    .map(root => path.resolve(root))
);

export const isImportPathAllowed = (targetPath: string) => {
  const allowedRoots = getAllowedImportRoots();
  if (allowedRoots.length === 0) {
    return process.env.NODE_ENV !== 'production';
  }

  const resolvedTarget = path.resolve(targetPath);
  return allowedRoots.some(root => resolvedTarget === root || resolvedTarget.startsWith(`${root}${path.sep}`));
};

export const getAudioContentType = (filename: string) => {
  const ext = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    '.aac': 'audio/aac',
    '.aif': 'audio/aiff',
    '.aiff': 'audio/aiff',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
  };

  return types[ext] || 'application/octet-stream';
};

export const getSafeDownloadName = (filename: string) => (
  filename.replace(/[\r\n"]/g, '').replace(/[\\/]/g, '-')
);
