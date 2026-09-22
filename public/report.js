/* Report: approved against rejected amounts, by month.
   Two series, so two categorical hues, blue and orange, validated for colour
   vision deficiency against both surfaces. Never green against red: that pair
   is the one most people cannot separate, and this chart is about money. */

(function () {
  'use strict';

  var $ = ATV.$;
  var esc = ATV.esc;
  var current = null;

  function currentRange() {
    var preset = $('#filter-preset').value;
    if (preset === 'custom') {
      return { from: $('#filter-from').value, to: $('#filter-to').value };
    }
    return ATV.rangeFor(preset, $('#filter-month').value);
  }

  function describeRange(range) {
    if (!range.from && !range.to) return 'All time';
    if (range.from && range.to) return range.from + ' to ' + range.to;
    return range.from ? 'From ' + range.from : 'Up to ' + range.to;
  }

  function statsHtml(report) {
    var t = report.totals || {};
    var c = report.currency;
    var runs = function (n) {
      return n + (n === 1 ? ' run' : ' runs');
    };
    var amount = function (value) {
      return ATV.money(value, c) || (c ? ATV.money(0, c) : '0');
    };
    var cells = [
      { n: amount(t.approved.amount), k: 'Approved', sub: runs(t.approved.count) },
      { n: amount(t.rejected.amount), k: 'Rejected', sub: runs(t.rejected.count) },
      { n: amount(t.returned.amount), k: 'Sent back', sub: runs(t.returned.count) },
      { n: amount(t.pending.amount), k: 'Awaiting a decision', sub: runs(t.pending.count) },
      {
        n: String(report.runs || 0),
        k: 'Submitted in the period',
        sub: t.unfinished && t.unfinished.count ? runs(t.unfinished.count) + ' did not finish' : ''
      }
    ];
    return cells
      .map(function (cell) {
        return (
          '<div class="stat"><div class="n" style="font-size: 18px">' +
          esc(cell.n) +
          '</div><div class="k">' +
          esc(cell.k) +
          (cell.sub ? ', ' + esc(cell.sub) : '') +
          '</div></div>'
        );
      })
      .join('');
  }

  /* A grouped bar chart drawn as plain SVG: two bars per month, a baseline,
     four grid lines, direct labels on the tallest pair only, and a tooltip on
     every bar. No library, so nothing to load and nothing to break. */
  function chartHtml(report) {
    var months = report.months || [];
    if (!months.length) {
      return '<div class="empty"><strong>Nothing to plot yet</strong>No runs were submitted in this period.</div>';
    }

    var decided = (report.totals.approved.amount || 0) + (report.totals.rejected.amount || 0);
    var decidedCount = report.totals.approved.count + report.totals.rejected.count;
    if (decided <= 0) {
      return (
        '<div class="empty"><strong>No approved or rejected amounts yet</strong>' +
        (decidedCount
          ? 'Decisions were recorded, but no amount was read from those packets.'
          : report.totals.pending.count +
            ' run' +
            (report.totals.pending.count === 1 ? '' : 's') +
            ' in this period are still waiting for a decision.') +
        '</div>'
      );
    }

    // A shrunken desktop chart is unreadable on a phone, so the geometry is
    // chosen from the width the chart actually has.
    var narrow = window.innerWidth < 720;
    var W = narrow ? 380 : 860;
    var H = narrow ? 300 : 300;
    var padL = narrow ? 52 : 68;
    var padR = narrow ? 10 : 16;
    var padT = 18;
    var padB = narrow ? 40 : 44;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;

    var peak = 0;
    months.forEach(function (m) {
      peak = Math.max(peak, m.approved.amount, m.rejected.amount);
    });
    if (peak <= 0) peak = 1;
    var top = Math.pow(10, Math.floor(Math.log10(peak)));
    top = Math.ceil(peak / top) * top;

    var slot = plotW / months.length;
    var barW = Math.min(narrow ? 26 : 44, Math.max(10, (slot - (narrow ? 12 : 18)) / 2));
    var gap = 2; // the surface gap the mark specs ask for between adjacent bars

    var y = function (value) {
      return padT + plotH - (value / top) * plotH;
    };

    var gridLines = [0, 0.25, 0.5, 0.75, 1]
      .map(function (fraction) {
        var value = top * fraction;
        var yy = y(value);
        return (
          '<line class="grid-line" x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '"/>' +
          '<text class="axis-text" x="' + (padL - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' +
          esc(ATV.moneyShort(value, report.currency)) +
          '</text>'
        );
      })
      .join('');

    var tallest = months.reduce(function (best, m, i) {
      var v = Math.max(m.approved.amount, m.rejected.amount);
      return v > best.v ? { v: v, i: i } : best;
    }, { v: -1, i: -1 });

    var bars = months
      .map(function (m, i) {
        var centre = padL + slot * i + slot / 2;
        var leftX = centre - barW - gap / 2;
        var rightX = centre + gap / 2;

        var one = function (kind, x) {
          var value = m[kind].amount;
          var h = Math.max(value > 0 ? 3 : 0, padT + plotH - y(value));
          var top4 = h >= 4 ? 4 : h;
          var rect =
            '<rect class="bar-' + kind + '" x="' + x + '" y="' + (padT + plotH - h) + '" width="' + barW +
            '" height="' + h + '" rx="' + top4 + '"/>';
          var hit =
            '<rect class="hit" x="' + x + '" y="' + padT + '" width="' + barW + '" height="' + plotH +
            '" data-month="' + esc(m.key) + '" data-kind="' + kind + '" data-amount="' +
            esc(ATV.money(value, report.currency)) + '" data-count="' + m[kind].count + '"/>';
          var label =
            i === tallest.i && value > 0
              ? '<text class="value-text" x="' + (x + barW / 2) + '" y="' + (padT + plotH - h - 6) +
                '" text-anchor="middle">' + esc(ATV.moneyShort(value, report.currency)) + '</text>'
              : '';
          return rect + label + hit;
        };

        var none =
          m.approved.amount <= 0 && m.rejected.amount <= 0
            ? '<text class="axis-text" x="' + centre + '" y="' + (padT + plotH - 8) +
              '" text-anchor="middle">No decisions</text>'
            : '';
        return (
          one('approved', leftX) +
          one('rejected', rightX) +
          none +
          '<text class="axis-text" x="' + centre + '" y="' + (H - 18) + '" text-anchor="middle">' +
          esc(ATV.monthLabel(m.key)) +
          '</text>'
        );
      })
      .join('');

    return (
      '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="Approved and rejected amounts by month">' +
      gridLines +
      bars +
      '<line class="grid-line" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) +
      '" y2="' + (padT + plotH) + '"/>' +
      '</svg>'
    );
  }

  function tableHtml(report) {
    var months = report.months || [];
    if (!months.length) return '<p class="card-sub" style="margin: 0">Nothing in this period.</p>';
    return (
      '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>Month</th><th class="num">Approved</th><th class="num">Rejected</th>' +
      '<th class="num">Sent back</th><th class="num">Awaiting</th>' +
      '</tr></thead><tbody>' +
      months
        .map(function (m) {
          var cell = function (kind, label) {
            return (
              '<td class="num" data-label="' + label + '"><div>' +
              esc(ATV.money(m[kind].amount, report.currency) || '0') +
              '</div><div class="card-sub" style="margin: 0">' +
              m[kind].count +
              (m[kind].count === 1 ? ' run' : ' runs') +
              '</div></td>'
            );
          };
          return (
            '<tr><td data-label="Month">' +
            esc(ATV.monthLabel(m.key)) +
            '</td>' +
            cell('approved', 'Approved') +
            cell('rejected', 'Rejected') +
            cell('returned', 'Sent back') +
            cell('pending', 'Awaiting') +
            '</tr>'
          );
        })
        .join('') +
      '</tbody></table></div>'
    );
  }

  function wireTooltip() {
    var tip = document.getElementById('chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'chart-tip';
      tip.className = 'chart-tip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    ATV.$$('#chart-host rect.hit').forEach(function (hit) {
      hit.addEventListener('mousemove', function (event) {
        tip.innerHTML =
          '<b>' +
          esc(ATV.monthLabel(hit.getAttribute('data-month'))) +
          '</b>' +
          esc(hit.getAttribute('data-kind') === 'approved' ? 'Approved' : 'Rejected') +
          ': ' +
          esc(hit.getAttribute('data-amount') || '0') +
          '<br>' +
          esc(hit.getAttribute('data-count')) +
          ' runs';
        tip.hidden = false;
        tip.style.left = Math.min(event.clientX + 14, window.innerWidth - 190) + 'px';
        tip.style.top = Math.max(event.clientY - 54, 8) + 'px';
      });
      hit.addEventListener('mouseleave', function () {
        tip.hidden = true;
      });
    });
  }

  function load() {
    var range = currentRange();
    var query = ATV.rangeQuery(range);
    var currency = $('#filter-currency').value;
    if (currency) query += (query ? '&' : '') + 'currency=' + encodeURIComponent(currency);

    // The pill repeats the preset when nothing is narrowed, so it only shows
    // once a real range is in play.
    $('#range-pill').hidden = !range.from && !range.to;
    $('#range-pill').textContent = describeRange(range);
    $('#export-link').href = '/api/export.csv' + (ATV.rangeQuery(range) ? '?' + ATV.rangeQuery(range) : '');

    ATV.fetchJson('/api/report' + (query ? '?' + query : ''))
      .then(function (report) {
        current = report;
        if (!report.configured) {
          $('#chart-host').innerHTML =
            '<div class="notice notice-warn"><span class="glyph">▲</span> ' +
            esc(report.note || 'Reporting needs run history.') +
            '</div>';
          $('#report-stats').hidden = true;
          return;
        }
        $('#report-stats').hidden = false;
        $('#report-stats').innerHTML = statsHtml(report);
        $('#chart-host').innerHTML = chartHtml(report);
        $('#chart-table').innerHTML = tableHtml(report);
        wireTooltip();

        var select = $('#filter-currency');
        if (report.currencies && report.currencies.length > 1) {
          if (select.options.length !== report.currencies.length) {
            select.innerHTML = report.currencies
              .map(function (c) {
                return '<option value="' + esc(c) + '">' + esc(c) + ' amounts</option>';
              })
              .join('');
            select.value = report.currency;
          }
          select.hidden = false;
          $('#currency-pill').hidden = false;
          $('#currency-pill').textContent = 'Amounts in ' + report.currency;
        } else {
          select.hidden = true;
          $('#currency-pill').hidden = !report.currency;
          $('#currency-pill').textContent = report.currency ? 'Amounts in ' + report.currency : '';
        }
      })
      .catch(function (err) {
        if (ATV.onAuthLoss(err)) return;
        $('#chart-host').innerHTML =
          '<div class="notice notice-bad"><span class="glyph">!</span> The report could not be read: ' +
          esc(err.message) +
          '</div>';
      });
  }

  function syncControls() {
    var preset = $('#filter-preset').value;
    $('#filter-month').hidden = preset !== 'month';
    $('#custom-wrap').hidden = preset !== 'custom';
    if (preset === 'month' && !$('#filter-month').value) {
      $('#filter-month').value = new Date().toISOString().slice(0, 7);
    }
    if (preset === 'custom' && !$('#filter-from').value) {
      var start = ATV.rangeFor('last-90');
      $('#filter-from').value = start.from;
      $('#filter-to').value = start.to;
    }
  }

  ATV.boot(
    function () {
      ['#filter-preset', '#filter-month', '#filter-from', '#filter-to', '#filter-currency'].forEach(
        function (sel) {
          $(sel).addEventListener('change', function () {
            syncControls();
            load();
          });
        }
      );
      syncControls();
      load();

      var wide = window.innerWidth >= 720;
      window.addEventListener('resize', function () {
        var nowWide = window.innerWidth >= 720;
        if (nowWide === wide) return;
        wide = nowWide;
        if (current) {
          $('#chart-host').innerHTML = chartHtml(current);
          wireTooltip();
        }
      });
    },
    { need: 'reviewer' }
  );
})();
