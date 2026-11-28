/* Cài app lên màn hình điện thoại (PWA) */
(function () {
  'use strict';
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    });
  }
  var deferred = null;
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function btn() { return document.getElementById('btn-install'); }
  function show() { var b = btn(); if (b && !standalone) b.hidden = false; }

  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; show(); });
  window.addEventListener('appinstalled', function () { var b = btn(); if (b) b.hidden = true; deferred = null; });

  document.addEventListener('DOMContentLoaded', function () {
    var b = btn(), help = document.getElementById('install-help');
    if (!b) return;
    if (isIOS && !standalone) show();
    b.addEventListener('click', async function () {
      if (deferred) {
        deferred.prompt();
        try { await deferred.userChoice; } catch (e) {}
        deferred = null; b.hidden = true;
      } else if (help) {
        help.hidden = !help.hidden;
      }
    });
    var close = document.getElementById('install-help-close');
    if (close) close.addEventListener('click', function () { help.hidden = true; });
  });
})();
