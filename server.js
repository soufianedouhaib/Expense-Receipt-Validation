'use strict';

const path = require('path');
const express = require('express');
const opus = require('./lib/opus');
const store = require('./lib/store');
const auth = require('./lib/auth');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(auth.attach);
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: '5m'
  })
);

const LIST_KEY = 'atv:cases';
const OWNER_KEY = function (email) {
  return 'atv:cases:' + String(email).toLowerCase();
};
const RECORD_KEY = function (id) {
  return 'atv:case:' + id;
};
const HISTORY_CAP = 300;
const BOOTED_AT = new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Projection. Every screen agrees because they all read this one map. *
 * ------------------------------------------------------------------ */

function parseMoney(printed) {
  if (printed === null || printed === undefined) return { amount: null, currency: null };
  if (typeof printed === 'number') return { amount: printed, currency: null };
  const text = String(printed).trim();
  if (!text) return { amount: null, currency: null };
  const symbol = (text.match(/^[^\d\-.,\s]+|[A-Z]{3}$/) || [null])[0];
  const cleaned = text.replace(/[^0-9.\-]/g, '');
  const amount = cleaned === '' || isNaN(Number(cleaned)) ? null : Number(cleaned);
  return { amount: amount, currency: symbol ? String(symbol).trim() : null };
}

/**
 * The stored record for one case. Both the printed money string and its parts
 * are kept: pulling "$95,000.00" apart in the browser is guesswork the moment a
 * currency prints differently.
 */
function toRow(rec) {
  if (!rec) return null;
  const result = rec.result || {};
  const form = (result.extracted && result.extracted.form) || {};
  const audit = result.audit || {};
  const money = parseMoney(form.value);
  const review = rec.review || null;
  return {
    caseId: rec.caseId,
    title: rec.title || null,
    fileName: rec.fileName || null,
    status: rec.status || 'PENDING',
    verdict: result.status || null,
    isIgo: typeof result.is_igo === 'boolean' ? result.is_igo : null,
    decisionSummary: result.decision_summary || null,
    clientName: form.client_name || null,
    contraFirm: form.contra_firm || null,
    accountType: form.account_type || null,
    submittedValue: form.value === undefined ? null : form.value,
    valueAmount: money.amount,
    valueCurrency: money.currency,
    totalIssues: typeof audit.total_issues === 'number' ? audit.total_issues : null,
    lowConfidence: typeof audit.low_confidence === 'number' ? audit.low_confidence : null,
    createdAt: rec.createdAt || null,
    completedAt: rec.completedAt || null,
    failure: rec.failure || null,
    submittedBy: (rec.owner && rec.owner.email) || null,
    submittedByName: (rec.owner && rec.owner.name) || null,
    // A packet is readable only when this server kept its own copy. Opus takes
    // uploads and has no endpoint that gives one back, so a stored fileUrl on
    // its own proves nothing about what a reviewer can open.
    hasDocument: Boolean(rec.fileUrl) || Boolean(rec.packet && rec.packet.parts),
    packetKept: Boolean(rec.packet && rec.packet.parts),
    reviewState: review ? review.decision : 'pending',
    reviewNote: review ? review.note || null : null,
    reviewedBy: review ? review.by || null : null,
    reviewedByName: review ? review.byName || review.by || null : null,
    reviewedAt: review ? review.at || null : null
  };
}

function safeParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/^﻿/, '');
  if (!text) return null;
  const fenced = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  if (start > 0) text = text.slice(start);
  const end = text.lastIndexOf('}');
  if (end !== -1 && end < text.length - 1) text = text.slice(0, end + 1);
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function shapeResults(results) {
  const out = { result: null, explanation: null, workflowError: '' };
  if (!results) return out;
  const pick = function (key) {
    const entry = results[key];
    return entry && Object.prototype.hasOwnProperty.call(entry, 'value') ? entry.value : null;
  };
  out.result = safeParseJson(pick(opus.OUTPUT_RESULT));
  out.explanation = safeParseJson(pick(opus.OUTPUT_EXPLANATION));
  const err = pick(opus.OUTPUT_ERROR);
  out.workflowError = typeof err === 'string' ? err : '';
  return out;
}

async function loadRecord(caseId) {
  try {
    return await store.getJson(RECORD_KEY(caseId));
  } catch (e) {
    return null;
  }
}

async function saveRecord(rec) {
  try {
    await store.setJson(RECORD_KEY(rec.caseId), rec);
    await store.pushId(LIST_KEY, rec.caseId, HISTORY_CAP);
    if (rec.owner && rec.owner.email) {
      await store.pushId(OWNER_KEY(rec.owner.email), rec.caseId, HISTORY_CAP);
    }
  } catch (e) {
    // History is a convenience. A storage outage must never fail a validation.
  }
}

/** Advisors see their own work. Reviewers and the admin see all of it. */
function maySee(user, rec) {
  if (!user || !rec) return false;
  if (auth.canReview(user)) return true;
  return Boolean(rec.owner && rec.owner.email === user.email);
}

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  res.status(status).json({
    error: (err && err.message) || 'Unexpected error',
    retryAfter: err && err.retryAfter ? err.retryAfter : undefined
  });
}

/* The support contact is one object so every screen writes the same subject:
   the workflow id, always, because that is what Opus support asks for. */
function support() {
  return {
    email: process.env.SUPPORT_EMAIL || 'support@opus.com',
    workflowId: opus.WORKFLOW_ID,
    subjectPrefix: 'Opus workflow ' + opus.WORKFLOW_ID
  };
}

/* ------------------------------------------------------------------ *
 * Session                                                             *
 * ------------------------------------------------------------------ */

app.post('/api/login', function (req, res) {
  const body = req.body || {};
  const user = auth.authenticate(body.email, body.password);
  if (!user) {
    return res.status(401).json({ error: 'That email and password do not match an account.' });
  }
  /* Either door takes any account. The two pages exist for their wording, not
     as a gate: an account that lands on the other one is signed in and sent to
     the home its role actually has, which is far less annoying than being
     bounced back with an error while holding correct credentials. */
  auth.setCookie(req, res, auth.issue(user));
  res.json({
    signedIn: true,
    email: user.email,
    role: user.role,
    name: user.name,
    home: auth.canReview(user) ? '/review.html' : '/'
  });
});

app.post('/api/logout', function (req, res) {
  auth.clearCookie(req, res);
  res.json({ signedIn: false });
});

app.get('/api/me', function (req, res) {
  const user = req.user;
  res.json({
    signedIn: Boolean(user),
    email: user ? user.email : null,
    role: user ? user.role : null,
    roleLabel: user ? auth.ROLE_LABEL[user.role] || user.role : null,
    name: user ? user.name : null,
    canReview: auth.canReview(user),
    canSubmit: Boolean(user) && (user.role === 'advisor' || user.role === 'admin'),
    appName: 'Account Transfer Validation',
    historyEnabled: store.configured,
    configured: opus.missingEnv().length === 0,
    demoAccounts: auth.demoAccounts(),
    support: support()
  });
});

/* ------------------------------------------------------------------ *
 * Health                                                              *
 * ------------------------------------------------------------------ */

app.get('/api/health', async function (req, res) {
  const missing = opus.missingEnv();
  const storage = await store.ping();
  // Names only, never values: enough to tell a missing variable from a
  // misnamed one, or a stale build from a fresh one.
  const seenEnvNames = Object.keys(process.env)
    .filter(function (k) {
      return /OPUS|KV_REST|REDIS|UPSTASH|APP_USERS|SESSION_SECRET/i.test(k);
    })
    .sort();
  res.json({
    ok: missing.length === 0,
    missingEnv: missing,
    seenEnvNames: seenEnvNames,
    serviceKeyLength: opus.storedKeyLength(),
    serviceKeyRepaired: opus.keyWasRepaired(),
    workflowId: opus.WORKFLOW_ID,
    baseUrl: opus.BASE,
    accounts: {
      count: auth.accountCount,
      usingDefaults: auth.usingDefaultAccounts,
      sessionSecretSet: Boolean(process.env.SESSION_SECRET)
    },
    build: {
      target: process.env.VERCEL_ENV || 'local',
      deployment: process.env.VERCEL_URL || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      startedAt: BOOTED_AT
    },
    history: {
      configured: store.configured,
      mode: store.mode,
      reachable: storage.ok,
      reason: storage.reason || null
    }
  });
});

/* ------------------------------------------------------------------ *
 * Submitting                                                          *
 * ------------------------------------------------------------------ */

function requireSubmitter(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.user.role === 'reviewer') {
    return res.status(403).json({ error: 'Manager accounts do not submit packets.' });
  }
  next();
}

/** Step 1. A presigned slot. The browser uploads straight to storage. */
app.post('/api/upload-url', requireSubmitter, async function (req, res) {
  const missing = opus.missingEnv();
  if (missing.length) {
    return res.status(503).json({ error: 'Server is not configured: ' + missing.join(', ') });
  }
  const name = String((req.body && req.body.fileName) || '').trim();
  if (!name) return res.status(400).json({ error: 'fileName is required.' });
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  const allowed = ['.pdf', '.docx', '.csv', '.xls', '.xlsx', '.txt', '.json', '.html', '.xml', '.jpeg', '.jpg', '.png'];
  if (allowed.indexOf(ext) === -1) {
    return res.status(400).json({ error: 'Unsupported file type: ' + (ext || 'no extension') });
  }
  try {
    const slot = await opus.uploadUrl(ext, name);
    res.json(slot);
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Fallback upload. Used only when the browser cannot PUT to storage directly,
 * which happens when the storage bucket does not allow the page's origin.
 * Serverless request bodies are capped well below the 10 MB Opus limit, so this
 * path refuses anything large and says why.
 */
app.put(
  '/api/upload-proxy',
  requireSubmitter,
  express.raw({ type: '*/*', limit: '4mb' }),
  async function (req, res) {
    const target = String(req.query.to || '');
    const localOnly = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(target);
    if (!target || !(/^https:\/\//.test(target) || localOnly)) {
      return res.status(400).json({ error: 'A presigned https target is required.' });
    }
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Empty upload.' });
    }
    try {
      await opus.putFile(String(target), req.body, req.get('x-content-type') || 'application/octet-stream');
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err);
    }
  }
);

/** Step 2. Create the case and start it. */
app.post('/api/submit', requireSubmitter, async function (req, res) {
  const missing = opus.missingEnv();
  if (missing.length) {
    return res.status(503).json({ error: 'Server is not configured: ' + missing.join(', ') });
  }
  const body = req.body || {};
  const fileUrl = String(body.fileUrl || '').trim();
  const fileName = String(body.fileName || '').trim() || 'submitted-documents';
  const title = String(body.title || '').trim() || fileName;
  if (!fileUrl) return res.status(400).json({ error: 'fileUrl is required.' });

  try {
    const caseId = await opus.initiateCase(
      title,
      'Submitted by ' + req.user.email + ' through the Account Transfer Validation console.'
    );
    await opus.executeCase(caseId, fileUrl);
    const rec = {
      caseId: caseId,
      title: title,
      fileName: fileName,
      fileUrl: fileUrl,
      owner: { email: req.user.email, name: req.user.name },
      status: 'IN_PROGRESS',
      createdAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      explanation: null,
      workflowError: '',
      failure: null,
      review: null
    };
    await saveRecord(rec);
    res.json({ caseId: caseId, row: toRow(rec) });
  } catch (err) {
    sendError(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Reading one case                                                    *
 * ------------------------------------------------------------------ */

function casePayload(rec, user) {
  return {
    status: rec.status,
    terminal: Boolean(rec.result) || Boolean(rec.failure),
    row: toRow(rec),
    result: rec.result || null,
    explanation: rec.explanation || null,
    workflowError: rec.workflowError || '',
    failure: rec.failure || null,
    review: rec.review || null,
    canReview: auth.canReview(user),
    isOwner: Boolean(rec.owner && user && rec.owner.email === user.email),
    stored: store.configured
  };
}

/** Step 3. The browser polls this, never Opus. */
app.get('/api/status/:caseId', auth.requireUser, async function (req, res) {
  const caseId = String(req.params.caseId);
  const missing = opus.missingEnv();
  if (missing.length) {
    return res.status(503).json({ error: 'Server is not configured: ' + missing.join(', ') });
  }
  try {
    let rec = await loadRecord(caseId);
    // A stored case belonging to somebody else is a 404, never a 403: a 403
    // would confirm that the case exists.
    if (rec && !maySee(req.user, rec)) {
      return res.status(404).json({ error: 'No such case.' });
    }
    const status = await opus.status(caseId);
    if (!rec) {
      rec = {
        caseId: caseId,
        title: null,
        fileName: null,
        owner: { email: req.user.email, name: req.user.name },
        createdAt: null,
        completedAt: null,
        result: null,
        explanation: null,
        workflowError: '',
        failure: null,
        review: null
      };
    }
    rec.status = status;

    if (opus.isTerminal(status)) {
      if (status === 'COMPLETED') {
        const results = await opus.results(caseId);
        if (results) {
          const shaped = shapeResults(results);
          rec.result = shaped.result;
          rec.explanation = shaped.explanation;
          rec.workflowError = shaped.workflowError;
        }
      } else {
        rec.failure = 'The run ended with status ' + status + '.';
      }
      rec.completedAt = rec.completedAt || new Date().toISOString();
      await saveRecord(rec);
    }

    res.json(casePayload(rec, req.user));
  } catch (err) {
    sendError(res, err);
  }
});

/** A stored case, straight from storage where possible. */
app.get('/api/case/:caseId', auth.requireUser, async function (req, res) {
  const caseId = String(req.params.caseId);
  try {
    const rec = await loadRecord(caseId);
    if (!rec || !maySee(req.user, rec)) {
      return res.status(404).json({ error: 'No such case.' });
    }
    res.json(casePayload(rec, req.user));
  } catch (err) {
    sendError(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * The submitted packet                                                *
 * ------------------------------------------------------------------ *
 *
 * Opus has endpoints for uploading a file and none at all for reading one
 * back. Its fileUrl is an identifier to quote in an execute call, not a URL
 * that answers a GET: files.opus.com serves /upload with a short lived token
 * and nothing else, so the reviewer's copy of the packet has to come from
 * here.
 *
 * So the browser sends the same bytes a second time, to this server, right
 * after the case starts. They are kept in the history store in base64 chunks,
 * because a REST store caps a single request well below a 10 MB packet, and
 * because a serverless request body is capped too. One manifest on the record
 * says how many chunks there are.
 */

const PACKET_PART_BYTES = 512 * 1024; // raw bytes per chunk, ~683 KB as base64
const PACKET_MAX_PARTS = 20; // 10 MB, which is the Opus limit as well
const PACKET_TTL_SECONDS = 90 * 24 * 3600;

function packetKey(caseId, part) {
  return 'atv:packet:' + caseId + ':' + part;
}

/** Step 4. The reviewer's copy of the packet, chunk by chunk. */
app.put(
  '/api/case/:caseId/packet',
  requireSubmitter,
  express.raw({ type: '*/*', limit: '1mb' }),
  async function (req, res) {
    const caseId = String(req.params.caseId);
    const part = Number(req.query.part);
    const parts = Number(req.query.parts);
    if (!store.configured) {
      return res.status(503).json({ error: 'History storage is not switched on.' });
    }
    if (!(parts >= 1 && parts <= PACKET_MAX_PARTS) || !(part >= 0 && part < parts)) {
      return res.status(400).json({ error: 'That is not a valid chunk.' });
    }
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty chunk.' });
    try {
      const rec = await loadRecord(caseId);
      // Only the person who submitted it may attach the packet, and only while
      // no decision has been recorded against it.
      if (!rec || !rec.owner || rec.owner.email !== req.user.email) {
        return res.status(404).json({ error: 'No such case.' });
      }
      if (rec.review) return res.status(409).json({ error: 'This case has already been decided.' });

      await store.setText(packetKey(caseId, part), req.body.toString('base64'), PACKET_TTL_SECONDS);

      if (part === parts - 1) {
        rec.packet = {
          parts: parts,
          type: String(req.get('x-file-type') || 'application/octet-stream').slice(0, 100),
          bytes: Number(req.query.bytes) || null,
          storedAt: new Date().toISOString()
        };
        await saveRecord(rec);
      }
      res.json({ ok: true, part: part, parts: parts });
    } catch (err) {
      sendError(res, err);
    }
  }
);

/**
 * The submitted packet, read back for whoever may see the case, so a reviewer
 * never needs an Opus sign in of their own. The kept copy comes first; the
 * stored fileUrl is only tried as a fallback, for records written before this
 * server kept copies and for environments where that URL is fetchable.
 */
app.get('/api/case/:caseId/document', auth.requireUser, async function (req, res) {
  const caseId = String(req.params.caseId);
  try {
    const rec = await loadRecord(caseId);
    if (!rec || !maySee(req.user, rec)) {
      return res.status(404).json({ error: 'No such case.' });
    }

    if (rec.packet && rec.packet.parts) {
      const chunks = [];
      for (let i = 0; i < rec.packet.parts; i++) {
        const text = await store.getText(packetKey(caseId, i));
        if (!text) {
          return res.status(410).json({
            error: 'The kept copy of this packet has expired.',
            expired: true
          });
        }
        chunks.push(Buffer.from(text, 'base64'));
      }
      const body = Buffer.concat(chunks);
      res.setHeader('Content-Type', rec.packet.type || 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        'inline; filename="' + String(rec.fileName || 'packet').replace(/[^\w.\- ]/g, '_') + '"'
      );
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(body);
    }

    /* No stored copy means there is nothing to serve. Opus has upload
       endpoints and no download endpoint at all, so the fileUrl on the record
       cannot be fetched back, by this server or by anyone else. */
    res.status(404).json({
      error:
        'No packet was kept for this case. Opus has no endpoint that reads an uploaded file ' +
        'back, so only runs submitted after this console began keeping its own copy can be ' +
        'opened here.'
    });
  } catch (err) {
    sendError(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Lists                                                               *
 * ------------------------------------------------------------------ */

/* A range is inclusive of both ends, and an absent end means open ended.
   Everything is compared on the submission timestamp. */
function withinRange(row, from, to) {
  if (!row || !row.createdAt) return !from && !to;
  const when = String(row.createdAt);
  if (from && when < from) return false;
  if (to && when > to + 'T23:59:59.999Z') return false;
  return true;
}

function rangeFromQuery(query) {
  const clean = function (v) {
    const text = String(v || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
  };
  return { from: clean(query.from), to: clean(query.to) };
}

async function rowsFor(ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    const rec = await loadRecord(ids[i]);
    if (rec) rows.push(toRow(rec));
  }
  // Recording a decision rewrites the record, which would otherwise float that
  // run to the top of the index. Submission time is what "newest first" means.
  rows.sort(function (a, b) {
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return rows;
}

/** An advisor's own runs. A reviewer or admin sees everything. */
app.get('/api/history', auth.requireUser, async function (req, res) {
  if (!store.configured) {
    return res.json({ configured: false, rows: [], scope: 'none', note: 'History is not configured.' });
  }
  const limit = Math.min(Number(req.query.limit) || 50, HISTORY_CAP);
  const everything = auth.canReview(req.user) && req.query.scope !== 'mine';
  try {
    const ids = await store.listIds(everything ? LIST_KEY : OWNER_KEY(req.user.email), limit);
    const range = rangeFromQuery(req.query);
    const rows = (await rowsFor(ids)).filter(function (row) {
      return withinRange(row, range.from, range.to);
    });
    res.json({
      configured: true,
      scope: everything ? 'all' : 'mine',
      range: range,
      rows: rows
    });
  } catch (err) {
    res.json({ configured: true, rows: [], note: 'History is unavailable: ' + err.message });
  }
});

/** The reviewer queue: every finished run, newest first. */
app.get('/api/queue', auth.requireReviewer, async function (req, res) {
  if (!store.configured) {
    return res.json({
      configured: false,
      rows: [],
      note: 'The queue needs run history. Connect a storage database and redeploy.'
    });
  }
  try {
    const ids = await store.listIds(LIST_KEY, HISTORY_CAP);
    const range = rangeFromQuery(req.query);
    const rows = (await rowsFor(ids)).filter(function (row) {
      return (row.status === 'COMPLETED' || row.failure) && withinRange(row, range.from, range.to);
    });
    res.json({ configured: true, range: range, rows: rows });
  } catch (err) {
    res.json({ configured: true, rows: [], note: 'The queue is unavailable: ' + err.message });
  }
});

/** Approve, reject or send back. A note is required on anything but approval. */
app.post('/api/case/:caseId/review', auth.requireReviewer, async function (req, res) {
  const caseId = String(req.params.caseId);
  const body = req.body || {};
  const decision = String(body.decision || '').toLowerCase();
  const note = String(body.note || '').trim();

  if (['approved', 'rejected', 'returned'].indexOf(decision) === -1) {
    return res.status(400).json({ error: 'The decision must be approved, rejected or returned.' });
  }
  if (decision !== 'approved' && note.length < 3) {
    return res.status(400).json({ error: 'A note is required when rejecting or sending a packet back.' });
  }
  if (!store.configured) {
    return res.status(503).json({
      error: 'Decisions cannot be saved because run history is not configured.'
    });
  }

  try {
    const rec = await loadRecord(caseId);
    if (!rec) return res.status(404).json({ error: 'No such case.' });
    if (!rec.result && !rec.failure) {
      return res.status(409).json({ error: 'This run has not finished yet.' });
    }
    rec.review = {
      decision: decision,
      note: note || null,
      by: req.user.email,
      byName: req.user.name,
      at: new Date().toISOString()
    };
    await saveRecord(rec);
    res.json({ review: rec.review, row: toRow(rec) });
  } catch (err) {
    sendError(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Reporting and export, managers and the admin                        *
 * ------------------------------------------------------------------ */

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

const CSV_COLUMNS = [
  ['caseId', 'Case id'],
  ['createdAt', 'Submitted at'],
  ['submittedByName', 'Submitted by'],
  ['submittedBy', 'Submitted by email'],
  ['title', 'Reference'],
  ['fileName', 'File'],
  ['clientName', 'Client'],
  ['contraFirm', 'Contra firm'],
  ['accountType', 'Account type'],
  ['submittedValue', 'Value as printed'],
  ['valueAmount', 'Amount'],
  ['valueCurrency', 'Currency'],
  ['status', 'Run status'],
  ['verdict', 'Workflow verdict'],
  ['totalIssues', 'Issues'],
  ['lowConfidence', 'Low confidence reads'],
  ['reviewState', 'Review decision'],
  ['reviewedByName', 'Decided by'],
  ['reviewedAt', 'Decided at'],
  ['reviewNote', 'Decision note']
];

/** The same rows the queue shows, as a spreadsheet, honouring the same range. */
app.get('/api/export.csv', auth.requireReviewer, async function (req, res) {
  if (!store.configured) {
    return res.status(503).json({ error: 'Export needs run history. Connect a storage database and redeploy.' });
  }
  try {
    const range = rangeFromQuery(req.query);
    const ids = await store.listIds(LIST_KEY, HISTORY_CAP);
    const rows = (await rowsFor(ids)).filter(function (row) {
      return withinRange(row, range.from, range.to);
    });
    const header = CSV_COLUMNS.map(function (c) {
      return csvCell(c[1]);
    }).join(',');
    const body = rows
      .map(function (row) {
        return CSV_COLUMNS.map(function (c) {
          return csvCell(row[c[0]]);
        }).join(',');
      })
      .join('\n');
    const stamp = (range.from || 'all') + '-to-' + (range.to || 'now');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="transfer-validations-' + stamp + '.csv"');
    // The BOM keeps Excel from mangling names with accents.
    res.send('\uFEFF' + header + '\n' + body + '\n');
  } catch (err) {
    sendError(res, err);
  }
});

/**
 * Monthly totals for the report: how much was approved against how much was
 * rejected. Amounts are grouped by the currency they were printed in, because
 * adding dirhams to dollars would be a lie.
 */
app.get('/api/report', auth.requireReviewer, async function (req, res) {
  if (!store.configured) {
    return res.json({ configured: false, months: [], currencies: [], note: 'Reporting needs run history.' });
  }
  try {
    const range = rangeFromQuery(req.query);
    const ids = await store.listIds(LIST_KEY, HISTORY_CAP);
    const rows = (await rowsFor(ids)).filter(function (row) {
      return withinRange(row, range.from, range.to);
    });

    const currencies = {};
    rows.forEach(function (row) {
      if (row.valueAmount !== null && row.valueAmount !== undefined) {
        const key = row.valueCurrency || 'unlabelled';
        currencies[key] = (currencies[key] || 0) + 1;
      }
    });
    const currencyList = Object.keys(currencies).sort(function (a, b) {
      return currencies[b] - currencies[a];
    });
    const currency = String(req.query.currency || currencyList[0] || '');

    const buckets = {};
    const blank = function () {
      return {
        approved: { amount: 0, count: 0 },
        rejected: { amount: 0, count: 0 },
        returned: { amount: 0, count: 0 },
        pending: { amount: 0, count: 0 },
        unfinished: { amount: 0, count: 0 }
      };
    };
    rows.forEach(function (row) {
      if (!row.createdAt) return;
      const month = String(row.createdAt).slice(0, 7);
      if (!buckets[month]) buckets[month] = blank();
      // A run that never produced a verdict is counted apart from one that is
       // waiting for a manager, so this page and the queue agree.
      const state = row.status === 'COMPLETED' ? row.reviewState || 'pending' : 'unfinished';
      const target = buckets[month][state] || buckets[month].pending;
      target.count += 1;
      const rowCurrency = row.valueCurrency || 'unlabelled';
      if (typeof row.valueAmount === 'number' && (!currency || rowCurrency === currency)) {
        target.amount += row.valueAmount;
      }
    });

    const months = Object.keys(buckets)
      .sort()
      .map(function (key) {
        return Object.assign({ key: key }, buckets[key]);
      });

    const totals = months.reduce(
      function (acc, m) {
        ['approved', 'rejected', 'returned', 'pending', 'unfinished'].forEach(function (k) {
          acc[k].amount += m[k].amount;
          acc[k].count += m[k].count;
        });
        return acc;
      },
      blank()
    );

    res.json({
      configured: true,
      range: range,
      currency: currency,
      currencies: currencyList,
      months: months,
      totals: totals,
      runs: rows.length
    });
  } catch (err) {
    sendError(res, err);
  }
});

/** What the console is pointed at. Read only: nothing here needs setting up. */
app.get('/api/settings', auth.requireReviewer, async function (req, res) {
  const storage = await store.ping();
  res.json({
    workflow: {
      id: opus.WORKFLOW_ID,
      baseUrl: opus.BASE,
      inputVariable: opus.INPUT_SUBMITTED_DOCS,
      outputVariables: [opus.OUTPUT_RESULT, opus.OUTPUT_EXPLANATION, opus.OUTPUT_ERROR]
    },
    serviceKey: { configured: opus.missingEnv().length === 0 },
    history: {
      configured: store.configured,
      mode: store.mode,
      reachable: storage.ok,
      reason: storage.reason || null
    },
    accounts: {
      count: auth.accountCount,
      usingDemoAccounts: auth.usingDefaultAccounts,
      sessionSecretSet: Boolean(process.env.SESSION_SECRET),
      list: auth.canReview(req.user) && req.user.role === 'admin' ? auth.roster() : []
    },
    support: support(),
    build: {
      target: process.env.VERCEL_ENV || 'local',
      deployment: process.env.VERCEL_URL || null,
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null
    }
  });
});

app.use('/api', function (req, res) {
  res.status(404).json({ error: 'No such endpoint: ' + req.method + ' ' + req.path });
});

module.exports = app;
module.exports.toRow = toRow;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, function () {
    // eslint-disable-next-line no-console
    console.log('Account Transfer Validation console on http://localhost:' + port);
  });
}
