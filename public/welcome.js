/* Welcome page — sign in, then choose a role.
   The role choice is a convenience for people who hold more than one; the
   server checks the role on every request regardless of what was clicked. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ROLE_KEY = 'aaico.expense.role';

  var ROLES = {
    employee: {
      title: 'Submit a claim',
      blurb: 'Upload a receipt and have it checked against what you are claiming.',
      href: 'submit.html',
      icon: 'M12 16V4m0 0L8 8m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    },
    manager: {
      title: 'Review my team',
      blurb: 'See the claims filed by people who report to you, and why each was decided.',
      href: 'workspace.html',
      icon: 'M4 6h16M4 12h16M4 18h10',
    },
    admin: {
      title: 'Administer',
      blurb: 'Every claim across the company, with search, filters and CSV export.',
      href: 'workspace.html',
      icon: 'M12 3l7 4v5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V7l7-4Z',
    },
  };

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

    me.roles.forEach(function (key) {
      var role = ROLES[key];
      if (!role) return;

      var card = document.createElement('a');
      card.className = 'role-card';
      card.href = role.href + '?as=' + encodeURIComponent(key);

      card.appendChild(icon(role.icon));

      var text = document.createElement('div');
      var h = document.createElement('h2');
      h.textContent = role.title;
      var p = document.createElement('p');
      p.textContent = role.blurb;
      text.appendChild(h);
      text.appendChild(p);
      card.appendChild(text);

      card.addEventListener('click', function () {
        try { sessionStorage.setItem(ROLE_KEY, key); } catch (e) {}
      });

      grid.appendChild(card);
    });

    show('view-roles');
  }

  $('signout-link').addEventListener('click', function () {
    try { sessionStorage.removeItem(ROLE_KEY); } catch (e) {}
    fetch('/api/auth/logout', { method: 'POST' })
      .then(function () { window.location.reload(); })
      .catch(function () { window.location.reload(); });
  });

  fetch('/api/me')
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.configured) return show('view-unconfigured');

      if (!me.signedIn) {
        if (me.domain) {
          $('domain-note').textContent = 'Use your ' + me.domain + ' account.';
        }
        return show('view-signin');
      }

      renderRoles(me);
    })
    .catch(function () {
      showError('Could not reach the server. Reload the page to try again.');
      show('view-signin');
    });
})();
