/* Claims workspace — split list and detail.
   One page serves three scopes, chosen by ?scope= and re-checked server-side:
   mine (your own), team (claims naming you as manager), all (admin).

   The access code lives in sessionStorage, so it dies with the tab. It is also
   cleared deliberately on log out and on leaving for the Submit page, so the
   next person at this machine starts from the gate. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var me = null;          // { name, email, roles }
  var scope = new URLSearchParams(window.location.search).get('scope') || 'mine';
  var rows = [];
  var selectedId = null;

  var TITLES = { mine: 'My claims', team: 'My team', all: 'All claims' };

  /* Periods are computed locally, so "this month" is the viewer's month rather
     than UTC's — which matters at both ends of the day in UTC+4. */
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }
  function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }

  function periodWindow(key) {
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();

    switch (key) {
      case 'this-month':
        return { from: new Date(y, m, 1).getTime(),
                 to: endOfDay(new Date(y, m + 1, 0)).getTime() };
      case 'last-month':
        return { from: new Date(y, m - 1, 1).getTime(),
                 to: endOfDay(new Date(y, m, 0)).getTime() };
      case 'last-3':
        return { from: new Date(y, m - 2, 1).getTime(), to: endOfDay(now).getTime() };
      case 'last-30':
        return { from: startOfDay(new Date(now.getTime() - 29 * 86400000)).getTime(),
                 to: endOfDay(now).getTime() };
      case 'ytd':
        return { from: new Date(y, 0, 1).getTime(), to: endOfDay(now).getTime() };
      case 'custom': {
        var f = $('date-from').value, t = $('date-to').value;
        return {
          from: f ? startOfDay(new Date(f + 'T12:00:00')).getTime() : null,
          to: t ? endOfDay(new Date(t + 'T12:00:00')).getTime() : null,
        };
      }
      default:
        return { from: null, to: null };
    }
  }

  function currentWindow() { return periodWindow($('filter-period').value); }

  function withinWindow(row, win) {
    if (win.from === null && win.to === null) return true;
    var t = new Date(row.submittedAt).getTime();
    if (isNaN(t)) return true;
    if (win.from !== null && t < win.from) return false;
    if (win.to !== null && t > win.to) return false;
    return true;
  }

  var EMPTY = {
    mine: 'You have not submitted a claim yet',
    team: 'No claims name you as manager yet',
    all: 'No claims yet',
  };

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

  function personKey(row) {
    return (row.employeeEmail || row.employeeName || '').trim().toLowerCase();
  }

  function personLabel(row) {
    return row.employeeName || row.employeeEmail || 'Unnamed';
  }

  /* The dropdown is built from the claims actually loaded, so it never offers a
     name with nothing behind it. A selection that disappears — the person has
     no claims in the new period — falls back to everyone rather than silently
     showing an empty list. */
  function refreshPeopleFilter() {
    var wrap = $('person-wrap');
    var sel = $('filter-person');
    if (!wrap || !sel) return;

    // On "my claims" every row is you, so the filter would be a no-op.
    if (scope === 'mine') { wrap.hidden = true; sel.value = 'all'; return; }

    var seen = {};
    var people = [];
    rows.forEach(function (row) {
      var key = personKey(row);
      if (!key || seen[key]) return;
      seen[key] = true;
      people.push({ key: key, label: personLabel(row) });
    });
    people.sort(function (a, b) { return a.label.localeCompare(b.label); });

    var previous = sel.value;
    sel.innerHTML = '';

    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = people.length ? 'Everyone (' + people.length + ')' : 'Everyone';
    sel.appendChild(all);

    people.forEach(function (person) {
      var opt = document.createElement('option');
      opt.value = person.key;
      opt.textContent = person.label;
      sel.appendChild(opt);
    });

    sel.value = seen[previous] ? previous : 'all';
    wrap.hidden = people.length < 2;
  }

  function visibleRows() {
    var q = $('search').value.trim().toLowerCase();
    var status = $('filter-status').value;
    var person = $('filter-person') ? $('filter-person').value : 'all';
    var win = currentWindow();

    return rows.filter(function (row) {
      if (!withinWindow(row, win)) return false;
      if (status !== 'all' && outcomeOf(row).key !== status) return false;
      if (person !== 'all' && personKey(row) !== person) return false;
      if (!q) return true;
      return [row.employeeName, row.employeeEmail, row.receiptType, row.managerName]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  /* Claims are summed per currency and never converted — there is no rate in
     this app, and a total that quietly mixed AED with USD would be worse than
     no total at all. */
  function sumByCurrency(list) {
    var totals = {};
    var order = [];

    list.forEach(function (row) {
      var n = parseFloat(String(row.amount != null ? row.amount : '').replace(/,/g, ''));
      if (isNaN(n)) {
        // Older records predate the split fields; fall back to the printed string.
        var m = String(row.submittedTotal || '').match(/^\s*([\d.,]+)\s*([A-Za-z]{3})?/);
        if (!m) return;
        n = parseFloat(m[1].replace(/,/g, ''));
        if (isNaN(n)) return;
        var fallback = (m[2] || '').toUpperCase() || '—';
        if (!(fallback in totals)) { totals[fallback] = 0; order.push(fallback); }
        totals[fallback] += n;
        return;
      }
      var cur = (row.currency || '').toUpperCase() || '—';
      if (!(cur in totals)) { totals[cur] = 0; order.push(cur); }
      totals[cur] += n;
    });

    return order.map(function (cur) {
      var v = totals[cur];
      // Always two decimals: a total is money, and "1,452" beside "3,426.50"
      // reads like a different kind of number.
      var text = v.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return text + (cur === '—' ? '' : ' ' + cur);
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
      main.appendChild(el('div', 'list-row-name',
        scope === 'mine'
          ? (row.receiptType || 'Uncategorised')
          : (row.employeeName || row.employeeEmail || 'Unnamed')));
      main.appendChild(el('div', 'list-row-meta',
        scope === 'mine'
          ? fmtDate(row.submittedAt)
          : fmtDate(row.submittedAt) + ' · ' + (row.receiptType || 'Uncategorised')));
      btn.appendChild(main);

      btn.appendChild(el('span', 'list-row-amt', row.submittedTotal || '—'));
      btn.appendChild(el('span', 'badge ' + o.cls, o.label));

      btn.addEventListener('click', function () { select(row.caseId); });
      host.appendChild(btn);
    });

    $('list-empty').hidden = list.length > 0;
    $('list-empty').textContent = rows.length
      ? 'No claims match these filters.'
      : (EMPTY[scope] || 'Nothing here yet.');

    /* Both figures describe what is on screen, not the whole history — the
       point of choosing a period is to get that period's numbers. */
    var attention = list.filter(function (r) { return outcomeOf(r).key === 'attention'; }).length;
    var sums = sumByCurrency(list);
    updateExport();

    $('count-total').textContent = rows.length
      ? (list.length === rows.length
          ? rows.length + ' claims'
          : list.length + ' of ' + rows.length + ' claims')
      : (EMPTY[scope] || 'Nothing here yet');

    $('count-sum').textContent = sums.join('  ·  ');
    $('count-sum').hidden = sums.length === 0;

    $('count-attention').textContent = attention ? attention + ' need attention' : '';
    $('count-attention').hidden = attention === 0;
  }

  function loadList(quiet) {
    if (!me) return Promise.resolve();
    if (!quiet) pageError('');

    return api('/api/claims?scope=' + encodeURIComponent(scope))
      .then(function (data) {
        rows = data.submissions || [];
        // The server has the final word on scope, so if it narrowed the request
        // the tab bar has to follow it rather than the URL we asked with.
        if (data.scope && data.scope !== scope) {
          scope = data.scope;
          if (window.renderNav) window.renderNav(me, scope);
        }
        refreshPeopleFilter();
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

  /* The export carries whatever the list is showing, so the CSV and the screen
     can never disagree about which period they cover. */
  function updateExport() {
    var win = currentWindow();
    var url = '/api/claims.csv?scope=' + encodeURIComponent(scope);
    if (win.from !== null) url += '&fromMs=' + win.from;
    if (win.to !== null) url += '&toMs=' + win.to;
    $('export-link').href = url;
  }

  function periodChanged() {
    var custom = $('filter-period').value === 'custom';
    $('custom-range').hidden = !custom;
    renderList();
  }

  $('search').addEventListener('input', renderList);
  $('filter-status').addEventListener('change', renderList);
  if ($('filter-person')) $('filter-person').addEventListener('change', renderList);
  $('filter-period').addEventListener('change', periodChanged);
  $('date-from').addEventListener('change', renderList);
  $('date-to').addEventListener('change', renderList);

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
    head.appendChild(el('h2', '',
      scope === 'mine'
        ? (row.receiptType || 'Expense claim')
        : (row.employeeName || 'Submission')));
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
      api('/api/claims/' + encodeURIComponent(caseId))
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
      open.href = '/api/claims/' + encodeURIComponent(caseId) + '/receipt';
      open.target = '_blank';
      open.rel = 'noopener';
      acts.appendChild(open);
    }
    var refresh = el('button', 'btn btn-ghost btn-sm', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', function () { loadList(); });
    acts.appendChild(refresh);

    host.appendChild(acts);
  }

  /* -------------------------------- boot -------------------------------- */

  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (session) {
      if (!session.signedIn) { window.location.href = '/'; return; }

      // Everyone may look at their own claims; the other scopes need the role,
      // and the server re-checks regardless of what the URL asks for.
      if (scope === 'team' && session.roles.indexOf('manager') === -1) scope = 'mine';
      if (scope === 'all' && session.roles.indexOf('admin') === -1) scope = 'mine';

      me = session;
      if (window.renderNav) window.renderNav(session, scope);
      if (scope === 'mine') $('search').placeholder = 'Search category or manager';
      document.body.classList.remove('is-loading');
      loadList();
    })
    .catch(function () { window.location.href = '/'; });
})();
