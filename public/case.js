/* One validation: poll our own status route, render the decision, show the
   submitted packet, and let a reviewer record approve, reject or send back.
   The browser never talks to Opus. */

(function () {
  'use strict';

  var $ = ATV.$;
  var esc = ATV.esc;
  var caseId = new URLSearchParams(location.search).get('id') || '';
  var latest = null;
  var me = null;
  var timer = null;
  var startedAt = Date.now();
  var POLL_MS = 4000;

  var FORM_ORDER = [
    'client_name',
    'ssn',
    'dob',
    'address',
    'registration',
    'account_type',
    'contra_firm',
    'contra_account_number',
    'nana',
    'transfer_type',
    'value',
    'form_id',
    'signature_present',
    'signature_date',
    'medallion_present'
  ];

  var STATEMENT_ORDER = ['firm', 'account_holder', 'account_number', 'account_type', 'total_value'];

  function confidenceFor(map, prefix, key) {
    if (!map) return null;
    var direct = map[prefix + '.' + key];
    if (typeof direct === 'number') return direct;
    var nested = Object.keys(map).filter(function (k) {
      return k.indexOf(prefix + '.' + key + '.') === 0;
    });
    if (!nested.length) return null;
    var lowest = null;
    nested.forEach(function (k) {
      if (typeof map[k] === 'number' && (lowest === null || map[k] < lowest)) lowest = map[k];
    });
    return lowest;
  }

  function pairs(obj, order, confidence, prefix) {
    var keys = order.filter(function (k) {
      return Object.prototype.hasOwnProperty.call(obj || {}, k);
    });
    Object.keys(obj || {}).forEach(function (k) {
      if (keys.indexOf(k) === -1) keys.push(k);
    });
    if (!keys.length) {
      return '<div class="empty"><strong>Nothing extracted</strong>No values were read from this part of the packet.</div>';
    }
    var rows = keys
      .map(function (key) {
        var shown = ATV.formatValue(obj[key]);
        if (shown === null && (key === 'transfer_type' || key === 'scope')) {
          shown = 'No election selected';
        }
        var conf = confidenceFor(confidence, prefix, key);
        var confHtml = '';
        if (typeof conf === 'number') {
          confHtml =
            '<span class="conf' + (conf < 75 ? ' is-low' : '') + '">' + conf + '% confidence</span>';
        }
        return (
          '<div class="pair">' +
          '<span class="k">' +
          esc(ATV.fieldLabel(key)) +
          '</span>' +
          '<span class="v' +
          (shown === null ? ' is-empty' : '') +
          '">' +
          (shown === null ? 'Not found on the document' : ATV.escMasked(shown)) +
          '</span>' +
          confHtml +
          '</div>'
        );
      })
      .join('');
    return '<div class="pairs">' + rows + '</div>';
  }

  function statsHtml(audit) {
    var a = audit || {};
    var cells = [
      { n: a.total_issues, k: 'Issues in total', hit: a.total_issues > 0 },
      { n: a.consistency_issues, k: 'Consistency', hit: a.consistency_issues > 0 },
      { n: a.completeness_issues, k: 'Completeness', hit: a.completeness_issues > 0 },
      { n: a.contrafit_issues, k: 'Contra firm fit', hit: a.contrafit_issues > 0 },
      { n: a.low_confidence, k: 'Low confidence reads', warn: a.low_confidence > 0 }
    ];
    return (
      '<div class="stats">' +
      cells
        .map(function (c) {
          return (
            '<div class="stat' +
            (c.hit ? ' is-hit' : '') +
            (c.warn ? ' is-warn' : '') +
            '"><div class="n">' +
            (typeof c.n === 'number' ? c.n : '0') +
            '</div><div class="k">' +
            esc(c.k) +
            '</div></div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function explanationHtml(explanation, hasStructuredLowConfidence) {
    if (!explanation) return '';
    var items = Array.isArray(explanation.action_items) ? explanation.action_items : [];
    var list = items.length
      ? '<ol class="action-list">' +
        items
          .map(function (item) {
            return (
              '<li><div class="issue">' +
              ATV.escMasked(item.issue || '') +
              '</div><div class="todo">' +
              ATV.escMasked(item.what_to_do || '') +
              '</div></li>'
            );
          })
          .join('') +
        '</ol>'
      : '';
    var verify =
      explanation.verify_note && !hasStructuredLowConfidence
        ? '<div class="notice notice-warn" style="margin-top: 14px"><span class="glyph">▲</span> ' +
          esc(explanation.verify_note) +
          '</div>'
        : '';
    return (
      '<section class="card">' +
      '<div class="card-head"><h2>What this means</h2></div>' +
      (explanation.headline
        ? '<p style="font-size: 16px; font-weight: 500">' + ATV.escMasked(explanation.headline) + '</p>'
        : '') +
      (explanation.narrative
        ? '<p style="margin-top: 8px; color: var(--ink-2)">' + ATV.escMasked(explanation.narrative) + '</p>'
        : '') +
      (list ? '<h3 style="margin: 18px 0 4px">What to do next</h3>' + list : '') +
      verify +
      '</section>'
    );
  }

  function issuesHtml(issues) {
    if (!issues || !issues.length) return '';
    var rows = issues
      .map(function (issue) {
        return (
          '<tr>' +
          '<td data-label="Issue"><div>' +
          '<div>' +
          esc(issue.label || 'Issue') +
          '</div>' +
          '<div class="card-sub" style="margin: 2px 0 0">' +
          ATV.escMasked(issue.detail || '') +
          '</div></div></td>' +
          '<td data-label="Field">' +
          esc(ATV.fieldLabel(issue.field)) +
          '</td>' +
          '<td data-label="Check">' +
          esc(ATV.sectionLabel(issue.section)) +
          '</td>' +
          '<td data-label="Severity">' +
          ATV.severityPill(issue.severity) +
          '</td>' +
          '<td class="num" data-label="Confidence">' +
          (typeof issue.confidence === 'number' ? issue.confidence + '%' : '') +
          '</td>' +
          '<td class="nowrap" data-label="Code"><span class="mono">' +
          esc(issue.reason_code || '') +
          '</span></td>' +
          '</tr>'
        );
      })
      .join('');
    return (
      '<section class="card">' +
      '<div class="card-head"><h2>Flagged issues</h2><span class="pill pill-bad">' +
      issues.length +
      ' to resolve</span></div>' +
      '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>Issue</th><th>Field</th><th>Check</th><th>Severity</th><th class="num">Confidence</th><th>Code</th>' +
      '</tr></thead><tbody>' +
      rows +
      '</tbody></table></div>' +
      '</section>'
    );
  }

  /* The workflow finding a packet clean is not the same as a reviewer letting
     it go, so the card says which of the two has happened. */
  function reviewGatePill() {
    var state = latest && latest.review ? latest.review.decision : 'pending';
    if (state === 'approved') {
      return '<span class="pill pill-ok"><span class="glyph">✓</span>Approved to send</span>';
    }
    if (state === 'rejected' || state === 'returned') {
      return ATV.reviewPill(state);
    }
    return '<span class="pill"><span class="glyph">◷</span>Awaiting reviewer approval</span>';
  }

  function packageHtml(pkg) {
    if (!pkg) return '';
    var order = [
      'client_name',
      'registration',
      'account_type',
      'contra_firm',
      'contra_account_number',
      'nana',
      'transfer_type',
      'scope',
      'value',
      'form_id'
    ];
    var copy = {};
    order.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(pkg, k)) copy[k] = pkg[k];
    });
    return (
      '<section class="card">' +
      '<div class="card-head"><h2>What would be sent to the contra firm</h2>' +
      reviewGatePill() +
      '</div>' +
      pairs(copy, order, null, 'package') +
      '</section>'
    );
  }

  function lowConfidenceHtml(list) {
    if (!list || !list.length) return '';
    return (
      '<div class="notice notice-warn" style="margin-top: 16px"><span class="glyph">▲</span> Worth a second look: ' +
      list
        .map(function (item) {
          return esc(ATV.pathLabel(item.field)) + ' at ' + esc(item.confidence) + '%';
        })
        .join('; ') +
      '.</div>'
    );
  }

  /* ---------------------------- the packet ---------------------------- */

  /* While the run is in flight the page is one card and nothing else, so the
     title, the meta row and the footer are centred with it rather than being
     pinned to the left of an otherwise empty screen. */
  function setWaiting(on) {
    document.body.classList[on ? 'add' : 'remove']('is-waiting');
  }

  function documentHtml(row) {
    if (!row || !row.hasDocument) return '';
    var url = '/api/case/' + encodeURIComponent(caseId) + '/document';

    /* Opus keeps no readable copy of an uploaded file, so a run submitted
       before this console started keeping its own has nothing to show. Saying
       that plainly beats an iframe rendering the server's error as raw JSON. */
    if (!row.packetKept) {
      return (
        '<section class="card">' +
        '<div class="card-head"><h2>The submitted packet</h2>' +
        (row.fileName ? '<span class="pill"><span class="glyph">▪</span>' + esc(row.fileName) + '</span>' : '') +
        '</div>' +
        '<div class="empty"><strong>No packet was kept for this run</strong>' +
        'It was submitted before this console began keeping its own copy. Everything the ' +
        'workflow read from the documents is on this page; the file itself has to come from ' +
        'the person who sent it.</div>' +
        '</section>'
      );
    }

    var name = row.fileName || 'packet';
    var ext = (name.split('.').pop() || '').toLowerCase();
    var viewer = '';
    if (ext === 'pdf') {
      viewer = '<iframe class="doc-frame" src="' + url + '#view=FitH" title="Submitted packet"></iframe>';
    } else if (['png', 'jpg', 'jpeg'].indexOf(ext) !== -1) {
      viewer = '<img class="doc-image" src="' + url + '" alt="Submitted packet">';
    } else {
      viewer =
        '<div class="empty"><strong>No preview for this file type</strong>' +
        'Open it in a new tab to read it.</div>';
    }
    return (
      '<section class="card">' +
      '<div class="card-head"><h2>The submitted packet</h2>' +
      '<span class="pill"><span class="glyph">▪</span>' +
      esc(name) +
      '</span>' +
      '<a class="btn btn-quiet btn-small" href="' +
      url +
      '" target="_blank" rel="noopener">Open in a new tab</a>' +
      '</div>' +
      viewer +
      '</section>'
    );
  }

  /* ---------------------------- the decision -------------------------- */

  function decisionBannerHtml(review) {
    if (!review) return '';
    var tone =
      review.decision === 'approved' ? 'is-ok' : review.decision === 'rejected' ? 'is-bad' : 'is-warn';
    var glyph = review.decision === 'approved' ? '✓' : review.decision === 'rejected' ? '✕' : '↩';
    return (
      '<div class="verdict ' +
      tone +
      '" style="margin-bottom: 16px">' +
      '<div class="verdict-mark">' +
      glyph +
      '</div>' +
      '<div class="verdict-body">' +
      '<div class="verdict-title">Reviewer decision: ' +
      esc(ATV.reviewLabel(review.decision)) +
      '</div>' +
      '<div class="verdict-sub">' +
      (review.note ? ATV.escMasked(review.note) + ' ' : '') +
      '<span class="quiet">Recorded by ' +
      esc(review.byName || review.by) +
      ' on ' +
      esc(ATV.formatTime(review.at)) +
      '.</span>' +
      '</div></div></div>'
    );
  }

  function reviewFormHtml(payload) {
    if (!payload.canReview || !payload.terminal) return '';
    var current = payload.review ? payload.review.decision : null;
    return (
      '<section class="card" id="review-card">' +
      '<div class="card-head"><h2>Your decision</h2>' +
      ATV.reviewPill(current || 'pending') +
      '</div>' +
      '<div class="choices" role="radiogroup" aria-label="Decision">' +
      '<label class="choice"><input type="radio" name="decision" value="approved"' +
      (current === 'approved' ? ' checked' : '') +
      '><span><strong>Approve</strong>Send the transfer on to the contra firm.</span></label>' +
      '<label class="choice"><input type="radio" name="decision" value="returned"' +
      (current === 'returned' ? ' checked' : '') +
      '><span><strong>Send back</strong>The advisor corrects the packet and resubmits.</span></label>' +
      '<label class="choice"><input type="radio" name="decision" value="rejected"' +
      (current === 'rejected' ? ' checked' : '') +
      '><span><strong>Reject</strong>The request cannot proceed at all.</span></label>' +
      '</div>' +
      '<label class="field" style="margin-top: 16px">' +
      '<span>Note for the advisor, required unless you approve</span>' +
      '<textarea id="review-note" rows="3" placeholder="What the advisor needs to know, or what to fix">' +
      esc((payload.review && payload.review.note) || '') +
      '</textarea>' +
      '</label>' +
      '<div id="review-error" class="notice notice-bad" hidden></div>' +
      '<button type="button" class="btn" id="review-save">' +
      (current ? 'Update the decision' : 'Record the decision') +
      '</button>' +
      '</section>'
    );
  }

  function wireReviewForm() {
    var button = $('#review-save');
    if (!button) return;
    button.addEventListener('click', function () {
      var picked = document.querySelector('input[name="decision"]:checked');
      var box = $('#review-error');
      box.hidden = true;
      if (!picked) {
        box.textContent = 'Choose approve, send back or reject first.';
        box.hidden = false;
        return;
      }
      button.disabled = true;
      var was = button.textContent;
      button.textContent = 'Saving';
      ATV.fetchJson('/api/case/' + encodeURIComponent(caseId) + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: picked.value, note: $('#review-note').value })
      })
        .then(function (out) {
          latest.review = out.review;
          latest.row = out.row;
          $('#decision-slot').innerHTML = decisionBannerHtml(out.review);
          $('#review-slot').innerHTML = reviewFormHtml(latest);
          wireReviewForm();
          renderActions(latest);
          renderJumpBar(latest);
          renderMeta(latest.row, latest.status);
        })
        .catch(function (err) {
          if (ATV.onAuthLoss(err)) return;
          button.disabled = false;
          button.textContent = was;
          box.textContent = err.message;
          box.hidden = false;
        });
    });
  }

  /* ------------------------------ rendering --------------------------- */

  function renderResult(payload) {
    var result = payload.result || {};
    var isIgo = result.status === 'IGO';
    var extracted = result.extracted || {};
    var verdictClass = result.status ? (isIgo ? 'is-ok' : 'is-bad') : 'is-dead';

    var head =
      '<div class="verdict ' +
      verdictClass +
      '">' +
      '<div class="verdict-mark">' +
      (isIgo ? '✓' : '!') +
      '</div>' +
      '<div class="verdict-body">' +
      '<div class="verdict-title">' +
      (isIgo ? 'In good order' : 'Not in good order') +
      '</div>' +
      '<div class="verdict-sub">' +
      esc(ATV.tidy(result.decision_summary)) +
      '</div>' +
      '</div></div>';

    var errorNote = payload.workflowError
      ? '<div class="notice notice-bad" style="margin-top: 16px">The workflow reported a problem while assembling the result: ' +
        esc(payload.workflowError) +
        '</div>'
      : '';

    var extractedBody =
      '<div class="grid-2">' +
      '<div><h3 style="margin-bottom: 8px">Transfer form</h3>' +
      pairs(extracted.form || {}, FORM_ORDER, result.field_confidence, 'form') +
      '</div>' +
      '<div><h3 style="margin-bottom: 8px">Delivering firm statement</h3>' +
      pairs(extracted.statement || {}, STATEMENT_ORDER, result.field_confidence, 'statement') +
      '</div>' +
      '</div>';

    var extractedSection =
      '<section class="card">' +
      '<div class="card-head"><h2>What was read from the packet</h2></div>' +
      extractedBody +
      '</section>';

    var raw = me && me.canReview
      ? '<details class="raw"><summary>Raw workflow output</summary><pre>' +
        ATV.escMasked(JSON.stringify({ result: payload.result, explanation: payload.explanation }, null, 2)) +
        '</pre></details>'
      : '';

    $('#result').innerHTML =
      head +
      statsHtml(result.audit) +
      lowConfidenceHtml(result.low_confidence_fields) +
      errorNote +
      (payload.workflowError ? supportCardHtml(payload) : '') +
      '<div style="height: 16px"></div>' +
      explanationHtml(
        payload.explanation,
        Boolean(result.low_confidence_fields && result.low_confidence_fields.length)
      ) +
      issuesHtml(result.flagged_issues) +
      (isIgo ? packageHtml(result.igo_package) : '') +
      (isIgo
        ? '<details class="raw" style="margin-top: 16px"><summary>What was read from the packet</summary><div style="padding: 0 14px 14px">' +
          extractedBody +
          '</div></details>'
        : extractedSection) +
      raw;

    $('#result').hidden = false;
    $('#running').hidden = true;
    setWaiting(false);
    $('#failed').hidden = true;
    $('#actions').hidden = false;
    afterTerminal(payload);
  }

  function supportCardHtml(payload) {
    var href = ATV.supportHref(me, {
      what: 'a run that did not finish',
      caseId: caseId,
      status: (payload && payload.status) || 'unknown'
    });
    return (
      '<section class="card" style="margin-top: 16px"><div class="support-card">' +
      ATV.icon('support') +
      '<div><h2 style="font-size: 17px; margin-bottom: 4px">Still stuck?</h2>' +
      '<p class="card-sub" style="margin: 0 0 12px">' +
      'If this keeps happening, Opus support can look at the run itself. The email opens with ' +
      'the workflow id, this case id and the run status already filled in.' +
      '</p>' +
      '<a class="btn btn-small" href="' +
      href +
      '">Contact Opus support</a></div></div></section>'
    );
  }

  function renderFailure(payload) {
    $('#failed').innerHTML =
      '<div class="verdict is-dead">' +
      '<div class="verdict-mark">!</div>' +
      '<div class="verdict-body">' +
      '<div class="verdict-title">The run did not finish</div>' +
      '<div class="verdict-sub">' +
      'The validation stopped before it reached a decision. Nothing was decided about ' +
      'this packet, so submitting it again is safe.' +
      '</div></div></div>' +
      supportCardHtml(payload);
    $('#failed').hidden = false;
    $('#running').hidden = true;
    setWaiting(false);
    $('#result').hidden = true;
    $('#actions').hidden = false;
    $('#copy-json').hidden = true;
    afterTerminal(payload);
  }

  /* The packet and the decision belong to both endings. */
  function afterTerminal(payload) {
    $('#decision-slot').innerHTML = decisionBannerHtml(payload.review);
    $('#document-slot').innerHTML = documentHtml(payload.row);
    $('#review-slot').innerHTML = reviewFormHtml(payload);
    wireReviewForm();
    renderActions(payload);
    renderJumpBar(payload);
  }

  /* The advisor's next step depends on what came back. A packet that was sent
     back needs a resubmit, not a generic "validate another". */
  function renderActions(payload) {
    var copy = $('#copy-json');
    if (copy) copy.hidden = !(me && me.canReview) || !payload.result;

    var primary = $('#action-new');
    if (!primary || !me || !me.canSubmit) return;
    var sentBack = payload.review && payload.review.decision === 'returned';
    var title = (payload.row && payload.row.title) || '';
    if (sentBack) {
      primary.textContent = 'Resubmit this packet';
      primary.href = '/?from=' + encodeURIComponent(caseId);
    } else {
      primary.textContent = 'Validate another packet';
      primary.href = '/';
    }
  }

  /* A reviewer with a pending run gets one persistent way to the decision,
     however long the findings and the packet run. */
  function renderJumpBar(payload) {
    var existing = document.getElementById('jump-bar');
    if (existing) existing.parentNode.removeChild(existing);
    if (!me || !me.canReview || !payload.terminal) return;
    if (payload.review) return;
    var bar = document.createElement('div');
    bar.id = 'jump-bar';
    bar.className = 'jump-bar';
    bar.innerHTML =
      '<span>This run is waiting for your decision.</span>' +
      '<button type="button" class="btn btn-small" id="jump-btn">Go to the decision</button>';
    document.body.appendChild(bar);
    document.getElementById('jump-btn').addEventListener('click', function () {
      var card = document.getElementById('review-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function renderMeta(row, status) {
    var bits = [];
    bits.push('Case ' + esc(caseId));
    if (row && row.submittedByName && me && me.canReview) {
      bits.push('Submitted by ' + esc(row.submittedByName));
    }
    if (row && row.createdAt) bits.push('Submitted ' + esc(ATV.formatTime(row.createdAt)));
    bits.push(ATV.statusPill(status));
    // Only a finished run can be waiting for a manager. A run still going, or
    // one that crashed, says so once in the status pill and nowhere else.
    if (row && status === 'COMPLETED' && row.reviewState === 'pending') {
      bits.push(ATV.reviewPill('pending'));
    }
    $('#case-meta').innerHTML = bits
      .map(function (b) {
        return '<span>' + b + '</span>';
      })
      .join('');
    if (row && (row.title || row.fileName)) {
      $('#case-title').textContent = row.title || row.fileName;
    }
  }

  function poll() {
    ATV.fetchJson('/api/status/' + encodeURIComponent(caseId))
      .then(function (payload) {
        latest = payload;
        renderMeta(payload.row, payload.status);
        if (!payload.terminal) {
          $('#running').hidden = false;
          setWaiting(true);
          $('#running-note').textContent =
            'Reading the documents and running the checks. This usually takes a minute or two. ' +
            'Elapsed ' +
            Math.round((Date.now() - startedAt) / 1000) +
            's.';
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        if (payload.status === 'COMPLETED' && payload.result) renderResult(payload);
        else renderFailure(payload);
      })
      .catch(function (err) {
        if (ATV.onAuthLoss(err)) return;
        $('#running').hidden = true;
        setWaiting(false);
        $('#failed').hidden = false;
        $('#actions').hidden = false;
        $('#copy-json').hidden = true;
        $('#case-title').textContent = 'Validation not found';
        $('#failed').innerHTML =
          '<div class="card"><div class="empty"><strong>This validation could not be found</strong>' +
          'It may belong to another colleague, or the link may be incomplete. ' +
          'Starting a new validation is the quickest way forward.' +
          '</div></div>' +
          supportCardHtml({ status: 'not found' });
        if (window.console && console.warn) console.warn('Case lookup failed: ' + err.message);
      });
  }

  ATV.boot(function (user) {
    me = user;
    if (me.canReview) {
      $('#action-new').hidden = !me.canSubmit;
      $('#action-list').textContent = 'Back to the queue';
      $('#action-list').href = '/review.html';
    } else {
      $('#action-list').textContent = 'My runs';
    }

    if (!caseId) {
      $('#running').hidden = true;
      setWaiting(false);
      $('#failed').hidden = false;
      $('#failed').innerHTML =
        '<div class="card"><div class="empty"><strong>No case selected</strong>' +
        'Pick a run from the list to open it.</div></div>';
      $('#actions').hidden = false;
      $('#copy-json').hidden = true;
      return;
    }

    $('#copy-json').addEventListener('click', function () {
      if (!latest) return;
      var text = JSON.stringify({ result: latest.result, explanation: latest.explanation }, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        $('#copy-json').textContent = 'Copied';
        setTimeout(function () {
          $('#copy-json').textContent = 'Copy result JSON';
        }, 1600);
      }
    });

    /* A stored case comes back in one call. A case still in flight, or one
       this server has never stored, falls through to polling. */
    ATV.fetchJson('/api/case/' + encodeURIComponent(caseId))
      .then(function (payload) {
        latest = payload;
        renderMeta(payload.row, payload.status);
        if (payload.result) return renderResult(payload);
        if (payload.terminal) return renderFailure(payload);
        $('#running').hidden = false;
        setWaiting(true);
        poll();
      })
      .catch(function (err) {
        if (ATV.onAuthLoss(err)) return;
        $('#running').hidden = false;
        setWaiting(true);
        poll();
      });
  });

  window.addEventListener('beforeunload', function () {
    if (timer) clearTimeout(timer);
  });
})();
