/**
 * Expense Receipt Validation — backend
 *
 * Holds the Opus service key and is the only part of the app allowed to talk to
 * Opus. The browser only ever calls the routes in this file.
 *
 * Opus flow used here (External Integration API v1):
 *   1. POST /file/upload/presigned  -> { presignedUrl, fileUrl }
 *   2. PUT  <presignedUrl>          -> raw receipt bytes (goes to S3, no service key)
 *   3. POST /case                   -> { caseId }
 *   4. POST /case/{caseId}/execute  -> payload keyed by workflow_input_* ids
 *   5. GET  /case/{caseId}/status   -> { status }
 *   6. GET  /case/{caseId}/results  -> { results: { workflow_output_*: { value } } }
 */

// Local development reads .env; on Vercel the values come from project settings.
try { require('dotenv').config(); } catch (e) { /* dotenv not installed — fine in production */ }

const express = require('express');
const multer = require('multer');
const path = require('path');

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
  return Object.entries(REQUIRED_ENV)
    .filter(([, v]) => !v)
    .map(([k]) => k);
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

/** Upload the receipt to Opus storage and return the fileUrl to pass as the input value. */
async function uploadReceipt(file) {
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

  if (!put.ok) {
    throw new Error(`Receipt upload failed (${put.status}).`);
  }

  return presign.fileUrl;
}

/** Build the Employee Record JSON exactly as the workflow expects it. */
function buildEmployeeRecord(form) {
  const record = {
    full_name: (form.fullName || '').trim().toUpperCase(),
    phone_number: (form.phoneNumber || '').trim(),
    date_of_birth: (form.dateOfBirth || '').trim(),
    gender: (form.gender || '').trim().toUpperCase(),
    job_title: (form.jobTitle || '').trim().toUpperCase(),
    email: (form.email || '').trim(),
    manager: { name: (form.managerName || '').trim().toUpperCase() },
  };
  return JSON.stringify(record);
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

app.get('/api/health', (req, res) => {
  const missing = missingEnv();
  res.json({ ok: missing.length === 0, missingEnv: missing });
});

/**
 * Submit a claim. Returns a caseId the frontend then polls.
 * multipart/form-data: receipt (file) + the employee/amount fields.
 */
app.post('/api/submit', upload.single('receipt'), async (req, res) => {
  try {
    const missing = missingEnv();
    if (missing.length) {
      return res.status(500).json({
        error: `Server is not configured. Missing: ${missing.join(', ')}`,
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'A receipt file is required.' });
    }

    const { fullName, email, amount, currency } = req.body;
    if (!fullName || !email || !amount || !currency) {
      return res.status(400).json({
        error: 'Name, work email, amount and currency are all required.',
      });
    }

    const employeeRecord = buildEmployeeRecord(req.body);
    const submittedTotal = `${String(amount).trim()} ${String(currency).trim().toUpperCase()}`;

    const fileUrl = await uploadReceipt(req.file);

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
          [INPUT_EMPLOYEE_RECORD]: {
            value: employeeRecord,
            type: 'str',
            displayName: 'Employee Record',
          },
          [INPUT_RECEIPT]: {
            value: fileUrl,
            type: 'file',
            displayName: 'Receipt',
          },
          [INPUT_SUBMITTED_TOTAL]: {
            value: submittedTotal,
            type: 'str',
            displayName: 'Submitted Total Expense Amount',
          },
        },
      }),
    });

    res.status(202).json({ caseId, submittedTotal });
  } catch (err) {
    console.error('[submit]', err);
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500;
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That receipt is over the 10MB limit.'
        : err.message || 'Something went wrong submitting your claim.';
    res.status(status).json({ error: message });
  }
});

/**
 * Poll a case. While running returns { state: 'running' }; when finished,
 * returns the parsed validation report.
 */
app.get('/api/status/:caseId', async (req, res) => {
  try {
    const { caseId } = req.params;

    const { body: statusBody } = await opusFetch(`/case/${caseId}/status`);
    const status = statusBody.status || 'UNKNOWN';

    if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(status)) {
      return res.json({
        state: 'failed',
        status,
        error: `The validation run ended with status ${status}.`,
      });
    }

    if (status !== 'COMPLETED') {
      return res.json({ state: 'running', status });
    }

    const { status: httpStatus, body: resultsBody } = await opusFetch(`/case/${caseId}/results`);
    if (httpStatus === 202) {
      return res.json({ state: 'running', status });
    }

    const results = resultsBody.results || resultsBody || {};
    const pick = (id) => (id && results[id] ? results[id].value : undefined);

    const rawReport = pick(OUTPUT_SUMMARY_REPORT);
    let report = null;
    if (rawReport) {
      if (typeof rawReport === 'string') {
        try {
          // Be forgiving if the agent ever wraps its JSON in a code fence.
          const cleaned = rawReport.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
          report = JSON.parse(cleaned);
        } catch {
          report = null;
        }
      } else if (typeof rawReport === 'object') {
        report = rawReport;
      }
    }

    res.json({
      state: 'done',
      status,
      report,
      rawReport: report ? undefined : rawReport,
      receiptUrl: pick(OUTPUT_RECEIPT),
      employeeRecord: pick(OUTPUT_EMPLOYEE_RECORD),
    });
  } catch (err) {
    console.error('[status]', err);
    res.status(err.status || 500).json({
      state: 'failed',
      error: err.message || 'Could not read the validation status.',
    });
  }
});

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
    if (missing.length) {
      console.warn(`Warning — missing env vars: ${missing.join(', ')}`);
    }
  });
}

module.exports = app;
