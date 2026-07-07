#!/bin/zsh

# Fix MP3 dates from filenames like:
#   VID_20170429_134943.mp3
#   VID_20170531_200743_1.mp3
#   idea_042917.mp3
#
# Finder use:
#   1. Copy this .command file into the folder with the MP3s.
#   2. Double-click it.
#
# Terminal use:
#   ./scripts/fix-voice-memo-metadata.command /path/to/folder
#
# The script updates:
#   - embedded MP3 date/title metadata, using ffmpeg if installed
#   - filesystem modified date, using touch
#   - macOS Finder creation date, when SetFile is installed

set -u

SCRIPT_DIR="${0:A:h}"
TARGETS=("$@")

if (( ${#TARGETS[@]} == 0 )); then
  TARGETS=("$SCRIPT_DIR")
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'HELP'
Usage:
  fix-voice-memo-metadata.command [folder-or-file ...]

If no folder or file is passed, the script processes MP3s in the same folder as
the script. Copy it into a folder of voice memos and double-click it from Finder.

Matches filenames containing:
  YYYYMMDD_HHMMSS
  YYYYMMDD
  MMDDYY

Examples:
  VID_20170429_134943.mp3
  VID_20170429_135518.mp3
  VID_20170531_200743_1.mp3
  idea_042917.mp3

Optional:
  DRY_RUN=1 ./fix-voice-memo-metadata.command /path/to/folder
HELP
  exit 0
fi

DRY_RUN="${DRY_RUN:-0}"
PROCESSED=0
SKIPPED=0
FAILED=0

has_command() {
  command -v "$1" >/dev/null 2>&1
}

append_mp3_files() {
  local target="$1"

  if [[ -d "$target" ]]; then
    local file
    while IFS= read -r -d '' file; do
      FILES+=("$file")
    done < <(find "$target" -maxdepth 1 -type f \( -iname '*.mp3' \) -print0)
  elif [[ -f "$target" ]]; then
    FILES+=("$target")
  else
    printf 'Skipping missing path: %s\n' "$target"
    (( SKIPPED += 1 ))
  fi
}

parse_timestamp() {
  local filename="$1"

  if [[ "$filename" =~ '(^|[ _-])([12][0-9]{3})([01][0-9])([0-3][0-9])[ _-]?([0-2][0-9])([0-5][0-9])([0-5][0-9])($|[ ._-])' ]]; then
    YEAR="${match[2]}"
    MONTH="${match[3]}"
    DAY="${match[4]}"
    HOUR="${match[5]}"
    MINUTE="${match[6]}"
    SECOND="${match[7]}"
  elif [[ "$filename" =~ '(^|[ _-])([12][0-9]{3})([01][0-9])([0-3][0-9])($|[ ._-])' ]]; then
    YEAR="${match[2]}"
    MONTH="${match[3]}"
    DAY="${match[4]}"
    HOUR="12"
    MINUTE="00"
    SECOND="00"
  elif [[ "$filename" =~ '(^|[ _-])([01][0-9])([0-3][0-9])([0-9]{2})($|[ ._-])' ]]; then
    local yy="${match[4]}"
    local yy_number=$(( (${yy[1]} * 10) + ${yy[2]} ))

    if (( yy_number >= 70 )); then
      YEAR="$((1900 + yy_number))"
    else
      YEAR="$((2000 + yy_number))"
    fi

    MONTH="${match[2]}"
    DAY="${match[3]}"
    HOUR="12"
    MINUTE="00"
    SECOND="00"
  else
    return 1
  fi

  local raw="${YEAR}${MONTH}${DAY}${HOUR}${MINUTE}${SECOND}"
  local normalized
  normalized="$(date -j -f '%Y%m%d%H%M%S' "$raw" '+%Y%m%d%H%M%S' 2>/dev/null)" || return 1
  [[ "$normalized" == "$raw" ]]
}

set_filesystem_dates() {
  local file="$1"
  local touch_stamp="${YEAR}${MONTH}${DAY}${HOUR}${MINUTE}.${SECOND}"
  local setfile_stamp="${MONTH}/${DAY}/${YEAR} ${HOUR}:${MINUTE}:${SECOND}"

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  would set modified date to %s\n' "$setfile_stamp"
    if has_command SetFile; then
      printf '  would set Finder created date to %s\n' "$setfile_stamp"
    fi
    return 0
  fi

  touch -t "$touch_stamp" "$file" || return 1

  if has_command SetFile; then
    SetFile -d "$setfile_stamp" -m "$setfile_stamp" "$file" >/dev/null 2>&1 || true
  fi
}

write_tags_with_ffmpeg() {
  local file="$1"
  local title="$2"
  local iso_date="${YEAR}-${MONTH}-${DAY}T${HOUR}:${MINUTE}:${SECOND}"
  local dir="${file:h}"
  local base="${file:t}"
  local ext="${base:e}"
  local tmp="${dir}/.${base:r}.metadata-fix.$$"

  if [[ -n "$ext" ]]; then
    tmp="${tmp}.${ext}"
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  would rewrite MP3 tags with ffmpeg: title=%s date=%s year=%s\n' "$title" "$iso_date" "$YEAR"
    return 0
  fi

  ffmpeg \
    -hide_banner \
    -loglevel error \
    -y \
    -i "$file" \
    -map 0 \
    -codec copy \
    -id3v2_version 3 \
    -write_id3v1 1 \
    -metadata "title=$title" \
    -metadata "date=$iso_date" \
    -metadata "year=$YEAR" \
    -metadata "creation_time=$iso_date" \
    -metadata "comment=Recorded $iso_date from filename" \
    "$tmp" || {
      rm -f "$tmp"
      return 1
    }

  chmod --reference="$file" "$tmp" 2>/dev/null || chmod "$(stat -f '%Lp' "$file")" "$tmp" 2>/dev/null || true
  mv "$tmp" "$file"
}

write_audio_tags() {
  local file="$1"
  local title="$2"

  if has_command ffmpeg; then
    write_tags_with_ffmpeg "$file" "$title"
  else
    printf '  no ffmpeg found, so only filesystem dates were updated\n'
    return 0
  fi
}

FILES=()
for target in "${TARGETS[@]}"; do
  append_mp3_files "$target"
done

if (( ${#FILES[@]} == 0 )); then
  printf 'No MP3 files found.\n'
  exit 0
fi

printf 'Voice memo metadata fixer\n'
printf 'Matched folder/file inputs: %s\n' "${TARGETS[*]}"
if [[ "$DRY_RUN" == "1" ]]; then
  printf 'Dry run only. No files will be changed.\n'
fi
printf '\n'

for file in "${FILES[@]}"; do
  filename="${file:t}"
  title="${filename:r}"

  if ! parse_timestamp "$filename"; then
    printf 'Skipping %s: no valid YYYYMMDD_HHMMSS timestamp in filename\n' "$filename"
    (( SKIPPED += 1 ))
    continue
  fi

  printf 'Updating %s -> %s-%s-%s %s:%s:%s\n' "$filename" "$YEAR" "$MONTH" "$DAY" "$HOUR" "$MINUTE" "$SECOND"

  if write_audio_tags "$file" "$title" && set_filesystem_dates "$file"; then
    (( PROCESSED += 1 ))
  else
    printf '  failed to update %s\n' "$filename"
    (( FAILED += 1 ))
  fi
done

printf '\nDone. Updated: %d, skipped: %d, failed: %d\n' "$PROCESSED" "$SKIPPED" "$FAILED"

if [[ -t 0 ]]; then
  printf '\nPress Return to close this window...'
  read -r _
fi
