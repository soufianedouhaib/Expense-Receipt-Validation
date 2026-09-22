/* Settings for managers and the admin. Read only, except the theme, which is
   this browser's own preference. */

(function () {
  'use strict';

  var $ = ATV.$;
  var esc = ATV.esc;
  var THEME_KEY = 'atv-theme';

  function yesNo(flag, yes, no) {
    return flag
      ? '<span class="pill pill-ok"><span class="glyph">✓</span>' + esc(yes) + '</span>'
      : '<span class="pill pill-warn"><span class="glyph">▲</span>' + esc(no) + '</span>';
  }

  function rows(host, pairs) {
    $(host).innerHTML = pairs
      .map(function (pair) {
        return '<dt>' + esc(pair[0]) + '</dt><dd>' + pair[1] + '</dd>';
      })
      .join('');
  }

  function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') {
      document.documentElement.setAttribute('data-theme', choice);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch (e) {
      /* a private window simply forgets the preference */
    }
  }

  ATV.boot(
    function (me) {
      var saved = 'system';
      try {
        saved = localStorage.getItem(THEME_KEY) || 'system';
      } catch (e) {
        saved = 'system';
      }
      $('#theme').value = saved;
      $('#theme').addEventListener('change', function () {
        applyTheme($('#theme').value);
      });

      $('#support-btn').href = ATV.supportHref(me, { what: 'question from the console' });
      if (me.support && me.support.email) {
        $('#support-lead').innerHTML =
          'Something wrong with a run? Write to ' +
          esc(me.support.email) +
          '. The subject always carries the workflow id, ' +
          '<span class="mono">' +
          esc(me.support.workflowId) +
          '</span>, which is the first thing they ask for.';
      }

      if (me.role === 'admin') {
        $('#page-sub').textContent =
          'Your preferences, how to reach support, and what this console is pointed at.';
        $('#admin-only').hidden = false;
      }

      ATV.fetchJson('/api/settings')
        .then(function (settings) {
          if (me.role !== 'admin') return;
          rows('#workflow-kv', [
            ['Workflow id', '<span class="mono">' + esc(settings.workflow.id) + '</span>'],
            ['API base', '<span class="mono">' + esc(settings.workflow.baseUrl) + '</span>'],
            ['Input variable', '<span class="mono">' + esc(settings.workflow.inputVariable) + '</span>'],
            [
              'Output variables',
              settings.workflow.outputVariables
                .map(function (v) {
                  return '<span class="mono">' + esc(v) + '</span>';
                })
                .join('<br>')
            ],
            ['Service key', yesNo(settings.serviceKey.configured, 'Configured', 'Missing')]
          ]);

          rows('#deploy-kv', [
            ['Environment', esc(settings.build.target)],
            ['Deployment', settings.build.deployment ? '<span class="mono">' + esc(settings.build.deployment) + '</span>' : 'Local'],
            ['Commit', settings.build.commit ? '<span class="mono">' + esc(settings.build.commit) + '</span>' : 'Not reported'],
            [
              'Run history',
              settings.history.configured
                ? yesNo(settings.history.reachable, 'Connected, ' + settings.history.mode, 'Configured but unreachable')
                : '<span class="pill pill-warn"><span class="glyph">▲</span>Not switched on</span>'
            ],
            ['Session secret', yesNo(settings.accounts.sessionSecretSet, 'Set', 'Derived from the service key')]
          ]);

          if (settings.accounts.list && settings.accounts.list.length) {
            $('#accounts-card').hidden = false;
            $('#accounts-pill').textContent =
              settings.accounts.count + (settings.accounts.usingDemoAccounts ? ' demo accounts' : ' accounts');
            $('#accounts-body').innerHTML =
              '<div class="table-wrap"><table class="data-table"><thead><tr>' +
              '<th>Name</th><th>Email</th><th>Role</th>' +
              '</tr></thead><tbody>' +
              settings.accounts.list
                .map(function (a) {
                  return (
                    '<tr><td data-label="Name">' +
                    esc(a.name) +
                    '</td><td data-label="Email"><span class="mono">' +
                    esc(a.email) +
                    '</span></td><td data-label="Role">' +
                    esc(a.role) +
                    '</td></tr>'
                  );
                })
                .join('') +
              '</tbody></table></div>' +
              (settings.accounts.usingDemoAccounts
                ? '<p class="card-sub" style="margin: 12px 0 0">These are the built in demo accounts, ' +
                  'shown on the sign in pages so anyone can try the console. Replacing them with real ' +
                  'people is a one line change in the project environment.</p>'
                : '');
          }
        })
        .catch(function (err) {
          if (ATV.onAuthLoss(err)) return;
          $('#workflow-kv').innerHTML =
            '<dd><div class="notice notice-bad"><span class="glyph">!</span> Settings could not be read: ' +
            esc(err.message) +
            '</div></dd>';
        });
    },
    { need: 'reviewer' }
  );
})();
