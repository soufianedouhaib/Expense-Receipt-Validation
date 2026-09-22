/* Both sign in pages run this. They differ only in their wording: either one
   accepts any account and the server answers with the home that account's role
   actually has. */

(function () {
  'use strict';

  var $ = ATV.$;
  var esc = ATV.esc;

  function showError(message, redirect) {
    var box = $('#signin-error');
    if (!message) {
      box.hidden = true;
      return;
    }
    box.innerHTML =
      '<span class="glyph">!</span> ' +
      esc(message) +
      (redirect ? ' <a href="' + esc(redirect) + '">Go to the right sign in</a>' : '');
    box.hidden = false;
  }

  function nextUrl(fallback) {
    var wanted = new URLSearchParams(location.search).get('next');
    // Only ever follow a same site path, never an absolute URL from the query.
    if (wanted && /^\/[^/\\]/.test(wanted)) return wanted;
    return fallback;
  }

  function submit(event) {
    event.preventDefault();
    showError('');
    var btn = $('#signin-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in';

    ATV.fetchJson('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: $('#email').value,
        password: $('#password').value
      })
    })
      .then(function (out) {
        location.href = nextUrl(out.home || '/');
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Sign in';
        showError(err.message, err.body && err.body.redirect);
        $('#password').value = '';
        $('#password').focus();
      });
  }

  ATV.boot(
    function (me) {
      $('#signin-form').addEventListener('submit', submit);

      /* Every account in this build is a demo account, and both doors list the
         whole set: three employees, two managers and the administrator. One
         click fills the form so nobody types a test password, and either door
         accepts any of them, so picking a manager here signs in as a manager
         rather than bouncing to the other page. */
      var accounts = me.demoAccounts || [];
      if (!accounts.length) return;

      var GROUPS = [
        { role: 'advisor', title: 'Employees, submit a packet' },
        { role: 'reviewer', title: 'Managers, review and decide' },
        { role: 'admin', title: 'Administrator, everything' }
      ];

      $('#demo-title').hidden = false;
      $('#demo-list').innerHTML = GROUPS.map(function (group) {
        var rows = accounts
          .map(function (a, i) {
            if (a.role !== group.role) return '';
            return (
              '<button type="button" class="demo-account" data-i="' +
              i +
              '"><span class="who"><b>' +
              esc(a.name) +
              '</b><span>' +
              esc(a.email) +
              '</span></span><span class="pill">' +
              esc(a.roleLabel) +
              '</span></button>'
            );
          })
          .join('');
        if (!rows) return '';
        return '<div class="demo-group"><span class="demo-group-title">' + esc(group.title) + '</span>' + rows + '</div>';
      }).join('');

      ATV.$$('.demo-account').forEach(function (button) {
        button.addEventListener('click', function () {
          var picked = accounts[Number(button.getAttribute('data-i'))];
          if (!picked) return;
          $('#email').value = picked.email;
          $('#password').value = picked.password;
          showError('');
          $('#signin-btn').focus();
        });
      });
    },
    { need: 'public' }
  );
})();
