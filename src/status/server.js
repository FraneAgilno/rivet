import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { buildStatusViewModel } from './view-model.js';

const objectFreeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const promiseThen = Promise.prototype.then;
const reflectApply = Reflect.apply;
const HOST = '127.0.0.1';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_SSE_FRAME_BYTES = 32 * 1024;
const MAX_SSE_BATCH_BYTES = 256 * 1024;
const ASSETS = new Map([
  ['/', { type: 'text/html; charset=utf-8', body: readFileSync(fileURLToPath(new URL('./public/index.html', import.meta.url))) }],
  ['/app.js', { type: 'text/javascript; charset=utf-8', body: readFileSync(fileURLToPath(new URL('./public/app.js', import.meta.url))) }],
  ['/styles.css', { type: 'text/css; charset=utf-8', body: readFileSync(fileURLToPath(new URL('./public/styles.css', import.meta.url))) }],
]);
const ROUTES = new Set(['/api/state', '/api/events', '/events']);
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
});

class StatusServerError extends Error {
  constructor() {
    super('Status unavailable');
    this.name = 'StatusServerError';
    this.code = 'ERR_STATUS_UNAVAILABLE';
  }
}

function integer(value, minimum, maximum, fallback) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
function send(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-length': bytes.length, ...headers });
  response.end(bytes);
}
function sendUnavailable(response) {
  send(response, 503, 'Status unavailable', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
}
function sendJson(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_JSON_BYTES) { sendUnavailable(response); return; }
  send(response, 200, body, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}
function requestPath(request) {
  const value = request.url;
  if (typeof value !== 'string' || value.length > 64 || value.includes('%') || value.includes('?') || value.includes('#')) return null;
  return ROUTES.has(value) || ASSETS.has(value) ? value : null;
}
function rawHeaderValues(request, target) {
  const result = [];
  const values = request.rawHeaders;
  if (!Array.isArray(values) || values.length % 2 !== 0) return result;
  for (let index = 0; index < values.length; index += 2) {
    if (typeof values[index] === 'string' && values[index].toLowerCase() === target) result.push(values[index + 1]);
  }
  return result;
}
function reconnectCursor(request) {
  const values = rawHeaderValues(request, 'last-event-id');
  if (values.length === 0) return 0;
  if (values.length !== 1 || typeof values[0] !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/.test(values[0])) return null;
  return Number(values[0]);
}

export function createStatusServer(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.readState !== 'function') {
    throw new TypeError('Status server requires a state reader.');
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const pollIntervalMs = integer(options.pollIntervalMs, 25, 60_000, 1_000);
  const readTimeoutMs = integer(options.readTimeoutMs, 10, 30_000, 2_000);
  const maxSseClients = integer(options.maxSseClients, 1, 128, 16);
  const clients = new Set();
  const sockets = new Set();
  let actualPort = null;
  let started = false;
  let closing = null;

  function boundedStateRead(externalSignal) {
    const controller = new AbortController();
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        externalSignal?.removeEventListener?.('abort', onAbort);
        callback(value);
      };
      const fail = () => {
        controller.abort();
        finish(reject, new StatusServerError());
      };
      const onAbort = () => fail();
      const timer = setTimeout(fail, readTimeoutMs);
      timer.unref?.();
      if (externalSignal?.aborted) { fail(); return; }
      externalSignal?.addEventListener?.('abort', onAbort, { once: true });
      let source;
      try { source = options.readState({ signal: controller.signal }); }
      catch { finish(reject, new StatusServerError()); return; }
      const onFulfilled = value => finish(resolvePromise, value);
      const onRejected = () => finish(reject, new StatusServerError());
      try {
        reflectApply(promiseThen, source, [onFulfilled, onRejected]);
      } catch {
        try {
          const prototype = source !== null && typeof source === 'object' ? getPrototypeOf(source) : null;
          const thenDescriptor = source !== null && (typeof source === 'object' || typeof source === 'function')
            ? getDescriptor(source, 'then')
            : undefined;
          if ((prototype === Object.prototype || prototype === null) && !thenDescriptor) onFulfilled(source);
          else onRejected();
        } catch { onRejected(); }
      }
    });
  }

  async function readModel(signal) {
    const state = await boundedStateRead(signal);
    return buildStatusViewModel(state, { nowMs: now(), limits: options.limits });
  }

  function writeSse(client, payload) {
    if (client.closed || Buffer.byteLength(payload) > MAX_SSE_FRAME_BYTES) return Promise.resolve(false);
    if (client.response.write(payload)) return Promise.resolve(true);
    return new Promise(resolvePromise => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.response.off('drain', onDrain);
        client.response.off('close', onClose);
        resolvePromise(value);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      const timer = setTimeout(() => {
        client.abort.abort();
        client.response.destroy();
        finish(false);
      }, 1_000);
      timer.unref?.();
      client.response.once('drain', onDrain);
      client.response.once('close', onClose);
    });
  }

  async function sendSseEvents(client) {
    if (client.closed || client.busy) return;
    client.busy = true;
    try {
      const model = await readModel(client.abort.signal);
      if (client.closed) return;
      const firstAvailableSequence = model.events[0]?.sequence ?? 0;
      const latestSequence = model.events.at(-1)?.sequence ?? 0;
      let batchBytes = 0;
      if (!client.resetChecked && client.cursor > 0
        && (firstAvailableSequence === 0 || client.cursor < firstAvailableSequence - 1 || client.cursor > latestSequence)) {
        const reset = `id:\nevent: reset\ndata: ${JSON.stringify({ firstAvailableSequence, latestSequence })}\n\n`;
        if (!await writeSse(client, reset)) return;
        batchBytes += Buffer.byteLength(reset);
        client.cursor = Math.max(0, firstAvailableSequence - 1);
      }
      client.resetChecked = true;
      let wrote = false;
      for (const event of model.events) {
        if (event.sequence <= client.cursor) continue;
        const frame = `id: ${event.sequence}\nevent: status\ndata: ${JSON.stringify(event)}\n\n`;
        const frameBytes = Buffer.byteLength(frame);
        if (batchBytes + frameBytes > MAX_SSE_BATCH_BYTES || !await writeSse(client, frame)) break;
        batchBytes += frameBytes;
        client.cursor = event.sequence;
        wrote = true;
      }
      if (!wrote && batchBytes === 0) await writeSse(client, ': heartbeat\n\n');
    } catch {
      if (!client.closed) await writeSse(client, 'event: unavailable\ndata: {}\n\n');
    } finally { client.busy = false; }
  }

  const server = createServer(async (request, response) => {
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(key, value);
    const host = rawHeaderValues(request, 'host');
    if (actualPort === null || host.length !== 1 || host[0] !== `${HOST}:${actualPort}`) {
      send(response, 421, 'Misdirected Request', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return;
    }
    const origins = rawHeaderValues(request, 'origin');
    if (origins.length > 1 || (origins.length === 1 && origins[0] !== `http://${HOST}:${actualPort}`)) {
      send(response, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return;
    }
    if (request.method !== 'GET') {
      send(response, 405, 'Method Not Allowed', { allow: 'GET', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return;
    }
    const path = requestPath(request);
    if (!path) {
      send(response, 404, 'Not Found', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return;
    }
    try {
      if (path === '/api/state' || path === '/api/events') {
        const abort = new AbortController();
        const disconnect = () => abort.abort();
        request.once('aborted', disconnect);
        response.once('close', disconnect);
        try {
          const model = await readModel(abort.signal);
          if (path === '/api/state') sendJson(response, model);
          else sendJson(response, { events: model.events, truncated: model.truncated.events });
        } finally {
          request.off('aborted', disconnect);
          response.off('close', disconnect);
        }
        return;
      }
      if (path === '/events') {
        const cursor = reconnectCursor(request);
        if (cursor === null) {
          send(response, 400, 'Invalid Last-Event-ID', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return;
        }
        if (clients.size >= maxSseClients) {
          send(response, 503, 'Status stream capacity reached', { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' });
          return;
        }
        response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        response.write('retry: 2000\n\n');
        const client = { response, cursor, resetChecked: false, busy: false, closed: false, timer: null, abort: new AbortController() };
        clients.add(client);
        const closeClient = () => {
          if (client.closed) return;
          client.closed = true;
          client.abort.abort();
          clearInterval(client.timer);
          clients.delete(client);
        };
        request.once('aborted', closeClient);
        request.once('close', closeClient);
        response.once('close', closeClient);
        await sendSseEvents(client);
        if (!client.closed) {
          client.timer = setInterval(() => { void sendSseEvents(client); }, pollIntervalMs);
          client.timer.unref?.();
        }
        return;
      }
      const asset = ASSETS.get(path);
      send(response, 200, asset.body, { 'content-type': asset.type, 'cache-control': 'no-store' });
    } catch {
      if (!response.headersSent) sendUnavailable(response);
      else if (!response.destroyed) response.destroy();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 2_000;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  return Object.freeze({
    async start(startOptions = {}) {
      if (started || closing) throw new Error('Status server is already started.');
      if (!startOptions || typeof startOptions !== 'object' || Array.isArray(startOptions)
        || Object.keys(startOptions).some(key => key !== 'port')) throw new TypeError('Status server start options are invalid.');
      const port = integer(startOptions.port ?? 0, 0, 65_535, null);
      if (port === null) throw new TypeError('Status server port is invalid.');
      await new Promise((resolvePromise, reject) => {
        const onError = () => { server.off('listening', onListening); reject(new StatusServerError()); };
        const onListening = () => { server.off('error', onError); resolvePromise(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, HOST);
      });
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== HOST || !Number.isSafeInteger(address.port) || address.port < 1) {
        await new Promise(resolvePromise => server.close(resolvePromise));
        throw new StatusServerError();
      }
      actualPort = address.port;
      started = true;
      return objectFreeze({ host: HOST, port: actualPort, url: `http://${HOST}:${actualPort}` });
    },
    async close() {
      if (closing) return closing;
      if (!started) return;
      closing = (async () => {
        for (const client of clients) {
          client.closed = true;
          client.abort.abort();
          clearInterval(client.timer);
          client.response.destroy();
        }
        clients.clear();
        const stopped = new Promise((resolvePromise, reject) => server.close(error => error ? reject(new StatusServerError()) : resolvePromise()));
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
        await stopped;
        started = false;
        actualPort = null;
      })();
      try { await closing; } finally { closing = null; }
    },
  });
}
