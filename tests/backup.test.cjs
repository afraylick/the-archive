/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('backup validation detects missing media, corruption and changed copies', async () => {
  const { inspectBackup } = await import('../scripts/verify-backup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-backup-'));
  try {
    fs.mkdirSync(path.join(root, 'uploads')); fs.writeFileSync(path.join(root, 'uploads', 'one.wav'), 'audio');
    fs.writeFileSync(path.join(root, 'data.json'), JSON.stringify([{ id: 'one.wav' }]));
    const before = await inspectBackup(root);
    fs.writeFileSync(path.join(root, 'uploads', 'one.wav'), 'changed');
    assert.notDeepEqual(await inspectBackup(root), before);
    fs.unlinkSync(path.join(root, 'uploads', 'one.wav'));
    await assert.rejects(inspectBackup(root), /Missing/);
    fs.writeFileSync(path.join(root, 'data.json'), '{');
    await assert.rejects(inspectBackup(root), SyntaxError);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
