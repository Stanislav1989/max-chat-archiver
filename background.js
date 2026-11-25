/* MAX Chat Archiver — фоновая часть: только кнопка на панели инструментов. */
'use strict';

browser.action.onClicked.addListener(async function (tab) {
  if (!tab || tab.id == null) return;
  // content-скрипт мог ещё не успеть загрузиться — пробуем несколько раз
  for (var i = 0; i < 4; i++) {
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'toggle-panel' });
      return;
    } catch (e) {
      await new Promise(function (r) { setTimeout(r, 350); });
    }
  }
});
