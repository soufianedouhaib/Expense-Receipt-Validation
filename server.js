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

const MANAGER_ACCESS_CODE = process.env.MANAGER_ACCESS_CODE;

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
 * Storage — Upstash Redis for records, Vercel Blob for receipt copies.
 * ------------------------------------------------------------------ */

const INDEX_KEY = 'expense:index';           // sorted set, score = submittedAt ms
const RECORD_KEY = (id) => `expense:case:${id}`;
const RECORD_TTL_SECONDS = 60 * 60 * 24 * 365; // keep a year of history

// Vercel's Upstash integration writes KV_REST_API_*; a direct Upstash project
// writes UPSTASH_REDIS_REST_*. Accept either so setup can't trip on the name.
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  } catch (e) {
    console.warn('[storage] @upstash/redis not installed — history disabled.', e.message);
  }
}

const storageReady = () => Boolean(redis);

async function saveRecord(record) {
  if (!redis) return;
  try {
    await redis.set(RECORD_KEY(record.caseId), record, { ex: RECORD_TTL_SECONDS });
    await redis.zadd(INDEX_KEY, {
      score: new Date(record.submittedAt).getTime(),
      member: record.caseId,
    });
  } catch (err) {
    // History is secondary — never fail an employee's submission over it.
    console.error('[storage] save failed', err);
  }
}

// A Redis set overwrites, so updating is the same operation as saving.
const updateRecord = saveRecord;

async function loadRecord(caseId) {
  if (!redis) return null;
  try {
    return await redis.get(RECORD_KEY(caseId));
  } catch (err) {
    console.error('[storage] load failed', err);
    return null;
  }
}

async function listRecords(limit = 300) {
  if (!redis) return [];
  try {
    const ids = await redis.zrange(INDEX_KEY, 0, limit - 1, { rev: true });
    if (!ids || !ids.length) return [];
    const records = await Promise.all(ids.map((id) => loadRecord(id)));
    return records.filter(Boolean);
  } catch (err) {
    console.error('[storage] list failed', err);
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
 * Manager access
 * ------------------------------------------------------------------ */

function codeMatches(supplied) {
  if (!MANAGER_ACCESS_CODE) return false;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(MANAGER_ACCESS_CODE);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireManager(req, res, next) {
  if (!MANAGER_ACCESS_CODE) {
    return res.status(503).json({
      error: 'Manager access is not configured. Set MANAGER_ACCESS_CODE in the environment.',
    });
  }
  const supplied = req.get('x-access-code') || req.query.code;
  if (!codeMatches(supplied)) {
    return res.status(401).json({ error: 'That access code is not right.' });
  }
  next();
}

/* ------------------------------------------------------------------ *
 * Employee routes
 * ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  const missing = missingEnv();
  res.json({
    ok: missing.length === 0,
    missingEnv: missing,
    history: storageReady(),
    storage: storageReady() ? 'redis' : null,
    receiptArchive: Boolean(BLOB_TOKEN),
    managerAccess: Boolean(MANAGER_ACCESS_CODE),
  });
});

app.post('/api/submit', upload.single('receipt'), async (req, res) => {
  try {
    const missing = missingEnv();
    if (missing.length) {
      return res.status(500).json({ error: `Server is not configured. Missing: ${missing.join(', ')}` });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A receipt file is required.' });
    }

    const { fullName, email, amount, currency } = req.body;
    if (!fullName || !email || !amount || !currency) {
      return res.status(400).json({ error: 'Name, work email, amount and currency are all required.' });
    }

    const employeeRecord = buildEmployeeRecord(req.body);
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

app.get('/api/status/:caseId', async (req, res) => {
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

app.post('/api/manager/verify', (req, res) => {
  if (!MANAGER_ACCESS_CODE) {
    return res.status(503).json({ error: 'Manager access is not configured on this deployment.' });
  }
  if (!codeMatches(req.body && req.body.code)) {
    return res.status(401).json({ error: 'That access code is not right.' });
  }
  res.json({ ok: true });
});

/**
 * A submission's outcome is normally written by the employee's own browser as it
 * polls. If they close the tab mid-run the record would sit at "running" forever,
 * so anything still running is re-checked against Opus when the manager looks.
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
  return {
    caseId: record.caseId,
    submittedAt: record.submittedAt,
    completedAt: record.completedAt,
    employeeName: record.employee ? record.employee.fullName : '',
    employeeEmail: record.employee ? record.employee.email : '',
    jobTitle: record.employee ? record.employee.jobTitle : '',
    managerName: record.employee ? record.employee.managerName : '',
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
  };
}

app.get('/api/manager/submissions', requireManager, async (req, res) => {
  if (!storageReady()) {
    return res.status(503).json({
      error: 'History storage is not configured. Connect Upstash Redis in Vercel, then redeploy.',
    });
  }
  try {
    let records = await listRecords();
    records = await refreshStale(records);
    res.json({ submissions: records.map(toRow) });
  } catch (err) {
    console.error('[manager/list]', err);
    res.status(500).json({ error: err.message || 'Could not load submissions.' });
  }
});

app.get('/api/manager/submissions/:caseId', requireManager, async (req, res) => {
  try {
    let record = await loadRecord(req.params.caseId);
    if (!record) return res.status(404).json({ error: 'No submission with that id.' });

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
    console.error('[manager/detail]', err);
    res.status(500).json({ error: err.message || 'Could not load that submission.' });
  }
});

/** Streams the archived receipt. The blob URL itself never reaches the browser. */
app.get('/api/manager/receipt/:caseId', requireManager, async (req, res) => {
  try {
    const record = await loadRecord(req.params.caseId);
    if (!record || !record.receipt || !record.receipt.blobUrl) {
      return res.status(404).json({ error: 'No stored receipt for that submission.' });
    }
    const upstream = await fetch(record.receipt.blobUrl);
    if (!upstream.ok) return res.status(502).json({ error: 'The stored receipt could not be read.' });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', record.receipt.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${record.receipt.filename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  } catch (err) {
    console.error('[manager/receipt]', err);
    res.status(500).json({ error: 'Could not fetch that receipt.' });
  }
});

app.get('/api/manager/export.csv', requireManager, async (req, res) => {
  if (!storageReady()) return res.status(503).send('History storage is not configured.');
  try {
    const records = await listRecords();
    const rows = records.map(toRow);

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
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [columns.map(([label]) => esc(label)).join(',')]
      .concat(rows.map((r) => columns.map(([, key]) => esc(r[key])).join(',')))
      .join('\n');

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="expense-submissions-${stamp}.csv"`);
    res.send('﻿' + csv); // BOM so Excel reads UTF-8 correctly
  } catch (err) {
    console.error('[manager/export]', err);
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
    console.log(`  history: ${storageReady() ? 'on' : 'off'} · receipt archive: ${BLOB_TOKEN ? 'on' : 'off'} · manager code: ${MANAGER_ACCESS_CODE ? 'set' : 'not set'}`);
    if (missing.length) console.warn(`  warning — missing env vars: ${missing.join(', ')}`);
  });
}

module.exports = app;
