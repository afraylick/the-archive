import { useMemo, useState } from 'react';

interface FilterResults {
  key: string;
  ids: string[];
}

/** Keep existing results in place until the user changes the view. */
export function reconcileFilterResults(
  previous: FilterResults,
  key: string,
  matchingIds: string[],
  availableIds: Set<string>,
): FilterResults {
  if (previous.key !== key) return { key, ids: matchingIds };

  const ids = previous.ids.filter(id => availableIds.has(id));
  const included = new Set(ids);
  for (const id of matchingIds) {
    if (!included.has(id)) {
      ids.push(id);
      included.add(id);
    }
  }

  return ids.length === previous.ids.length && ids.every((id, index) => id === previous.ids[index])
    ? previous
    : { key, ids };
}

export function useStableFilterResults<T extends { id: string }>(files: T[], matchingFiles: T[], key: string): T[] {
  const fileById = useMemo(() => new Map(files.map(file => [file.id, file])), [files]);
  const [previous, setPrevious] = useState<FilterResults>(() => ({ key, ids: matchingFiles.map(file => file.id) }));
  const results = reconcileFilterResults(previous, key, matchingFiles.map(file => file.id), new Set(fileById.keys()));

  // Adjust during render so a new filter never briefly shows the old results.
  if (results !== previous) setPrevious(results);

  return useMemo(() => results.ids.flatMap(id => {
    const file = fileById.get(id);
    return file ? [file] : [];
  }), [fileById, results]);
}
