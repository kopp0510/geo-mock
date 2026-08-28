// geo-mock — 跑在擴充的隔離環境（ISOLATED world）。
// 唯一任務：把 chrome.storage 的設定送進 MAIN world，因為那邊拿不到 chrome.*。
(() => {
  'use strict';

  const EVT_SETTINGS = 'geo-mock:settings';
  const EVT_READY = 'geo-mock:ready';

  // 送不出真正的設定時改送這個。讓 MAIN world 明確收到「不介入」的終端狀態，
  // 好過讓它一直等 —— 等到底是靜默懸掛，最難查。
  const DISABLED = { enabled: false };

  // 跨 world 傳物件會被結構化複製擋掉，一律轉成 JSON 字串傳。
  function send(settings) {
    document.dispatchEvent(
      new CustomEvent(EVT_SETTINGS, { detail: JSON.stringify(settings) })
    );
  }

  let cached = null;
  document.addEventListener(EVT_READY, () => {
    if (cached) send(cached);
  });

  function publish(settings) {
    cached = settings;
    send(settings);
  }

  try {
    chrome.storage.local.get(GEO_MOCK_DEFAULTS, (settings) => {
      // context 在讀取途中失效時，callback 仍可能被呼叫，但帶著 lastError
      if (chrome.runtime.lastError) {
        publish(DISABLED);
        return;
      }
      publish(settings);
    });
  } catch (err) {
    // 「Extension context invalidated」這類同步例外：擴充剛被 reload 或停用。
    // 這是比 inject.js 那道逾時更早、更便宜的一道防線。
    publish(DISABLED);
  }
})();
