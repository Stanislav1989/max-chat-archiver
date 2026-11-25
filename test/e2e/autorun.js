/* E2E: автоматически запускает прокрутку и сборку архива на тестовой странице. */
(function () {
  'use strict';

  function report(msg) {
    try { fetch('/log?m=' + encodeURIComponent(String(msg))); } catch (e) {}
  }

  report('autorun: script loaded, readyState=' + document.readyState);

  function go() {
    report('autorun: go');
    var api = globalThis.__maxArchiver;
    if (!api) {
      report('autorun: __maxArchiver НЕ найден');
      return;
    }
    report('autorun: api найден, показываю панель');
    api.showPanel();

    setTimeout(async function () {
      try {
        report('autorun: runScroll start');
        await api.runScroll();
        report('autorun: runScroll done, сообщений=' + api.exp.count());
        await api.runBuild();
        report('autorun: runBuild done');
        var logText = '';
        try {
          logText = document.querySelector('#max-archiver-root').shadowRoot.getElementById('log').textContent;
        } catch (e) { logText = 'нет доступа к логу панели: ' + e.message; }
        report('PAINELLOG ' + logText.slice(-2500));
      } catch (e) {
        report('autorun: ОШИБКА ' + (e && e.message ? e.message : e));
      }
    }, 1200);
  }

  if (document.readyState === 'complete') setTimeout(go, 800);
  else window.addEventListener('load', function () { setTimeout(go, 800); });
})();
