export function recordingUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  const collection = window.location.pathname.match(/^\/collections\/([^/]+)/)?.[1];
  if (!collection || /[?&]collection=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}collection=${collection}`;
}
export function archiveUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  const archive = new URLSearchParams(window.location.search).get('archive') || localStorage.getItem('songie-archive');
  return archive ? `${url}${url.includes('?') ? '&' : '?'}archive=${encodeURIComponent(archive)}` : url;
}
