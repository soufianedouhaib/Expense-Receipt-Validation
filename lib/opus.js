'use strict';

/**
 * The only place that talks to Opus. The service key lives here and never
 * reaches the browser.
 *
 * Contract, read from the live workflow on 17 Sep 2026:
 *   base    https://operator.opus.com/api/v1
 *   auth    x-service-key: <key>
 *   flow    POST /file/upload/presigned -> { presignedUrl, fileUrl }
 *           PUT  <presignedUrl>         -> raw bytes, no service key
 *           POST /case                  -> { caseId }
 *           POST /case/{id}/execute     -> payload keyed by input variable id
 *           GET  /case/{id}/status      -> { status }
 *           GET  /case/{id}/results     -> { results: { <id>: { value } } }
 */

const BASE = (process.env.OPUS_BASE_URL || 'https://operator.opus.com/api/v1').replace(/\/+$/, '');
const WORKFLOW_ID = process.env.OPUS_WORKFLOW_ID || '471f6915-8b0d-43ed-8d11-fdc226d48abc';
const VERSION = process.env.OPUS_WORKFLOW_VERSION || '';

// Workflow variable ids. Recorded as named constants so a workflow change is a
// one line edit here rather than a hunt through the codebase.
const INPUT_SUBMITTED_DOCS = 'workflow_input_rzn32jqyr'; // file, "Submitted Docs"
const OUTPUT_RESULT = 'workflow_output_19c3j6l3b';       // object, "Assembled Result"
const OUTPUT_EXPLANATION = 'workflow_output_0pk3ch2zt';  // json_string, "Explanation"
const OUTPUT_ERROR = 'workflow_output_2p2xhf3ys';        // str, "Assembled Error"

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

/* The stored key, and the one that actually worked.
 *
 * Opus keys begin with an underscore, which is the single easiest character to
 * lose when copying a value into a hosting dashboard: a double click selects
 * the word and leaves the underscore behind, and the result is a 401 that looks
 * like an expired key rather than a typo. So a key that does not start with an
 * underscore gets one retry with it restored, and whichever form is accepted is
 * remembered for the life of the process. Nothing is guessed beyond that one
 * character, and /api/health reports when the repair was used. */
let workingKey = null;

function storedKey() {
  // Trailing newlines and stray spaces are the other two paste casualties.
  return (process.env.OPUS_SERVICE_KEY || '').trim();
}

function keyCandidates() {
  const raw = storedKey();
  if (!raw) return [''];
  const list = [raw];
  if (raw.charAt(0) !== '_') list.push('_' + raw);
  return list;
}

function serviceKey() {
  return workingKey || storedKey();
}

function keyWasRepaired() {
  return Boolean(workingKey) && workingKey !== storedKey();
}

function missingEnv() {
  const missing = [];
  if (!serviceKey()) missing.push('OPUS_SERVICE_KEY');
  if (!WORKFLOW_ID) missing.push('OPUS_WORKFLOW_ID');
  return missing;
}

/**
 * Always read the body as text first. A platform 413 / 502 / crash answers with
 * an HTML error page, and a bare res.json() would throw a parse error that
 * hides the status code the user actually needs to see.
 */
async function readBody(res) {
  const text = await res.text();
  if (!text) return { json: null, text: '' };
  try {
    return { json: JSON.parse(text), text: text };
  } catch (e) {
    return { json: null, text: text };
  }
}

async function send(key, method, path, body) {
  const headers = { 'x-service-key': key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(BASE + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    const e = new Error('Could not reach Opus: ' + err.message);
    e.status = 502;
    throw e;
  }
}

async function call(method, path, body) {
  const candidates = workingKey ? [workingKey] : keyCandidates();
  let res = await send(candidates[0], method, path, body);

  if (res.status === 401 && candidates.length > 1) {
    const retry = await send(candidates[1], method, path, body);
    if (retry.status !== 401) {
      workingKey = candidates[1];
      res = retry;
    }
  }
  if (res.ok && !workingKey) workingKey = candidates[0];

  const parsed = await readBody(res);
  if (!res.ok && res.status !== 202) {
    const detail =
      (parsed.json && (parsed.json.message || parsed.json.error)) ||
      parsed.text.slice(0, 300) ||
      res.statusText;
    // A 401 is almost always the stored service key, and the raw wording sends
    // people hunting in the wrong place.
    const message =
      res.status === 401
        ? 'Opus rejected this server\'s service key. Check OPUS_SERVICE_KEY in the project ' +
          'environment, including its leading underscore, then redeploy.'
        : 'Opus ' + res.status + ': ' + detail;
    const e = new Error(message);
    e.status = res.status;
    e.retryAfter =
      parsed.json && parsed.json.metadata && parsed.json.metadata.retryAfterSeconds;
    throw e;
  }
  return { status: res.status, body: parsed.json, raw: parsed.text };
}

const opus = {
  BASE: BASE,
  WORKFLOW_ID: WORKFLOW_ID,
  INPUT_SUBMITTED_DOCS: INPUT_SUBMITTED_DOCS,
  OUTPUT_RESULT: OUTPUT_RESULT,
  OUTPUT_EXPLANATION: OUTPUT_EXPLANATION,
  OUTPUT_ERROR: OUTPUT_ERROR,
  TERMINAL: TERMINAL,
  missingEnv: missingEnv,
  storedKeyLength: function () {
    return storedKey().length;
  },
  /* Anything that talks to Opus outside this module asks for the header here,
     so a repaired key is used everywhere rather than only on this path. */
  authHeaders: function () {
    return { 'x-service-key': serviceKey() };
  },
  keyWasRepaired: keyWasRepaired,

  isTerminal: function (status) {
    return TERMINAL.indexOf(status) !== -1;
  },

  /** Presigned upload slot for one file. */
  async uploadUrl(fileExtension, originalName) {
    const out = await call('POST', '/file/upload/presigned', {
      fileExtension: fileExtension,
      originalName: originalName,
      workflowId: WORKFLOW_ID
    });
    const b = out.body || {};
    if (!b.presignedUrl || !b.fileUrl) {
      const e = new Error('Opus did not return an upload URL.');
      e.status = 502;
      throw e;
    }
    return { presignedUrl: b.presignedUrl, fileUrl: b.fileUrl };
  },

  /** Server side PUT to S3, used when the browser cannot reach S3 directly. */
  async putFile(presignedUrl, buffer, contentType) {
    let res;
    try {
      res = await fetch(presignedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType || 'application/octet-stream' },
        body: buffer
      });
    } catch (err) {
      const e = new Error('Upload to storage failed: ' + err.message);
      e.status = 502;
      throw e;
    }
    if (!res.ok) {
      const text = await res.text();
      const e = new Error('Upload to storage failed (' + res.status + '): ' + text.slice(0, 200));
      e.status = res.status === 413 ? 413 : 502;
      throw e;
    }
    return true;
  },

  async initiateCase(title, description) {
    const payload = { workflowId: WORKFLOW_ID, title: title, description: description };
    if (VERSION) payload.workflowVersionNumber = Number(VERSION);
    const out = await call('POST', '/case', payload);
    const caseId = out.body && out.body.caseId;
    if (!caseId) {
      const e = new Error('Opus did not return a case id.');
      e.status = 502;
      throw e;
    }
    return String(caseId);
  },

  async executeCase(caseId, fileUrl) {
    const payload = {};
    payload[INPUT_SUBMITTED_DOCS] = {
      value: fileUrl,
      type: 'file',
      displayName: 'Submitted Docs'
    };
    const out = await call('POST', '/case/' + encodeURIComponent(caseId) + '/execute', {
      payload: payload
    });
    return out.body || {};
  },

  async status(caseId) {
    const out = await call('GET', '/case/' + encodeURIComponent(caseId) + '/status');
    return (out.body && out.body.status) || 'UNKNOWN';
  },

  /** Returns null while the case is still running (Opus answers 202). */
  async results(caseId) {
    const out = await call('GET', '/case/' + encodeURIComponent(caseId) + '/results');
    if (out.status === 202) return null;
    return (out.body && out.body.results) || null;
  }
};

module.exports = opus;
