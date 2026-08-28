// geo-mock — 跑在擴充的隔離環境（ISOLATED world）。
// 唯一任務：把 chrome.storage 的設定送進 MAIN world，因為那邊拿不到 chrome.*。
(() => {
  'use strict';

  const EVT_SETTINGS = 'geo-mock:settings';
  const EVT_READY = 'geo-mock:ready';

  // 台北 101 附近（通用知識，僅作為開箱可用的預設值）。
  // 改動 lat/lng 需同步更新 tools/verify.js 的 EXPECT，否則驗證會比對到過時的座標，
  // 而失敗訊息會把人誤導到 inject.js 去找問題。
  // enabled 預設開著是因為第一版還沒有 popup 開關，否則無從驗證；
  // task 3 加上開關後再檢討這個預設。
  const DEFAULTS = {
    enabled: true,
    lat: 25.0330,
    lng: 121.5654,
    accuracy: 20,
  };

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
    chrome.storage.local.get(DEFAULTS, (settings) => {
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
