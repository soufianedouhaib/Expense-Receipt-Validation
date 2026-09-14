/* Settings — connection details for this instance, admin only.

   Everything on this page comes from /api/settings, which reports the service
   key as a yes/no and never sends the key itself. Nothing here is editable:
   the values live in Vercel's environment variables, and changing one there
   only takes effect on the next deployment. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function fail(message) {
    $('loading').hidden = true;
    $('page-error').textContent = message;
    $('page-error').hidden = false;
  }

  /* A definition row. `mono` is for machine values — hosts, ids — which read
     far better in the monospace face than in the body font. */
  function row(host, label, value, opts) {
    opts = opts || {};

    var dt = document.createElement('dt');
    dt.textContent = label;

    var dd = document.createElement('dd');
    dd.textContent = value;
    if (opts.mono) dd.classList.add('mono');
    if (opts.tone) dd.classList.add('tone-' + opts.tone);

    host.appendChild(dt);
    host.appendChild(dd);
  }

  function yesNo(v) { return v ? 'Yes' : 'No'; }
  function tone(v) { return v ? 'ok' : 'warn'; }

  /* ---------------------------- support link --------------------------- */

  /* The subject is the workflow id, always — that is the one string Opus
     support can use to find the workflow being asked about. */
  function wireSupport(data) {
    var id = data.workflowId || 'unknown workflow';

    var body = [
      'Hello Opus support,',
      '',
      '',
      '',
      '— Instance details —',
      'Workflow ID: ' + id,
      'Opus host: ' + (data.opusHost || '—'),
      'Portal: ' + window.location.origin,
    ].join('\n');

    var href = 'mailto:' + encodeURIComponent(data.supportEmail) +
               '?subject=' + encodeURIComponent(id) +
               '&body=' + encodeURIComponent(body);

    var btn = $('support-btn');
    btn.href = href;

    $('support-hint').textContent =
      'Opens your mail app to ' + data.supportEmail +
      ' with the workflow ID as the subject.';
  }

  /* -------------------------------- boot ------------------------------- */

  $('signout-btn').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function () { window.location.href = '/'; })
      .catch(function () { window.location.href = '/'; });
  });

  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.signedIn) { window.location.href = '/'; return null; }
      if (me.roles.indexOf('admin') === -1) {
        // Not an error the person can act on — send them somewhere they belong.
        window.location.href = '/';
        return null;
      }
      $('who').textContent = me.name || me.email;
      return fetch('/api/settings').then(function (r) {
        if (r.status === 403 || r.status === 401) {
          throw new Error('This page is for administrators.');
        }
        if (!r.ok) throw new Error('Could not load the settings (' + r.status + ').');
        return r.json();
      });
    })
    .then(function (data) {
      if (!data) return;

      var conn = $('conn-rows');
      row(conn, 'Opus Host', data.opusHost || '—', { mono: true });
      row(conn, 'Workflow ID', data.workflowId || 'Not set', {
        mono: true,
        tone: data.workflowId ? null : 'warn',
      });
      row(conn, 'Service Key Configured', yesNo(data.serviceKeyConfigured), {
        tone: tone(data.serviceKeyConfigured),
      });

      if (data.missingEnv && data.missingEnv.length) {
        row(conn, 'Missing variables', data.missingEnv.join(', '), {
          mono: true, tone: 'warn',
        });
      }

      var store = $('storage-rows');
      row(store, 'Claim history', data.historyReady ? 'Connected' : 'Not connected', {
        tone: tone(data.historyReady),
      });
      row(store, 'History mode', data.storage ? data.storage.toUpperCase() : '—', { mono: true });
      row(store, 'Receipt archive', yesNo(data.receiptArchive), {
        tone: tone(data.receiptArchive),
      });

      wireSupport(data);

      $('loading').hidden = true;
      $('settings-body').hidden = false;
      document.body.classList.remove('is-loading');
    })
    .catch(function (err) {
      fail(err.message || 'Could not reach the server.');
    });
})();
