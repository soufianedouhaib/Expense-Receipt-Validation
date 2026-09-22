/* Shared chrome, session handling and helpers. Every page loads this first,
   then its own script. Pages render nothing until /api/me answers, so a
   signed out visitor never sees a flash of a screen they are about to lose. */

(function (global) {
  'use strict';

  /* The theme choice is this browser's, so apply it before anything paints. */
  try {
    var savedTheme = localStorage.getItem('atv-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }
  } catch (e) {
    /* a private window simply follows the device */
  }

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* A social security number never renders in full, wherever it came from.
     The workflow quotes firm records verbatim, so the masking happens here at
     the last moment rather than being trusted to every upstream string. */
  function maskSensitive(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/\b(\d{3})[-\s.](\d{2})[-\s.](\d{4})\b/g, '***\u2011**\u2011$3')
      .replace(/\b\d{5}(\d{4})\b/g, '*****$1');
  }

  function escMasked(value) {
    return esc(maskSensitive(value));
  }

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* Read the body as text first. A platform error page is HTML, and res.json()
     would throw a parse error that hides the status the user needs to see. */
  function fetchJson(url, options) {
    return fetch(url, options).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }
        if (!res.ok) {
          var message =
            (data && (data.error || data.message)) ||
            'Request failed with status ' + res.status + '.';
          var err = new Error(message);
          err.status = res.status;
          err.body = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ------------------------------ the rail ------------------------------ */

  var ICONS = {
    submit:
      '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
    runs: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    queue:
      '<path d="M3 13h4l2 3h6l2-3h4"/><path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    settings:
      '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    support: '<path d="M3 7l9 6 9-6"/><rect x="3" y="5" width="18" height="14" rx="2"/>',
    signout: '<path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10"/><path d="M15 8l4 4-4 4M19 12H9"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>'
  };

  function icon(name) {
    return (
      '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') +
      '</svg>'
    );
  }

  function navFor(me) {
    if (!me || !me.signedIn) return [];
    var links = [];
    if (me.canSubmit) {
      links.push({ href: '/', label: 'New validation', icon: 'submit', match: ['/', '/index.html'] });
    }
    if (me.canReview) {
      links.push({
        href: '/review.html',
        label: 'Transfer requests',
        icon: 'queue',
        match: ['/review.html']
      });
    }
    links.push({
      href: '/history.html',
      label: me.canReview ? 'All runs' : 'My runs',
      icon: 'runs',
      match: ['/history.html']
    });
    if (me.canReview) {
      links.push({ href: '/report.html', label: 'Report', icon: 'report', match: ['/report.html'] });
      links.push({
        href: '/settings.html',
        label: 'Settings',
        icon: 'settings',
        match: ['/settings.html']
      });
    }
    return links;
  }

  /* One mailto for the whole app: the subject always carries the workflow id,
     which is the first thing Opus support asks for. */
  function supportHref(me, context) {
    var s = (me && me.support) || {};
    var subject = (s.subjectPrefix || 'Opus workflow') + (context && context.what ? ', ' + context.what : '');
    var lines = [
      'Workflow id: ' + (s.workflowId || 'unknown'),
      context && context.caseId ? 'Case id: ' + context.caseId : '',
      context && context.status ? 'Run status: ' + context.status : '',
      'Reported by: ' + ((me && me.email) || 'unknown'),
      'When: ' + new Date().toISOString(),
      '',
      'What happened:',
      ''
    ].filter(Boolean);
    return (
      'mailto:' +
      (s.email || 'support@opus.com') +
      '?subject=' +
      encodeURIComponent(subject) +
      '&body=' +
      encodeURIComponent(lines.join('\n'))
    );
  }

  var SIDE_KEY = 'atv-sidebar';

  function sidebarCollapsed() {
    var saved = null;
    try {
      saved = localStorage.getItem(SIDE_KEY);
    } catch (e) {
      saved = null;
    }
    if (saved) return saved === 'collapsed';
    // No preference yet: a phone starts with the menu closed, a desktop open.
    return window.innerWidth < 861;
  }

  function setSidebar(collapsed) {
    document.body.classList.toggle('side-collapsed', collapsed);
    try {
      localStorage.setItem(SIDE_KEY, collapsed ? 'collapsed' : 'open');
    } catch (e) {
      /* a private window simply forgets the preference */
    }
  }

  function renderNav(me) {
    var host = $('#topbar');
    if (!host) return;
    if (!me || !me.signedIn) {
      host.className = 'sidebar is-empty';
      host.innerHTML = '';
      return;
    }

    host.className = 'sidebar';
    document.body.classList.add('has-sidebar');
    if (sidebarCollapsed()) document.body.classList.add('side-collapsed');

    var here = location.pathname.replace(/\/index\.html$/, '/');
    var links = navFor(me)
      .map(function (item) {
        var active = item.match.indexOf(here) !== -1;
        return (
          '<a href="' +
          item.href +
          '"' +
          (active ? ' aria-current="page"' : '') +
          ' title="' +
          esc(item.label) +
          '">' +
          icon(item.icon) +
          '<span class="label">' +
          esc(item.label) +
          '</span></a>'
        );
      })
      .join('');

    host.innerHTML =
      '<div class="side-top">' +
      /* The product name alone, no logo mark. It is the link home. */
      '<a class="brand-lockup" href="' + (me.canSubmit ? '/' : '/review.html') + '" title="Account Transfer Validation">' +
      '<span class="label">Account Transfer Validation</span>' +
      '</a>' +
      '<button type="button" class="side-toggle" id="side-toggle" aria-label="Expand or collapse the menu">' +
      icon('chevron') +
      '</button>' +
      '</div>' +
      '<nav class="side-nav">' +
      links +
      '</nav>' +
      '<div class="side-foot">' +
      '<a class="side-support" id="support-link" href="' +
      supportHref(me, { what: 'question from the console' }) +
      '" title="Contact Opus support">' +
      icon('support') +
      '<span class="label">Contact Opus support</span></a>' +
      '<div class="side-account">' +
      '<span class="avatar">' +
      esc((me.name || me.email || '?').slice(0, 1).toUpperCase()) +
      '</span>' +
      '<span class="label"><span class="account-name">' +
      esc(me.name || me.email) +
      '</span><span class="account-role">' +
      esc(me.roleLabel || '') +
      '</span></span>' +
      '</div>' +
      '<button type="button" class="side-out" id="sign-out" title="Sign out">' +
      icon('signout') +
      '<span class="label">Sign out</span></button>' +
      '</div>';

    $('#side-toggle').addEventListener('click', function () {
      setSidebar(!document.body.classList.contains('side-collapsed'));
    });

    $('#sign-out').addEventListener('click', function () {
      fetchJson('/api/logout', { method: 'POST' })
        .catch(function () {})
        .then(function () {
          location.href = me.canReview && !me.canSubmit ? '/review-login.html' : '/login.html';
        });
    });
  }

  function renderFooter(me) {
    var host = $('#footer');
    if (!host) return;
    var bits = ['Applied AI, Account Transfer Validation'];
    if (me && me.signedIn && !me.configured) bits.push('Server not configured');
    if (me && me.signedIn && !me.historyEnabled) bits.push('History not configured');
    host.innerHTML = bits
      .map(function (b) {
        return '<span>' + esc(b) + '</span>';
      })
      .join('');
  }

  /**
   * One call for the shared chrome and the session gate.
   *   ATV.boot(fn)                        a signed in user of any role
   *   ATV.boot(fn, { need: 'reviewer' })  managers and the admin only
   *   ATV.boot(fn, { need: 'public' })    the sign in pages
   */
  function boot(onReady, options) {
    var need = (options && options.need) || 'user';
    fetchJson('/api/me')
      .then(function (me) {
        if (need !== 'public' && !me.signedIn) {
          location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
          return;
        }
        if (need === 'reviewer' && !me.canReview) {
          location.replace('/');
          return;
        }
        if (need === 'public' && me.signedIn) {
          location.replace(me.canReview && !me.canSubmit ? '/review.html' : '/');
          return;
        }
        renderNav(need === 'public' ? null : me);
        renderFooter(need === 'public' ? null : me);
        var main = $('#main');
        if (main) main.hidden = false;
        onReady(me);
      })
      .catch(function (err) {
        renderNav(null);
        var main = $('#main');
        if (main) {
          main.hidden = false;
          main.innerHTML =
            '<div class="card"><div class="notice notice-bad"><span class="glyph">!</span> ' +
            'This console could not reach its own API: ' +
            esc(err.message) +
            '</div></div>';
        }
      });
  }

  /** A 401 mid session means the cookie expired. Send them back to sign in. */
  function onAuthLoss(err) {
    if (err && err.status === 401) {
      location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
      return true;
    }
    return false;
  }

  var STATUS_TEXT = {
    PENDING: 'Queued',
    IN_PROGRESS: 'Running',
    WAITING: 'Waiting',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
    TIMED_OUT: 'Timed out',
    UNKNOWN: 'Unknown'
  };

  function statusPill(status) {
    var label = STATUS_TEXT[status] || status || 'Unknown';
    var cls = 'pill';
    var glyph = '•';
    if (status === 'COMPLETED') {
      glyph = '▪';
      label = 'Run finished';
    } else if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
      cls = 'pill pill-stop';
      glyph = '⊘';
      label = 'Did not finish';
    } else if (status === 'IN_PROGRESS' || status === 'PENDING' || status === 'WAITING') {
      glyph = '◷';
    }
    return '<span class="' + cls + '"><span class="glyph">' + glyph + '</span>' + esc(label) + '</span>';
  }

  function verdictPill(verdict) {
    if (verdict === 'IGO') {
      return '<span class="pill pill-ok"><span class="glyph">✓</span>In good order</span>';
    }
    if (verdict === 'NIGO') {
      return '<span class="pill pill-bad"><span class="glyph">!</span>Not in good order</span>';
    }
    return '<span class="pill">Not determined</span>';
  }

  var REVIEW_TEXT = {
    approved: { label: 'Approved', cls: 'pill pill-ok', glyph: '✓' },
    rejected: { label: 'Rejected', cls: 'pill pill-bad', glyph: '✕' },
    returned: { label: 'Sent back', cls: 'pill pill-warn', glyph: '↩' },
    pending: { label: 'Awaiting review', cls: 'pill', glyph: '◷' }
  };

  function reviewPill(state) {
    var spec = REVIEW_TEXT[state] || REVIEW_TEXT.pending;
    return '<span class="' + spec.cls + '"><span class="glyph">' + spec.glyph + '</span>' + spec.label + '</span>';
  }

  function reviewLabel(state) {
    return (REVIEW_TEXT[state] || REVIEW_TEXT.pending).label;
  }

  function severityPill(severity) {
    var s = (severity || '').toLowerCase();
    if (s === 'high') return '<span class="pill pill-bad"><span class="glyph">!</span>High</span>';
    if (s === 'medium') return '<span class="pill pill-warn"><span class="glyph">▲</span>Medium</span>';
    if (s === 'low') return '<span class="pill"><span class="glyph">▪</span>Low</span>';
    return '<span class="pill">Unrated</span>';
  }

  /* Field ids are internal. Advisors read words. */
  var FIELD_LABELS = {
    client_name: 'Client name',
    ssn: 'SSN',
    dob: 'Date of birth',
    address: 'Address',
    contra_firm: 'Contra firm',
    contra_account_number: 'Contra account number',
    nana: 'NANA code',
    registration: 'Registration',
    account_type: 'Account type',
    transfer_type: 'Transfer election',
    transfer_election: 'Transfer election',
    value: 'Account value',
    form_id: 'Form id',
    signature: 'Signature',
    signature_present: 'Signature present',
    signature_date: 'Signature date',
    medallion: 'Medallion guarantee',
    medallion_present: 'Medallion guarantee',
    firm: 'Firm',
    account_holder: 'Account holder',
    account_number: 'Account number',
    total_value: 'Total value',
    scope: 'Transfer scope'
  };

  var SECTION_LABELS = {
    consistency: 'Consistency',
    completeness: 'Completeness',
    contra_fit: 'Contra firm fit',
    consolidator: 'System'
  };

  function fieldLabel(key) {
    if (!key) return 'General';
    if (FIELD_LABELS[key]) return FIELD_LABELS[key];
    return String(key)
      .replace(/[_.]/g, ' ')
      .replace(/^./, function (c) {
        return c.toUpperCase();
      });
  }

  function sectionLabel(key) {
    return SECTION_LABELS[key] || fieldLabel(key);
  }

  /* Election tokens are workflow vocabulary. Advisors read words. */
  var TOKENS = {
    in_kind: 'In kind',
    liquidate: 'Liquidate',
    full: 'Full',
    partial: 'Partial',
    IN_GOOD_ORDER: 'In good order'
  };

  function formatValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') {
      var on = Object.keys(value).filter(function (k) {
        return value[k] === true;
      });
      if (!on.length) return null;
      var RANK = { in_kind: 0, liquidate: 1, full: 2, partial: 3 };
      return on
        .sort(function (a, b) {
          return (RANK[a] === undefined ? 9 : RANK[a]) - (RANK[b] === undefined ? 9 : RANK[b]);
        })
        .map(function (k) {
          return TOKENS[k] || fieldLabel(k);
        })
        .join(', ');
    }
    if (TOKENS[value]) return TOKENS[value];
    return String(value);
  }

  /* "form.ssn" reads as "SSN (transfer form)". Dotted paths never reach a user. */
  var PATH_PREFIX = { form: 'transfer form', statement: 'firm statement' };

  function pathLabel(path) {
    if (!path) return 'A field';
    var parts = String(path).split('.');
    if (parts.length < 2) return fieldLabel(parts[0]);
    var where = PATH_PREFIX[parts[0]];
    var leaf = fieldLabel(parts[parts.length - 1]);
    return where ? leaf + ' (' + where + ')' : leaf;
  }

  /* The workflow writes "3 issue(s)". Nobody should have to read that. */
  function tidy(text) {
    if (!text) return '';
    return String(text)
      .replace(/(\d+)([^.]{0,30}?)\b([a-z-]+)\(s\)/gi, function (m, n, middle, word) {
        return n + middle + word + (Number(n) === 1 ? '' : 's');
      })
      .replace(/\(s\)/g, 's')
      .replace(/^(IGO|NIGO)\s*-\s*/i, '')
      .replace(/^([a-z])/, function (c) {
        return c.toUpperCase();
      })
      .replace(/\bin ([a-z ]+), ([a-z ]+)\.$/i, 'in $1 and $2.');
  }

  /* Date ranges: one vocabulary for the lists, the export and the report. */
  function ymd(d) {
    return (
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0')
    );
  }

  function monthRange(offset) {
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth() + (offset || 0), 1);
    var end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    return { from: ymd(start), to: ymd(end) };
  }

  function rangeFor(preset, month) {
    if (preset === 'this-month') return monthRange(0);
    if (preset === 'last-month') return monthRange(-1);
    if (preset === 'last-7') {
      var now = new Date();
      var back = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      return { from: ymd(back), to: ymd(now) };
    }
    if (preset === 'last-90') {
      var today = new Date();
      var then = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 89);
      return { from: ymd(then), to: ymd(today) };
    }
    if (preset === 'month' && month) {
      var parts = String(month).split('-');
      var first = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
      var last = new Date(Number(parts[0]), Number(parts[1]), 0);
      return { from: ymd(first), to: ymd(last) };
    }
    return { from: '', to: '' };
  }

  function rangeQuery(range) {
    var bits = [];
    if (range && range.from) bits.push('from=' + encodeURIComponent(range.from));
    if (range && range.to) bits.push('to=' + encodeURIComponent(range.to));
    return bits.join('&');
  }

  function monthLabel(key) {
    var parts = String(key).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    if (isNaN(d.getTime())) return key;
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }

  function money(amount, currency) {
    if (typeof amount !== 'number' || isNaN(amount)) return '';
    var text = amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (!currency) return text;
    return /^[A-Za-z]{3}$/.test(currency) ? currency + ' ' + text : currency + text;
  }

  /* Axis ticks need short money: $1.2M reads, $1,200,000 does not, and five
     ticks that all round to the same string read as a bug. */
  function moneyShort(amount, currency) {
    if (typeof amount !== 'number' || isNaN(amount)) return '';
    var abs = Math.abs(amount);
    var text;
    if (abs >= 1e9) text = (amount / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
    else if (abs >= 1e6) text = (amount / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
    else if (abs >= 1e3) text = (amount / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'k';
    else text = String(Math.round(amount));
    text = text.replace(/\.0(?=[kMB]$)/, '');
    if (!currency) return text;
    return /^[A-Za-z]{3}$/.test(currency) ? currency + ' ' + text : currency + text;
  }

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  global.ATV = {
    $: $,
    $$: $$,
    esc: esc,
    escMasked: escMasked,
    maskSensitive: maskSensitive,
    fetchJson: fetchJson,
    boot: boot,
    supportHref: supportHref,
    icon: icon,
    onAuthLoss: onAuthLoss,
    statusPill: statusPill,
    verdictPill: verdictPill,
    reviewPill: reviewPill,
    reviewLabel: reviewLabel,
    severityPill: severityPill,
    fieldLabel: fieldLabel,
    pathLabel: pathLabel,
    sectionLabel: sectionLabel,
    formatValue: formatValue,
    tidy: tidy,
    formatTime: formatTime,
    ymd: ymd,
    rangeFor: rangeFor,
    rangeQuery: rangeQuery,
    monthLabel: monthLabel,
    money: money,
    moneyShort: moneyShort,
    STATUS_TEXT: STATUS_TEXT
  };
})(window);
