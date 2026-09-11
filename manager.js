/* Manager view — submissions list and detail.
   Talks only to this app's own /api/manager/* routes. The access code is held
   in sessionStorage, so it is gone when the tab closes. */

(function () {
  'use strict';

  var CODE_KEY = 'aaico.expense.managerCode';

  var $ = function (id) { return document.getElementById(id); };

  var views = {
    gate: $('view-gate'),
    list: $('view-list'),
    detail: $('view-detail'),
  };

  var accessCode = null;
  var rows = [];

  function show(name) {
    Object.keys(views).forEach(function (k) { views[k].hidden = k !== name; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function pageError(message) {
    var el = $('page-error');
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.hidden = false;
  }

  /* Same defensive read as the employee page: a platform error page is HTML,
     and res.json() would hide the status code behind a parse error. */
  function readJson(res) {
    return res.text().then(function (text) {
      var body;
      try {
        body = JSON.parse(text);
      } catch (e) {
        var err = new Error('The server returned ' + res.status + ' ' +
          (res.statusText || '') + ' instead of a result.');
        err.status = res.status;
        throw err;
      }
      return { res: res, body: body };
    });
  }

  function api(pathname, options) {
    options = options || {};
    return fetch(pathname, {
      method: options.method || 'GET',
      headers: Object.assign({ 'x-access-code': accessCode || '' }, options.headers || {}),
      body: options.body,
    }).then(readJson).then(function (r) {
      if (r.res.status === 401) {
        forgetCode();
        throw new Error('Your access code was rejected. Enter it again.');
      }
      if (!r.res.ok) throw new Error(r.body.error || 'Request failed.');
      return r.body;
    });
  }

  /* ------------------------------- gate ------------------------------ */

  function rememberCode(code) {
    accessCode = code;
    try { sessionStorage.setItem(CODE_KEY, code); } catch (e) {}
  }

  function forgetCode() {
    accessCode = null;
    try { sessionStorage.removeItem(CODE_KEY); } catch (e) {}
    show('gate');
  }

  $('gate-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('access-code').value;
    $('err-code').hidden = true;
    $('gate-btn').disabled = true;

    fetch('/api/manager/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
    })
      .then(readJson)
      .then(function (r) {
        if (!r.res.ok) throw new Error(r.body.error || 'That access code is not right.');
        rememberCode(code);
        $('access-code').value = '';
        return loadList();
      })
      .catch(function (err) {
        $('err-code').textContent = err.message;
        $('err-code').hidden = false;
      })
      .then(function () { $('gate-btn').disabled = false; });
  });

  /* ------------------------------- list ------------------------------ */

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function fmtBytes(b) {
    if (!b && b !== 0) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function outcomeOf(row) {
    if (row.state === 'failed') return { key: 'failed', label: 'Did not complete', cls: 'badge-error' };
    if (row.state === 'running') return { key: 'running', label: 'Running', cls: '' };
    if (row.approved === true) return { key: 'approved', label: 'Approved', cls: 'badge-ok' };
    return { key: 'attention', label: 'Needs attention', cls: 'badge-warn' };
  }

  function visibleRows() {
    var q = $('search').value.trim().toLowerCase();
    var status = $('filter-status').value;

    return rows.filter(function (row) {
      if (status !== 'all' && outcomeOf(row).key !== status) return false;
      if (!q) return true;
      return [row.employeeName, row.employeeEmail, row.receiptType, row.managerName]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderStats() {
    var counts = { approved: 0, attention: 0, running: 0, failed: 0 };
    rows.forEach(function (r) { counts[outcomeOf(r).key]++; });

    var tiles = [
      ['Total', rows.length, ''],
      ['Approved', counts.approved, 'ok'],
      ['Needs attention', counts.attention, 'warn'],
      ['Running', counts.running, ''],
    ];

    var host = $('stat-row');
    host.innerHTML = '';
    tiles.forEach(function (t) {
      var el = document.createElement('div');
      el.className = 'stat' + (t[2] ? ' stat-' + t[2] : '');
      var n = document.createElement('span');
      n.className = 'stat-num';
      n.textContent = t[1];
      var l = document.createElement('span');
      l.className = 'stat-label';
      l.textContent = t[0];
      el.appendChild(n);
      el.appendChild(l);
      host.appendChild(el);
    });
  }

  function renderTable() {
    var list = visibleRows();
    var tbody = $('tbody');
    tbody.innerHTML = '';

    list.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.setAttribute('role', 'link');
      tr.dataset.caseId = row.caseId;

      function cell(text, cls) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        td.textContent = text;
        return td;
      }

      var who = document.createElement('td');
      var name = document.createElement('span');
      name.className = 'cell-strong';
      name.textContent = row.employeeName || '—';
      var mail = document.createElement('span');
      mail.className = 'cell-sub';
      mail.textContent = row.employeeEmail || '';
      who.appendChild(name);
      who.appendChild(mail);
      tr.appendChild(who);

      tr.appendChild(cell(fmtDate(row.submittedAt)));
      tr.appendChild(cell(row.submittedTotal || '—', 'num mono'));
      tr.appendChild(cell(row.extractedTotal || '—', 'num mono'));
      tr.appendChild(cell(row.receiptType || '—'));

      var o = outcomeOf(row);
      var td = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'badge ' + o.cls;
      badge.textContent = o.label;
      td.appendChild(badge);
      tr.appendChild(td);

      tbody.appendChild(tr);
    });

    $('empty').hidden = list.length > 0;
    $('list-caption').textContent = rows.length
      ? 'Showing ' + list.length + ' of ' + rows.length + ' submissions, newest first.'
      : 'Nothing has been submitted yet.';
  }

  function loadList() {
    pageError('');
    return api('/api/manager/submissions')
      .then(function (data) {
        rows = data.submissions || [];
        renderStats();
        renderTable();
        show('list');
      })
      .catch(function (err) {
        if (!accessCode) { show('gate'); return; }
        pageError(err.message);
        show('list');
      });
  }

  $('tbody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-case-id]');
    if (tr) openDetail(tr.dataset.caseId);
  });

  $('tbody').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var tr = e.target.closest('tr[data-case-id]');
    if (tr) { e.preventDefault(); openDetail(tr.dataset.caseId); }
  });

  $('search').addEventListener('input', renderTable);
  $('filter-status').addEventListener('change', renderTable);
  $('refresh-btn').addEventListener('click', loadList);

  $('export-btn').addEventListener('click', function () {
    // The export route needs the code too; a plain link can't set a header.
    window.open('/api/manager/export.csv?code=' + encodeURIComponent(accessCode || ''), '_blank');
  });

  /* ------------------------------ detail ----------------------------- */

  function defList(host, pairs) {
    host.innerHTML = '';
    pairs.forEach(function (pair) {
      if (!pair[1]) return;
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      host.appendChild(dt);
      host.appendChild(dd);
    });
  }

  function openDetail(caseId) {
    pageError('');
    api('/api/manager/submissions/' + encodeURIComponent(caseId))
      .then(function (data) {
        var row = data.submission;
        var report = data.report || {};
        var emp = data.employee || {};
        var o = outcomeOf(row);

        $('d-badge').textContent = o.label;
        $('d-badge').className = 'badge ' + o.cls;
        $('d-title').textContent = row.employeeName || 'Submission';
        $('d-summary').textContent = row.summary || row.error ||
          (row.state === 'running' ? 'This claim is still being checked.' : '');

        $('d-submitted').textContent = row.submittedTotal || '—';
        $('d-extracted').textContent = row.extractedTotal || '—';
        var matched = row.amountsMatch === true;
        $('d-compare').className = 'compare ' + (row.amountsMatch === null ? '' : matched ? 'match' : 'mismatch');
        $('d-arrow').textContent = row.amountsMatch === null ? '?' : matched ? '=' : '≠';

        defList($('d-employee'), [
          ['Name', emp.fullName],
          ['Work email', emp.email],
          ['Job title', emp.jobTitle],
          ['Manager', emp.managerName],
          ['Phone', emp.phoneNumber],
          ['Submitted', fmtDate(row.submittedAt)],
          ['Checked', row.completedAt ? fmtDate(row.completedAt) : 'Not finished'],
        ]);

        defList($('d-receipt'), [
          ['File', data.receipt ? data.receipt.filename : ''],
          ['Size', data.receipt ? fmtBytes(data.receipt.size) : ''],
          ['Category', report.receipt_type],
          ['Date on receipt', report.date],
        ]);

        var link = $('d-receipt-link');
        if (data.receipt && data.receipt.available) {
          link.href = '/api/manager/receipt/' + encodeURIComponent(caseId) +
                      '?code=' + encodeURIComponent(accessCode || '');
          link.hidden = false;
        } else {
          link.hidden = true;
        }

        $('d-amount-reasoning').textContent = report.amount_match_reasoning || '—';
        $('d-type-reasoning').textContent = report.receipt_type_reasoning || '—';
        $('d-reasoning-card').hidden = !report.amount_match_reasoning && !report.receipt_type_reasoning;

        show('detail');
      })
      .catch(function (err) { pageError(err.message); });
  }

  $('back-btn').addEventListener('click', function () { show('list'); });

  /* ------------------------------- boot ------------------------------ */

  try { accessCode = sessionStorage.getItem(CODE_KEY); } catch (e) {}

  if (accessCode) {
    loadList();
  } else {
    show('gate');
  }
})();
