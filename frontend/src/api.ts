export const vendorId = location.pathname.startsWith('/vendor/') ? location.pathname.split('/')[2] : null;
export const vendorToken =
  new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('forge_vendor_' + vendorId) || '';
if (vendorId && vendorToken) {
  sessionStorage.setItem('forge_vendor_' + vendorId, vendorToken);
  history.replaceState(null, '', location.pathname);
}
export const headers = () => ({ 'X-Forge-Request': '1', ...(vendorId ? { Authorization: 'Bearer ' + vendorToken } : {}) });

export async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch('/api' + path, {
    method,
    headers: { ...headers(), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const a = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail));
  }
  return r.json();
}

export async function asset(path: string) {
  const r = await fetch('/api' + path, { headers: headers() });
  if (!r.ok) {
    const a = await r.json().catch(() => ({}));
    throw new Error(a.detail || 'File unavailable; generate the document first');
  }
  return r.blob();
}

export async function assetJson(path: string) {
  const r = await fetch('/api' + path, { headers: headers() });
  if (!r.ok) {
    const a = await r.json().catch(() => ({}));
    throw new Error(a.detail || 'Not available yet');
  }
  return r.json();
}

export function saveBlob(b: Blob, name: string) {
  const url = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function download(path: string, name: string) {
  saveBlob(await asset(path), name);
}
