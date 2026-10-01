export const vendorId = location.pathname.startsWith('/vendor/') ? location.pathname.split('/')[2] : null;
export const vendorToken =
  new URLSearchParams(location.hash.slice(1)).get('token') || sessionStorage.getItem('forge_vendor_' + vendorId) || '';
if (vendorId && vendorToken) {
  sessionStorage.setItem('forge_vendor_' + vendorId, vendorToken);
  history.replaceState(null, '', location.pathname);
}
export const headers = () => ({ 'X-Forge-Request': '1', ...(vendorId ? { Authorization: 'Bearer ' + vendorToken } : {}) });

/** FastAPI validation errors arrive as a list of {loc, msg}: turn them into one readable sentence. */
function errorText(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((d: any) => {
      const field = Array.isArray(d?.loc) ? d.loc.filter((x: unknown) => x !== 'body').join(' › ') : '';
      return (field ? field + ': ' : '') + String(d?.msg || 'invalid value').replace(/ after validation/, '');
    }).slice(0, 3).join(' · ');
  }
  return 'The server rejected the request';
}

export async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch('/api' + path, {
    method,
    headers: { ...headers(), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const a = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(errorText(a.detail));
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

/** 3D meshes are never downloadable: ask for a short-lived, session-bound ticket, fetch the AES-GCM
 * encrypted stream and decrypt it in memory. `key` is "revisionId:file[:partId]". */
export async function loadSecureModel(key: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const [revision, file, part] = key.split(':');
  const q = new URLSearchParams({ revision, file, ...(part ? { part } : {}) });
  const ticket = await fetch('/api/model-ticket?' + q.toString(), { headers: headers(), signal });
  if (!ticket.ok) {
    const body = await ticket.json().catch(() => ({ detail: '3D mesh is not available yet' }));
    throw new Error(body.detail || '3D mesh is not available yet');
  }
  const t = await ticket.json();
  const r = await fetch(t.url, { headers: headers(), signal, cache: 'no-store' });
  if (!r.ok) {
    const body = await r.json().catch(() => ({ detail: '3D mesh is not available yet' }));
    throw new Error(body.detail || '3D mesh is not available yet');
  }
  const aad = Uint8Array.from(atob(r.headers.get('X-Forge-Aad') || ''), c => c.charCodeAt(0));
  const data = new Uint8Array(await r.arrayBuffer());
  const raw = Uint8Array.from(atob(t.key), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: aad }, cryptoKey, data.slice(12));
}
