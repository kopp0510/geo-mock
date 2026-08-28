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
  // 覆寫沒開的 watch 要交回原生手上，所以連 clearWatch 也得先留一份
  const nativeWatchPosition = geo.watchPosition && geo.watchPosition.bind(geo);
  const nativeClearWatch = geo.clearWatch && geo.clearWatch.bind(geo);

  // jitter 模式下重送位置的間隔
  const JITTER_INTERVAL_MS = 1000;

  // 「不介入，走真實定位」的終端內容。settings 只會被整份替換、不會被就地改動，
  // 所以兩個退回點共用同一個物件（命名與 bridge.js 的 DISABLED 對齊）。
  const DISABLED = { enabled: false };

  // 我們發出去的 watch id 從一個大數起跳。頁面若用 Geolocation.prototype 繞過覆寫
  // 拿到原生 watch（那條路走得通，見 CLAUDE.md「已知限制」），再把原生 id 丟進
  // 我們的 clearWatch，小數字很容易撞上；從 1e6 開始基本上撞不到。
  let nextWatchId = 1000000;
  const watches = new Map();

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

    // 座標換了就等於位置變了，那正是 watchPosition 該回報的事。
    // 順帶處理三種切換：等設定的 watch 現在可以開工、模式改了要換送法、
    // 開關關掉要把 watch 交回原生。
    for (const w of watches.values()) {
      w.armed = true;
      applyWatch(w);
    }
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
    const lat = s.lat + (dist * Math.cos(angle)) / METERS_PER_DEGREE;
    const lng = s.lng + (dist * Math.sin(angle)) / (METERS_PER_DEGREE * shrink);

    // options 頁擋掉了超出 ±90 / ±180 的座標，抖動不該從後門把它們放回去。
    // 中心點設在極點或換日線附近、或半徑打錯多按幾個零時就會撞到。
    // 緯度夾住、經度繞回去（先取模再平移，直接 +540 對很大的負數會繞錯）。
    return {
      lat: Math.min(90, Math.max(-90, lat)),
      lng: (((lng % 360) + 540) % 360) - 180,
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

  // ── watchPosition / clearWatch ───────────────────────────────
  // 跟 getCurrentPosition 最大的不同：**id 必須同步回傳**（陷阱 2）。呼叫端拿到
  // 之後可能立刻 clearWatch，所以不能像 getCurrentPosition 那樣把整個呼叫排隊等
  // 設定 —— 只能先發 id，位置晚點再送。

  function stopDelivery(w) {
    if (w.timer !== null) { clearInterval(w.timer); w.timer = null; }
    if (w.nativeId !== null && nativeClearWatch) {
      nativeClearWatch(w.nativeId);
      w.nativeId = null;
    }
  }

  // 依「目前的設定」決定這個 watch 怎麼送位置。設定每次變更都會再跑一次，
  // 所以它必須能從任何狀態切到任何狀態，先把舊的送法整個停掉再重新開始。
  function applyWatch(w) {
    if (w.stopped || !w.armed) return;
    clearTimeout(w.fallbackTimer);
    stopDelivery(w);

    if (!settings || !settings.enabled) {
      // 覆寫沒開：交回原生，並記下它的 id，好讓我們的 clearWatch 停得掉
      if (nativeWatchPosition) w.nativeId = nativeWatchPosition(w.success, w.error, w.options);
      return;
    }

    // 非同步送第一筆，跟原生 API 的行為一致（同步呼叫 success 會讓某些網站的流程錯亂）
    setTimeout(() => { if (!w.stopped) w.success(makePosition(settings)); }, 0);

    // 固定模式送這一次就安靜：座標不會變，而真正的 watchPosition 只在位置**變化**
    // 時才回呼，每秒重送一組一模一樣的座標是在洗版。
    // jitter 每次都是新座標，持續送才有意義 —— 那正是這個模式存在的理由。
    if (settings.mode === 'jitter') {
      w.timer = setInterval(() => {
        if (!w.stopped) w.success(makePosition(settings));
      }, JITTER_INTERVAL_MS);
    }
  }

  geo.watchPosition = function (success, error, options) {
    const id = nextWatchId++;
    const w = {
      success, error, options,
      timer: null, nativeId: null, fallbackTimer: null,
      armed: false,     // 設定到了沒
      stopped: false,   // clearWatch 過了沒
    };
    watches.set(id, w);

    if (settings === null) {
      // 設定還沒到。跟 getCurrentPosition 的排隊同一個道理，但這裡不能等 ——
      // id 現在就得回傳。設定永遠不來的話，這道逾時會把 watch 交回原生，
      // 不讓呼叫端無聲無息地等一輩子。
      w.fallbackTimer = setTimeout(() => {
        if (settings === null) settings = DISABLED;
        w.armed = true;
        applyWatch(w);
      }, SETTINGS_WAIT_MS);
    } else {
      w.armed = true;
      applyWatch(w);
    }

    return id;   // 同步回傳，這是這個 API 的硬要求
  };

  geo.clearWatch = function (id) {
    const w = watches.get(id);
    if (!w) {
      // 不是我們發的 id —— 頁面可能用 prototype 繞過覆寫建了原生 watch。
      // 轉給原生，不要默默吃掉。
      if (nativeClearWatch) nativeClearWatch(id);
      return;
    }
    w.stopped = true;
    clearTimeout(w.fallbackTimer);
    stopDelivery(w);
    watches.delete(id);
  };
})();
