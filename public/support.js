/* The "Contact Opus customer support" link, in one place.

   Two screens raise it — the Settings page, and a claim that failed to complete —
   and both must produce the same mail: the workflow id in the subject, and the
   instance details in the body so support does not have to ask for them. */

(function () {
  'use strict';

  var cached = null;

  /* Connection details every signed-in person may see. Never the service key. */
  window.loadSupport = function () {
    if (cached) return Promise.resolve(cached);
    return fetch('/api/support')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { cached = data; return data; })
      .catch(function () { return null; });
  };

  /**
   * Build the mailto for a support request.
   * `detail` is optional: what went wrong, for the body of the mail.
   */
  window.supportMailto = function (data, detail) {
    if (!data || !data.supportEmail) return null;

    var id = data.workflowId || 'unknown workflow';
    var subject = 'Error within the workflow ID: ' + id;

    var body = [
      'Hello Opus support,',
      '',
      'We are seeing a problem with the Expense Receipt Validation workflow.',
      '',
      'What happened:',
      detail ? detail : '',
      '',
      '— Instance details —',
      'Workflow ID: ' + id,
      'Opus host: ' + (data.opusHost || '—'),
      'Portal: ' + window.location.origin,
    ].join('\n');

    return {
      subject: subject,
      href: 'mailto:' + encodeURIComponent(data.supportEmail) +
            '?subject=' + encodeURIComponent(subject) +
            '&body=' + encodeURIComponent(body),
    };
  };
})();
