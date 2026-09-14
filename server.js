/**
 * Expense Receipt Validation — backend
 *
 * Holds the Opus service key and is the only part of the app allowed to talk to
 * Opus. The browser only ever calls the routes in this file.
 *
 * Opus flow (External Integration API v1):
 *   1. POST /file/upload/presigned  -> { presignedUrl, fileUrl }
 *   2. PUT  <presignedUrl>          -> raw receipt bytes (S3, no service key)
 *   3. POST /case                   -> { caseId }
 *   4. POST /case/{caseId}/execute  -> payload keyed by workflow_input_* ids
 *   5. GET  /case/{caseId}/status   -> { status }
 *   6. GET  /case/{caseId}/results  -> { results: { workflow_output_*: { value } } }
 *
 * Persistence (added for the manager view):
 *   - Upstash Redis  one record per submission, plus an index ordered by time.
 *   - Vercel Blob    holds a private copy of each receipt, since Opus's own file
 *                    URLs are internal references that cannot be fetched back.
 *
 * Both are optional. Without them the employee flow works exactly as before and
 * the manager page reports that storage is not configured.
 */

// Local development reads .env; on Vercel the values come from project settings.
try { require('dotenv').config(); } catch (e) { /* dotenv not installed — fine in production */ }

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const auth = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ *
 * Opus configuration — every workflow-specific id lives here, once.
 * ------------------------------------------------------------------ */

const OPUS_BASE_URL = process.env.OPUS_BASE_URL || 'https://operator.opus.com/api/v1';
const OPUS_SERVICE_KEY = process.env.OPUS_SERVICE_KEY;
const OPUS_WORKFLOW_ID = process.env.OPUS_WORKFLOW_ID;

// Input variable ids, from the workflow's Input node.
const INPUT_EMPLOYEE_RECORD = process.env.OPUS_INPUT_EMPLOYEE_RECORD;
const INPUT_RECEIPT = process.env.OPUS_INPUT_RECEIPT;
const INPUT_SUBMITTED_TOTAL = process.env.OPUS_INPUT_SUBMITTED_TOTAL;

// Output variable ids, from the workflow's Output node.
const OUTPUT_SUMMARY_REPORT = process.env.OPUS_OUTPUT_SUMMARY_REPORT;
const OUTPUT_RECEIPT = process.env.OPUS_OUTPUT_RECEIPT;
const OUTPUT_EMPLOYEE_RECORD = process.env.OPUS_OUTPUT_EMPLOYEE_RECORD;


const REQUIRED_ENV = {
  OPUS_SERVICE_KEY,
  OPUS_WORKFLOW_ID,
  OPUS_INPUT_EMPLOYEE_RECORD: INPUT_EMPLOYEE_RECORD,
  OPUS_INPUT_RECEIPT: INPUT_RECEIPT,
  OPUS_INPUT_SUBMITTED_TOTAL: INPUT_SUBMITTED_TOTAL,
  OPUS_OUTPUT_SUMMARY_REPORT: OUTPUT_SUMMARY_REPORT,
};

function missingEnv() {
  return Object.entries(REQUIRED_ENV).filter(([, v]) => !v).map(([k]) => k);
}

/* ------------------------------------------------------------------ *
 * Storage — Redis for records, Vercel Blob for receipt copies.
 * ------------------------------------------------------------------ */

const INDEX_KEY = 'expense:index';                     // every claim, by time
const BY_EMPLOYEE = (email) => `expense:emp:${email}`; // one person's own claims
const BY_MANAGER = (name) => `expense:mgr:${name}`;    // the claims naming them
const MANAGERS_SET = 'expense:managers';               // who has ever been named
const RECORD_KEY = (id) => `expense:case:${id}`;
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 365; // keep a year of history

/** Fold a person's name so small differences in spacing or case still match. */
function normaliseName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Find an environment variable by suffix, so a prefix chosen when the store was
 * connected (MYSTORE_REDIS_URL) still resolves.
 */
function findEnv(...suffixes) {
  for (const suffix of suffixes) {
    if (process.env[suffix]) return { name: suffix, value: process.env[suffix] };
  }
  for (const suffix of suffixes) {
    const name = Object.keys(process.env).find((k) => k.endsWith(suffix) && process.env[k]);
    if (name) return { name, value: process.env[name] };
  }
  return { name: null, value: undefined };
}

const restUrlVar = findEnv('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const restTokenVar = findEnv('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
const tcpUrlVar = findEnv('REDIS_URL', 'KV_URL');
const blobTokenVar = findEnv('BLOB_READ_WRITE_TOKEN');

const REST_URL = /^https?:\/\//.test(restUrlVar.value || '') ? restUrlVar.value : undefined;
const REST_TOKEN = restTokenVar.value;
const TCP_URL = /^rediss?:\/\//.test(tcpUrlVar.value || '') ? tcpUrlVar.value : undefined;
const BLOB_TOKEN = blobTokenVar.value;

// Two ways to reach the same Redis. Vercel's integration injects one or the
// other depending on how the store was created, so support both: REST when it
// is there (better suited to serverless), a normal connection otherwise.
const STORAGE_MODE = (REST_URL && REST_TOKEN) ? 'rest' : (TCP_URL ? 'tcp' : null);
const storageReady = () => STORAGE_MODE !== null;

let restClient = null;
let tcpClient = null;

function getRestClient() {
  if (!restClient) {
    const { Redis } = require('@upstash/redis');
    restClient = new Redis({ url: REST_URL, token: REST_TOKEN });
  }
  return restClient;
}

async function getTcpClient() {
  if (tcpClient && tcpClient.isOpen) return tcpClient;
  const { createClient } = require('redis');
  tcpClient = createClient({ url: TCP_URL });
  tcpClient.on('error', (e) => console.error('[redis]', e.message));
  await tcpClient.connect();
  return tcpClient;
}

async function redisSet(key, value) {
  if (STORAGE_MODE === 'rest') {
    return getRestClient().set(key, value, { ex: RECORD_TTL_SECONDS });
  }
  const client = await getTcpClient();
  return client.sendCommand(['SET', key, JSON.stringify(value), 'EX', String(RECORD_TTL_SECONDS)]);
}

async function redisGet(key) {
  if (STORAGE_MODE === 'rest') {
    return getRestClient().get(key);
  }
  const client = await getTcpClient();
  const raw = await client.sendCommand(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function redisZAdd(key, score, member) {
  if (STORAGE_MODE === 'rest') {
    return getRestClient().zadd(key, { score, member });
  }
  const client = await getTcpClient();
  return client.sendCommand(['ZADD', key, String(score), member]);
}

async function redisSAdd(key, member) {
  if (STORAGE_MODE === 'rest') return getRestClient().sadd(key, member);
  const client = await getTcpClient();
  return client.sendCommand(['SADD', key, member]);
}

async function redisSIsMember(key, member) {
  if (STORAGE_MODE === 'rest') return getRestClient().sismember(key, member);
  const client = await getTcpClient();
  const n = await client.sendCommand(['SISMEMBER', key, member]);
  return Number(n) === 1;
}

async function redisZRangeRev(key, limit) {
  if (STORAGE_MODE === 'rest') {
    return getRestClient().zrange(key, 0, limit - 1, { rev: true });
  }
  const client = await getTcpClient();
  return client.sendCommand(['ZRANGE', key, '0', String(limit - 1), 'REV']);
}

async function saveRecord(record) {
  if (!storageReady()) return;
  try {
    const when = new Date(record.submittedAt).getTime();
    const emp = record.employee || {};

    await redisSet(RECORD_KEY(record.caseId), record);
    await redisZAdd(INDEX_KEY, when, record.caseId);

    // Two more indexes, so "my claims" and "my team's claims" are direct reads
    // rather than a scan of everything.
    if (emp.email) {
      await redisZAdd(BY_EMPLOYEE(String(emp.email).toLowerCase()), when, record.caseId);
    }
    if (emp.managerName) {
      // Naming someone as your manager is what makes them one. The key is the
      // name folded to lowercase with runs of spaces collapsed, so "Omar  Busaileh"
      // and "omar busaileh" land in the same place.
      const mgr = normaliseName(emp.managerName);
      if (mgr) {
        await redisZAdd(BY_MANAGER(mgr), when, record.caseId);
        await redisSAdd(MANAGERS_SET, mgr);
      }
    }
  } catch (err) {
    // History is secondary — never fail an employee's submission over it.
    console.error('[storage] save failed', err.message);
  }
}

// A Redis set overwrites, so updating is the same operation as saving.
const updateRecord = saveRecord;

async function loadRecord(caseId) {
  if (!storageReady()) return null;
  try {
    return await redisGet(RECORD_KEY(caseId));
  } catch (err) {
    console.error('[storage] load failed', err.message);
    return null;
  }
}

async function isManager(name) {
  if (!storageReady() || !name) return false;
  try {
    return await redisSIsMember(MANAGERS_SET, normaliseName(name));
  } catch (err) {
    console.error('[storage] manager check failed', err.message);
    return false;
  }
}

async function listRecords(limit = 300, key = INDEX_KEY) {
  if (!storageReady()) return [];
  try {
    const ids = await redisZRangeRev(key, limit);
    if (!ids || !ids.length) return [];
    const records = await Promise.all(ids.map((id) => loadRecord(id)));
    return records.filter(Boolean);
  } catch (err) {
    console.error('[storage] list failed', err.message);
    return [];
  }
}

/** Keep a private copy of the receipt so the manager can actually open it. */
async function archiveReceipt(file, caseIdHint) {
  if (!BLOB_TOKEN) return null;
  try {
    const { put } = require('@vercel/blob');
    const safeName = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_');
    const blob = await put(`receipts/${caseIdHint}/${safeName}`, file.buffer, {
      access: 'public',            // unguessable URL; we never hand it to the browser
      contentType: file.mimetype || 'application/octet-stream',
      token: BLOB_TOKEN,
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (err) {
    console.error('[storage] receipt archive failed', err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

const MAX_FILE_BYTES = 10 * 1024 * 1024; // Opus caps file inputs at 10MB

const ALLOWED_EXTENSIONS = [
  '.jpeg', '.png', '.jpg', '.pdf', '.docx',
  '.csv', '.xls', '.xlsx', '.txt', '.json', '.html', '.xml',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return cb(new Error(`Unsupported file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
    }
    cb(null, true);
  },
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * Opus helpers
 * ------------------------------------------------------------------ */

async function opusFetch(pathname, options = {}) {
  const res = await fetch(`${OPUS_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'x-service-key': OPUS_SERVICE_KEY,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok && res.status !== 202) {
    const message = body.message || body.error || `Opus responded ${res.status}`;
    const err = new Error(typeof message === 'string' ? message : JSON.stringify(message));
    err.status = res.status;
    throw err;
  }

  return { status: res.status, body };
}

async function uploadReceiptToOpus(file) {
  const fileExtension = path.extname(file.originalname).toLowerCase();

  const { body: presign } = await opusFetch('/file/upload/presigned', {
    method: 'POST',
    body: JSON.stringify({
      fileExtension,
      originalName: file.originalname,
      workflowId: OPUS_WORKFLOW_ID,
    }),
  });

  if (!presign.presignedUrl || !presign.fileUrl) {
    throw new Error('Opus did not return a presigned upload URL.');
  }

  // Straight to S3 — deliberately no service key on this request.
  const put = await fetch(presign.presignedUrl, {
    method: 'PUT',
    body: file.buffer,
    headers: { 'Content-Type': file.mimetype || 'application/octet-stream' },
  });

  if (!put.ok) throw new Error(`Receipt upload failed (${put.status}).`);

  return presign.fileUrl;
}

function buildEmployeeRecord(form) {
  return JSON.stringify({
    full_name: (form.fullName || '').trim().toUpperCase(),
    phone_number: (form.phoneNumber || '').trim(),
    date_of_birth: (form.dateOfBirth || '').trim(),
    gender: (form.gender || '').trim().toUpperCase(),
    job_title: (form.jobTitle || '').trim().toUpperCase(),
    email: (form.email || '').trim(),
    manager: { name: (form.managerName || '').trim().toUpperCase() },
  });
}

function parseReport(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/** Read a case from Opus and fold the outcome into its stored record. */
async function refreshCase(caseId) {
  const { body: statusBody } = await opusFetch(`/case/${caseId}/status`);
  const status = statusBody.status || 'UNKNOWN';

  if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(status)) {
    return { state: 'failed', status, error: `The validation run ended with status ${status}.` };
  }

  if (status !== 'COMPLETED') return { state: 'running', status };

  const { status: httpStatus, body: resultsBody } = await opusFetch(`/case/${caseId}/results`);
  if (httpStatus === 202) return { state: 'running', status };

  const results = resultsBody.results || resultsBody || {};
  const pick = (id) => (id && results[id] ? results[id].value : undefined);

  const rawReport = pick(OUTPUT_SUMMARY_REPORT);
  const report = parseReport(rawReport);

  return {
    state: 'done',
    status,
    report,
    rawReport: report ? undefined : rawReport,
    opusReceiptUrl: pick(OUTPUT_RECEIPT),
    employeeRecord: pick(OUTPUT_EMPLOYEE_RECORD),
  };
}

async function applyOutcome(caseId, outcome) {
  const record = await loadRecord(caseId);
  if (!record) return;
  if (outcome.state === 'done') {
    record.state = 'done';
    record.opusStatus = outcome.status;
    record.report = outcome.report || null;
    record.rawReport = outcome.report ? undefined : outcome.rawReport;
    record.completedAt = new Date().toISOString();
  } else if (outcome.state === 'failed') {
    record.state = 'failed';
    record.opusStatus = outcome.status;
    record.error = outcome.error;
    record.completedAt = new Date().toISOString();
  } else {
    record.opusStatus = outcome.status;
  }
  await updateRecord(record);
}

/* ------------------------------------------------------------------ *
 * Access — who is signed in, and what they may see
 * ------------------------------------------------------------------ */

const requireSignedIn = auth.require([]);

const isAdmin = (session) => session.roles.indexOf('admin') !== -1;

/**
 * An admin sees everything. A manager sees the claims that name them — by the
 * manager email the employee gave, or failing that by name. Name matching is a
 * convenience, not a boundary: two people called the same thing would see each
 * other's team, which is why the email field exists.
 */
function managesClaim(session, record) {
  const emp = record.employee || {};
  return Boolean(emp.managerName) &&
         normaliseName(emp.managerName) === normaliseName(session.name);
}

function ownsClaim(session, record) {
  const emp = record.employee || {};
  return String(emp.email || '').toLowerCase() === String(session.email || '').toLowerCase();
}

/* ------------------------------------------------------------------ *
 * Employee routes
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

app.post('/api/auth/login', auth.login);

/** No account: file one claim, typing your own name and email. */
app.post('/api/auth/guest', (req, res) => {
  const session = auth.startGuestSession(res);
  res.json({ ok: true, guest: true, roles: session.roles });
});

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(res);
  res.json({ ok: true });
});

/** Who is signed in, and what may they do. The welcome page asks this first. */
app.get('/api/me', async (req, res) => {
  const session = auth.sessionFrom(req);
  if (!session) return res.json({ signedIn: false, configured: true });

  // "Manager" is configured nowhere. You become one the moment somebody names
  // you on a claim, so it is looked up fresh rather than stored in the cookie.
  if (session.guest) {
    return res.json({
      signedIn: true, configured: true, guest: true,
      email: '', name: '', roles: session.roles, defaultManager: '',
    });
  }

  const roles = session.roles.slice();
  try {
    if (await isManager(session.name)) roles.push('manager');
  } catch (e) { /* not being shown the team view is better than a broken page */ }

  res.json({
    signedIn: true,
    configured: true,
    email: session.email,
    name: session.name,
    roles,
    // Prefills the Manager field for demo employees so the first claim wires
    // itself to the right person without anyone having to remember a name.
    defaultManager: auth.defaultManagerFor(session.email),
  });
});

app.get('/api/health', (req, res) => {
  const missing = missingEnv();
  const body = {
    ok: missing.length === 0,
    missingEnv: missing,
    history: storageReady(),
    storage: STORAGE_MODE,
    receiptArchive: Boolean(BLOB_TOKEN),
    signIn: true,
    demoAccounts: auth.config.accounts,
    sessionSecretIsDefault: auth.config.secretIsDefault,
  };

  // Diagnostics, behind the manager code: which variables were matched, and what
  // storage-ish names exist in the environment. Names only — never any values.
  const who = auth.sessionFrom(req);
  if (who && who.roles.indexOf('admin') !== -1) {
    body.matched = {
      restUrl: restUrlVar.name,
      restToken: restTokenVar.name,
      tcpUrl: tcpUrlVar.name,
      blobToken: blobTokenVar.name,
    };
    body.storageEnvNames = Object.keys(process.env)
      .filter((k) => /REDIS|KV_|BLOB|UPSTASH/i.test(k))
      .sort();
  }

  res.json(body);
});

app.post('/api/submit', requireSignedIn, upload.single('receipt'), async (req, res) => {
  try {
    const missing = missingEnv();
    if (missing.length) {
      return res.status(500).json({ error: `Server is not configured. Missing: ${missing.join(', ')}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A receipt file is required.' });
    }

    const { amount, currency } = req.body;
    if (!amount || !currency) {
      return res.status(400).json({ error: 'An amount and a currency are required.' });
    }

    // For a signed-in account, identity comes from the session and the form
    // cannot override it. A guest has no identity to take, so they type it —
    // and the record keeps a flag saying so, since it is unverified.
    let fullName, email;
    if (req.session.guest) {
      fullName = String(req.body.fullName || '').trim();
      email = String(req.body.email || '').trim().toLowerCase();
      if (!fullName) {
        return res.status(400).json({ error: 'Enter your name.' });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
      }
    } else {
      fullName = req.session.name;
      email = req.session.email;
    }

    const employeeRecord = buildEmployeeRecord(Object.assign({}, req.body, { fullName, email }));
    const submittedTotal = `${String(amount).trim()} ${String(currency).trim().toUpperCase()}`;

    const fileUrl = await uploadReceiptToOpus(req.file);

    const { body: created } = await opusFetch('/case', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: OPUS_WORKFLOW_ID,
        title: `Expense claim — ${fullName} — ${submittedTotal}`,
        description: `Submitted via the expense portal on ${new Date().toISOString().slice(0, 10)}.`,
      }),
    });

    const caseId = created.caseId;
    if (!caseId) throw new Error('Opus did not return a caseId.');

    await opusFetch(`/case/${caseId}/execute`, {
      method: 'POST',
      body: JSON.stringify({
        payload: {
          [INPUT_EMPLOYEE_RECORD]: { value: employeeRecord, type: 'str', displayName: 'Employee Record' },
          [INPUT_RECEIPT]: { value: fileUrl, type: 'file', displayName: 'Receipt' },
          [INPUT_SUBMITTED_TOTAL]: { value: submittedTotal, type: 'str', displayName: 'Submitted Total Expense Amount' },
        },
      }),
    });

    // Archive + record for the manager view. Never block the employee on these.
    const blobUrl = await archiveReceipt(req.file, caseId);

    await saveRecord({
      caseId,
      submittedAt: new Date().toISOString(),
      state: 'running',
      opusStatus: 'PENDING',
      employee: {
        fullName: (fullName || '').trim(),
        email: (email || '').trim(),
        jobTitle: (req.body.jobTitle || '').trim(),
        managerName: (req.body.managerName || '').trim(),
        phoneNumber: (req.body.phoneNumber || '').trim(),
        unverified: Boolean(req.session.guest),
      },
      amount: String(amount).trim(),
      currency: String(currency).trim().toUpperCase(),
      submittedTotal,
      receipt: {
        filename: req.file.originalname,
        size: req.file.size,
        contentType: req.file.mimetype,
        blobUrl: blobUrl || null,
      },
      report: null,
      completedAt: null,
    });

    res.status(202).json({ caseId, submittedTotal });
  } catch (err) {
    console.error('[submit]', err);
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That receipt is over the 10MB limit.'
      : err.message || 'Something went wrong submitting your claim.';
    res.status(status).json({ error: message });
  }
});

app.get('/api/status/:caseId', requireSignedIn, async (req, res) => {
  try {
    const { caseId } = req.params;
    const outcome = await refreshCase(caseId);
    await applyOutcome(caseId, outcome);

    if (outcome.state === 'done') {
      // The employee's own copy of the receipt is the one in their browser.
      return res.json({
        state: 'done',
        status: outcome.status,
        report: outcome.report,
        rawReport: outcome.rawReport,
        employeeRecord: outcome.employeeRecord,
      });
    }
    res.json(outcome);
  } catch (err) {
    console.error('[status]', err);
    res.status(err.status || 500).json({
      state: 'failed',
      error: err.message || 'Could not read the validation status.',
    });
  }
});

/* ------------------------------------------------------------------ *
 * Manager routes
 * ------------------------------------------------------------------ */

/**
 * A submission's outcome is normally written by the employee's own browser as it
 * polls. If they close the tab mid-run the record would sit at "running" forever,
 * so anything still running is re-checked against Opus when someone looks.
 */
async function refreshStale(records) {
  const stale = records.filter((r) => r.state === 'running');
  if (!stale.length) return records;

  const refreshed = await Promise.all(stale.map(async (r) => {
    try {
      const outcome = await refreshCase(r.caseId);
      await applyOutcome(r.caseId, outcome);
      return await loadRecord(r.caseId);
    } catch {
      return r;
    }
  }));

  const byId = new Map(refreshed.filter(Boolean).map((r) => [r.caseId, r]));
  return records.map((r) => byId.get(r.caseId) || r);
}

function toRow(record) {
  const report = record.report || {};
  const emp = record.employee || {};
  return {
    caseId: record.caseId,
    submittedAt: record.submittedAt,
    completedAt: record.completedAt,
    employeeName: emp.fullName || '',
    employeeEmail: emp.email || '',
    jobTitle: emp.jobTitle || '',
    managerName: emp.managerName || '',
    submittedTotal: record.submittedTotal,
    extractedTotal: report.extracted_total
      ? `${report.extracted_total.amount || ''} ${report.extracted_total.currency || ''}`.trim()
      : '',
    receiptType: report.receipt_type || '',
    receiptDate: report.date || '',
    amountsMatch: typeof report.amounts_match === 'boolean' ? report.amounts_match : null,
    approved: typeof report.approved === 'boolean' ? report.approved : null,
    summary: report.summary || '',
    state: record.state,
    opusStatus: record.opusStatus,
    error: record.error || '',
    receiptName: record.receipt ? record.receipt.filename : '',
    hasReceipt: Boolean(record.receipt && record.receipt.blobUrl),
    unverified: Boolean(emp.unverified),
  };
}

/* ------------------------------------------------------------------ *
 * Claims — one endpoint, three scopes
 *
 *   mine   the claims you filed        anyone signed in
 *   team   the claims naming you       anyone somebody named as their manager
 *   all    every claim                 ADMIN_EMAILS only
 * ------------------------------------------------------------------ */

async function resolveScope(req) {
  const wanted = String(req.query.scope || 'mine').toLowerCase();
  const session = req.session;

  // A guest typed their email rather than proving it, so there is no "mine"
  // that can safely be shown to them.
  if (session.guest) {
    return { error: 'Sign in to see claim history.' };
  }

  if (wanted === 'all') {
    if (!isAdmin(session)) return { error: 'That view is for administrators.' };
    return { scope: 'all', key: INDEX_KEY };
  }

  if (wanted === 'team') {
    if (!(await isManager(session.name))) {
      return { error: 'No claims name you as manager yet.' };
    }
    return { scope: 'team', key: BY_MANAGER(normaliseName(session.name)) };
  }

  return { scope: 'mine', key: BY_EMPLOYEE(String(session.email).toLowerCase()) };
}

/**
 * The date range to show, from the query string.
 *
 * fromMs/toMs are exact instants and come from the browser, which computes them
 * in the viewer's own timezone — so "this month" means their month, not UTC's.
 * from/to accept plain YYYY-MM-DD for anyone calling the URL by hand.
 */
function dateWindow(req) {
  const ms = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  let from = ms(req.query.fromMs);
  let to = ms(req.query.toMs);

  if (from === null && req.query.from) {
    const d = new Date(String(req.query.from) + 'T00:00:00Z');
    if (!isNaN(d)) from = d.getTime();
  }
  if (to === null && req.query.to) {
    const d = new Date(String(req.query.to) + 'T23:59:59.999Z');
    if (!isNaN(d)) to = d.getTime();
  }

  return { from, to };
}

function withinWindow(record, win) {
  if (win.from === null && win.to === null) return true;
  const t = new Date(record.submittedAt).getTime();
  if (isNaN(t)) return true;           // never hide a record over a bad date
  if (win.from !== null && t < win.from) return false;
  if (win.to !== null && t > win.to) return false;
  return true;
}

/** Your own claim, one naming you as manager, or anything at all if admin. */
function maySee(session, record) {
  return isAdmin(session) || ownsClaim(session, record) || managesClaim(session, record);
}

app.get('/api/claims', requireSignedIn, async (req, res) => {
  if (!storageReady()) {
    return res.status(503).json({
      error: 'History storage is not configured, so there is nothing to show yet.',
    });
  }
  try {
    const resolved = await resolveScope(req);
    if (resolved.error) return res.status(403).json({ error: resolved.error });

    const win = dateWindow(req);
    let records = await listRecords(300, resolved.key);
    records = records.filter((r) => withinWindow(r, win));
    records = await refreshStale(records);

    res.json({
      scope: resolved.scope,
      viewer: { name: req.session.name, email: req.session.email },
      submissions: records.map(toRow),
    });
  } catch (err) {
    console.error('[claims]', err);
    res.status(500).json({ error: err.message || 'Could not load claims.' });
  }
});

app.get('/api/claims/:caseId', requireSignedIn, async (req, res) => {
  try {
    let record = await loadRecord(req.params.caseId);
    // A claim you cannot see is reported as missing rather than forbidden, so
    // the response never confirms that someone else's claim exists.
    if (!record || !maySee(req.session, record)) {
      return res.status(404).json({ error: 'No claim with that id.' });
    }

    if (record.state === 'running') {
      try {
        const outcome = await refreshCase(record.caseId);
        await applyOutcome(record.caseId, outcome);
        record = await loadRecord(record.caseId);
      } catch { /* keep what we have */ }
    }

    res.json({
      submission: toRow(record),
      report: record.report || null,
      employee: record.employee || null,
      receipt: record.receipt
        ? { filename: record.receipt.filename, size: record.receipt.size, available: Boolean(record.receipt.blobUrl) }
        : null,
    });
  } catch (err) {
    console.error('[claim]', err);
    res.status(500).json({ error: err.message || 'Could not load that claim.' });
  }
});

/** Streams the archived receipt. The blob URL itself never reaches the browser. */
app.get('/api/claims/:caseId/receipt', requireSignedIn, async (req, res) => {
  try {
    const record = await loadRecord(req.params.caseId);
    if (!record || !maySee(req.session, record) || !record.receipt || !record.receipt.blobUrl) {
      return res.status(404).json({ error: 'No stored receipt for that claim.' });
    }
    const upstream = await fetch(record.receipt.blobUrl);
    if (!upstream.ok) return res.status(502).json({ error: 'The stored receipt could not be read.' });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', record.receipt.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      'inline; filename="' + String(record.receipt.filename).replace(/"/g, '') + '"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (err) {
    console.error('[receipt]', err);
    res.status(500).json({ error: 'Could not fetch that receipt.' });
  }
});

app.get('/api/claims.csv', requireSignedIn, async (req, res) => {
  if (!storageReady()) return res.status(503).send('History storage is not configured.');
  try {
    const resolved = await resolveScope(req);
    if (resolved.error) return res.status(403).send(resolved.error);

    const win = dateWindow(req);
    const rows = (await listRecords(1000, resolved.key))
      .filter((r) => withinWindow(r, win))
      .map(toRow);

    const columns = [
      ['Submitted at', 'submittedAt'], ['Employee', 'employeeName'], ['Email', 'employeeEmail'],
      ['Job title', 'jobTitle'], ['Manager', 'managerName'], ['Claimed', 'submittedTotal'],
      ['Read from receipt', 'extractedTotal'], ['Category', 'receiptType'],
      ['Receipt date', 'receiptDate'], ['Amounts match', 'amountsMatch'],
      ['Approved', 'approved'], ['State', 'state'], ['Receipt file', 'receiptName'],
      ['Summary', 'summary'], ['Case id', 'caseId'],
    ];

    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const csv = [columns.map(([label]) => esc(label)).join(',')]
      .concat(rows.map((r) => columns.map(([, key]) => esc(r[key])).join(',')))
      .join('\n');

    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const period = (win.from !== null || win.to !== null)
      ? (win.from !== null ? day(win.from) : 'start') + '_to_' +
        (win.to !== null ? day(win.to) : 'now')
      : 'all-time';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      'attachment; filename="claims-' + resolved.scope + '-' + period + '.csv"');
    res.send('﻿' + csv); // BOM so Excel reads UTF-8 correctly
  } catch (err) {
    console.error('[csv]', err);
    res.status(500).send('Could not build the export.');
  }
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That receipt is over the 10MB limit.' });
  }
  if (err) {
    console.error('[unhandled]', err);
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
  next();
});

/* ------------------------------------------------------------------ *
 * Export for Vercel; listen only when run directly.
 * ------------------------------------------------------------------ */

if (require.main === module) {
  app.listen(PORT, () => {
    const missing = missingEnv();
    console.log(`Expense Receipt Validation running on http://localhost:${PORT}`);
    console.log(`  history: ${storageReady() ? 'on' : 'off'} · receipts: ${BLOB_TOKEN ? 'on' : 'off'} · demo accounts: ${auth.config.accounts}`);
    if (missing.length) console.warn(`  warning — missing env vars: ${missing.join(', ')}`);
  });
}

module.exports = app;
