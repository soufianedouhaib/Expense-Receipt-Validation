/* Shared side navigation.

   A collapsed icon rail that expands over the page the moment the pointer
   reaches it, behind a blurred scrim, and folds back when the pointer leaves.
   The toggle pins it open for anyone without a pointer to hover with — touch,
   or a keyboard — and Escape or a click off it puts everything back. Every page
   the signed-in person may open is a row, so moving between them is one click. The list is
   built from their roles: a manager or admin also gets Report and Settings, and
   a guest — who has no claim history at all — sees only the claim form.

   Pages call renderNav(me, current) from inside the /api/me handler they already
   have, so this costs no extra request. `current` is one of:
   submit | mine | team | all | report | settings */

(function () {
  'use strict';

  /* 24×24 stroke paths, drawn at 1.6. */
  var ICONS = {
    submit:   'M12 16V4m0 0L8 8m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    list:     'M8 6h11M8 12h11M8 18h11M4 6h.01M4 12h.01M4 18h.01',
    team:     'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 20v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    shield:   'M12 3l7 4v5c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V7l7-4Z',
    chart:    'M4 20V10M10 20V4M16 20v-7M22 20H2',
    cog:      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2.1-1.2L14.5 3h-4l-.4 2.6a7.5 7.5 0 0 0-2.1 1.2l-2.3-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.5l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2.1 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2.1-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.3Z',
    menu:     'M4 7h16M4 12h16M4 17h16',
    signout:  'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  };

  /* `roles: null` means everyone signed in. An array means any one of them. */
  var ITEMS = [
    { key: 'submit',   roles: null,                   label: 'Submit a claim', href: 'submit.html',               icon: 'submit' },
    { key: 'mine',     roles: ['employee'],           label: 'My claims',      href: 'workspace.html?scope=mine', icon: 'list' },
    { key: 'team',     roles: ['manager'],            label: 'My team',        href: 'workspace.html?scope=team', icon: 'team' },
    { key: 'all',      roles: ['admin'],              label: 'All claims',     href: 'workspace.html?scope=all',  icon: 'shield' },
    { key: 'report',   roles: ['manager', 'admin'],   label: 'Report',         href: 'report.html',               icon: 'chart' },
    { key: 'settings', roles: ['manager', 'admin'],   label: 'Settings',       href: 'settings.html',             icon: 'cog' },
  ];

  function svg(pathKey, cls) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', cls || 'side-icon');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[pathKey]);
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ---------------------------- open / closed --------------------------- */

  /* Deliberately not remembered between pages. An expanded rail dims and blurs
     everything behind it, and no page should arrive already looking like that —
     it is a menu you glance at, not a layout mode. */
  var pinned = false;
  var closeTimer = null;

  function setOpen(open, toggle) {
    document.body.classList.toggle('side-open', open);
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Collapse menu' : 'Expand menu');
    }
  }

  /* Opening is immediate; closing waits a moment, so crossing a corner of the
     rail on the way somewhere else does not make it flap. */
  function hoverOpen(toggle) {
    clearTimeout(closeTimer);
    setOpen(true, toggle);
  }

  function hoverClose(toggle) {
    if (pinned) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(function () { setOpen(false, toggle); }, 140);
  }

  /* The scrim is what blurs the page behind an open rail. It is also the way
     most people will close it — clicking off a menu is the usual reflex. */
  function scrim(toggle) {
    var existing = document.querySelector('.side-scrim');
    if (existing) return existing;

    var s = el('div', 'side-scrim');
    s.addEventListener('click', function () {
      pinned = false;
      toggle.setAttribute('aria-pressed', 'false');
      setOpen(false, toggle);
    });
    document.body.appendChild(s);
    return s;
  }

  /* -------------------------------- build ------------------------------- */

  window.renderNav = function (me, current) {
    var host = document.getElementById('side');
    if (!host) return;

    host.innerHTML = '';
    var roles = (me && me.roles) || [];

    /* top: toggle, then the wordmark that only shows when expanded */
    var top = el('div', 'side-top');

    var toggle = el('button', 'side-toggle');
    toggle.type = 'button';
    toggle.appendChild(svg('menu'));
    top.appendChild(toggle);

    var brand = el('a', 'side-brand');
    brand.href = 'submit.html';
    var logo = document.createElement('img');
    logo.src = 'logo.png';
    logo.alt = 'Applied AI';
    logo.className = 'side-logo';
    brand.appendChild(logo);
    top.appendChild(brand);

    host.appendChild(top);

    /* the rows */
    var nav = el('nav', 'side-nav');
    nav.setAttribute('aria-label', 'Sections');

    ITEMS.forEach(function (item) {
      if (item.roles && !item.roles.some(function (r) { return roles.indexOf(r) !== -1; })) return;

      var row = el('a', 'side-link' + (item.key === current ? ' is-current' : ''));
      row.appendChild(svg(item.icon));
      row.appendChild(el('span', 'side-label', item.label));
      // A tooltip is the only label there is while the rail is collapsed.
      row.title = item.label;

      if (item.key === current) {
        row.setAttribute('aria-current', 'page');
      } else {
        row.href = item.href;
      }

      nav.appendChild(row);
    });

    host.appendChild(nav);

    /* foot: who you are, and the way out */
    var foot = el('div', 'side-foot');

    var who = el('div', 'side-who');
    who.appendChild(el('span', 'side-dot'));
    who.appendChild(el('span', 'side-label side-name',
      (me && (me.name || me.email)) || (me && me.guest ? 'Guest' : '')));
    who.title = (me && (me.name || me.email)) || 'Guest';
    foot.appendChild(who);

    var out = el('button', 'side-link side-out');
    out.type = 'button';
    out.appendChild(svg('signout'));
    out.appendChild(el('span', 'side-label', me && me.guest ? 'Leave' : 'Sign out'));
    out.title = me && me.guest ? 'Leave' : 'Sign out';
    out.addEventListener('click', function () {
      fetch('/api/auth/logout', { method: 'POST' })
        .then(function () { window.location.href = '/'; })
        .catch(function () { window.location.href = '/'; });
    });
    foot.appendChild(out);

    host.appendChild(foot);

    /* wiring */
    scrim(toggle);

    host.addEventListener('mouseenter', function () { hoverOpen(toggle); });
    host.addEventListener('mouseleave', function () { hoverClose(toggle); });

    // Keyboard users get the same thing by tabbing into it.
    host.addEventListener('focusin', function () { hoverOpen(toggle); });
    host.addEventListener('focusout', function (e) {
      if (!host.contains(e.relatedTarget)) hoverClose(toggle);
    });

    /* The toggle pins it, for touch screens and for anyone who wants it to
       stay put while they read down the list. */
    toggle.setAttribute('aria-pressed', 'false');
    toggle.addEventListener('click', function () {
      pinned = !pinned;
      toggle.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      if (pinned) hoverOpen(toggle);
      else setOpen(false, toggle);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && document.body.classList.contains('side-open')) {
        pinned = false;
        toggle.setAttribute('aria-pressed', 'false');
        setOpen(false, toggle);
      }
    });

    setOpen(false, toggle);
  };
})();
