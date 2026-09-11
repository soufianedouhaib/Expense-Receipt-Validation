/* Expense Receipt Validation — frontend.
   Talks only to this app's own /api routes, never to Opus directly. */

(function () {
  'use strict';

  var MAX_BYTES = 10 * 1024 * 1024;
  var POLL_MS = 3000;
  var POLL_TIMEOUT_MS = 5 * 60 * 1000;
  var STORE_KEY = 'aaico.expense.profile';

  var PROFILE_FIELDS = [
    'fullName', 'email', 'jobTitle', 'managerName',
    'phoneNumber', 'dateOfBirth', 'gender',
  ];

  var $ = function (id) { return document.getElementById(id); };

  /* Read a response that is *supposed* to be JSON. When something in front of
     the app answers instead — a platform 413, a 502, a crashed function — the
     body is an HTML error page, and blindly calling res.json() throws a parse
     error that hides the status code. Surface the status instead. */
  function readJson(res) {
    return res.text().then(function (text) {
      var body;
      try {
        body = JSON.parse(text);
      } catch (e) {
        var snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
        var hint = '';
        if (res.status === 413) {
          hint = ' The receipt is too large for the server to accept — try a file under 4MB.';
        } else if (res.status === 404) {
          hint = ' The API route was not found, so the backend is not being reached.';
        } else if (res.status >= 500) {
          hint = ' The backend errored before it could reply — check the function logs.';
        }
        var err = new Error(
          'The server returned ' + res.status + ' ' + (res.statusText || '') +
          ' instead of a result.' + hint + (snippet ? ' Response began: "' + snippet + '"' : '')
        );
        err.status = res.status;
        throw err;
      }
      return { res: res, body: body };
    });
  }

  var views = {
    form: $('view-form'),
    progress: $('view-progress'),
    result: $('view-result'),
    error: $('view-error'),
  };

  var form = $('claim-form');
  var fileInput = $('receipt');
  var dropzone = $('dropzone');
  var submitBtn = $('submit-btn');

  var pollTimer = null;
  var pollStartedAt = 0;
  var lastPayload = null;

  /* The fileUrl Opus returns for the receipt is an internal reference under
     /media/private/ — it is not served over HTTP and 404s in a browser. So
     "View receipt" points at the copy the browser already holds instead. */
  var receiptObjectUrl = null;

  function releaseReceiptUrl() {
    if (receiptObjectUrl) {
      URL.revokeObjectURL(receiptObjectUrl);
      receiptObjectUrl = null;
    }
  }

  /* ------------------------------ views ------------------------------ */

  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* --------------------------- file handling ------------------------- */

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function setFile(file) {
    clearError('receipt');

    if (!file) {
      fileInput.value = '';
      dropzone.classList.remove('has-file');
      $('dropzone-empty').hidden = false;
      $('dropzone-filled').hidden = true;
      return;
    }

    if (file.size > MAX_BYTES) {
      showError('receipt', 'That file is ' + formatBytes(file.size) + '. The limit is 10MB.');
      setFile(null);
      return;
    }

    var dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    $('file-name').textContent = file.name;
    $('file-size').textContent = formatBytes(file.size);
    dropzone.classList.add('has-file');
    $('dropzone-empty').hidden = true;
    $('dropzone-filled').hidden = false;
  }

  dropzone.addEventListener('click', function (e) {
    if (e.target.closest('.file-remove')) return;
    if (dropzone.classList.contains('has-file')) return;
    fileInput.click();
  });

  dropzone.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && !dropzone.classList.contains('has-file')) {
      e.preventDefault();
      fileInput.click();
    }
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.add('is-dragging');
    });
  });

  ['dragleave', 'drop'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.remove('is-dragging');
    });
  });

  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      setFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', function () {
    setFile(fileInput.files[0] || null);
  });

  $('file-remove').addEventListener('click', function (e) {
    e.stopPropagation();
    setFile(null);
  });

  /* ---------------------------- validation --------------------------- */

  function showError(field, message) {
    var el = $('err-' + field);
    if (el) { el.textContent = message; el.hidden = false; }
    var input = $(field);
    if (input) input.classList.add('invalid');
  }

  function clearError(field) {
    var el = $('err-' + field);
    if (el) el.hidden = true;
    var input = $(field);
    if (input) input.classList.remove('invalid');
  }

  function validate() {
    ['receipt', 'amount', 'fullName', 'email'].forEach(clearError);
    $('form-error').hidden = true;

    var ok = true;

    if (!fileInput.files.length) {
      showError('receipt', 'Attach the receipt before submitting.');
      ok = false;
    }

    var amount = $('amount').value.trim();
    if (!amount || Number(amount) <= 0) {
      showError('amount', 'Enter the total amount on the receipt.');
      ok = false;
    }

    if (!$('fullName').value.trim()) {
      showError('fullName', 'Your name is required.');
      ok = false;
    }

    var email = $('email').value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError('email', 'Enter a valid work email.');
      ok = false;
    }

    return ok;
  }

  /* ------------------------- profile persistence --------------------- */

  function saveProfile() {
    if (!$('remember').checked) {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      return;
    }
    var data = {};
    PROFILE_FIELDS.forEach(function (f) { data[f] = $(f).value; });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function loadProfile() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      PROFILE_FIELDS.forEach(function (f) {
        if (data[f]) $(f).value = data[f];
      });
    } catch (e) {}
  }

  /* ----------------------------- progress ---------------------------- */

  var STEP_ORDER = ['upload', 'read', 'check', 'decide'];

  function markStep(active) {
    var idx = STEP_ORDER.indexOf(active);
    STEP_ORDER.forEach(function (s, i) {
      var li = document.querySelector('.steps li[data-step="' + s + '"]');
      if (!li) return;
      li.classList.toggle('done', i < idx);
      li.classList.toggle('active', i === idx);
    });
  }

  function setStatusLine(text) { $('status-line').textContent = text; }

  /* ------------------------------ submit ----------------------------- */

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validate()) return;

    saveProfile();

    var fd = new FormData();
    fd.append('receipt', fileInput.files[0]);
    ['amount', 'currency', 'fullName', 'email', 'jobTitle',
     'managerName', 'phoneNumber', 'dateOfBirth', 'gender'].forEach(function (f) {
      fd.append(f, $(f).value);
    });

    lastPayload = fd;
    submitBtn.disabled = true;

    releaseReceiptUrl();
    try {
      receiptObjectUrl = URL.createObjectURL(fileInput.files[0]);
    } catch (e) {
      receiptObjectUrl = null;
    }

    show('progress');
    markStep('upload');
    setStatusLine('Uploading your receipt…');

    fetch('/api/submit', { method: 'POST', body: fd })
      .then(readJson)
      .then(function (r) {
        if (!r.res.ok) throw new Error(r.body.error || 'Submission failed.');
        markStep('read');
        setStatusLine('Reading the receipt…');
        startPolling(r.body.caseId);
      })
      .catch(function (err) {
        submitBtn.disabled = false;
        failWith(err.message);
      });
  });

  /* ------------------------------ polling ---------------------------- */

  function startPolling(caseId) {
    pollStartedAt = Date.now();

    function tick() {
      if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
        return failWith('This is taking longer than expected. Your claim is still running in Opus — check with HR before resubmitting.');
      }

      fetch('/api/status/' + encodeURIComponent(caseId))
        .then(readJson)
        .then(function (r) {
          var data = r.body;
          if (data.state === 'running') {
            advanceProgress();
            pollTimer = setTimeout(tick, POLL_MS);
            return;
          }
          if (data.state === 'failed') {
            return failWith(data.error || 'The validation run did not complete.');
          }
          renderResult(data);
        })
        .catch(function () {
          pollTimer = setTimeout(tick, POLL_MS);
        });
    }

    pollTimer = setTimeout(tick, 1500);
  }

  function advanceProgress() {
    var elapsed = Date.now() - pollStartedAt;
    if (elapsed > 22000) { markStep('decide'); setStatusLine('Building the decision…'); }
    else if (elapsed > 11000) { markStep('check'); setStatusLine('Comparing the amounts…'); }
    else { markStep('read'); setStatusLine('Reading the receipt…'); }
  }

  /* ------------------------------ result ----------------------------- */

  function money(obj) {
    if (!obj) return '—';
    var amount = obj.amount != null ? String(obj.amount) : '';
    var currency = obj.currency != null ? String(obj.currency) : '';
    return (amount + ' ' + currency).trim() || '—';
  }

  function renderResult(data) {
    submitBtn.disabled = false;

    var report = data.report;

    if (!report) {
      return failWith(
        'The workflow finished but returned a report we could not read. ' +
        (data.rawReport ? 'Raw output: ' + String(data.rawReport).slice(0, 300) : '')
      );
    }

    var approved = report.approved === true;
    var matched = report.amounts_match === true;

    var badge = $('verdict-badge');
    badge.textContent = approved ? 'Approved' : 'Needs attention';
    badge.className = 'badge ' + (approved ? 'badge-ok' : 'badge-warn');

    $('verdict-title').textContent = approved
      ? 'Your claim checks out'
      : 'We need you to take another look';

    $('summary').textContent = report.summary || '';

    var facts = $('facts');
    facts.innerHTML = '';
    [
      ['Category', report.receipt_type],
      ['Receipt date', report.date],
      ['Amounts match', matched ? 'Yes' : 'No'],
    ].forEach(function (pair) {
      if (!pair[1]) return;
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      facts.appendChild(dt);
      facts.appendChild(dd);
    });

    $('submitted-total').textContent = money(report.submitted_total);
    $('extracted-total').textContent = money(report.extracted_total);

    var compare = $('compare');
    compare.className = 'compare ' + (matched ? 'match' : 'mismatch');
    $('compare-arrow').textContent = matched ? '=' : '≠';

    $('amount-reasoning').textContent = report.amount_match_reasoning || '—';
    $('type-reasoning').textContent = report.receipt_type_reasoning || '—';

    var link = $('receipt-link');
    if (receiptObjectUrl) {
      link.href = receiptObjectUrl;
      link.hidden = false;
    } else {
      link.hidden = true;
    }

    show('result');
  }

  function failWith(message) {
    if (pollTimer) clearTimeout(pollTimer);
    submitBtn.disabled = false;
    $('error-summary').textContent = message;
    show('error');
  }

  /* ------------------------------ resets ----------------------------- */

  $('new-claim').addEventListener('click', function () {
    releaseReceiptUrl();
    setFile(null);
    $('amount').value = '';
    show('form');
  });

  window.addEventListener('pagehide', releaseReceiptUrl);

  $('back-to-form').addEventListener('click', function () { show('form'); });

  $('retry').addEventListener('click', function () {
    if (!lastPayload) return show('form');
    show('progress');
    markStep('upload');
    setStatusLine('Resubmitting…');

    fetch('/api/submit', { method: 'POST', body: lastPayload })
      .then(readJson)
      .then(function (r) {
        if (!r.res.ok) throw new Error(r.body.error || 'Submission failed.');
        startPolling(r.body.caseId);
      })
      .catch(function (err) { failWith(err.message); });
  });

  loadProfile();
})();
