/* Welcome page — sign in, then choose a role.
   The role choice is a convenience for people who hold more than one; the
   server checks the role on every request regardless of what was clicked. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* Doors, in the order they are offered. "employee" always yields two: filing
     a claim and looking back at your own. Manager appears only once somebody
     has named you; admin only for listed accounts. */
  var DOORS = [
    {
      role: 'employee',
      title: 'Submit a claim',
      blurb: 'Upload a receipt and have it checked against what you are claiming.',
      href: 'submit.html',
      icon: 'M12 16V4m0 0L8 8m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    },
    {
      role: 'employee',
      title: 'My claims',
      blurb: 'Everything you have submitted before, and how each one was decided.',
      href: 'workspace.html?scope=mine',
      icon: 'M8 6h11M8 12h11M8 18h11M4 6h.01M4 12h.01M4 18h.01',
    },
    {
      role: 'manager',
      title: 'My team',
      blurb: 'Claims where someone named you as their manager.',
      href: 'workspace.html?scope=team',
      icon: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 20v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    },
    {
      role: 'admin',
      title: 'All claims',
      blurb: 'Every claim submitted through the portal, with search and export.',
      href: 'workspace.html?scope=all',
      icon: 'M12 3l7 4v5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V7l7-4Z',
    },
  ];

  function show(id) {
    ['view-signin', 'view-roles', 'view-unconfigured'].forEach(function (v) {
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

  function icon(path) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'role-icon');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  function renderRoles(me) {
    $('who-name').textContent = me.name || me.email;

    var grid = $('role-grid');
    grid.innerHTML = '';

    DOORS.forEach(function (door) {
      if (me.roles.indexOf(door.role) === -1) return;

      var card = document.createElement('a');
      card.className = 'role-card';
      card.href = door.href;

      card.appendChild(icon(door.icon));

      var text = document.createElement('div');
      var h = document.createElement('h2');
      h.textContent = door.title;
      var p = document.createElement('p');
      p.textContent = door.blurb;
      text.appendChild(h);
      text.appendChild(p);
      card.appendChild(text);

      grid.appendChild(card);
    });

    show('view-roles');
  }

  $('signout-link').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function () { window.location.reload(); })
      .catch(function () { window.location.reload(); });
  });

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
        return fetch('/api/me').then(function (x) { return x.json(); }).then(renderRoles);
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
      if (!me.signedIn) return show('view-signin');
      renderRoles(me);
    })
    .catch(function () {
      showError('Could not reach the server. Reload the page to try again.');
      show('view-signin');
    });
})();
