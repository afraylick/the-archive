/* eslint-disable @typescript-eslint/no-require-imports */
// Optional manual diagnostic. No production archive access, credentials or writes.
// node scripts/diagnostics/mp3-seek.cjs /path/to/sample.mp3 /tmp/seek-results [port]
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const [source, output, port = '3016'] = process.argv.slice(2);
if (!source || !output) throw Error('Usage: node scripts/diagnostics/mp3-seek.cjs sample.mp3 output-directory [port]');
fs.mkdirSync(output, { recursive: true });
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
  return resolve.call(this, name.startsWith('@/') ? path.join(root, name.slice(2)) : name, parent, ...rest);
};
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { getMp3Container, streamMp3Container } = require('../../lib/mp3-mp4.ts');
const { readAudioRange } = require('../../lib/audio-range.ts');
const { generateServerWaveform } = require('../../lib/server-waveform.ts');
async function main() {
  // Sequential decoder reference stays on the server. Never sent to the browser.
  const decoded = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', source, '-ac', '1', '-ar', '8000', '-f', 'f32le', path.join(output, 'reference.f32')]);
  if (decoded.status !== 0) throw Error(decoded.stderr.toString());
  const waveform = await generateServerWaveform(source);
  const start = performance.now(); const container = await getMp3Container(source);
  console.log({ indexMs: performance.now() - start, headerBytes: container?.header.length, sourceBytes: fs.statSync(source).size });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && ['/result', '/done'].includes(url.pathname)) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw Error('Capture too large'); chunks.push(chunk); }
        const data = Buffer.concat(chunks);
        const result = JSON.parse(data.toString());
        const file = `${Date.now()}-${result.mode}-${url.pathname.slice(1)}.json`;
        fs.writeFileSync(path.join(output, file), data); console.log(file);
        res.end('OK'); return;
      }
      if (url.pathname === '/audio') {
        if (url.searchParams.get('mode') === 'indexed') {
          if (!container) throw Error('Unsupported sample');
          const response = streamMp3Container(source, container, req.headers.range || null);
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (!response.body) return res.end();
          const stream = Readable.fromWeb(response.body);
          res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res); return;
        }
        const size = fs.statSync(source).size, range = readAudioRange(req.headers.range || null, size);
        if (range === 'unsatisfiable') { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
        const { start, end } = range || { start: 0, end: size - 1 };
        res.writeHead(range ? 206 : 200, { 'Content-Type': source.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}), 'Cache-Control': 'no-store' });
        const stream = fs.createReadStream(source, { start, end });
        res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      if (url.pathname === '/waveform') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(waveform)); return; }
      if (url.pathname === '/wavesurfer.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(path.join(root, 'node_modules/wavesurfer.js/dist/wavesurfer.esm.js'))); return; }
      if (url.pathname === '/playback.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(ts.transpileModule(fs.readFileSync(path.join(root, 'lib/playback.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText); return;
      }
      res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(__dirname, 'mp3-seek.html')));
    } catch (error) { console.error(error); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(Number(port), '127.0.0.1', () => console.log(`Open http://127.0.0.1:${port}/?mode=original and ?mode=indexed`));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
