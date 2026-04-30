#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
FOLDER_NAME="${SCRIPT_DIR:t}"
SAFE_FOLDER_NAME="$(printf '%s' "$FOLDER_NAME" | tr -cs '[:alnum:]_.-' '-')"
OUTPUT_FILE="$SCRIPT_DIR/finder-tags-$SAFE_FOLDER_NAME.json"

/usr/bin/python3 - "$SCRIPT_DIR" "$OUTPUT_FILE" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

source_dir = Path(sys.argv[1]).resolve()
output_file = Path(sys.argv[2]).resolve()

audio_extensions = {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif'}
color_by_index = {
    '1': 'gray',
    '2': 'green',
    '3': 'purple',
    '4': 'blue',
    '5': 'yellow',
    '6': 'red',
    '7': 'orange',
}
color_names = set(color_by_index.values())

def parse_finder_tags(raw):
    if not raw or '(null)' in raw:
        return [], []

    tags = []
    current = ''
    in_quote = False
    escaped = False
    for char in raw:
        if escaped:
            current += char
            escaped = False
        elif char == '\\':
            escaped = True
        elif char == '"':
            in_quote = not in_quote
            if not in_quote and current:
                tags.append(current.replace('\\n', '\n'))
                current = ''
        elif in_quote:
            current += char

    if not tags:
        tags = [tag.strip() for tag in raw.split(',') if tag.strip()]

    colors = []
    for tag in tags:
        color = None
        parts = tag.splitlines()
        if parts and parts[-1] in color_by_index:
            color = color_by_index[parts[-1]]
        else:
            lower = tag.lower()
            for color_name in color_names:
                if color_name in lower:
                    color = color_name
                    break
        if color and color not in colors:
            colors.append(color)

    return tags, colors

def read_finder_tags(file_path):
    try:
        raw = subprocess.check_output(
            ['mdls', '-raw', '-name', 'kMDItemUserTags', str(file_path)],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
    except Exception:
        return [], []
    return parse_finder_tags(raw)

files = []
for root, _, names in os.walk(source_dir):
    for name in names:
        file_path = Path(root) / name
        if file_path.suffix.lower() not in audio_extensions:
            continue
        all_finder_tags, color_tags = read_finder_tags(file_path)
        files.append({
            'name': file_path.name,
            'relativePath': str(file_path.relative_to(source_dir)),
            'path': str(file_path),
            'colorTags': color_tags,
            'allFinderTags': all_finder_tags,
        })

output_file.write_text(json.dumps({
    'version': 1,
    'exportedAt': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),
    'sourceDir': str(source_dir),
    'files': files,
}, indent=2), encoding='utf-8')

print(f'Exported Finder tags for {len(files)} audio files.')
print(f'Output: {output_file}')
PY

echo
echo "Done. Upload this file in the archive:"
echo "$OUTPUT_FILE"
echo
read "?Press Return to close."
