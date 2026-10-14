/* eslint-disable @typescript-eslint/no-require-imports */
// Disposable fixtures only. Run: node --expose-gc scripts/benchmark-library.cjs
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-benchmark-'));
process.env.ARCHIVE_STORAGE_DIR = scratch;
const auth = require('../lib/auth.ts');
auth.getSessionUser = () => ({ id: 'adam', isAdmin: true });
const { GET } = require('../app/api/files/route.ts');
const { getArchiveIndex, getIndexedWaveform } = require('../lib/archive-index.ts');
const { NextRequest } = require('next/server');
const timed = async fn => { const start = performance.now(); const result = await fn(); return { result, ms: +(performance.now() - start).toFixed(2) }; };
(async () => {
  try {
    fs.mkdirSync(path.join(scratch, 'uploads'));
    const peaks = [Array.from({ length: 4000 }, (_, i) => +(Math.sin(i) * .9).toFixed(4))];
    for (const count of [100, 1000, 5000]) {
      const data = Array.from({ length: count }, (_, i) => ({ id: `${i}.wav`, name: `Recording ${i}`, ratings: {}, comments: [], collections: [], waveformPeaks: peaks, waveformDuration: 120, waveformCacheVersion: 6 }));
      for (const record of data) fs.writeFileSync(path.join(scratch, 'uploads', record.id), 'fixture');
      fs.writeFileSync(path.join(scratch, 'data.json'), JSON.stringify(data));
      global.gc?.();
      const full = await timed(async () => (await GET(new NextRequest('http://test/api/files'))).text());
      const cold = await timed(async () => (await GET(new NextRequest('http://test/api/files?view=metadata'))).text());
      const warm = await timed(async () => (await GET(new NextRequest('http://test/api/files?view=metadata'))).text());
      const index = await timed(() => { for (let i = 0; i < 1000; i++) getArchiveIndex().byId.get('0.wav'); });
      const waveform = await timed(() => getIndexedWaveform('0.wav'));
      global.gc?.();
      console.log(JSON.stringify({ count, fullBytes: Buffer.byteLength(full.result), metadataBytes: Buffer.byteLength(warm.result), fullMs: full.ms, coldMetadataMs: cold.ms, warmMetadataMs: warm.ms, thousandIndexedLookupsMs: index.ms, waveformMs: waveform.ms, rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1), heapMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1) }));
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
