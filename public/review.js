/* The reviewer queue. Reads the same projected rows every other screen reads,
   and adds the review state on top. */

(function () {
  'use strict';

  var $ = ATV.$;
  var esc = ATV.esc;
  var rows = [];

  /* A run that never finished has nothing to approve, so it sits outside the
     review states rather than inflating the waiting count. */
  function stateOf(row) {
    if (row.status !== 'COMPLETED') return 'unfinished';
    return row.reviewState || 'pending';
  }


  /* The period controls are shared with the report, so they behave the same
     way wherever they appear. */
  function currentRange() {
    var preset = $('#filter-preset').value;
    if (preset === 'custom') return { from: $('#filter-from').value, to: $('#filter-to').value };
    return ATV.rangeFor(preset, $('#filter-month').value);
  }

  function syncPeriodControls() {
    var preset = $('#filter-preset').value;
    $('#filter-month').hidden = preset !== 'month';
    $('#custom-wrap').hidden = preset !== 'custom';
    if (preset === 'month' && !$('#filter-month').value) {
      $('#filter-month').value = new Date().toISOString().slice(0, 7);
    }
    if (preset === 'custom' && !$('#filter-from').value) {
      var start = ATV.rangeFor('this-month');
      $('#filter-from').value = start.from;
      $('#filter-to').value = start.to;
    }
  }

  function matches(row) {
    var state = $('#filter-state').value;
    if (state && stateOf(row) !== state) return false;

    var verdict = $('#filter-verdict').value;
    if (verdict && row.verdict !== verdict) return false;

    var text = $('#filter-text').value.trim().toLowerCase();
    if (!text) return true;
    return (
      [row.title, row.fileName, row.clientName, row.contraFirm, row.submittedBy, row.caseId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .indexOf(text) !== -1
    );
  }

  function renderStats() {
    var counts = { pending: 0, approved: 0, rejected: 0, returned: 0, unfinished: 0 };
    rows.forEach(function (row) {
      var state = stateOf(row);
      if (counts[state] === undefined) counts[state] = 0;
      counts[state] += 1;
    });
    var unfinished = counts.unfinished;
    var cells = [
      { n: counts.pending, k: 'Awaiting review', warn: counts.pending > 0 },
      { n: counts.approved, k: 'Approved' },
      { n: counts.returned, k: 'Sent back' },
      { n: counts.rejected, k: 'Rejected' },
      { n: unfinished, k: 'Did not finish' }
    ];
    $('#queue-stats').innerHTML = cells
      .map(function (c) {
        return (
          '<div class="stat' +
          (c.warn ? ' is-warn' : '') +
          '"><div class="n">' +
          c.n +
          '</div><div class="k">' +
          esc(c.k) +
          '</div></div>'
        );
      })
      .join('');
  }

  function render() {
    var visible = rows.filter(matches);
    $('#count-pill').textContent = visible.length + (visible.length === 1 ? ' run' : ' runs');

    if (!rows.length) {
      $('#queue-body').innerHTML =
        '<div class="empty"><strong>Nothing to review yet</strong>' +
        'Finished runs appear here as advisors submit packets.</div>';
      return;
    }
    if (!visible.length) {
      $('#queue-body').innerHTML =
        '<div class="empty"><strong>Nothing matches those filters</strong>' +
        'Clear the search, or switch the state filter to All states.</div>';
      return;
    }

    var body = visible
      .map(function (row) {
        var outcome =
          row.status === 'COMPLETED' && row.verdict
            ? ATV.verdictPill(row.verdict)
            : ATV.statusPill(row.status);
        return (
          '<tr>' +
          '<td data-label="Reference"><div><a class="row-link" href="/case.html?id=' +
          encodeURIComponent(row.caseId) +
          '">' +
          esc(row.title || row.fileName || row.caseId) +
          '</a>' +
          '<div class="card-sub" style="margin: 2px 0 0">' +
          esc(row.clientName || 'Client not read') +
          (row.contraFirm ? ', ' + esc(row.contraFirm) : '') +
          '</div></div></td>' +
          '<td data-label="Submitted by">' +
          esc(row.submittedByName || row.submittedBy || '') +
          '</td>' +
          '<td data-label="Workflow"><div>' +
          outcome +
          (row.lowConfidence
            ? '<div style="margin-top: 4px"><span class="pill pill-warn"><span class="glyph">▲</span>' +
              row.lowConfidence +
              ' to verify</span></div>'
            : '') +
          '</div></td>' +
          '<td class="num" data-label="Issues"' +
          (typeof row.totalIssues === 'number' ? '' : ' data-empty="1"') +
          '>' +
          (typeof row.totalIssues === 'number' ? row.totalIssues : '') +
          '</td>' +
          '<td data-label="Review"' +
          (stateOf(row) === 'unfinished' ? ' data-empty="1"' : '') +
          '>' +
          (stateOf(row) === 'unfinished'
            ? '<span class="quiet">Not applicable</span>'
            : ATV.reviewPill(row.reviewState)) +
          (row.reviewedByName
            ? '<div class="card-sub" style="margin: 2px 0 0">' + esc(row.reviewedByName) + '</div>'
            : '') +
          '</td>' +
          '<td data-label="Submitted">' +
          esc(ATV.formatTime(row.createdAt)) +
          '</td>' +
          '<td data-label="Action"><a class="btn btn-small' +
          (stateOf(row) === 'pending' ? '' : ' btn-quiet') +
          '" href="/case.html?id=' +
          encodeURIComponent(row.caseId) +
          '">' +
          (stateOf(row) === 'pending' ? 'Review' : 'Open') +
          '</a></td>' +
          '</tr>'
        );
      })
      .join('');

    $('#queue-body').innerHTML =
      '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>Reference</th><th>Submitted by</th><th>Workflow</th><th class="num">Issues</th>' +
      '<th>Review</th><th>Submitted</th><th></th>' +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></div>';
  }

  function load() {
    var range = currentRange();
    var query = ATV.rangeQuery(range);
    $('#export-link').href = '/api/export.csv' + (query ? '?' + query : '');
    $('#queue-body').innerHTML = '<div class="skeleton">Loading the queue</div>';

    ATV.fetchJson('/api/queue' + (query ? '?' + query : ''))
      .then(function (out) {
        rows = out.rows || [];
        if (out.note) {
          $('#queue-body').innerHTML =
            '<div class="notice notice-warn"><span class="glyph">▲</span> ' + esc(out.note) + '</div>';
          $('#queue-stats').hidden = true;
          if (!rows.length) return;
        }
        $('#queue-stats').hidden = false;
        renderStats();
        render();
      })
      .catch(function (err) {
        if (ATV.onAuthLoss(err)) return;
        $('#queue-body').innerHTML =
          '<div class="notice notice-bad"><span class="glyph">!</span> The queue could not be read: ' +
          esc(err.message) +
          '</div>';
      });
  }

  ATV.boot(
    function () {
      $('#filter-state').addEventListener('change', render);
      $('#filter-verdict').addEventListener('change', render);
      $('#filter-text').addEventListener('input', render);
      ['#filter-preset', '#filter-month', '#filter-from', '#filter-to'].forEach(function (sel) {
        $(sel).addEventListener('change', function () {
          syncPeriodControls();
          load();
        });
      });

      syncPeriodControls();
      load();
    },
    { need: 'reviewer' }
  );
})();
