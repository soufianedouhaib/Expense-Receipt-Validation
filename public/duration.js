/* How a duration is printed, in one place.
 *
 * The result page, the claims list and the report all show the same claim's
 * time to decision. If each formatted it itself they would drift the first time
 * one of them rounded differently, and a manager comparing a claim against the
 * average would be comparing two different roundings of the same millisecond.
 *
 * Loaded by submit.html, workspace.html and report.html before their own script.
 */
(function (win) {
  'use strict';

  /**
   * Milliseconds to something a person reads at a glance.
   *   940   -> "0.9s"
   *   20740 -> "20.7s"
   *   93400 -> "1m 33s"
   * Anything that is not a number comes back as null, never as "0s" — a run
   * that was not timed has to be distinguishable from one that was instant.
   */
  function fmtDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;

    if (ms < 60000) {
      // One decimal up to a minute: the difference between 17.8s and 20.7s is
      // the whole point of showing this number at all.
      return (ms / 1000).toFixed(1) + 's';
    }

    var totalSeconds = Math.round(ms / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    if (minutes < 60) {
      return minutes + 'm ' + (seconds < 10 ? '0' : '') + seconds + 's';
    }

    var hours = Math.floor(minutes / 60);
    return hours + 'h ' + ((minutes % 60) < 10 ? '0' : '') + (minutes % 60) + 'm';
  }

  win.fmtDuration = fmtDuration;
}(window));
