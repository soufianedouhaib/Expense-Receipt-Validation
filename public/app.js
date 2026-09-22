/* New validation page: pick a file, upload it, start a case, hand over to the
   case page. The service key never appears here; the server mints the upload
   slot and the browser sends the bytes straight to storage. */

(function () {
  'use strict';

  var $ = ATV.$;
  var esc = ATV.esc;
  var chosen = null;
  var me = null;

  function humanSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function showError(message) {
    var box = $('#submit-error');
    box.innerHTML = message ? '<span class="glyph">!</span> ' + esc(message) : '';
    box.hidden = !message;
    if (message) {
      // The button sits below the fold on a short window, so a failure that
      // renders quietly reads as "nothing happened".
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function setBusy(busy, label) {
    $('#progress').hidden = !busy;
    $('#submit-btn').disabled = busy || !chosen;
    $('#dropzone').style.pointerEvents = busy ? 'none' : '';
    if (label) $('#progress-label').textContent = label;
  }

  function pick(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showError('That file is ' + humanSize(file.size) + '. The limit is 10 MB.');
      return;
    }
    showError('');
    chosen = file;
    $('#file-name').textContent = file.name;
    $('#file-size').textContent = humanSize(file.size);
    $('#file-chip').hidden = false;
    $('#dropzone').hidden = true;
    $('#samples-lead').textContent = 'Or swap in a different sample.';
    $('#submit-btn').disabled = false;
    if (!$('#title').value) {
      $('#title').value = file.name.replace(/\.[^.]+$/, '');
    }
  }

  /* Sample packets live with the app so anyone can try it end to end. Each
     one is fetched and handed to the form exactly as a chosen file would be. */
  var SAMPLES = [
    {
      file: '/samples/packet-ira.pdf',
      name: 'Karim, Sterling Financial',
      note: 'Traditional IRA, unsigned and missing an election',
      amount: '$95,000.00'
    },
    {
      file: '/samples/packet-joint.pdf',
      name: 'Ellison-Vandermeer, Harbor Trust',
      note: 'Joint account, signed, Medallion affixed',
      amount: '$1,284,500.00'
    },
    {
      file: '/samples/packet-international.pdf',
      name: 'Al Mheiri, Gulf Cooperative',
      note: 'Individual account in a second currency',
      amount: 'AED 4,120,000.00'
    }
  ];

  function renderSamples() {
    $('#samples').innerHTML = SAMPLES.map(function (sample, i) {
      return (
        '<button type="button" class="sample" data-i="' +
        i +
        '"><span class="pill">Sample</span><span class="what"><b>' +
        esc(sample.name) +
        '</b><span>' +
        esc(sample.note) +
        '</span></span><span class="amount">' +
        esc(sample.amount) +
        '</span></button>'
      );
    }).join('');

    ATV.$$('.sample').forEach(function (button) {
      button.addEventListener('click', function () {
        var sample = SAMPLES[Number(button.getAttribute('data-i'))];
        if (!sample) return;
        button.disabled = true;
        fetch(sample.file)
          .then(function (res) {
            if (!res.ok) throw new Error('The sample packet could not be loaded.');
            return res.blob();
          })
          .then(function (blob) {
            var file = new File([blob], sample.file.split('/').pop(), { type: 'application/pdf' });
            var transfer = new DataTransfer();
            transfer.items.add(file);
            $('#file-input').files = transfer.files;
            pick(file);
            $('#title').value = sample.name;
          })
          .catch(function (err) {
            showError(err.message);
          })
          .then(function () {
            button.disabled = false;
          });
      });
    });
  }

  function clearFile() {
    chosen = null;
    $('#file-input').value = '';
    $('#file-chip').hidden = true;
    $('#dropzone').hidden = false;
    $('#samples-lead').textContent = 'No packet to hand? Load one of these samples and run it.';
    $('#submit-btn').disabled = true;
  }

  /* Direct PUT to storage keeps big files out of the serverless function.
     Some buckets do not allow a browser origin, so fall back to the server. */
  function uploadBytes(slot, file) {
    return fetch(slot.presignedUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' }
    })
      .then(function (res) {
        if (res.ok) return true;
        throw new Error('Storage refused the upload with status ' + res.status + '.');
      })
      .catch(function () {
        return ATV.fetchJson('/api/upload-proxy?to=' + encodeURIComponent(slot.presignedUrl), {
          method: 'PUT',
          body: file,
          headers: { 'x-content-type': file.type || 'application/octet-stream' }
        }).then(function () {
          return true;
        });
      });
  }

  /* Opus takes an upload and offers nothing that reads it back, so the packet
     a manager opens has to be this console's own copy. The same bytes go up a
     second time, in chunks, because a serverless request body and a REST store
     request are both capped well below the 10 MB a packet may run to.

     Everything here is best effort. The validation is already running by the
     time this starts, so a store that is switched off, full or slow costs the
     reviewer a preview and costs the submitter nothing. */
  var PACKET_PART_BYTES = 512 * 1024;
  var PACKET_MAX_BYTES = 20 * PACKET_PART_BYTES;

  function keepPacket(caseId, file) {
    if (!me || !me.historyEnabled) return Promise.resolve(false);
    if (!file || !file.size || file.size > PACKET_MAX_BYTES) return Promise.resolve(false);

    var parts = Math.max(1, Math.ceil(file.size / PACKET_PART_BYTES));
    var base =
      '/api/case/' + encodeURIComponent(caseId) + '/packet?parts=' + parts + '&bytes=' + file.size;

    function sendPart(i) {
      if (i >= parts) return Promise.resolve(true);
      setBusy(true, parts > 1 ? 'Keeping a copy for review, ' + (i + 1) + ' of ' + parts : 'Keeping a copy for review');
      return ATV.fetchJson(base + '&part=' + i, {
        method: 'PUT',
        body: file.slice(i * PACKET_PART_BYTES, (i + 1) * PACKET_PART_BYTES),
        /* A Blob carved out of a File carries no type, and a body with no
           Content-Type never reaches the raw parser. The packet's real type
           travels beside it, for the reviewer's viewer to use later. */
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-type': file.type || 'application/octet-stream'
        }
      }).then(function () {
        return sendPart(i + 1);
      });
    }

    return sendPart(0).catch(function (err) {
      if (window.console && console.warn) console.warn('Packet copy not kept: ' + err.message);
      return false;
    });
  }

  function submit(event) {
    event.preventDefault();
    if (!chosen) return;
    showError('');
    setBusy(true, 'Requesting an upload slot');

    ATV.fetchJson('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: chosen.name })
    })
      .then(function (slot) {
        setBusy(true, 'Uploading ' + chosen.name);
        return uploadBytes(slot, chosen).then(function () {
          return slot.fileUrl;
        });
      })
      .then(function (fileUrl) {
        setBusy(true, 'Starting the validation');
        return ATV.fetchJson('/api/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileUrl: fileUrl,
            fileName: chosen.name,
            title: $('#title').value
          })
        });
      })
      .then(function (out) {
        // The run is already going. Keeping the reviewer's copy is best effort
        // from here on: a failure there must not look like a failed submission.
        return keepPacket(out.caseId, chosen).then(function () {
          return out;
        });
      })
      .then(function (out) {
        location.href = '/case.html?id=' + encodeURIComponent(out.caseId);
      })
      .catch(function (err) {
        if (ATV.onAuthLoss(err)) return;
        setBusy(false);
        showError(
          err.message +
            (err.status === 401 || err.status === 503
              ? ' Nothing was submitted, so nothing is running.'
              : '')
        );
      });
  }

  function renderRecent(rows) {
    if (!rows.length) {
      // Nothing to show yet, so the block stays out of the way entirely.
      $('#recent-card').hidden = true;
      return;
    }
    $('#recent-card').hidden = false;
    var body = rows
      .slice(0, 5)
      .map(function (row) {
        return (
          '<tr>' +
          '<td data-label="Reference"><a class="row-link" href="/case.html?id=' +
          encodeURIComponent(row.caseId) +
          '">' +
          esc(row.title || row.fileName || row.caseId) +
          '</a></td>' +
          '<td data-label="Client">' +
          esc(row.clientName || '') +
          '</td>' +
          '<td data-label="Workflow">' +
          (row.status === 'COMPLETED' && row.verdict
            ? ATV.verdictPill(row.verdict)
            : ATV.statusPill(row.status)) +
          '</td>' +
          '<td data-label="Review">' +
          (row.status === 'COMPLETED' ? ATV.reviewPill(row.reviewState) : '') +
          '</td>' +
          '<td class="num" data-label="Issues"' +
          (typeof row.totalIssues === 'number' ? '' : ' data-empty="1"') +
          '><div>' +
          '<div>' +
          (row.totalIssues === null ? '' : row.totalIssues) +
          '</div>' +
          (row.lowConfidence
            ? '<div style="margin-top: 4px"><span class="pill pill-warn"><span class="glyph">▲</span>' +
              row.lowConfidence +
              ' to verify</span></div>'
            : '') +
          '</div></td>' +
          '<td data-label="Submitted">' +
          esc(ATV.formatTime(row.createdAt)) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    $('#recent-body').innerHTML =
      '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>Reference</th><th>Client</th><th>Workflow</th><th>Review</th><th class="num">Issues</th><th>Submitted</th>' +
      '</tr></thead><tbody>' +
      body +
      '</tbody></table></div>';
  }

  ATV.boot(function (user) {
    me = user;
    // A reviewer account has no submit screen. Send it to the queue instead of
    // showing a form its session cannot use.
    if (!me.canSubmit) {
      location.replace('/review.html');
      return;
    }

    var zone = $('#dropzone');
    var input = $('#file-input');

    zone.addEventListener('click', function () {
      input.click();
    });
    zone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', function () {
      zone.classList.remove('is-over');
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('is-over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        pick(e.dataTransfer.files[0]);
      }
    });
    input.addEventListener('change', function () {
      pick(input.files && input.files[0]);
    });
    var from = new URLSearchParams(location.search).get('from');
    if (from) {
      ATV.fetchJson('/api/case/' + encodeURIComponent(from))
        .then(function (payload) {
          var row = payload.row || {};
          if (row.title) $('#title').value = row.title;
          var note = payload.review && payload.review.note;
          $('#resubmit-note').innerHTML =
            '<span class="glyph">▪</span> <strong>Resubmitting ' +
            esc(row.title || 'a corrected packet') +
            '.</strong>' +
            (note ? ' The reviewer asked for: ' + ATV.escMasked(note) : '') +
            ' Attach the corrected file and run it again.';
          $('#resubmit-note').hidden = false;
        })
        .catch(function () {});
    }

    renderSamples();
    $('#file-clear').addEventListener('click', clearFile);
    $('#submit-form').addEventListener('submit', submit);

    if (!me.configured) {
      showError(
        'The server has no Opus service key, so runs will fail. Set OPUS_SERVICE_KEY in the project environment and redeploy.'
      );
    }

    if (me.historyEnabled) {
      ATV.fetchJson('/api/history?limit=5')
        .then(function (out) {
          renderRecent(out.rows || []);
        })
        .catch(function (err) {
          if (ATV.onAuthLoss(err)) return;
          $('#recent-card').hidden = true;
        });
    }
  });
})();
