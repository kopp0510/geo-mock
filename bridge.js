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
  if (typeof GEO_MOCK_DEFAULTS === 'undefined') {
    console.error('[geo-mock] defaults.js 未載入，覆寫停用 —— 檢查 manifest 的 content_scripts 順序');
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
  // 同一個 storage 區裡的 geocodeCache / geocodeLastAt 不在 defaults 裡，
  // 本來就不會被派生進來。
  const NOT_WATCHED = ['places'];
  const WATCHED = Object.keys(GEO_MOCK_DEFAULTS).filter((k) => !NOT_WATCHED.includes(k));

  // 送出去的內容也只留 WATCHED，不是整份設定。這個事件頁面自己的 JS 監聽得到
  // （見 CLAUDE.md「已知限制」），整份送的話，使用者自己命名的地點簿連同精確
  // 座標會被每個網站讀走 —— 那超出「頁面看得到你設的那組假座標」那條已知限制
  // 講好的範圍。inject.js 從頭到尾沒讀過 places，多送純粹是白給。
  //
  // 過濾放在這裡而不是 publish() 裡：publish 也服務 DISABLED 那條路徑，
  // 而那條在 GEO_MOCK_DEFAULTS 沒載入時就會跑，那時 WATCHED 還在 TDZ 裡。
  const pick = (settings) => Object.fromEntries(WATCHED.map((k) => [k, settings[k]]));

  try {
    chrome.storage.local.get(GEO_MOCK_DEFAULTS, (settings) => {
      // context 在讀取途中失效時，callback 仍可能被呼叫，但帶著 lastError
      if (chrome.runtime.lastError) {
        publish(DISABLED);
        return;
      }
      publish(pick(settings));
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
          publish(pick(settings));
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
