// geo-mock — 跑在頁面自己的 JS 環境（MAIN world）。
// 這裡是唯一真正覆寫 navigator.geolocation 的地方。
// 設定拿不到 chrome.storage，由 bridge.js（ISOLATED world）經 CustomEvent 送進來。
(() => {
  'use strict';

  const EVT_SETTINGS = 'geo-mock:settings';
  const EVT_READY = 'geo-mock:ready';

  const geo = navigator.geolocation;
  if (!geo) return;

  const nativeGetCurrentPosition = geo.getCurrentPosition.bind(geo);

  let settings = null;   // null 代表設定還沒送到，不是「沒有設定」
  const pending = [];    // 陷阱 1：設定到達前進來的請求先排隊，不能直接放行

  document.addEventListener(EVT_SETTINGS, (e) => {
    try {
      settings = JSON.parse(e.detail);
    } catch (err) {
      settings = { enabled: false };   // 解析失敗一律退回真實定位，不要卡住頁面
    }
    while (pending.length) pending.shift()();
  });

  // 握手：bridge.js 可能比本檔晚註冊 listener，也可能早一步就送出設定。
  // 兩邊各主動出手一次，誰先載入都接得上。
  document.dispatchEvent(new CustomEvent(EVT_READY));

  // 注意：這是普通物件，不是真的 GeolocationPosition。
  // 少數網站會檢查 prototype 或 instanceof（SPEC 陷阱 4，第三版再處理）。
  function makePosition(s) {
    return {
      coords: {
        latitude: s.lat,
        longitude: s.lng,
        accuracy: s.accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    };
  }

  function serve(success, error, options) {
    if (settings && settings.enabled) {
      // 非同步回呼，跟原生 API 的行為一致（同步呼叫 success 會讓某些網站的流程錯亂）
      setTimeout(() => success(makePosition(settings)), 0);
      return;
    }
    nativeGetCurrentPosition(success, error, options);
  }

  geo.getCurrentPosition = function (success, error, options) {
    if (settings === null) {
      pending.push(() => serve(success, error, options));
      return;
    }
    serve(success, error, options);
  };
})();
