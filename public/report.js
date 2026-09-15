/* Report — how much was claimed, and how much of it cleared the amount check.

   Managers see their own team, admins can see everyone. It reads the same
   /api/claims the workspace does and does the arithmetic in the browser, so the
   figures on this page and the rows in the list can never disagree.

   Two series, one measure, one axis: approved amount and needing-attention
   amount, grouped per month. Amounts are never converted between currencies —
   there is no rate in this app — so the page totals one currency at a time and
   offers a picker when more than one is present. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var me = null;
  var rows = [];
  var scope = 'team';

  /* ------------------------------ plumbing ------------------------------ */

  function api(pathname) {
    return fetch(pathname).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try { body = JSON.parse(text); }
        catch (e) { throw new Error('The server returned ' + res.status + ' instead of a result.'); }
        if (res.status === 401 || res.status === 403) {
          window.location.href = '/';
          throw new Error('signed-out');
        }
        if (!res.ok) throw new Error(body.error || 'Request failed.');
        return body;
      });
    });
  }

  function pageError(message) {
    var el = $('page-error');
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ------------------------------- periods ------------------------------ */

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }
  function endOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }

  /* Computed in the viewer's timezone, so "this month" is their month. */
  function periodWindow() {
    var key = $('rep-period').value;
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();

    switch (key) {
      case 'last-6':
        return { from: new Date(y, m - 5, 1).getTime(), to: endOfDay(now).getTime() };
      case 'last-12':
        return { from: new Date(y, m - 11, 1).getTime(), to: endOfDay(now).getTime() };
      case 'ytd':
        return { from: new Date(y, 0, 1).getTime(), to: endOfDay(now).getTime() };
      case 'month': {
        var v = $('rep-month').value;           // YYYY-MM
        if (!v) return { from: null, to: null };
        var parts = v.split('-');
        var yy = Number(parts[0]), mm = Number(parts[1]) - 1;
        return { from: new Date(yy, mm, 1).getTime(),
                 to: endOfDay(new Date(yy, mm + 1, 0)).getTime() };
      }
      case 'custom': {
        var f = $('rep-from').value, t = $('rep-to').value;
        return {
          from: f ? startOfDay(new Date(f + 'T12:00:00')).getTime() : null,
          to: t ? endOfDay(new Date(t + 'T12:00:00')).getTime() : null,
        };
      }
      default:
        return { from: null, to: null };
    }
  }

  function withinWindow(row, win) {
    if (win.from === null && win.to === null) return true;
    var t = new Date(row.submittedAt).getTime();
    if (isNaN(t)) return false;
    if (win.from !== null && t < win.from) return false;
    if (win.to !== null && t > win.to) return false;
    return true;
  }

  /* -------------------------------- shape ------------------------------- */

  /* Only finished claims carry a verdict, so running and failed ones are held
     out of the chart rather than counted as if they had been rejected. */
  function verdict(row) {
    if (row.state === 'failed') return 'failed';
    if (row.state === 'running') return 'running';
    return row.approved === true ? 'approved' : 'attention';
  }

  function amountOf(row) {
    var n = parseFloat(String(row.amount != null ? row.amount : '').replace(/,/g, ''));
    if (!isNaN(n)) return n;
    var m = String(row.submittedTotal || '').match(/^\s*([\d.,]+)/);
    if (!m) return NaN;
    return parseFloat(m[1].replace(/,/g, ''));
  }

  function currencyOf(row) {
    if (row.currency) return String(row.currency).toUpperCase();
    var m = String(row.submittedTotal || '').match(/([A-Za-z]{3})\s*$/);
    return m ? m[1].toUpperCase() : '';
  }

  function monthKey(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function monthLabel(key) {
    var parts = key.split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }

  function money(n, currency) {
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
           (currency ? ' ' + currency : '');
  }

  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  /* --------------------------- currency picker -------------------------- */

  function refreshCurrencies(list) {
    var sel = $('rep-currency');
    var seen = {};
    var order = [];

    list.forEach(function (row) {
      var c = currencyOf(row) || '—';
      if (!seen[c]) { seen[c] = 0; order.push(c); }
      seen[c] += 1;
    });

    // Most-used first, so the default picks the currency the team actually uses.
    order.sort(function (a, b) { return seen[b] - seen[a]; });

    var previous = sel.value;
    sel.innerHTML = '';
    order.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c === '—' ? 'Unspecified' : c;
      sel.appendChild(opt);
    });

    if (order.indexOf(previous) !== -1) sel.value = previous;
    sel.parentNode.hidden = order.length < 2;
    return sel.value || (order[0] || '');
  }

  /* -------------------------------- chart ------------------------------- */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function node(name, attrs) {
    var e = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /* Grouped bars: one pair per month. The bars carry 4px rounded tops, a 2px
     gap between the pair, and a hover tooltip; the legend and the table below
     mean the two series are never told apart by colour alone. */
  function drawChart(buckets, currency) {
    var host = $('chart');
    host.innerHTML = '';

    var W = Math.max(host.clientWidth || 720, 320);
    var H = 300;
    var padL = 54, padR = 12, padT = 14, padB = 38;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var max = 0;
    buckets.forEach(function (b) { max = Math.max(max, b.approved, b.attention); });
    if (max <= 0) max = 1;

    // A round ceiling so the gridline labels are readable numbers.
    var step = Math.pow(10, Math.floor(Math.log10(max)));
    var ceiling = Math.ceil(max / step) * step;
    if (ceiling / max > 1.6 && step > 1) ceiling = Math.ceil(max / (step / 2)) * (step / 2);

    var svg = node('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      width: '100%', height: H, role: 'presentation',
    });

    /* gridlines + y labels — recessive, behind the marks */
    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH;
      svg.appendChild(node('line', {
        x1: padL, x2: W - padR, y1: y, y2: y,
        class: f === 0 ? 'grid grid-base' : 'grid',
      }));
      var label = node('text', { x: padL - 9, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
      label.textContent = compact(ceiling * f);
      svg.appendChild(label);
    });

    var slot = plotW / buckets.length;
    var pairW = Math.min(slot * 0.62, 84);
    var barW = (pairW - 2) / 2;               // 2px surface gap inside the pair

    buckets.forEach(function (b, i) {
      var cx = padL + slot * i + slot / 2;
      var x0 = cx - pairW / 2;

      [['approved', b.approved, x0], ['attention', b.attention, x0 + barW + 2]].forEach(function (pair) {
        var key = pair[0], value = pair[1], x = pair[2];
        // A month with nothing in this series draws nothing — a 1px stub would
        // still catch the pointer and report "0.00, 0 claims" as if it were data.
        if (!(value > 0)) return;

        var h = Math.max((value / ceiling) * plotH, 2);
        var r = Math.min(4, barW / 2, h);
        var y = padT + plotH - h;

        var rect = node('rect', {
          x: x, y: y, width: barW, height: h, rx: r,
          class: 'bar bar-' + key,
        });
        rect.dataset.month = b.label;
        rect.dataset.series = key === 'approved' ? 'Approved' : 'Needs attention';
        rect.dataset.value = money(value, currency);
        rect.dataset.count = key === 'approved' ? b.approvedCount : b.attentionCount;
        svg.appendChild(rect);
      });

      /* x label */
      var t = node('text', { x: cx, y: H - 14, class: 'axis-label', 'text-anchor': 'middle' });
      t.textContent = b.label;
      svg.appendChild(t);
    });

    host.appendChild(svg);
    wireTooltip(host);
  }

  function wireTooltip(host) {
    var tip = $('chart-tip');

    host.addEventListener('mousemove', function (e) {
      var bar = e.target.closest ? e.target.closest('.bar') : null;
      if (!bar) { tip.hidden = true; return; }

      tip.innerHTML = '';
      tip.appendChild(el('div', 'tip-head', bar.dataset.month));
      var line = el('div', 'tip-line');
      line.appendChild(el('span', 'swatch ' + (bar.classList.contains('bar-approved') ? 'swatch-ok' : 'swatch-warn')));
      line.appendChild(el('span', 'tip-series', bar.dataset.series));
      line.appendChild(el('span', 'tip-value', bar.dataset.value));
      tip.appendChild(line);
      tip.appendChild(el('div', 'tip-foot', bar.dataset.count + ' claim' + (bar.dataset.count === '1' ? '' : 's')));

      var box = host.getBoundingClientRect();
      tip.hidden = false;
      var x = e.clientX - box.left + 14;
      if (x + tip.offsetWidth > box.width) x = e.clientX - box.left - tip.offsetWidth - 14;
      tip.style.left = Math.max(0, x) + 'px';
      tip.style.top = Math.max(0, e.clientY - box.top - 10) + 'px';
    });

    host.addEventListener('mouseleave', function () { tip.hidden = true; });
  }

  /* ------------------------------- render ------------------------------- */

  function render() {
    var win = periodWindow();
    var inWindow = rows.filter(function (row) { return withinWindow(row, win); });

    var currency = refreshCurrencies(inWindow);
    var list = inWindow.filter(function (row) {
      return (currencyOf(row) || '—') === currency;
    });

    /* bucket by month */
    var map = {};
    var order = [];
    var totals = { approved: 0, attention: 0, approvedCount: 0, attentionCount: 0, pending: 0 };

    list.forEach(function (row) {
      var v = verdict(row);
      if (v === 'running' || v === 'failed') { totals.pending += 1; return; }

      var key = monthKey(row.submittedAt);
      if (!key) return;
      if (!map[key]) {
        map[key] = { key: key, label: monthLabel(key), approved: 0, attention: 0,
                     approvedCount: 0, attentionCount: 0 };
        order.push(key);
      }

      var n = amountOf(row);
      if (isNaN(n)) n = 0;

      if (v === 'approved') {
        map[key].approved += n;
        map[key].approvedCount += 1;
        totals.approved += n;
        totals.approvedCount += 1;
      } else {
        map[key].attention += n;
        map[key].attentionCount += 1;
        totals.attention += n;
        totals.attentionCount += 1;
      }
    });

    order.sort();
    var buckets = order.map(function (k) { return map[k]; });

    /* headline tiles */
    $('t-approved').textContent = money(totals.approved, currency);
    $('t-approved-sub').textContent = totals.approvedCount + ' claim' + (totals.approvedCount === 1 ? '' : 's');
    $('t-attention').textContent = money(totals.attention, currency);
    $('t-attention-sub').textContent = totals.attentionCount + ' claim' + (totals.attentionCount === 1 ? '' : 's');

    var decided = totals.approved + totals.attention;
    $('t-rate').textContent = decided > 0 ? Math.round((totals.approved / decided) * 100) + '%' : '—';

    var counted = totals.approvedCount + totals.attentionCount;
    $('t-count').textContent = String(counted);
    $('t-count-sub').textContent = totals.pending
      ? totals.pending + ' still running or failed, not counted'
      : 'all decided';

    /* chart + table */
    $('chart-empty').hidden = buckets.length > 0;
    $('chart').hidden = buckets.length === 0;
    $('chart-sub').textContent = buckets.length === 1
      ? monthLabel(buckets[0].key) + ' · amounts in ' + currency
      : 'By month · amounts in ' + currency;

    if (buckets.length) drawChart(buckets, currency);

    var body = $('table-body');
    body.innerHTML = '';
    buckets.forEach(function (b) {
      var tr = document.createElement('tr');
      tr.appendChild(el('th', '', b.label));
      tr.appendChild(el('td', 'num', money(b.approved, '')));
      tr.appendChild(el('td', 'num', money(b.attention, '')));
      tr.appendChild(el('td', 'num', String(b.approvedCount + b.attentionCount)));
      body.appendChild(tr);
    });
  }

  /* ------------------------------ controls ------------------------------ */

  function periodChanged() {
    var key = $('rep-period').value;
    $('month-wrap').hidden = key !== 'month';
    $('from-wrap').hidden = key !== 'custom';
    $('to-wrap').hidden = key !== 'custom';

    if (key === 'month' && !$('rep-month').value) {
      var now = new Date();
      $('rep-month').value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
    render();
  }

  function load() {
    pageError('');
    return api('/api/claims?scope=' + encodeURIComponent(scope))
      .then(function (data) {
        rows = data.submissions || [];
        scope = data.scope || scope;
        $('report-lede').textContent = scope === 'all'
          ? 'Every claim submitted through the portal, and how much of it cleared the amount check.'
          : 'Claims from the people who named you as their manager, and how much of it cleared the amount check.';
        render();
      })
      .catch(function (err) {
        if (err.message !== 'signed-out') pageError(err.message);
      });
  }

  $('rep-period').addEventListener('change', periodChanged);
  $('rep-month').addEventListener('change', render);
  $('rep-from').addEventListener('change', render);
  $('rep-to').addEventListener('change', render);
  $('rep-currency').addEventListener('change', render);
  $('rep-scope').addEventListener('change', function () {
    scope = $('rep-scope').value;
    load();
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  /* -------------------------------- boot -------------------------------- */

  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (session) {
      if (!session.signedIn) { window.location.href = '/'; return; }

      var isAdmin = session.roles.indexOf('admin') !== -1;
      var isManager = session.roles.indexOf('manager') !== -1;
      if (!isAdmin && !isManager) { window.location.href = '/'; return; }

      me = session;
      scope = isAdmin ? 'all' : 'team';

      // Only somebody who holds both roles has a choice to make.
      if (isAdmin && isManager) {
        $('scope-wrap').hidden = false;
        $('rep-scope').value = 'all';
      }

      if (window.renderNav) window.renderNav(session, 'report');
      document.body.classList.remove('is-loading');
      load();
    })
    .catch(function () { window.location.href = '/'; });
})();
