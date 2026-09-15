/* Report — how much was claimed, and how much of it cleared the amount check.

   Laid out as chapters: the headline numbers stay pinned across the top while
   the panel beside the chapter list slides in and out. Managers see their own
   team, admins can see everyone. It reads the same /api/claims the workspace
   does and does the arithmetic in the browser, so the figures here and the rows
   in the list can never disagree.

   Two series, one measure, one axis: approved amount and needing-attention
   amount. Amounts are never converted between currencies — there is no rate in
   this app — so the page totals one currency at a time and offers a picker when
   more than one is present. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var me = null;
  var rows = [];
  var scope = 'team';
  var current = 0;        // which chapter is open
  var view = null;        // the numbers behind whatever is on screen

  var REDUCED = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  function slot(root, name) { return root.querySelector('[data-slot="' + name + '"]'); }

  /* ------------------------------ animation ----------------------------- */

  var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };

  /* Numbers roll up to their value rather than appearing. Each element keeps
     its own handle so a fast change of period cancels the run in flight
     instead of two of them fighting over the same text node. */
  function countTo(node, to, format, ms) {
    if (!node) return;
    if (node._anim) cancelAnimationFrame(node._anim);

    var from = typeof node._value === 'number' ? node._value : 0;
    node._value = to;

    if (REDUCED || from === to) { node.textContent = format(to); return; }

    var start = performance.now();
    var span = ms || 720;

    (function step(now) {
      var t = Math.min((now - start) / span, 1);
      node.textContent = format(from + (to - from) * easeOut(t));
      if (t < 1) node._anim = requestAnimationFrame(step);
      else node._anim = null;
    })(start);
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
        var v = $('rep-month').value;                   // YYYY-MM
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

  function periodLabel() {
    var key = $('rep-period').value;
    if (key === 'month' && $('rep-month').value) return monthLabelLong($('rep-month').value);
    if (key === 'custom') {
      var f = $('rep-from').value, t = $('rep-to').value;
      if (f || t) return (f || 'the start') + ' → ' + (t || 'today');
    }
    return {
      'last-6': 'Last 6 months', 'last-12': 'Last 12 months',
      'ytd': 'This year', 'all': 'All time',
    }[key] || 'This period';
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
     out of the figures rather than counted as if they had been rejected. */
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
    var p = key.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, 1)
      .toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }

  function monthLabelLong(key) {
    var p = key.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  var num = function (n) {
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  function money(n, currency) { return num(n) + (currency ? ' ' + currency : ''); }

  function compact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(n));
  }

  /* --------------------------- currency picker -------------------------- */

  function refreshCurrencies(list) {
    var sel = $('rep-currency');
    var seen = {}, order = [];

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
    sel.hidden = order.length < 2;
    return sel.value || (order[0] || '');
  }

  /* ------------------------------ the numbers --------------------------- */

  function compute() {
    var win = periodWindow();
    var inWindow = rows.filter(function (row) { return withinWindow(row, win); });
    var currency = refreshCurrencies(inWindow);
    var list = inWindow.filter(function (row) { return (currencyOf(row) || '—') === currency; });

    var months = {}, order = [];
    var people = {}, cats = {};
    var totals = { approved: 0, attention: 0, approvedCount: 0, attentionCount: 0, pending: 0 };
    var chase = [];

    list.forEach(function (row) {
      var v = verdict(row);
      if (v === 'running' || v === 'failed') { totals.pending += 1; return; }

      var n = amountOf(row);
      if (isNaN(n)) n = 0;
      var approved = v === 'approved';

      var key = monthKey(row.submittedAt);
      if (key) {
        if (!months[key]) {
          months[key] = { key: key, label: monthLabel(key), approved: 0, attention: 0,
                          approvedCount: 0, attentionCount: 0 };
          order.push(key);
        }
        months[key][approved ? 'approved' : 'attention'] += n;
        months[key][approved ? 'approvedCount' : 'attentionCount'] += 1;
      }

      function bucket(store, name) {
        if (!name) return;
        if (!store[name]) store[name] = { name: name, approved: 0, attention: 0, count: 0 };
        store[name][approved ? 'approved' : 'attention'] += n;
        store[name].count += 1;
      }
      bucket(people, row.employeeName || row.employeeEmail);
      bucket(cats, row.receiptType || 'Uncategorised');

      totals[approved ? 'approved' : 'attention'] += n;
      totals[approved ? 'approvedCount' : 'attentionCount'] += 1;

      if (!approved) chase.push(row);
    });

    function rank(store) {
      return Object.keys(store).map(function (k) { return store[k]; })
        .sort(function (a, b) {
          return (b.approved + b.attention) - (a.approved + a.attention);
        });
    }

    order.sort();
    chase.sort(function (a, b) { return amountOf(b) - amountOf(a); });

    return {
      currency: currency,
      totals: totals,
      months: order.map(function (k) { return months[k]; }),
      people: rank(people),
      cats: rank(cats),
      chase: chase,
    };
  }

  /* ------------------------------- ribbon ------------------------------- */

  function renderRibbon(v) {
    var c = v.currency;
    var t = v.totals;

    countTo($('k-approved'), t.approved, function (n) { return money(n, c); });
    countTo($('k-attention'), t.attention, function (n) { return money(n, c); });

    var decided = t.approved + t.attention;
    countTo($('k-rate'), decided > 0 ? (t.approved / decided) * 100 : 0,
            function (n) { return Math.round(n) + '%'; });

    var counted = t.approvedCount + t.attentionCount;
    countTo($('k-count'), counted, function (n) { return String(Math.round(n)); });

    $('k-approved-sub').textContent = t.approvedCount + ' claim' + (t.approvedCount === 1 ? '' : 's');
    $('k-attention-sub').textContent = t.attentionCount + ' claim' + (t.attentionCount === 1 ? '' : 's');
    $('k-count-sub').textContent = t.pending
      ? t.pending + ' not counted'
      : (counted ? 'all decided' : 'nothing yet');
  }

  /* ------------------------------ chapter 1 ----------------------------- */

  var RING_R = 48;
  var RING_C = 2 * Math.PI * RING_R;

  function panelHeadline(v) {
    var node = $('tpl-headline').content.cloneNode(true);
    var root = node.firstElementChild;
    var c = v.currency, t = v.totals;

    slot(root, 'period').textContent = periodLabel() + ' · amounts in ' + c;
    slot(root, 'approved-sub').textContent =
      'approved across ' + t.approvedCount + ' claim' + (t.approvedCount === 1 ? '' : 's');
    slot(root, 'attention-sub').textContent =
      'needs attention · ' + t.attentionCount + ' claim' + (t.attentionCount === 1 ? '' : 's');

    var decided = t.approved + t.attention;
    var pct = decided > 0 ? (t.approved / decided) * 100 : 0;

    slot(root, 'ring-label').setAttribute('aria-label',
      Math.round(pct) + '% of claimed value cleared the amount check');
    slot(root, 'ring-note').textContent = decided > 0
      ? money(t.approved, c) + ' of ' + money(decided, c)
      : 'No decided claims in this period';

    /* The arc is drawn from zero every time the panel opens: dasharray is the
       full circumference, and the offset animates down to the target. */
    var arc = slot(root, 'arc');
    arc.style.strokeDasharray = RING_C + ' ' + RING_C;
    arc.style.strokeDashoffset = RING_C;

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        arc.style.strokeDashoffset = RING_C * (1 - pct / 100);
      });
    });

    countTo(slot(root, 'approved'), t.approved, num, 900);
    countTo(slot(root, 'attention'), t.attention, num, 900);
    countTo(slot(root, 'pct'), pct, function (n) { return Math.round(n) + '%'; }, 900);

    return root;
  }

  /* ------------------------------ chapter 2 ----------------------------- */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgNode(name, attrs) {
    var e = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /* Grouped bars, one pair per month, growing up from the baseline. 4px rounded
     tops, a 2px gap inside the pair, a hover tooltip; the legend and the table
     below mean the two series are never told apart by colour alone. */
  function drawChart(host, tip, buckets, currency) {
    host.innerHTML = '';

    var W = Math.max(host.clientWidth || 700, 320);
    var H = 280;
    var padL = 54, padR = 12, padT = 14, padB = 36;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var max = 0;
    buckets.forEach(function (b) { max = Math.max(max, b.approved, b.attention); });
    if (max <= 0) max = 1;

    // A round ceiling so the gridline labels are readable numbers.
    var step = Math.pow(10, Math.floor(Math.log10(max)));
    var ceiling = Math.ceil(max / step) * step;
    if (ceiling / max > 1.6 && step > 1) ceiling = Math.ceil(max / (step / 2)) * (step / 2);

    var svg = svgNode('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H,
                               role: 'presentation' });

    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var y = padT + plotH - f * plotH;
      svg.appendChild(svgNode('line', { x1: padL, x2: W - padR, y1: y, y2: y,
                                        class: f === 0 ? 'grid grid-base' : 'grid' }));
      var label = svgNode('text', { x: padL - 9, y: y + 4, class: 'axis-label', 'text-anchor': 'end' });
      label.textContent = compact(ceiling * f);
      svg.appendChild(label);
    });

    var slotW = plotW / buckets.length;
    var pairW = Math.min(slotW * 0.62, 84);
    var barW = (pairW - 2) / 2;                  // 2px surface gap inside the pair
    var baseline = padT + plotH;
    var grown = [];

    buckets.forEach(function (b, i) {
      var cx = padL + slotW * i + slotW / 2;
      var x0 = cx - pairW / 2;

      [['approved', b.approved, x0], ['attention', b.attention, x0 + barW + 2]].forEach(function (p) {
        var key = p[0], value = p[1], x = p[2];
        // A month with nothing in this series draws nothing — a 1px stub would
        // still catch the pointer and report "0.00, 0 claims" as if it were data.
        if (!(value > 0)) return;

        var h = Math.max((value / ceiling) * plotH, 2);
        var rect = svgNode('rect', {
          x: x, y: baseline - h, width: barW, height: h,
          rx: Math.min(4, barW / 2, h),
          class: 'bar bar-' + key,
        });
        rect.dataset.month = b.label;
        rect.dataset.series = key === 'approved' ? 'Approved' : 'Needs attention';
        rect.dataset.value = money(value, currency);
        rect.dataset.count = key === 'approved' ? b.approvedCount : b.attentionCount;

        // Grow from the baseline: scaling about the foot of the bar animates
        // cheaply on the compositor and needs no per-frame work.
        if (!REDUCED) {
          rect.style.transformOrigin = x + 'px ' + baseline + 'px';
          rect.style.transform = 'scaleY(0)';
          grown.push(rect);
        }
        svg.appendChild(rect);
      });

      var t = svgNode('text', { x: cx, y: H - 12, class: 'axis-label', 'text-anchor': 'middle' });
      t.textContent = b.label;
      svg.appendChild(t);
    });

    host.appendChild(svg);

    grown.forEach(function (rect, i) {
      rect.style.transition = 'transform .55s cubic-bezier(.2,.7,.3,1) ' + (i * 28) + 'ms';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { rect.style.transform = 'scaleY(1)'; });
      });
    });

    wireTooltip(host, tip);
  }

  function wireTooltip(host, tip) {
    host.addEventListener('mousemove', function (e) {
      var bar = e.target.closest ? e.target.closest('.bar') : null;
      if (!bar) { tip.hidden = true; return; }

      tip.innerHTML = '';
      tip.appendChild(el('div', 'tip-head', bar.dataset.month));
      var line = el('div', 'tip-line');
      line.appendChild(el('span', 'swatch ' +
        (bar.classList.contains('bar-approved') ? 'swatch-ok' : 'swatch-warn')));
      line.appendChild(el('span', 'tip-series', bar.dataset.series));
      line.appendChild(el('span', 'tip-value', bar.dataset.value));
      tip.appendChild(line);
      tip.appendChild(el('div', 'tip-foot',
        bar.dataset.count + ' claim' + (bar.dataset.count === '1' ? '' : 's')));

      var box = host.getBoundingClientRect();
      tip.hidden = false;
      var x = e.clientX - box.left + 14;
      if (x + tip.offsetWidth > box.width) x = e.clientX - box.left - tip.offsetWidth - 14;
      tip.style.left = Math.max(0, x) + 'px';
      tip.style.top = Math.max(0, e.clientY - box.top - 10) + 'px';
    });

    host.addEventListener('mouseleave', function () { tip.hidden = true; });
  }

  function panelChart(v) {
    var root = $('tpl-chart').content.cloneNode(true).firstElementChild;
    var host = slot(root, 'chart');
    var tip = slot(root, 'tip');

    slot(root, 'title').textContent = v.months.length === 1
      ? monthLabelLong(v.months[0].key) + ' · amounts in ' + v.currency
      : 'By month · amounts in ' + v.currency;

    var body = slot(root, 'table');
    v.months.forEach(function (b) {
      var tr = document.createElement('tr');
      tr.appendChild(el('th', '', b.label));
      tr.appendChild(el('td', 'num', num(b.approved)));
      tr.appendChild(el('td', 'num', num(b.attention)));
      tr.appendChild(el('td', 'num', String(b.approvedCount + b.attentionCount)));
      body.appendChild(tr);
    });

    if (!v.months.length) {
      slot(root, 'empty').hidden = false;
      host.hidden = true;
      return root;
    }

    // The panel is not in the document yet, so the chart needs a frame to learn
    // how wide it is before it can lay itself out.
    requestAnimationFrame(function () { drawChart(host, tip, v.months, v.currency); });
    return root;
  }

  /* --------------------------- chapters 3 and 4 -------------------------- */

  function panelBars(items, eyebrow, title, empty) {
    var root = $('tpl-bars').content.cloneNode(true).firstElementChild;
    slot(root, 'eyebrow').textContent = eyebrow;
    slot(root, 'title').textContent = title;

    var host = slot(root, 'rank');
    if (!items.length) {
      slot(root, 'empty').textContent = empty;
      slot(root, 'empty').hidden = false;
      return root;
    }

    var max = 0;
    items.forEach(function (it) { max = Math.max(max, it.approved + it.attention); });
    if (max <= 0) max = 1;

    items.slice(0, 8).forEach(function (it, i) {
      var total = it.approved + it.attention;

      var row = el('div', 'rank-row');
      row.appendChild(el('span', 'rank-name', it.name));

      /* One stacked bar per row: approved then needing attention, with a 2px
         gap between the two fills so they never read as one block. */
      var track = el('span', 'rank-track');
      var okFill = el('span', 'rank-fill rank-ok');
      var warnFill = el('span', 'rank-fill rank-warn');
      track.appendChild(okFill);
      track.appendChild(warnFill);
      row.appendChild(track);

      var value = el('span', 'rank-value', num(total));
      row.appendChild(value);

      var meta = el('span', 'rank-meta', it.count + ' claim' + (it.count === 1 ? '' : 's'));
      row.appendChild(meta);

      host.appendChild(row);

      var okPct = (it.approved / max) * 100;
      var warnPct = (it.attention / max) * 100;

      if (REDUCED) {
        okFill.style.width = okPct + '%';
        warnFill.style.width = warnPct + '%';
      } else {
        okFill.style.transitionDelay = (i * 55) + 'ms';
        warnFill.style.transitionDelay = (i * 55 + 60) + 'ms';
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            okFill.style.width = okPct + '%';
            warnFill.style.width = warnPct + '%';
          });
        });
        countTo(value, total, num, 700 + i * 40);
      }
    });

    return root;
  }

  /* ------------------------------ chapter 5 ----------------------------- */

  function panelChase(v) {
    var root = $('tpl-chase').content.cloneNode(true).firstElementChild;
    var t = v.totals;

    slot(root, 'title').textContent = t.attentionCount
      ? t.attentionCount + ' claim' + (t.attentionCount === 1 ? '' : 's') + ' · ' +
        money(t.attention, v.currency)
      : 'Nothing outstanding';

    var host = slot(root, 'list');
    if (!v.chase.length) {
      slot(root, 'empty').hidden = false;
      return root;
    }

    v.chase.slice(0, 40).forEach(function (row, i) {
      var item = el('a', 'chase-row');
      item.href = 'workspace.html?scope=' + encodeURIComponent(scope);

      var who = el('span', 'chase-who');
      who.appendChild(el('span', 'chase-name', row.employeeName || row.employeeEmail || 'Unnamed'));
      who.appendChild(el('span', 'chase-meta',
        (row.receiptType || 'Uncategorised') + ' · ' + fmtDate(row.submittedAt)));
      item.appendChild(who);

      var right = el('span', 'chase-right');
      var n = amountOf(row);
      right.appendChild(el('span', 'chase-amount',
        money(isNaN(n) ? 0 : n, v.currency)));
      right.appendChild(el('span', 'badge badge-warn', 'Needs attention'));
      item.appendChild(right);

      if (!REDUCED) {
        item.style.animationDelay = (i * 45) + 'ms';
        item.classList.add('chase-in');
      }
      host.appendChild(item);
    });

    return root;
  }

  /* ------------------------------ chapters ------------------------------ */

  var CHAPTERS = [
    { title: 'Headline',      blurb: 'The period at a glance', build: function (v) { return panelHeadline(v); } },
    { title: 'Over time',     blurb: 'Month by month',         build: function (v) { return panelChart(v); } },
    { title: 'By person',     blurb: 'Who is claiming what',   build: function (v) {
        return panelBars(v.people, 'By person', 'Claimed value per person',
                         'Nobody has claimed in this period.'); } },
    { title: 'By category',   blurb: 'Where the money goes',   build: function (v) {
        return panelBars(v.cats, 'By category', 'Claimed value per category',
                         'No categories to show for this period.'); } },
    { title: 'Needs chasing', blurb: 'Still open',             build: function (v) { return panelChase(v); } },
  ];

  function renderChapterList() {
    var host = $('chapter-list');
    host.innerHTML = '';

    CHAPTERS.forEach(function (ch, i) {
      var b = el('button', 'chapter' + (i === current ? ' is-current' : ''));
      b.type = 'button';
      b.setAttribute('aria-current', i === current ? 'true' : 'false');

      b.appendChild(el('span', 'chapter-num', '0' + (i + 1)));
      var text = el('span', 'chapter-text');
      text.appendChild(el('span', 'chapter-title', ch.title));
      text.appendChild(el('span', 'chapter-blurb', ch.blurb));
      b.appendChild(text);

      b.addEventListener('click', function () { openChapter(i); });
      host.appendChild(b);
    });
  }

  function openChapter(i) {
    current = i;
    renderChapterList();

    var body = $('chapter-body');
    body.innerHTML = '';
    if (view) body.appendChild(CHAPTERS[i].build(view));
  }

  /* ------------------------------- render ------------------------------- */

  function render() {
    view = compute();
    renderRibbon(view);
    openChapter(current);
  }

  /* ------------------------------ controls ------------------------------ */

  function periodChanged() {
    var key = $('rep-period').value;
    $('rep-month').hidden = key !== 'month';
    $('rep-from').hidden = key !== 'custom';
    $('rep-to').hidden = key !== 'custom';

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

  // Only the chart needs to know the width changed, and only when it is open.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (current !== 1) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { openChapter(1); }, 180);
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
        $('rep-scope').hidden = false;
        $('rep-scope').value = 'all';
      }

      if (window.renderNav) window.renderNav(session, 'report');
      renderChapterList();
      document.body.classList.remove('is-loading');
      load();
    })
    .catch(function () { window.location.href = '/'; });
})();
