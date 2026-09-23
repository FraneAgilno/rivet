export class IntegrationError extends Error {
  constructor(reason = 'INPUT') {
    super(`Integration ${reason.toLowerCase().replaceAll('_', ' ')}. Check project scope, provider selection, authentication and tool inventory.`);
    this.name = 'IntegrationError';
    this.code = `ERR_INTEGRATION_${reason}`;
    this.safeMessage = this.message;
  }
}
export function fail(reason) { throw new IntegrationError(reason); }
export function snapshot(value, maxBytes = 65536) {
  // Accept plain JSON data only. Never invoke getters or toJSON methods.
  let nodes = 0;
  const walk = (item, depth = 0) => {
    if (++nodes > 10000 || depth > 20) fail('INPUT');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) fail('INPUT');
    const array = Array.isArray(item);
    if (array && (item.length > 10000 || Object.keys(item).length !== item.length
      || Object.keys(item).some((key,index) => key !== String(index)))) fail('INPUT');
    const result = array ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key)) fail('INPUT');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) fail('INPUT');
      result[key] = walk(descriptor.value, depth + 1);
    }
    return result;
  };
  try {
    const result = walk(value);
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('INPUT');
    return result;
  } catch { fail('INPUT'); }
}
export function fields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value,key))) fail('INPUT');
}
export function safeUrl(value, { endpoint = false } = {}) {
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f]/.test(value)) fail('INPUT');
    const url = new URL(value);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.hash) fail('INPUT');
    const secretKey = /(?:password|passwd|secret|api[-_]?key|authorization|cookie|credential|access[-_]?token|api[-_]?token|token)/i;
    const secretValue = /^(?:bearer\s+|basic\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|xox[baprs]-|AKIA[0-9A-Z]{16})/i;
    for (const [key, value] of url.searchParams) {
      if (secretKey.test(key) || secretValue.test(value)) fail('INPUT');
      if (!endpoint && (!['node-id','pageId'].includes(key) || !/^[A-Za-z0-9:_-]{1,128}$/.test(value))) fail('INPUT');
    }
    if (!endpoint && url.protocol !== 'https:') fail('INPUT');
    let path = url.pathname;
    for (let pass = 0; pass < 4; pass += 1) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    if (/%[0-9a-f]{2}/i.test(path)) fail('INPUT');
    for (const component of path.split('/')) {
      if (secretValue.test(component) || (/[=:]/.test(component) && secretKey.test(component.split(/[=:]/)[0]))) fail('INPUT');
    }
    return url;
  } catch { fail('INPUT'); }
}
export function negotiateCapabilities(provider, inventory) {
  const tools = provider.tools ?? [];
  return tools.filter(tool => inventory?.tools.includes(tool));
}
