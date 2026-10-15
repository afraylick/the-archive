/** Fetch the complete attachment before handing it to the browser download UI. */
export const downloadAudio = async (id: string, name: string, signal: AbortSignal) => {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}/audio?download=1`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? 'Your session expired. Reload and sign in to download.' : `Download failed (${response.status}). Try again.`);
  const blob = await response.blob();
  signal.throwIfAborted();
  const expected = Number(response.headers.get('content-length'));
  if (!blob.size || (expected > 0 && blob.size !== expected)) throw new Error('Download was interrupted. Try again.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give Firefox time to acquire the blob before releasing our reference.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};
