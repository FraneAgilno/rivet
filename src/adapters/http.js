import {
  ProviderAdapterError,
  boundedString,
  captureRecord,
  failProvider,
  immutableRedactedJson,
  isSensitiveQueryKey,
  providerWireBytes,
} from './contract.js';
import { isIP } from 'node:net';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FORBIDDEN_HEADERS = new Set(['connection', 'content-length', 'cookie', 'host', 'proxy-authorization', 'transfer-encoding']);
const TIMED_OUT = Symbol('provider-timeout');
const ABORTED = Symbol('provider-aborted');
const DNS_UNSAFE = Symbol('provider-dns-unsafe');
const TRANSPORT_FAILED = Symbol('provider-transport-failed');
const MALFORMED_READ = Symbol('provider-malformed-read');
const PROMISE_THEN = Promise.prototype.then;
const ABORTED_GET = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const EVENT_ADD = EventTarget.prototype.addEventListener;
const EVENT_REMOVE = EventTarget.prototype.removeEventListener;
const trustedTransports = new WeakSet();
const responseMetadata = new WeakMap();
const PAGINATION_QUERY_KEYS = new Set(['page', 'per_page', 'startAt', 'maxResults', 'cursor', 'after', 'before']);

export function createTrustedProviderTransport(input) {
  const value = captureRecord(input, new Set(['resolve', 'fetchPinned']), ['resolve', 'fetchPinned'], 'invalid-config');
  if (typeof value.resolve !== 'function' || typeof value.fetchPinned !== 'function') failProvider('invalid-config');
  const transport = Object.freeze({ resolve: value.resolve, fetchPinned: value.fetchPinned });
  trustedTransports.add(transport);
  return transport;
}

function integer(value, fallback, minimum, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) failProvider('invalid-config');
  return result;
}

function originUrl(value) {
  boundedString(value, 2048, undefined, 'invalid-config');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || unsafeHostname(url.hostname) || isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) failProvider('invalid-config');
    url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return url;
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    failProvider('invalid-config');
  }
}

function unsafeHostname(hostnameInput) {
  const hostname = hostnameInput.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.lan') || hostname.includes(':')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some(value => value > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function publicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const value = address.split('.').reduce((total, octet) => (total << 8n) | BigInt(octet), 0n);
    const reserved = [
      [0x00000000n, 8], [0x0a000000n, 8], [0x64400000n, 10], [0x7f000000n, 8],
      [0xa9fe0000n, 16], [0xac100000n, 12], [0xc0000000n, 24], [0xc0000200n, 24],
      [0xc0586300n, 24], [0xc0a80000n, 16], [0xc6120000n, 15], [0xc6336400n, 24],
      [0xcb007100n, 24], [0xe0000000n, 4], [0xf0000000n, 4],
    ];
    return !reserved.some(([prefix, length]) => prefixMatch(value, prefix, length, 32));
  }
  if (version === 6) {
    const value = parseIpv6(address);
    if (value === null || !prefixMatch(value, 0x20000000000000000000000000000000n, 3, 128)) return false;
    return ![
      [0x20010000000000000000000000000000n, 23],
      [0x20010db8000000000000000000000000n, 32],
      [0x20020000000000000000000000000000n, 16],
      [0x3fff0000000000000000000000000000n, 20],
    ].some(([prefix, length]) => prefixMatch(value, prefix, length, 128));
  }
  return false;
}

function canonicalPublicAddress(address) {
  if (!publicAddress(address)) return null;
  if (isIP(address) === 4) return address.split('.').map(Number).join('.');
  const value = parseIpv6(address);
  if (value === null) return null;
  const groups = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(Number((value >> shift) & 0xffffn).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== '0') { start += 1; continue; }
    let end = start;
    while (end < groups.length && groups[end] === '0') end += 1;
    if (end - start > bestLength && end - start >= 2) { bestStart = start; bestLength = end - start; }
    start = end;
  }
  if (bestStart < 0) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}

function prefixMatch(value, prefix, length, bits) {
  const shift = BigInt(bits - length);
  return (value >> shift) === (prefix >> shift);
}

function parseIpv6(input) {
  try {
    let value = input.toLowerCase();
    if (value.includes('.')) {
      const split = value.lastIndexOf(':');
      if (split < 0) return null;
      const octets = value.slice(split + 1).split('.').map(Number);
      if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
      value = `${value.slice(0, split)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = value.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
    const groups = [...left, ...Array(missing).fill('0'), ...right];
    if (groups.length !== 8 || groups.some(group => !/^[a-f0-9]{1,4}$/.test(group))) return null;
    return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
  } catch { return null; }
}

function resolvedAddresses(input, provider) {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) failProvider('dns-unsafe', { provider });
    const length = input.length;
    if (!Number.isSafeInteger(length) || length < 1 || length > 16) failProvider('dns-unsafe', { provider });
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable) failProvider('dns-unsafe', { provider });
      snapshot.push(boundedString(input[index], 64, undefined, 'dns-unsafe'));
    }
    Object.freeze(snapshot);
    const output = [];
    for (const address of snapshot) {
      const canonical = canonicalPublicAddress(address);
      if (!canonical || output.includes(canonical)) failProvider('dns-unsafe', { provider });
      output.push(canonical);
    }
    return Object.freeze(output.sort());
  } catch { failProvider('dns-unsafe', { provider }); }
}

function headers(input, reason = 'invalid-config') {
  if (input === undefined) return Object.freeze({});
  let array;
  try { array = Array.isArray(input); } catch { failProvider(reason); }
  if (!input || typeof input !== 'object' || array) failProvider(reason);
  let keys;
  try { keys = Reflect.ownKeys(input); } catch { failProvider(reason); }
  if (keys.length > 64 || keys.some(key => typeof key !== 'string')) failProvider(reason);
  const result = {};
  for (const key of keys) {
    let descriptor;
    let entry;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
      entry = input[key];
    } catch { failProvider(reason); }
    if (!descriptor?.enumerable) failProvider(reason);
    const name = boundedString(key.toLowerCase(), 64, HEADER, reason);
    if (FORBIDDEN_HEADERS.has(name) || Object.hasOwn(result, name)) failProvider(reason);
    result[name] = boundedString(entry, 8192, undefined, reason);
  }
  return Object.freeze(result);
}

function relayAbortSignal(input, provider) {
  if (input === undefined) return Object.freeze({ signal: undefined, release() {} });
  const controller = new AbortController();
  const relay = () => { controller.abort(); };
  let listening = false;
  try {
    Reflect.apply(EVENT_ADD, input, ['abort', relay, { once: true }]);
    listening = true;
  } catch { failProvider('invalid-request', { provider }); }
  let aborted;
  try { aborted = Reflect.apply(ABORTED_GET, input, []); } catch {
    try { Reflect.apply(EVENT_REMOVE, input, ['abort', relay]); } catch {}
    failProvider('invalid-request', { provider });
  }
  if (aborted) relay();
  let released = false;
  return Object.freeze({
    signal: controller.signal,
    release() {
      if (released) return;
      released = true;
      if (listening) {
        listening = false;
        try { Reflect.apply(EVENT_REMOVE, input, ['abort', relay]); } catch {}
      }
    },
  });
}

function requestPath(value, allowEncodedSlash = false) {
  boundedString(value, 4096);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) failProvider('invalid-request');
  const pathname = value.split('?', 1)[0];
  if ((allowEncodedSlash ? /%(?:2e|5c|25)/i : /%(?:2e|2f|5c|25)/i).test(pathname)) failProvider('invalid-request');
  const decoded = pathname.replace(/%2f/ig, '/');
  if (decoded.includes('//') || decoded.split('/').some(part => part === '.' || part === '..')) failProvider('invalid-request');
  return value;
}

function retryFor(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500 ? 'transient' : 'permanent';
}

function responseHeaders(snapshot, provider) {
  const values = {
    etag: snapshot.etag, link: snapshot.link, retryAfter: snapshot.retryAfter,
  };
  for (const value of Object.values(values)) if (value !== null && (value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value))) {
    failProvider('remote', { provider, retryClassification: 'permanent' });
  }
  if (values.link !== null) values.link = sanitizedLinkHeader(values.link, provider);
  return immutableRedactedJson(values);
}

function snapshotResponse(response, provider, baseUrl, basePrefix) {
  try {
    if (!(response instanceof Response)) throw new Error();
    const redirected = response.redirected;
    const responseUrlValue = response.url;
    const status = response.status;
    const ok = response.ok;
    const responseHeaderObject = response.headers;
    const body = response.body;
    if (typeof redirected !== 'boolean' || redirected || typeof responseUrlValue !== 'string'
      || responseUrlValue.length > 2048 || !Number.isInteger(status) || status < 100 || status > 599
      || typeof ok !== 'boolean' || ok !== (status >= 200 && status < 300)
      || !responseHeaderObject || typeof responseHeaderObject !== 'object') throw new Error();
    if (responseUrlValue) {
      const responseUrl = new URL(responseUrlValue);
      if (responseUrl.origin !== baseUrl.origin
        || (basePrefix && responseUrl.pathname !== basePrefix && !responseUrl.pathname.startsWith(`${basePrefix}/`))) throw new Error();
    }
    const get = responseHeaderObject.get;
    if (typeof get !== 'function') throw new Error();
    const headerValues = {};
    for (const [field, name] of [
      ['contentLength', 'content-length'], ['etag', 'etag'], ['link', 'link'], ['retryAfter', 'retry-after'],
    ]) {
      const value = Reflect.apply(get, responseHeaderObject, [name]);
      if (value !== null && typeof value !== 'string') throw new Error();
      headerValues[field] = value;
    }
    if (body !== null && (typeof body !== 'object' && typeof body !== 'function')) throw new Error();
    return Object.freeze({ status, ok, body, headers: Object.freeze(headerValues) });
  } catch { failProvider('remote', { provider, retryClassification: 'permanent' }); }
}

function snapshotReader(body, provider) {
  try {
    const getReader = body.getReader;
    if (typeof getReader !== 'function') throw new Error();
    const reader = Reflect.apply(getReader, body, []);
    if (!reader || (typeof reader !== 'object' && typeof reader !== 'function')) throw new Error();
    const read = reader.read;
    if (typeof read !== 'function') throw new Error();
    return Object.freeze({ reader, read });
  } catch { failProvider('remote', { provider, retryClassification: 'permanent' }); }
}

function settleReaderCancellation(reader) {
  try {
    const cancel = reader.cancel;
    if (typeof cancel !== 'function') return;
    const pending = Reflect.apply(cancel, reader, []);
    Reflect.apply(PROMISE_THEN, pending, [() => {}, () => {}]);
  } catch {}
}

function snapshotReadResult(value) {
  try {
    if (!value || typeof value !== 'object') return MALFORMED_READ;
    const done = value.done;
    if (typeof done !== 'boolean') return MALFORMED_READ;
    return Object.freeze({ done, value: done ? undefined : value.value });
  } catch { return MALFORMED_READ; }
}

function sanitizedLinkHeader(value, provider) {
  try {
    return parseLinkHeader(value, provider).map(part => {
      const url = new URL(part.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        failProvider('remote', { provider, retryClassification: 'permanent' });
      }
      for (const key of [...url.searchParams.keys()]) if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
      return `<${url.href}>; rel="${part.rel}"`;
    }).join(', ');
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    failProvider('remote', { provider, retryClassification: 'permanent' });
  }
}

function parseLinkHeader(value, provider) {
  const parts = value.split(',');
  if (parts.length > 100) failProvider('remote', { provider, retryClassification: 'permanent' });
  return parts.map(part => {
    const match = /^\s*<([^>]+)>(.*)$/.exec(part);
    if (!match) failProvider('remote', { provider, retryClassification: 'permanent' });
    const parameters = [];
    for (const raw of match[2].split(';').slice(1)) {
      const parameter = /^\s*([A-Za-z][A-Za-z0-9_-]{0,63})\s*=\s*(?:"([^"]{1,256})"|([^\s;]{1,256}))\s*$/.exec(raw);
      if (!parameter) failProvider('remote', { provider, retryClassification: 'permanent' });
      parameters.push(Object.freeze({ name: parameter[1], value: parameter[2] ?? parameter[3] }));
    }
    const relations = parameters.filter(parameter => parameter.name.toLowerCase() === 'rel');
    if (relations.length !== 1 || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(relations[0].value)) {
      failProvider('remote', { provider, retryClassification: 'permanent' });
    }
    return Object.freeze({ url: match[1], rel: relations[0].value.toLowerCase(), parameters: Object.freeze(parameters) });
  });
}

function nextLink(link, provider) {
  if (!link) return null;
  for (const part of parseLinkHeader(link, provider)) {
    if (part.rel === 'next') {
      if (part.parameters.some(parameter => parameter.name.toLowerCase() !== 'rel' && isSensitiveQueryKey(parameter.name))) {
        failProvider('remote', { provider, retryClassification: 'permanent' });
      }
      return part.url;
    }
  }
  return null;
}

export function createProviderHttpClient(input) {
  const config = captureRecord(input, new Set([
    'provider', 'baseUrl', 'transport', 'headers', 'timeoutMs', 'maxResponseBytes', 'maxPages', 'maxItems', 'allowEncodedSlash',
  ]), ['provider', 'baseUrl', 'transport'], 'invalid-config');
  const provider = boundedString(config.provider, 32, /^[a-z][a-z0-9-]*$/, 'invalid-config');
  if (!trustedTransports.has(config.transport)) failProvider('invalid-config', { provider });
  if (config.allowEncodedSlash !== undefined && typeof config.allowEncodedSlash !== 'boolean') failProvider('invalid-config', { provider });
  const allowEncodedSlash = config.allowEncodedSlash === true;
  const transport = config.transport;
  const baseUrl = originUrl(config.baseUrl);
  const basePrefix = baseUrl.pathname === '/' ? '' : baseUrl.pathname;
  const defaultHeaders = headers(config.headers);
  const timeoutMs = integer(config.timeoutMs, 10_000, 1, 120_000);
  const maxResponseBytes = integer(config.maxResponseBytes, 2 * 1024 * 1024, 1, 16 * 1024 * 1024);
  const maxPages = integer(config.maxPages, 20, 1, 100);
  const maxItems = integer(config.maxItems, 10_000, 1, 10_000);

  function snapshotRequest(inputRequest) {
    const value = captureRecord(inputRequest, new Set(['method', 'path', 'headers', 'wireBody', 'signal']), ['method', 'path']);
    const method = boundedString(value.method, 8, /^[A-Z]+$/);
    if (!METHODS.has(method)) failProvider('invalid-request', { provider });
    const path = requestPath(value.path, allowEncodedSlash);
    let url;
    try {
      url = new URL(`${basePrefix}${path}`, baseUrl.origin);
      if (url.origin !== baseUrl.origin || url.username || url.password || url.hash
        || (basePrefix && url.pathname !== basePrefix && !url.pathname.startsWith(`${basePrefix}/`))) failProvider('invalid-request', { provider });
      for (const key of url.searchParams.keys()) if (isSensitiveQueryKey(key)) failProvider('invalid-request', { provider });
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      failProvider('invalid-request', { provider });
    }
    const requestHeaders = { ...defaultHeaders, ...headers(value.headers, 'invalid-request') };
    let body;
    if (value.wireBody !== undefined) {
      if (method === 'GET') failProvider('invalid-request', { provider });
      try { body = providerWireBytes(value.wireBody); } catch { failProvider('invalid-request', { provider }); }
      if (Buffer.byteLength(body) > maxResponseBytes) failProvider('invalid-request', { provider });
      requestHeaders['content-type'] ??= 'application/json';
    }
    const signalState = relayAbortSignal(value.signal, provider);
    return Object.freeze({
      method, url: url.href, headers: Object.freeze(requestHeaders), body,
      signal: signalState.signal, releaseSignal: signalState.release,
    });
  }

  async function perform(request) {
    const controller = new AbortController();
    let resolveAbort;
    const cancelled = new Promise(resolve => { resolveAbort = resolve; });
    const abort = () => { controller.abort(); resolveAbort(ABORTED); };
    let timer;
    let timedOut = false;
    let listening = false;
    try {
      if (request.signal) {
        try {
          Reflect.apply(EVENT_ADD, request.signal, ['abort', abort, { once: true }]);
          listening = true;
          if (Reflect.apply(ABORTED_GET, request.signal, [])) abort();
        } catch { failProvider('invalid-request', { provider }); }
        if (Reflect.apply(ABORTED_GET, controller.signal, [])) {
          failProvider('aborted', { provider, retryClassification: 'none' });
        }
      }
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve(TIMED_OUT);
        }, timeoutMs);
      });
      const operation = Promise.resolve().then(() => transport.resolve(baseUrl.hostname)).then(addresses => {
        let pinnedAddresses;
        try { pinnedAddresses = resolvedAddresses(addresses, provider); }
        catch { return DNS_UNSAFE; }
        return Promise.resolve().then(() => {
          // DNS can settle after a timeout/abort. Never start a provider request then.
          if (Reflect.apply(ABORTED_GET, controller.signal, [])) return ABORTED;
          return transport.fetchPinned(request.url, {
            method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }),
            signal: controller.signal, redirect: 'error', credentials: 'omit',
          }, Object.freeze({ hostname: baseUrl.hostname, addresses: pinnedAddresses }));
        }).then(value => value === ABORTED ? ABORTED : Object.freeze({ response: value }), () => TRANSPORT_FAILED);
      }, () => TRANSPORT_FAILED);
      const outcome = await Promise.race([operation, timeout, cancelled]);
      if (outcome === ABORTED) failProvider('aborted', { provider, retryClassification: 'none' });
      if (outcome === TIMED_OUT || timedOut) failProvider('timeout', { provider, retryClassification: 'transient' });
      if (outcome === DNS_UNSAFE) failProvider('dns-unsafe', { provider, retryClassification: 'permanent' });
      if (outcome === TRANSPORT_FAILED) {
        if (request.signal && Reflect.apply(ABORTED_GET, request.signal, [])) {
          failProvider('aborted', { provider, retryClassification: 'none' });
        }
        failProvider('transport', { provider, retryClassification: 'transient' });
      }
      const response = snapshotResponse(outcome.response, provider, baseUrl, basePrefix);
      const declaredLength = response.headers.contentLength;
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxResponseBytes)) {
        failProvider('response-too-large', { provider, retryClassification: 'permanent' });
      }
      const chunks = [];
      let byteLength = 0;
      if (response.body) {
        const readerState = snapshotReader(response.body, provider);
        for (let reads = 0; ; reads += 1) {
          if (reads >= 10_000) {
            settleReaderCancellation(readerState.reader);
            failProvider('response-too-large', { provider, retryClassification: 'permanent' });
          }
          const bodyResult = await Promise.race([
            Promise.resolve().then(() => Reflect.apply(readerState.read, readerState.reader, [])).then(
              value => ({ value: snapshotReadResult(value) }), () => ({ bodyError: true }),
            ),
            timeout, cancelled,
          ]);
          if (bodyResult === ABORTED) {
            settleReaderCancellation(readerState.reader);
            failProvider('aborted', { provider, retryClassification: 'none' });
          }
          if (bodyResult === TIMED_OUT || timedOut) {
            settleReaderCancellation(readerState.reader);
            failProvider('timeout', { provider, retryClassification: 'transient' });
          }
          if (bodyResult?.bodyError) {
            settleReaderCancellation(readerState.reader);
            failProvider('transport', { provider, retryClassification: 'transient' });
          }
          if (bodyResult.value === MALFORMED_READ) {
            settleReaderCancellation(readerState.reader);
            failProvider('remote', { provider, retryClassification: 'permanent' });
          }
          if (bodyResult.value.done) break;
          const chunk = bodyResult.value.value;
          let chunkCopy;
          try {
            if (!(chunk instanceof Uint8Array)) throw new Error();
            chunkCopy = Buffer.from(chunk);
          } catch {
            settleReaderCancellation(readerState.reader);
            failProvider('transport', { provider, retryClassification: 'transient' });
          }
          byteLength += chunkCopy.byteLength;
          if (!Number.isSafeInteger(byteLength) || byteLength > maxResponseBytes) {
            settleReaderCancellation(readerState.reader);
            failProvider('response-too-large', { provider, retryClassification: 'permanent' });
          }
          chunks.push(chunkCopy);
        }
      }
      const bytes = Buffer.concat(chunks, byteLength);
      let data = null;
      if (bytes.byteLength > 0) {
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch {
          failProvider('remote', {
            provider, status: response.status,
            retryClassification: response.ok ? 'permanent' : retryFor(response.status),
          });
        }
      }
      if (!response.ok) failProvider('remote', { provider, status: response.status, retryClassification: retryFor(response.status) });
      const result = Object.freeze({ status: response.status, data: immutableRedactedJson(data), headers: responseHeaders(response.headers, provider) });
      responseMetadata.set(result, { link: response.headers.link });
      return result;
    } finally {
      clearTimeout(timer);
      if (listening) {
        try { Reflect.apply(EVENT_REMOVE, request.signal, ['abort', abort]); } catch {}
      }
      try { request.releaseSignal(); } catch {}
    }
  }

  function request(requestInput) { return perform(snapshotRequest(requestInput)); }

  function urlFor(pathInput) {
    const path = requestPath(pathInput, allowEncodedSlash);
    const url = new URL(`${basePrefix}${path}`, baseUrl.origin);
    for (const key of [...url.searchParams.keys()]) if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
    return url.href;
  }

  async function paginate(inputPagination) {
    const value = captureRecord(inputPagination, new Set([
      'path', 'signal', 'itemsKey', 'mode', 'identityKey', 'totalKey',
    ]), ['path']);
    let path = requestPath(value.path, allowEncodedSlash);
    const itemsKey = value.itemsKey === undefined ? undefined
      : boundedString(value.itemsKey, 64, /^[A-Za-z][A-Za-z0-9_]*$/);
    const identityKey = value.identityKey === undefined ? undefined
      : boundedString(value.identityKey, 64, /^[A-Za-z][A-Za-z0-9_]*$/);
    const totalKey = value.totalKey === undefined ? undefined
      : boundedString(value.totalKey, 64, /^[A-Za-z][A-Za-z0-9_]*$/);
    const mode = value.mode === undefined ? 'link' : boundedString(value.mode, 16, /^(?:link|jira-offset)$/);
    const initialUrl = new URL(`${basePrefix}${path}`, baseUrl.origin);
    const endpointPathname = initialUrl.pathname;
    const fixedQuery = new Map();
    for (const key of new Set(initialUrl.searchParams.keys())) {
      if (!PAGINATION_QUERY_KEYS.has(key)) fixedQuery.set(key, initialUrl.searchParams.getAll(key));
    }
    function validateNextUrl(url) {
      if (url.origin !== baseUrl.origin || url.username || url.password || url.hash || url.pathname !== endpointPathname) {
        failProvider('remote', { provider, retryClassification: 'permanent' });
      }
      const keys = [...new Set(url.searchParams.keys())];
      if (keys.length > 32) failProvider('pagination-limit', { provider, retryClassification: 'permanent' });
      for (const key of keys) {
        if (isSensitiveQueryKey(key)) failProvider('remote', { provider, retryClassification: 'permanent' });
        const values = url.searchParams.getAll(key);
        if (values.length !== 1) failProvider('remote', { provider, retryClassification: 'permanent' });
        if (!PAGINATION_QUERY_KEYS.has(key)) {
          if (JSON.stringify(values) !== JSON.stringify(fixedQuery.get(key))) failProvider('remote', { provider, retryClassification: 'permanent' });
        } else if (key === 'page' && (!/^[1-9][0-9]{0,8}$/.test(values[0]))) failProvider('remote', { provider });
        else if (key === 'per_page' && (!/^\d{1,3}$/.test(values[0]) || Number(values[0]) < 1 || Number(values[0]) > 100)) failProvider('remote', { provider });
        else if (key === 'startAt' && (!/^\d{1,9}$/.test(values[0]))) failProvider('remote', { provider });
        else if (key === 'maxResults' && (!/^[1-9]\d{0,3}$/.test(values[0]))) failProvider('remote', { provider });
        else if (['cursor', 'after', 'before'].includes(key) && !/^[A-Za-z0-9._~+=/-]{1,512}$/.test(values[0])) failProvider('remote', { provider });
      }
      for (const [key, values] of fixedQuery) {
        if (JSON.stringify(url.searchParams.getAll(key)) !== JSON.stringify(values)) failProvider('remote', { provider, retryClassification: 'permanent' });
      }
    }
    validateNextUrl(initialUrl);
    let expectedOffset;
    let requestedMaxResults;
    let previousTotal;
    let currentPage = initialUrl.searchParams.has('page') ? Number(initialUrl.searchParams.get('page')) : 1;
    const pinnedPageSize = initialUrl.searchParams.get('per_page');
    const initialCursorKeys = ['cursor', 'after', 'before'].filter(key => initialUrl.searchParams.has(key));
    if (mode === 'link' && initialCursorKeys.length > 1) failProvider('invalid-request', { provider });
    let cursorKey = initialCursorKeys[0];
    let currentCursor = cursorKey === undefined ? undefined : initialUrl.searchParams.get(cursorKey);
    if (mode === 'jira-offset') {
      const value = initialUrl.searchParams.get('startAt');
      if (initialUrl.searchParams.getAll('startAt').length !== 1 || value === null || !/^\d{1,9}$/.test(value)) {
        failProvider('invalid-request', { provider });
      }
      expectedOffset = Number(value);
      const maximum = initialUrl.searchParams.get('maxResults');
      if (initialUrl.searchParams.getAll('maxResults').length !== 1 || maximum === null || !/^[1-9]\d{0,3}$/.test(maximum)) {
        failProvider('invalid-request', { provider });
      }
      requestedMaxResults = Number(maximum);
    }
    const output = [];
    const seen = new Set();
    const identities = new Set();
    let declaredTotal;
    let totalDeclaration;
    for (let page = 0; page < maxPages; page += 1) {
      if (seen.has(path)) failProvider('pagination-limit', { provider, retryClassification: 'permanent' });
      seen.add(path);
      const response = await request({ method: 'GET', path, ...(value.signal === undefined ? {} : { signal: value.signal }) });
      const pageItems = itemsKey === undefined ? response.data : response.data?.[itemsKey];
      if (!Array.isArray(pageItems)) failProvider('remote', { provider, retryClassification: 'permanent' });
      if (output.length + pageItems.length > maxItems) failProvider('pagination-limit', { provider, retryClassification: 'permanent' });
      if (identityKey !== undefined) {
        for (const item of pageItems) {
          const identity = item?.[identityKey];
          const token = typeof identity === 'string' && identity.length > 0 && identity.length <= 256
            ? `s:${identity}`
            : Number.isSafeInteger(identity) && identity >= 0 ? `n:${identity}` : null;
          if (token === null || identities.has(token)) failProvider('remote', { provider, retryClassification: 'permanent' });
          identities.add(token);
        }
      }
      if (totalKey !== undefined) {
        const hasTotal = response.data !== null && typeof response.data === 'object'
          && Object.hasOwn(response.data, totalKey);
        if (totalDeclaration === undefined) totalDeclaration = hasTotal;
        else if (totalDeclaration !== hasTotal) failProvider('remote', { provider, retryClassification: 'permanent' });
        if (hasTotal) {
          const total = response.data[totalKey];
          if (!Number.isSafeInteger(total) || total < 0) failProvider('remote', { provider, retryClassification: 'permanent' });
          if (total > maxItems) failProvider('pagination-limit', { provider, retryClassification: 'permanent' });
          if (declaredTotal !== undefined && total !== declaredTotal) failProvider('remote', { provider, retryClassification: 'permanent' });
          declaredTotal = total;
          if (output.length + pageItems.length > total) failProvider('remote', { provider, retryClassification: 'permanent' });
        }
      }
      let next;
      if (mode === 'jira-offset') {
        const { startAt, maxResults, total } = response.data ?? {};
        if (Number.isSafeInteger(total) && total > maxItems) {
          failProvider('pagination-limit', { provider, retryClassification: 'permanent' });
        }
        if (!Number.isSafeInteger(startAt) || startAt < 0 || !Number.isSafeInteger(maxResults) || maxResults < 1
          || !Number.isSafeInteger(total) || total < 0 || startAt !== expectedOffset
          || maxResults > requestedMaxResults || pageItems.length > maxResults || startAt + pageItems.length > total
          || (previousTotal !== undefined && total < previousTotal)) {
          failProvider('remote', { provider, retryClassification: 'permanent' });
        }
        previousTotal = total;
        output.push(...pageItems);
        if (startAt + pageItems.length >= total) return Object.freeze(output);
        if (pageItems.length === 0) failProvider('pagination-limit', { provider, retryClassification: 'permanent' });
        expectedOffset = startAt + pageItems.length;
        const current = new URL(`${basePrefix}${path}`, baseUrl.origin);
        current.searchParams.set('startAt', String(expectedOffset));
        next = current.href;
      } else {
        output.push(...pageItems);
        next = nextLink(responseMetadata.get(response)?.link, provider);
        if (!next) {
          if (declaredTotal !== undefined && output.length !== declaredTotal) {
            failProvider('remote', { provider, retryClassification: 'permanent' });
          }
          return Object.freeze(output);
        }
        if (declaredTotal !== undefined && output.length >= declaredTotal) {
          failProvider('remote', { provider, retryClassification: 'permanent' });
        }
      }
      let url;
      try {
        url = new URL(next);
        validateNextUrl(url);
        if (mode === 'link') {
          if (url.searchParams.get('per_page') !== pinnedPageSize
            || url.searchParams.getAll('per_page').length !== (pinnedPageSize === null ? 0 : 1)) {
            failProvider('remote', { provider, retryClassification: 'permanent' });
          }
          const nextCursorKeys = ['cursor', 'after', 'before'].filter(key => url.searchParams.has(key));
          if (cursorKey !== undefined || nextCursorKeys.length > 0) {
            if (nextCursorKeys.length !== 1 || (cursorKey !== undefined && nextCursorKeys[0] !== cursorKey)
              || url.searchParams.has('page')) failProvider('remote', { provider, retryClassification: 'permanent' });
            cursorKey ??= nextCursorKeys[0];
            const nextCursor = url.searchParams.get(cursorKey);
            if (nextCursor === currentCursor) failProvider('remote', { provider, retryClassification: 'permanent' });
            currentCursor = nextCursor;
          } else {
            const nextPage = Number(url.searchParams.get('page'));
            if (url.searchParams.getAll('page').length !== 1 || nextPage !== currentPage + 1) {
              failProvider('remote', { provider, retryClassification: 'permanent' });
            }
            currentPage = nextPage;
          }
        }
      } catch (error) {
        if (error instanceof ProviderAdapterError) throw error;
        failProvider('remote', { provider });
      }
      path = `${basePrefix ? url.pathname.slice(basePrefix.length) : url.pathname}${url.search}`;
    }
    failProvider('pagination-limit', { provider, retryClassification: 'permanent' });
  }

  return Object.freeze({ provider, baseUrl: `${baseUrl.origin}${basePrefix}`, request, paginate, urlFor });
}
