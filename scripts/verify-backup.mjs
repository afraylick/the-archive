import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function inspectBackup(root) {
  const files = {};
  async function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new Error('Backup contains a symlink');
      if (entry.name.startsWith('.incoming-') || entry.name.endsWith('.tmp')) throw new Error('Backup contains unfinished writes; stop the service before copying');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(absolute)) hash.update(chunk);
        files[relative] = hash.digest('hex');
        if (entry.name.endsWith('.json')) JSON.parse(fs.readFileSync(absolute, 'utf8'));
      } else throw new Error('Unsupported backup entry');
    }
  }
  await walk(root);
  const records = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'));
  if (!Array.isArray(records)) throw new Error('Invalid archive metadata');
  const ids = new Set();
  for (const record of records) {
    if (typeof record.id !== 'string' || ids.has(record.id)) throw new Error('Missing or duplicate recording ID');
    ids.add(record.id);
    for (const [folder, id] of [['uploads', record.id], ['stems', record.stems?.id]]) {
      if (id === undefined) continue;
      if (typeof id !== 'string' || !id || id.includes('..') || /[/\\]/.test(id) || !files[`${folder}/${id}`]) throw new Error('Missing or unsafe recording/attachment reference');
    }
  }
  return { version: 1, recordings: records.length, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [root, mode, manifestPath] = process.argv.slice(2);
    if (!root || !['--record', '--check'].includes(mode) || !manifestPath) throw new Error('Usage: node scripts/verify-backup.mjs STORAGE --record|--check MANIFEST_OUTSIDE_STORAGE');
    const relative = path.relative(path.resolve(root), path.resolve(manifestPath));
    if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('Keep the manifest outside storage');
    const manifest = await inspectBackup(path.resolve(root));
    if (mode === '--record') fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    else {
      const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (JSON.stringify(expected) !== JSON.stringify(manifest)) throw new Error('Backup differs from the recorded manifest');
    }
    console.log(`Verified ${manifest.recordings} recordings and ${Object.keys(manifest.files).length} files.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
