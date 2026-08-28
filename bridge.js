// geo-mock — 跑在擴充的隔離環境（ISOLATED world）。
// 唯一任務：把 chrome.storage 的設定送進 MAIN world，因為那邊拿不到 chrome.*。
(() => {
  'use strict';

  const EVT_SETTINGS = 'geo-mock:settings';
  const EVT_READY = 'geo-mock:ready';

  // 台北 101 附近（通用知識，僅作為開箱可用的預設值）。
  // enabled 預設開著是因為第一版還沒有 popup 開關，否則無從驗證；
  // task 3 加上開關後再檢討這個預設。
  const DEFAULTS = {
    enabled: true,
    lat: 25.0330,
    lng: 121.5654,
    accuracy: 20,
  };

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

  chrome.storage.local.get(DEFAULTS, (settings) => {
    cached = settings;
    send(settings);
  });
})();
