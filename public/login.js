/* Both sign in pages run this. The page says which door it is with data-mode
   on the body, which decides whose demo accounts are listed. Either door
   accepts any account, and the server answers with the home that account's
   role actually has. */

(function () {
  'use strict';

  var $ = ATV.$;
  var esc = ATV.esc;
  var mode = document.body.getAttribute('data-mode') === 'reviewer' ? 'reviewer' : 'advisor';

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

      /* Every account in this build is a demo account. Each door lists its own,
         and the button under the list crosses to the other one. Either door
         still accepts any account and sends the person to the home their role
         has, so a wrong door is never a dead end. */
      var accounts = (me.demoAccounts && me.demoAccounts[mode]) || [];
      if (!accounts.length) return;

      $('#demo-title').hidden = false;
      $('#demo-list').innerHTML = accounts
        .map(function (a, i) {
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
