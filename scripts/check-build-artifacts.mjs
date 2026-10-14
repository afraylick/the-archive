import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inside = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);
const canonical = file => fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
const privateNames = new Set(['users.json', 'accounts.json', 'credentials-initialized.json', 'login-attempts.json', 'archive-settings.json', 'data.json', 'SONGIE_CHATGPT_CONTEXT.md']);

export function inspectBuild(root, storageRoot) {
  root = path.resolve(root);
  const build = path.join(root, '.next');
  const privateRoots = [path.join(root, 'data'), ...(storageRoot ? [path.resolve(root, storageRoot)] : [])].map(canonical);
  const findings = new Set();
  let traces = 0;
  const check = file => {
    const resolved = canonical(file);
    const relative = path.relative(root, resolved);
    const segments = relative.split(path.sep);
    const name = path.basename(resolved);
    if (privateRoots.some(dir => inside(resolved, dir)) || segments.includes('.git') || /^\.env(?:\.|$)/.test(name) || /\.(?:pem|key)$/i.test(name) || privateNames.has(name) || (!segments.includes('node_modules') && /\.(?:wav|mp3|flac|aiff?|m4a|aac|ogg|zip)$/i.test(name))) {
      findings.add(path.relative(root, file));
    }
  };
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        check(file);
        if (entry.name.endsWith('.nft.json')) {
          const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!Array.isArray(trace.files) || trace.files.some(value => typeof value !== 'string')) throw new Error('Invalid build trace');
          traces++;
          for (const item of trace.files) check(path.resolve(path.dirname(file), item));
        }
      }
    }
  };
  if (!fs.existsSync(path.join(build, 'BUILD_ID'))) throw new Error('No completed production build; run npm run build first');
  // Deployment outputs only; caches and dev output are not deployable artifacts.
  for (const name of ['server', 'static', 'standalone']) walk(path.join(build, name));
  for (const entry of fs.readdirSync(build)) {
    const file = path.join(build, entry);
    if (!fs.lstatSync(file).isDirectory()) check(file);
    if (entry.endsWith('.nft.json')) {
      traces++;
      const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(trace.files) || trace.files.some(value => typeof value !== 'string')) throw new Error('Invalid build trace');
      for (const item of trace.files) check(path.resolve(build, item));
    }
  }
  walk(path.join(root, 'public'));
  if (!traces) throw new Error('No production file traces found');
  return { traces, findings: [...findings] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = inspectBuild(process.cwd(), process.env.ARCHIVE_STORAGE_DIR);
    if (result.findings.length) {
      console.error(`Private files found in deployment artifacts (${result.findings.length} paths). Build rejected.`);
      // Paths only, never print private file contents.
      for (const file of result.findings.slice(0, 20)) console.error(file);
      process.exitCode = 1;
    } else console.log(`Artifact check passed: ${result.traces} traces; no archive files or credential files included.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
