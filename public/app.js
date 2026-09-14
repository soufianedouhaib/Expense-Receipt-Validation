/* Expense Receipt Validation — frontend.
   Talks only to this app's own /api routes, never to Opus directly. */

(function () {
  'use strict';

  var MAX_BYTES = 10 * 1024 * 1024;
  var POLL_MS = 3000;
  var POLL_TIMEOUT_MS = 5 * 60 * 1000;
  var STORE_KEY = 'aaico.expense.profile';

  var isGuest = false;

  var PROFILE_FIELDS = [
    'jobTitle', 'managerName',
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

  /* ------------------------- sample scenarios ------------------------ */

  /* Demo fixtures. Each one is a real PDF under public/samples/ plus the
     amount a person would type off it. `amount` is deliberately NOT read
     from the file — the mismatch cases depend on the two disagreeing, which
     is the whole point of the check the workflow performs. */
  var SCENARIOS = [
    {
      id: 'hotel',
      name: 'Hotel stay',
      blurb: 'Two nights in Dubai with breakfast. The total on the receipt is what gets claimed.',
      file: 'samples/hotel-stay.pdf',
      amount: '1291.50',
      currency: 'AED',
      expect: 'Approved',
      tone: 'ok',
    },
    {
      id: 'lunch',
      name: 'Team lunch',
      blurb: 'A four-cover restaurant bill, claimed exactly as printed.',
      file: 'samples/team-lunch.pdf',
      amount: '512.40',
      currency: 'AED',
      expect: 'Approved',
      tone: 'ok',
    },
    {
      id: 'taxi',
      name: 'Airport taxi, digits swapped',
      blurb: 'The ride cost 106.05 but 160.50 gets typed in — a transposed pair.',
      file: 'samples/airport-taxi.pdf',
      amount: '160.50',
      currency: 'AED',
      expect: 'Needs attention',
      tone: 'warn',
    },
    {
      id: 'supplies',
      name: 'Office supplies, VAT missed',
      blurb: 'The subtotal is claimed instead of the total, so 21.15 of VAT goes missing.',
      file: 'samples/office-supplies.pdf',
      amount: '423.00',
      currency: 'AED',
      expect: 'Needs attention',
      tone: 'warn',
    },
  ];

  var GUEST_SAMPLE = { fullName: 'Mahmoud Sharshira', email: 'mahmoud@demo.aaico.com' };

  function setTryStatus(text, kind) {
    var el = $('try-status');
    if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.textContent = text;
    el.className = 'try-status' + (kind ? ' is-' + kind : '');
    el.hidden = false;
  }

  function markChosen(id) {
    Array.prototype.forEach.call(
      document.querySelectorAll('.try-item'),
      function (el) { el.classList.toggle('is-chosen', el.dataset.id === id); }
    );
  }

  function applyScenario(s, button) {
    setTryStatus('Fetching the sample receipt…', 'busy');
    button.disabled = true;

    fetch(s.file)
      .then(function (r) {
        if (!r.ok) throw new Error('The sample receipt could not be loaded (' + r.status + ').');
        return r.blob();
      })
      .then(function (blob) {
        var filename = s.file.split('/').pop();
        var file;
        try {
          file = new File([blob], filename, { type: 'application/pdf' });
        } catch (e) {
          // Older Safari has no File constructor; a named Blob is enough for FormData.
          file = blob;
          file.name = filename;
        }

        setFile(file);
        $('amount').value = s.amount;
        $('currency').value = s.currency;
        clearError('amount');

        // Guests have no verified identity, so give them one to submit with —
        // but never overwrite something they have already typed.
        if (isGuest) {
          if (!$('fullName').value.trim()) $('fullName').value = GUEST_SAMPLE.fullName;
          if (!$('email').value.trim()) $('email').value = GUEST_SAMPLE.email;
          clearError('fullName');
          clearError('email');
        }
        if (!$('managerName').value.trim()) $('managerName').value = 'Omar Busaileh';
        if (!$('jobTitle').value.trim()) $('jobTitle').value = 'AI Implementation Engineer';

        markChosen(s.id);
        setTryStatus(
          'Filled in: ' + s.name + ' — ' + s.amount + ' ' + s.currency +
          '. Expected outcome: ' + s.expect + '. Submit when you are ready.'
        );
      })
      .catch(function (err) {
        setTryStatus(err.message, 'error');
      })
      .then(function () { button.disabled = false; });
  }

  function renderScenarios() {
    var grid = $('try-grid');
    if (!grid) return;
    grid.innerHTML = '';

    SCENARIOS.forEach(function (s) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'try-item';
      item.dataset.id = s.id;

      var name = document.createElement('span');
      name.className = 'try-name';
      name.textContent = s.name;

      var blurb = document.createElement('span');
      blurb.className = 'try-blurb';
      blurb.textContent = s.blurb;

      var foot = document.createElement('span');
      foot.className = 'try-foot';

      var amount = document.createElement('span');
      amount.className = 'try-amount';
      amount.textContent = s.amount + ' ' + s.currency;

      var expect = document.createElement('span');
      expect.className = 'try-expect ' + s.tone;
      expect.textContent = 'Expected: ' + s.expect;

      foot.appendChild(amount);
      foot.appendChild(expect);

      item.appendChild(name);
      item.appendChild(blurb);
      item.appendChild(foot);

      item.addEventListener('click', function () { applyScenario(s, item); });

      grid.appendChild(item);
    });
  }

  function clearForm() {
    releaseReceiptUrl();
    setFile(null);
    $('amount').value = '';
    $('currency').value = 'AED';
    ['receipt', 'amount', 'fullName', 'email'].forEach(clearError);
    $('form-error').hidden = true;
    markChosen(null);
    setTryStatus('Form cleared.');
  }

  if ($('try-clear')) $('try-clear').addEventListener('click', clearForm);

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

    if (isGuest) {
      if (!$('fullName').value.trim()) {
        showError('fullName', 'Enter your name.');
        ok = false;
      }
      var typed = $('email').value.trim();
      if (!typed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) {
        showError('email', 'Enter a valid email address.');
        ok = false;
      }
    }

    if (!fileInput.files.length) {
      showError('receipt', 'Attach the receipt before submitting.');
      ok = false;
    }

    var amount = $('amount').value.trim();
    if (!amount || Number(amount) <= 0) {
      showError('amount', 'Enter the total amount on the receipt.');
      ok = false;
    }

    return ok;
  }

  /* ------------------------- profile persistence --------------------- */

  function profileFields() {
    return isGuest ? PROFILE_FIELDS.concat(['fullName', 'email']) : PROFILE_FIELDS;
  }

  function saveProfile() {
    if (!$('remember').checked) {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      return;
    }
    var data = {};
    profileFields().forEach(function (f) { data[f] = $(f).value; });
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function loadProfile() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      profileFields().forEach(function (f) {
        if (data[f] && $(f)) $(f).value = data[f];
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
    var fields = ['amount', 'currency', 'jobTitle', 'managerName',
                  'phoneNumber', 'dateOfBirth', 'gender'];
    // A signed-in claim takes its identity from the session; a guest sends it.
    if (isGuest) fields = fields.concat(['fullName', 'email']);
    fields.forEach(function (f) { fd.append(f, $(f).value); });

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
    markChosen(null);
    setTryStatus(null);
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

  /* ------------------------------ session ---------------------------- */

  $('signout-btn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function () { window.location.href = '/'; })
      .catch(function () { window.location.href = '/'; });
  });

  /* Nothing renders until we know who this is. A signed-out visitor goes back
     to the welcome page rather than seeing a form they cannot submit. */
  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.signedIn) { window.location.href = '/'; return; }

      isGuest = Boolean(me.guest);

      if (isGuest) {
        // No verified identity, so the fields are the person's to fill in, and
        // the history links go away — there is no "mine" to show a guest.
        $('who').textContent = 'Guest';
        $('identity-fields').hidden = false;
        $('details-sub').textContent = 'Tell us who this claim is for';
        $('signout-btn').textContent = 'Leave';
        $('my-claims-link').hidden = true;
        if ($('all-claims-link')) $('all-claims-link').hidden = true;
      } else {
        $('who').textContent = me.name || me.email;
        $('identity').hidden = false;
        $('id-name').textContent = me.name || '—';
        $('id-email').textContent = me.email || '—';
      }

      document.body.classList.remove('is-loading');
      renderScenarios();
      loadProfile();

      // Demo accounts come with a manager already assigned; only fill it in if
      // the person has not typed or saved one of their own.
      if (me.defaultManager && !$('managerName').value) {
        $('managerName').value = me.defaultManager;
      }
    })
    .catch(function () {
      window.location.href = '/';
    });
})();
