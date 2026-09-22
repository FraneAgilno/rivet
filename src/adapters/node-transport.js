import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { createTrustedProviderTransport } from './http.js';

// The HTTP policy validates DNS answers before supplying these exact pins.
// Retain the URL hostname for TLS certificate validation and SNI.
export function createNodeProviderTransport({ lookup = dnsLookup, request = httpsRequest } = {}) {
  return createTrustedProviderTransport({
    async resolve(hostname) {
      return (await lookup(hostname, { all: true })).map(item => item.address);
    },
    fetchPinned(url, init, pins) {
      return new Promise((resolve, reject) => {
        const target = new URL(url);
        if (target.protocol !== 'https:' || target.hostname !== pins.hostname || !pins.addresses.length) {
          reject(new Error('Invalid pinned destination.'));
          return;
        }
        const addresses = pins.addresses.map(address => ({ address, family: isIP(address) }));
        const outgoing = request(target, {
          method: init.method,
          headers: init.headers,
          signal: init.signal,
          agent: false,
          servername: pins.hostname,
          rejectUnauthorized: true,
          lookup(hostname, options, callback) {
            if (hostname !== pins.hostname) return callback(new Error('Unexpected hostname.'));
            if (options?.all) return callback(null, addresses);
            const selected = addresses.find(item => !options?.family || item.family === options.family);
            if (!selected) return callback(new Error('No matching pinned address.'));
            callback(null, selected.address, selected.family);
          },
        }, incoming => {
          const status = incoming.statusCode;
          if (!Number.isInteger(status) || (status >= 300 && status < 400)) {
            incoming.destroy();
            reject(new Error('Provider redirect or invalid response.'));
            return;
          }
          try {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            const noBody = status === 204 || status === 205;
            if (noBody) incoming.resume();
            resolve(new Response(noBody ? null : Readable.toWeb(incoming), { status, headers }));
          } catch (error) { incoming.destroy(); reject(error); }
        });
        outgoing.on('error', reject);
        outgoing.end(init.body);
      });
    },
  });
}
