#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif']);
const FINDER_COLOR_BY_INDEX = {
  1: 'gray',
  2: 'green',
  3: 'purple',
  4: 'blue',
  5: 'yellow',
  6: 'red',
  7: 'orange',
};
const FINDER_COLOR_NAMES = new Set(Object.values(FINDER_COLOR_BY_INDEX));

const [folderArg, outputArg = 'finder-tags-export.json'] = process.argv.slice(2);

if (!folderArg) {
  console.error('Usage: node scripts/export-finder-tags.mjs /path/to/audio-folder [output.json]');
  process.exit(1);
}

const sourceDir = path.resolve(folderArg);
const outputPath = path.resolve(outputArg);

if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
  console.error(`Folder not found: ${sourceDir}`);
  process.exit(1);
}

const isAudioFile = (filePath) => AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());

const getAudioFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return getAudioFiles(entryPath);
    if (entry.isFile() && isAudioFile(entryPath)) return [entryPath];
    return [];
  });
};

const parseFinderTagOutput = (rawOutput) => {
  if (!rawOutput || rawOutput.includes('(null)')) return { allFinderTags: [], colorTags: [] };

  const quotedTags = Array.from(rawOutput.matchAll(/"((?:\\"|[^"])*)"/g), match =>
    match[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
  );
  const allFinderTags = quotedTags.length > 0
    ? quotedTags
    : rawOutput.split(',').map(tag => tag.trim()).filter(Boolean);

  const colorTags = Array.from(new Set(allFinderTags.flatMap((tag) => {
    const colorIndex = tag.match(/\n([1-7])$/)?.[1] || tag.match(/\b([1-7])\b/)?.[1];
    const indexedColor = colorIndex ? FINDER_COLOR_BY_INDEX[colorIndex] : undefined;
    if (indexedColor) return [indexedColor];

    const lowerTag = tag.toLowerCase();
    return Array.from(FINDER_COLOR_NAMES).filter(color => lowerTag.includes(color));
  })));

  return { allFinderTags, colorTags };
};

const readFinderTags = (filePath) => {
  try {
    const output = execFileSync('mdls', ['-raw', '-name', 'kMDItemUserTags', filePath], {
      encoding: 'utf8',
      timeout: 3000,
    });
    return parseFinderTagOutput(output);
  } catch {
    return { allFinderTags: [], colorTags: [] };
  }
};

const files = getAudioFiles(sourceDir).map((filePath) => {
  const { allFinderTags, colorTags } = readFinderTags(filePath);
  return {
    name: path.basename(filePath),
    relativePath: path.relative(sourceDir, filePath),
    path: filePath,
    colorTags,
    allFinderTags,
  };
});

fs.writeFileSync(outputPath, JSON.stringify({
  version: 1,
  exportedAt: new Date().toISOString(),
  sourceDir,
  files,
}, null, 2));

console.log(`Exported Finder tags for ${files.length} audio files to ${outputPath}`);
