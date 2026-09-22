'use strict';

/**
 * Optional history storage.
 *
 * Supports two shapes of Vercel storage, because Vercel injects whichever the
 * store was created with:
 *
 *   1. Upstash / Vercel KV REST  -> *_KV_REST_API_URL + *_KV_REST_API_TOKEN
 *                                   (or *_UPSTASH_REDIS_REST_URL / _TOKEN)
 *   2. A plain TCP connection    -> *_REDIS_URL
 *
 * Injected variables carry a project prefix (MYSTORE_KV_REST_API_URL), so every
 * lookup here matches by SUFFIX, never by exact name.
 *
 * When neither is configured the module reports notConfigured and every call
 * resolves to an empty answer. Nothing throws, so the app runs fine before a
 * store is connected.
 */

function envBySuffix(suffix) {
  const keys = Object.keys(process.env);
  // Exact match wins, then the shortest prefixed match, for determinism.
  if (process.env[suffix]) return process.env[suffix];
  const matches = keys
    .filter(function (k) {
      return k.endsWith('_' + suffix) && process.env[k];
    })
    .sort(function (a, b) {
      return a.length - b.length;
    });
  return matches.length ? process.env[matches[0]] : null;
}

const REST_URL =
  envBySuffix('KV_REST_API_URL') || envBySuffix('UPSTASH_REDIS_REST_URL');
const REST_TOKEN =
  envBySuffix('KV_REST_API_TOKEN') || envBySuffix('UPSTASH_REDIS_REST_TOKEN');
const TCP_URL = envBySuffix('REDIS_URL') || envBySuffix('KV_URL');

const mode = REST_URL && REST_TOKEN ? 'rest' : TCP_URL ? 'tcp' : 'none';

let tcpClientPromise = null;

function tcpClient() {
  if (!tcpClientPromise) {
    tcpClientPromise = (async function () {
      // Lazily required so a missing module never breaks a deploy that does
      // not use TCP storage.
      const redis = require('redis');
      const client = redis.createClient({
        url: TCP_URL,
        socket: { reconnectStrategy: function (n) { return Math.min(n * 100, 2000); } }
      });
      client.on('error', function () { /* handled by the callers below */ });
      await client.connect();
      return client;
    })().catch(function (err) {
      tcpClientPromise = null;
      throw err;
    });
  }
  return tcpClientPromise;
}

async function rest(command) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + REST_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  const text = await res.text();
  if (!res.ok) throw new Error('KV ' + res.status + ': ' + text.slice(0, 200));
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('KV returned non JSON: ' + text.slice(0, 200));
  }
  if (parsed && parsed.error) throw new Error('KV: ' + parsed.error);
  return parsed ? parsed.result : null;
}

async function run(command) {
  if (mode === 'rest') return rest(command);
  if (mode === 'tcp') {
    const client = await tcpClient();
    return client.sendCommand(command.map(String));
  }
  return null;
}

const store = {
  configured: mode !== 'none',
  mode: mode,

  async setJson(key, value) {
    if (!store.configured) return false;
    await run(['SET', key, JSON.stringify(value)]);
    return true;
  },

  async getJson(key) {
    if (!store.configured) return null;
    const raw = await run(['GET', key]);
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  /* Plain strings, used for the packet chunks. JSON wrapping a base64 blob
     would inflate it for no gain, so these two skip it. A ttl in seconds keeps
     stored packets from growing without limit. */
  async setText(key, text, ttlSeconds) {
    if (!store.configured) return false;
    if (ttlSeconds) await run(['SET', key, text, 'EX', ttlSeconds]);
    else await run(['SET', key, text]);
    return true;
  },

  async getText(key) {
    if (!store.configured) return null;
    const raw = await run(['GET', key]);
    if (raw === null || raw === undefined) return null;
    return String(raw);
  },

  async pushId(listKey, id, cap) {
    if (!store.configured) return false;
    await run(['LREM', listKey, 0, id]);
    await run(['LPUSH', listKey, id]);
    await run(['LTRIM', listKey, 0, (cap || 200) - 1]);
    return true;
  },

  async listIds(listKey, limit) {
    if (!store.configured) return [];
    const ids = await run(['LRANGE', listKey, 0, (limit || 50) - 1]);
    return Array.isArray(ids) ? ids : [];
  },

  async ping() {
    if (!store.configured) return { ok: false, reason: 'not configured' };
    try {
      await run(['PING']);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
};

module.exports = store;
