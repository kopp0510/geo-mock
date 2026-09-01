// geo-mock — 跑在擴充的隔離環境（ISOLATED world）。
// 唯一任務：把 chrome.storage 的設定送進 MAIN world，因為那邊拿不到 chrome.*。
(() => {
  'use strict';

  const EVT_SETTINGS = 'geo-mock:settings';
  const EVT_READY = 'geo-mock:ready';

  // 送不出真正的設定時改送這個。讓 MAIN world 明確收到「不介入」的終端狀態，
  // 好過讓它一直等 —— 等到底是靜默懸掛，最難查。
  const DISABLED = { enabled: false };

  // 遞增序號。頁面自己的 JS 也看得到這些 CustomEvent，序號**擋不住惡意偽造**
  // （見 CLAUDE.md「已知限制」）；它擋的是自家的亂序 —— storage.onChanged 的推送
  // 與 READY 握手的補送會交錯，舊設定後到就把新的蓋掉了。
  let seq = 0;
  let cached = null;

  // 把目前這份設定連同它的序號送出去。跨 world 傳物件會被結構化複製擋掉，
  // 一律轉成 JSON 字串傳。
  function broadcast() {
    document.dispatchEvent(new CustomEvent(EVT_SETTINGS, {
      detail: JSON.stringify({ seq, settings: cached }),
    }));
  }

  function publish(settings) {
    cached = settings;
    seq++;
    broadcast();
  }

  // 握手：bridge.js 可能比 inject.js 晚註冊 listener，也可能早一步就送出設定。
  // 兩邊各主動出手一次，誰先載入都接得上。補送用的是同一個 seq，
  // 而 inject 那邊要求嚴格遞增，所以重複補送不會被當成新設定重跑一次。
  document.addEventListener(EVT_READY, () => {
    if (cached) broadcast();
  });

  // defaults.js 沒載入時要吵。下面的 catch 會把 ReferenceError 一起吃掉，
  // 症狀是「裝了、也啟用了，但每個網站都回真實定位，console 一片乾淨」——
  // 正是本專案最想避免的那種靜默失效。
  if (typeof GEO_MOCK_DEFAULTS === 'undefined' || typeof GEO_MOCK_SITES === 'undefined') {
    console.error('[geo-mock] defaults.js 或 sites.js 未載入，覆寫停用'
      + ' —— 檢查 manifest 的 content_scripts 順序');
    publish(DISABLED);
    return;
  }

  // 要監看哪些鍵：從 defaults 派生，**不要手抄一份**。手抄的話，日後在
  // defaults.js 加了設定欄位卻忘了同步這裡，改那個欄位就不會推送 —— 而 popup、
  // options、README 到處都寫著「即時生效」，是這個專案最不想要的那種靜默失效。
  // （tools/CLAUDE.md：「拆不掉的副本就用斷言看著」，這份拆得掉，那就拆掉。）
  //
  // 例外用扣的，扣掉的每一個都要有理由：
  //   places —— 只有 popup 讀寫，存個地點不該驚動每個分頁
  //   locale —— 介面語言，只有擴充自己的頁面用得到；inject.js 的 console 訊息
  //             不做 i18n（它在 MAIN world，拿不到字串表）
  // 同一個 storage 區裡的 geocodeCache / geocodeLastAt 不在 defaults 裡，
  // 本來就不會被派生進來。
  const NOT_WATCHED = ['places', 'locale'];
  const WATCHED = Object.keys(GEO_MOCK_DEFAULTS).filter((k) => !NOT_WATCHED.includes(k));

  // 「要監看」與「要送出去」是兩件事。excludedSites 必須監看 —— 把目前這個站
  // 加進清單時，這個分頁要立刻停止覆寫；但它**不能送進 MAIN world**：那是一份
  // 使用者關心哪些網站的清單，頁面讀得到就等於白送一份瀏覽偏好。
  const NOT_SENT = ['excludedSites'];
  const SENT = WATCHED.filter((k) => !NOT_SENT.includes(k));

  // 送出去的內容只留 SENT，不是整份設定。這個事件頁面自己的 JS 監聽得到
  // （見 CLAUDE.md「已知限制」），整份送的話，使用者自己命名的地點簿連同精確
  // 座標、以及排除清單都會被每個網站讀走。inject.js 從頭到尾只用得到 SENT 那幾個。
  //
  // 過濾放在這裡而不是 publish() 裡：publish 也服務 DISABLED 那條路徑，
  // 而那條在 GEO_MOCK_DEFAULTS 沒載入時就會跑，那時 SENT 還在 TDZ 裡。
  const pick = (settings) => Object.fromEntries(SENT.map((k) => [k, settings[k]]));

  // 排除的單位是「網站」不是「frame」。加了 all_frames 之後，被排除的頁面裡
  // 嵌的第三方 iframe（地圖、風控廠商）host 不在清單上 —— 只比自己的話，
  // 網銀頁面裡仍有一塊在回報假座標，而使用者完全不會知道：announce() 印在那個
  // iframe 自己的 console，主 frame 看不到。所以本 frame 或最上層命中都算排除。
  function topHost() {
    try {
      const origins = location.ancestorOrigins;
      // ancestorOrigins 由內而外，最後一個是最上層文件
      if (origins && origins.length) return new URL(origins[origins.length - 1]).host;
    } catch { /* 拿不到就退回自己的 host，至少比完全不比對好 */ }
    return location.host;
  }

  // 「不介入」一律送 DISABLED，不管是全域關掉還是這個站被排除。
  // 兩者送不同形狀的話，頁面數一下鍵的數量就分辨得出「使用者把這個站排除了」——
  // 那正是 NOT_SENT 想擋的那一個 bit，從側門漏出去就沒意義了。
  // 順帶修掉一件既有的事：以前全域關掉時照樣把 lat/lng 廣播給每個頁面。
  // inject.js 在 enabled:false 時本來就不讀那些欄位，少送不影響任何行為。
  const effective = (settings) => {
    if (!settings.enabled) return DISABLED;
    const list = settings.excludedSites;
    const here = location.host;
    return (GEO_MOCK_SITES.excluded(list, here) || GEO_MOCK_SITES.excluded(list, topHost()))
      ? DISABLED : pick(settings);
  };

  try {
    chrome.storage.local.get(GEO_MOCK_DEFAULTS, (settings) => {
      // context 在讀取途中失效時，callback 仍可能被呼叫，但帶著 lastError
      if (chrome.runtime.lastError) {
        publish(DISABLED);
        return;
      }
      publish(effective(settings));
    });

    // 改了座標或開關之後，不必重新整理分頁就生效（SPEC 第二版第 6 項）。
    // 注意這只影響頁面**下一次**呼叫 getCurrentPosition —— 已經把位置存起來的
    // 頁面不會自己動，那要 watchPosition（第三版）。
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!WATCHED.some((k) => k in changes)) return;
      // 只把變動的那幾個鍵送過去不夠：使用者可能只改了 lat，其餘欄位仍要帶齊，
      // 所以重讀一次完整設定。
      //
      // 這個 callback 跑在另一個 tick，外層那個 try 接不到它 —— 擴充被 reload 之後
      // 這裡的 chrome.* 會丟「Extension context invalidated」，沒有自己的 try
      // 就變成沒人接的例外，靜靜消失。
      try {
        chrome.storage.local.get(GEO_MOCK_DEFAULTS, (settings) => {
          // 讀不到就維持目前這份設定。這裡不送 DISABLED —— 覆寫已經在運作，
          // 一次讀取失敗不該把它關掉。
          if (chrome.runtime.lastError) return;
          publish(effective(settings));
        });
      } catch (err) {
        console.warn('[geo-mock] 設定更新推送失敗，這個分頁需要重新整理:', err);
      }
    });
  } catch (err) {
    // 「Extension context invalidated」這類同步例外：擴充剛被 reload 或停用。
    // 這是比 inject.js 那道逾時更早、更便宜的一道防線。
    // 一定要印出來，否則非預期的程式錯誤也會在這裡消失無蹤。
    console.warn('[geo-mock] 讀取設定失敗，改走真實定位:', err);
    publish(DISABLED);
  }
})();
