// geo-mock — 跑在頁面自己的 JS 環境（MAIN world）。
// 這裡是唯一真正覆寫 navigator.geolocation 的地方。
// 設定拿不到 chrome.storage，由 bridge.js（ISOLATED world）經 CustomEvent 送進來。
(() => {
  'use strict';

  const EVT_SETTINGS = 'geo-mock:settings';
  const EVT_READY = 'geo-mock:ready';

  // 等設定的上限。正常情況實測 15–20ms 就到；這道保險是為了 bridge.js 整個沒送成的
  // 情況（storage 出錯、擴充在頁面載入途中被 reload）—— 沒有它，呼叫端的 success 與
  // error 兩個 callback 都永遠不會被呼叫，症狀是 loading 轉不停而 console 一片乾淨，
  // 比退回真實定位難查得多。
  const SETTINGS_WAIT_MS = 3000;

  const geo = navigator.geolocation;
  if (!geo) return;

  const nativeGetCurrentPosition = geo.getCurrentPosition.bind(geo);

  let settings = null;   // null 代表設定還沒送到，不是「沒有設定」
  let announced = false;
  const pending = [];    // 陷阱 1：設定到達前進來的請求先排隊，不能直接放行

  document.addEventListener(EVT_SETTINGS, (e) => {
    try {
      settings = JSON.parse(e.detail);
    } catch (err) {
      settings = { enabled: false };   // 解析失敗一律退回真實定位，不要卡住頁面
    }
    // 單筆請求丟例外不能連累排在它後面的請求（那些會永遠拿不到回應）
    while (pending.length) {
      try { pending.shift()(); } catch (err) { /* 這筆自己壞掉，繼續排空 */ }
    }
  });

  // 握手：bridge.js 可能比本檔晚註冊 listener，也可能早一步就送出設定。
  // 兩邊各主動出手一次，誰先載入都接得上。
  document.dispatchEvent(new CustomEvent(EVT_READY));

  // 注意：這是普通物件，不是真的 GeolocationPosition。
  // 少數網站會檢查 prototype 或 instanceof（CLAUDE.md 陷阱 4，第三版再處理）。
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
      if (!announced) {
        announced = true;
        // 預設開啟且套用到所有網站，不留痕跡的話「為什麼我在台北 101」無從查起。
        console.info('[geo-mock] 定位已覆寫為', settings.lat, settings.lng);
      }
      // 非同步回呼，跟原生 API 的行為一致（同步呼叫 success 會讓某些網站的流程錯亂）
      setTimeout(() => success(makePosition(settings)), 0);
      return;
    }
    nativeGetCurrentPosition(success, error, options);
  }

  // 設定還沒到：排隊，但一定要留出口。呼叫端自己帶了 timeout 時，等待不超過它。
  function enqueue(success, error, options) {
    let done = false;
    const asked = options && options.timeout;
    const waitMs = Math.min(Number.isFinite(asked) ? asked : SETTINGS_WAIT_MS, SETTINGS_WAIT_MS);

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      // 設定沒來就當成「不介入」，並記成終端狀態 ——
      // 否則後續每一筆呼叫都會再排一次隊、再等一次逾時。
      //
      // 已知取捨：退回原生後，原生會用它自己的 options.timeout 重新計時，
      // 所以這條路徑最壞會花掉呼叫端 timeout 的兩倍（實測 timeout:1000 → 約 2007ms
      // 才收到 error code=3）。選擇忍受這點，是因為 enabled=false 的語義本來就是
      // 「走真實定位」，直接丟 error 會連真實定位也放棄；而這是極端路徑，
      // 正常情況設定 20ms 內就到，根本走不到這裡。
      if (settings === null) settings = { enabled: false };
      serve(success, error, options);
    }, waitMs);

    pending.push(() => {
      if (done) return;        // 已經逾時走掉了，同一筆不服務兩次
      done = true;
      clearTimeout(timer);
      serve(success, error, options);
    });
  }

  geo.getCurrentPosition = function (success, error, options) {
    if (settings === null) {
      enqueue(success, error, options);
      return;
    }
    serve(success, error, options);
  };
})();
