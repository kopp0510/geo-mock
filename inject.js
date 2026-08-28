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

  // 「不介入，走真實定位」的終端內容。settings 只會被整份替換、不會被就地改動，
  // 所以兩個退回點共用同一個物件（命名與 bridge.js 的 DISABLED 對齊）。
  const DISABLED = { enabled: false };

  let settings = null;   // null 代表設定還沒送到，不是「沒有設定」
  let announced = false;
  let lastSeq = -1;      // 收過的最大序號；bridge.js 的 seq 從 1 開始
  const pending = [];    // 陷阱 1：設定到達前進來的請求先排隊，不能直接放行

  // 單筆請求丟例外不能連累排在它後面的請求（那些會永遠拿不到回應）
  function flush() {
    while (pending.length) {
      try { pending.shift()(); } catch (err) { /* 這筆自己壞掉，繼續排空 */ }
    }
  }

  // 只認得 bridge.js 的 { seq, settings }。不是 JSON、或欄位不齊（頁面自己亂送的
  // 事件也會走到這裡），一律回 null 交給呼叫端統一處理 —— 兩種壞法沒有分別。
  function parseMessage(detail) {
    try {
      const msg = JSON.parse(detail);
      // Number.isInteger 而不是 typeof === 'number'：NaN 也是 number，而
    // NaN <= lastSeq 恆為 false —— 一則 {seq: NaN} 會被收下並讓 lastSeq 永久變成
    // NaN，之後每則訊息都通過，亂序保護整個失效。
    if (msg && Number.isInteger(msg.seq) && msg.settings) return msg;
    } catch (err) { /* 不是 JSON，跟欄位不齊同一種處理 */ }
    return null;
  }

  document.addEventListener(EVT_SETTINGS, (e) => {
    const msg = parseMessage(e.detail);

    if (!msg) {
      // 收到看不懂的東西。分兩種情況，因為「還沒有設定」與「已經在覆寫」
      // 對同一則壞訊息該有不同反應：
      //   還沒有 → 當成不介入並把隊列放掉，否則排隊的請求會一路等到逾時
      //   已經有 → 直接丟掉這則。一則壞訊息不該把運作中的覆寫關掉
      // 兩種情況都不動 lastSeq。
      if (settings === null) {
        settings = DISABLED;
        flush();
      }
      return;
    }

    // 舊的、或 READY 握手重複補送的，不能蓋掉已經收到的新設定。
    if (msg.seq <= lastSeq) return;

    lastSeq = msg.seq;
    settings = msg.settings;
    announced = false;   // 設定換過了，讓下一次覆寫再印一行，座標變更才追得到
    flush();
  });

  // 握手：bridge.js 可能比本檔晚註冊 listener，也可能早一步就送出設定。
  // 兩邊各主動出手一次，誰先載入都接得上。
  document.dispatchEvent(new CustomEvent(EVT_READY));

  // 以**設定的座標**為中心，在 jitterRadius 公尺內隨機取一點。
  // 不是以真實位置為中心 —— 那會需要先拿到真實定位，也不是這個模式的用意
  // （CLAUDE.md 陷阱 5）。
  //
  // 半徑開根號是為了讓點在圓盤上均勻分布：直接用 radius * random() 的話，
  // 靠近圓心的環面積小卻分到同樣多的點，看起來會擠在中間。
  function jitterCoords(s) {
    const radius = Number(s.jitterRadius);
    if (!Number.isFinite(radius) || radius <= 0) return { lat: s.lat, lng: s.lng };

    const METERS_PER_DEGREE = 111320;        // 緯度一度的長度，經度還要再乘 cos(緯度)
    const dist = radius * Math.sqrt(Math.random());
    const angle = Math.random() * 2 * Math.PI;
    // 極點附近 cos 會趨近 0，除下去會炸出天文數字的經度偏移。
    // 夾一個下限，寧可在極圈內抖得比設定值窄，也不要吐出無意義的座標。
    const shrink = Math.max(Math.cos((s.lat * Math.PI) / 180), 1e-6);
    return {
      lat: s.lat + (dist * Math.cos(angle)) / METERS_PER_DEGREE,
      lng: s.lng + (dist * Math.sin(angle)) / (METERS_PER_DEGREE * shrink),
    };
  }

  // 注意：這是普通物件，不是真的 GeolocationPosition。
  // 少數網站會檢查 prototype 或 instanceof（CLAUDE.md 陷阱 4，第三版再處理）。
  function makePosition(s) {
    // 每次呼叫都重新抖，這正是這個模式的用途：測 UI 在座標微幅飄動時的反應
    const at = s.mode === 'jitter' ? jitterCoords(s) : { lat: s.lat, lng: s.lng };
    return {
      coords: {
        latitude: at.lat,
        longitude: at.lng,
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
        console.info('[geo-mock] 定位已覆寫為', settings.lat, settings.lng,
          settings.mode === 'jitter' ? `（抖動半徑 ${settings.jitterRadius} m）` : '');
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
      // 設定沒來就當成「不介入」，後續呼叫才不會每一筆都再排一次隊、再等一次逾時。
      // 這不再是終端狀態 —— 設定若是晚到（或使用者之後改了設定），
      // storage.onChanged 的推送會帶著更大的序號進來把它接回去。
      //
      // 已知取捨：退回原生後，原生會用它自己的 options.timeout 重新計時，
      // 所以這條路徑最壞會花掉呼叫端 timeout 的兩倍（實測 timeout:1000 → 約 2007ms
      // 才收到 error code=3）。選擇忍受這點，是因為 enabled=false 的語義本來就是
      // 「走真實定位」，直接丟 error 會連真實定位也放棄；而這是極端路徑，
      // 正常情況設定 20ms 內就到，根本走不到這裡。
      if (settings === null) settings = DISABLED;
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
