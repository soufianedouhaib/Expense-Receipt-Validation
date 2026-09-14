/* Admin view — split list and detail.
   Talks only to this app's own /api/manager/* routes.

   The access code lives in sessionStorage, so it dies with the tab. It is also
   cleared deliberately on log out and on leaving for the Submit page, so the
   next person at this machine starts from the gate. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var me = null;          // { name, email, roles }
  var scope = 'team';     // 'all' for admins, 'team' for managers
  var rows = [];
  var selectedId = null;

  /* ------------------------------ plumbing ------------------------------ */

  /* A platform error page is HTML; res.json() would hide the status behind a
     parse error, so read as text and report the status when it isn't JSON. */
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
      headers: options.headers || {},
      body: options.body,
    }).then(readJson).then(function (r) {
      // The cookie expired or the account lost access — back to the welcome page.
      if (r.res.status === 401 || r.res.status === 403) {
        window.location.href = '/';
        throw new Error('signed-out');
      }
      if (!r.res.ok) throw new Error(r.body.error || 'Request failed.');
      return r.body;
    });
  }

  function pageError(message) {
    var el = $('page-error');
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.hidden = false;
  }

  $('signout-btn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function () { window.location.href = '/'; })
      .catch(function () { window.location.href = '/'; });
  });

  /* ------------------------------ formatting ---------------------------- */

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

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* -------------------------------- list -------------------------------- */

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

  function renderList() {
    var list = visibleRows();
    var host = $('rows');
    host.innerHTML = '';

    list.forEach(function (row) {
      var o = outcomeOf(row);
      var btn = el('button', 'list-row' + (row.caseId === selectedId ? ' is-selected' : ''));
      btn.type = 'button';
      btn.dataset.caseId = row.caseId;

      var main = el('div', 'list-row-main');
      main.appendChild(el('div', 'list-row-name', row.employeeName || row.employeeEmail || 'Unnamed'));
      main.appendChild(el('div', 'list-row-meta',
        fmtDate(row.submittedAt) + ' · ' + (row.receiptType || 'Uncategorised')));
      btn.appendChild(main);

      btn.appendChild(el('span', 'list-row-amt', row.submittedTotal || '—'));
      btn.appendChild(el('span', 'badge ' + o.cls, o.label));

      btn.addEventListener('click', function () { select(row.caseId); });
      host.appendChild(btn);
    });

    $('list-empty').hidden = list.length > 0;

    var attention = rows.filter(function (r) { return outcomeOf(r).key === 'attention'; }).length;
    var noun = scope === 'all' ? ' claims' : ' team claims';
    $('count-total').textContent = rows.length
      ? (list.length === rows.length
          ? rows.length + noun
          : list.length + ' of ' + rows.length + noun)
      : (scope === 'all' ? 'No claims yet' : 'No claims name you as manager yet');
    $('count-attention').textContent = attention ? attention + ' need attention' : '';
  }

  function loadList(quiet) {
    if (!me) return Promise.resolve();
    if (!quiet) pageError('');

    return api('/api/manager/submissions')
      .then(function (data) {
        rows = data.submissions || [];
        scope = data.scope || 'team';
        $('mode-title').textContent = scope === 'all' ? 'All claims' : 'My team';
        if (!selectedId && rows.length) selectedId = rows[0].caseId;
        renderList();
        if (selectedId) renderDetail(selectedId);
      })
      .catch(function (err) {
        if (err.message !== 'signed-out') pageError(err.message);
      });
  }

  function select(caseId) {
    selectedId = caseId;
    renderList();
    renderDetail(caseId);
  }

  $('search').addEventListener('input', renderList);
  $('filter-status').addEventListener('change', renderList);

  /* ------------------------------- detail ------------------------------- */

  function facts(pairs) {
    var dl = el('dl', 'facts facts-flush');
    pairs.forEach(function (p) {
      if (!p[1]) return;
      dl.appendChild(el('dt', '', p[0]));
      dl.appendChild(el('dd', '', p[1]));
    });
    return dl;
  }

  function renderDetail(caseId) {
    var row = rows.filter(function (r) { return r.caseId === caseId; })[0];
    if (!row) return;

    var host = $('detail');
    host.innerHTML = '';

    var o = outcomeOf(row);

    var head = el('div', 'detail-head');
    head.appendChild(el('span', 'badge ' + o.cls, o.label));
    head.appendChild(el('h2', '', row.employeeName || 'Submission'));
    head.appendChild(el('div', 'sub', row.summary || row.error ||
      (row.state === 'running' ? 'This claim is still being checked.' : '')));
    host.appendChild(head);

    /* amounts */
    var amt = el('div', 'panel');
    amt.appendChild(el('h3', '', 'Amounts'));
    var matched = row.amountsMatch === true;
    var cmp = el('div', 'compare ' + (row.amountsMatch === null ? '' : matched ? 'match' : 'mismatch'));
    var left = el('div', 'compare-col');
    left.appendChild(el('span', 'compare-label', 'Claimed'));
    left.appendChild(el('span', 'compare-value', row.submittedTotal || '—'));
    var arrow = el('div', 'compare-arrow', row.amountsMatch === null ? '?' : matched ? '=' : '≠');
    var right = el('div', 'compare-col');
    right.appendChild(el('span', 'compare-label', 'On receipt'));
    right.appendChild(el('span', 'compare-value', row.extractedTotal || '—'));
    cmp.appendChild(left); cmp.appendChild(arrow); cmp.appendChild(right);
    amt.appendChild(cmp);
    host.appendChild(amt);

    /* who */
    var who = el('div', 'panel');
    who.appendChild(el('h3', '', 'Who submitted it'));
    who.appendChild(facts([
      ['Email', row.employeeEmail],
      ['Job title', row.jobTitle],
      ['Manager', row.managerName],
      ['Submitted', fmtDate(row.submittedAt)],
      ['Checked', row.completedAt ? fmtDate(row.completedAt) : 'Not finished'],
    ]));
    host.appendChild(who);

    /* receipt */
    var rec = el('div', 'panel');
    rec.appendChild(el('h3', '', 'The receipt'));
    rec.appendChild(facts([
      ['File', row.receiptName],
      ['Category', row.receiptType],
      ['Date on receipt', row.receiptDate],
    ]));
    host.appendChild(rec);

    /* reasoning */
    if (row.summary || row.state === 'done') {
      api('/api/manager/submissions/' + encodeURIComponent(caseId))
        .then(function (data) {
          if (selectedId !== caseId) return;   // selection moved on while loading
          var report = data.report || {};
          if (!report.amount_match_reasoning && !report.receipt_type_reasoning) return;

          var why = el('div', 'panel');
          why.appendChild(el('h3', '', 'Why this decision'));

          var b1 = el('div', 'reason-block');
          b1.appendChild(el('h3', '', 'Amount check'));
          b1.appendChild(el('p', '', report.amount_match_reasoning || '—'));
          why.appendChild(b1);

          var b2 = el('div', 'reason-block');
          b2.appendChild(el('h3', '', 'Category'));
          b2.appendChild(el('p', '', report.receipt_type_reasoning || '—'));
          why.appendChild(b2);

          host.insertBefore(why, host.lastChild);
        })
        .catch(function () { /* the summary above is enough */ });
    }

    /* actions */
    var acts = el('div', 'detail-acts');
    if (row.hasReceipt) {
      var open = el('a', 'btn btn-primary btn-sm', 'Open receipt');
      open.href = '/api/manager/receipt/' + encodeURIComponent(caseId);
      open.target = '_blank';
      open.rel = 'noopener';
      acts.appendChild(open);
    }
    var refresh = el('button', 'btn btn-ghost btn-sm', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', function () { loadList(); });
    acts.appendChild(refresh);

    // Export is an admin action; the route refuses it for anyone else.
    if (me && me.roles.indexOf('admin') !== -1) {
      var csv = el('a', 'btn btn-ghost btn-sm', 'Export CSV');
      csv.href = '/api/manager/export.csv';
      acts.appendChild(csv);
    }

    host.appendChild(acts);
  }

  /* -------------------------------- boot -------------------------------- */

  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (session) {
      if (!session.signedIn) { window.location.href = '/'; return; }

      var canReview = session.roles.indexOf('manager') !== -1 ||
                      session.roles.indexOf('admin') !== -1;
      if (!canReview) { window.location.href = '/'; return; }

      me = session;
      $('who').textContent = session.name || session.email;
      // Only offer "Switch role" to people who actually hold more than one.
      $('switch-btn').hidden = session.roles.length < 2;
      document.body.classList.remove('is-loading');
      loadList();
    })
    .catch(function () { window.location.href = '/'; });
})();
