import { request as httpRequest } from 'node:http';
import { createProviderHttpClient } from '../adapters/http.js';
import { createNodeProviderTransport } from '../adapters/node-transport.js';
import { createModelJsonBody, providerWireBytes } from '../adapters/contract.js';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Local model calls deliberately bypass public-only DNS policy, but only for an
// explicitly selected HTTP loopback destination. No DNS, proxy, redirect or Unix
// socket selection is exposed. HTTPS loopback is not supported in this slice.
async function loopbackJson(url, headers, body, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Model request cancelled')); return; }
    const request = httpRequest({
      protocol: 'http:', hostname: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
      port: url.port || 80, method: 'POST', path: url.pathname,
      headers: { ...headers, host: url.host, 'accept-encoding': 'identity' }, agent: false, signal,
    }, response => {
      const fail = () => { response.destroy(); reject(new Error('Invalid model response')); };
      if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300
        || !/^application\/(?:[A-Za-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) { fail(); return; }
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) { fail(); return; }
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { fail(); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Incomplete model response')));
      response.on('end', () => {
        if (bytes > MAX_RESPONSE_BYTES) return;
        try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { reject(new Error('Invalid model response')); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

export async function requestModelJson({ provider, request, timeoutMs, signal, transport }) {
  const url = new URL(request.url);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid model destination');
  const wireBody = createModelJsonBody({ provider, payload: request.body });
  if (LOOPBACK.has(url.hostname)) {
    if (!['ollama', 'openai-compatible'].includes(provider) || url.protocol !== 'http:' || transport !== undefined)
      throw new Error('Unsupported local model destination');
    return loopbackJson(url, request.headers, providerWireBytes(wireBody), signal);
  }
  if (url.protocol !== 'https:') throw new Error('Invalid model destination');
  const http = createProviderHttpClient({
    provider, baseUrl: url.origin, transport: transport ?? createNodeProviderTransport(),
    headers: request.headers, timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES,
  });
  return (await http.request({ method: 'POST', path: url.pathname, wireBody, signal })).data;
}
