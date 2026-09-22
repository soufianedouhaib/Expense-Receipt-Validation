/* Welcome page — the sign-in gate, and nothing more.

   Signing in (or entering as a guest) goes straight to the claim form; so does
   arriving here with a session already open. Roles decide what the side rail
   offers once you are inside, and the server re-checks them on every request. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* Everyone lands on the claim form. It is the one page every role can use,
     and the side rail is how they reach anything else — so the old "choose how
     you want to work" step had nothing left to decide. */
  var HOME = 'submit.html';

  function show(id) {
    ['view-signin', 'view-unconfigured'].forEach(function (v) {
      $(v).hidden = v !== id;
    });
    $('welcome-loading').hidden = true;
  }

  function showError(message) {
    if (!message) return;
    $('welcome-error').textContent = message;
    $('welcome-error').hidden = false;
  }

  /* A failed sign-in comes back as ?error=… so the reason isn't swallowed. */
  var params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    showError(params.get('error'));
    window.history.replaceState({}, '', window.location.pathname);
  }

  /* ------------------------------ sign in ------------------------------ */

  /* Demo passwords sit in the page on purpose: clicking a row fills both fields
     so the portal can be handed to someone and tried in one click. It also means
     anyone who opens this page can sign in as anyone, admin included. That is the
     trade a demo makes — remove this list before it stops being one. */
  var DEMO = [
    ['Employee', 'Mahmoud Sharshira', 'mahmoud@demo.aaico.com', 'amber-otter-3755'],
    ['Employee', 'Layla Haddad',      'layla@demo.aaico.com',   'cedar-falcon-6616'],
    ['Employee', 'Karim Nasser',      'karim@demo.aaico.com',   'harbor-lantern-7712'],
    ['Employee', 'Noor Abdallah',     'noor@demo.aaico.com',    'indigo-meadow-1271'],
    ['Manager',  'Omar Busaileh',     'omar@demo.aaico.com',    'marble-compass-8915'],
    ['Manager',  'Sara Khalil',       'sara@demo.aaico.com',    'quartz-ember-4983'],
    ['Admin',    'Portal Admin',      'admin@demo.aaico.com',   'tundra-willow-9236'],
  ];

  function renderDemoList() {
    var host = $('demo-list');
    host.innerHTML = '';

    DEMO.forEach(function (entry) {
      var role = entry[0], name = entry[1], email = entry[2], password = entry[3];

      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'demo-row';

      var tag = document.createElement('span');
      tag.className = 'demo-role';
      tag.textContent = role;

      var who = document.createElement('span');
      who.className = 'demo-who';
      var n = document.createElement('span');
      n.className = 'demo-name';
      n.textContent = name;
      var m = document.createElement('span');
      m.className = 'demo-email';
      m.textContent = email;
      who.appendChild(n);
      who.appendChild(m);

      var go = document.createElement('span');
      go.className = 'demo-go';
      go.textContent = 'Use';

      row.appendChild(tag);
      row.appendChild(who);
      row.appendChild(go);

      row.addEventListener('click', function () {
        $('email').value = email;
        $('password').value = password;
        $('err-signin').hidden = true;
        // Straight in — the point of the list is one click, not two.
        $('signin-form').requestSubmit
          ? $('signin-form').requestSubmit()
          : $('signin-btn').click();
      });

      host.appendChild(row);
    });
  }

  $('guest-btn').addEventListener('click', function () {
    $('guest-btn').disabled = true;
    fetch('/api/auth/guest', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('Could not start a guest session.');
        window.location.href = 'submit.html';
      })
      .catch(function (err) {
        showError(err.message);
        $('guest-btn').disabled = false;
      });
  });

  $('signin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('err-signin').hidden = true;
    $('signin-btn').disabled = true;

    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value }),
    })
      .then(function (r) {
        return r.json().then(function (body) { return { ok: r.ok, body: body }; });
      })
      .then(function (r) {
        if (!r.ok) throw new Error(r.body.error || 'Sign-in failed.');
        $('password').value = '';
        window.location.href = HOME;
      })
      .catch(function (err) {
        $('err-signin').textContent = err.message;
        $('err-signin').hidden = false;
      })
      .then(function () { $('signin-btn').disabled = false; });
  });

  /* -------------------------------- boot ------------------------------- */

  renderDemoList();

  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (me) {
      // Already signed in — nothing to ask, so go where the work is.
      if (!me.signedIn) return show('view-signin');
      window.location.replace(HOME);
    })
    .catch(function () {
      showError('Could not reach the server. Reload the page to try again.');
      show('view-signin');
    });
})();
