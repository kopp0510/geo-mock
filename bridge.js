// geo-mock — 跑在擴充的隔離環境（ISOLATED world）。
// 唯一任務：把 chrome.storage 的設定送進 MAIN world，因為那邊拿不到 chrome.*。
(() => {
  'use strict';

  const EVT_SETTINGS = 'geo-mock:settings';
  const EVT_READY = 'geo-mock:ready';

  // 送不出真正的設定時改送這個。讓 MAIN world 明確收到「不介入」的終端狀態，
  // 好過讓它一直等 —— 等到底是靜默懸掛，最難查。
  const DISABLED = { enabled: false };

  // inject.js 真正會用到的鍵。同一個 storage 區裡還有 geocodeCache、geocodeLastAt
  // 這些每次搜尋都會寫的東西 —— 不過濾的話，使用者查一次地址就會對每個開著的分頁
  // 推一次設定，白費工還把 console 洗版。
  const WATCHED = ['enabled', 'lat', 'lng', 'accuracy'];

  // 遞增序號。頁面自己的 JS 也看得到這些 CustomEvent，序號**擋不住惡意偽造**
  // （見 CLAUDE.md「已知限制」）；它擋的是自家的亂序 —— storage.onChanged 的推送
  // 與 READY 握手的補送會交錯，舊設定後到就把新的蓋掉了。
  let seq = 0;
  let cached = null;

  // 跨 world 傳物件會被結構化複製擋掉，一律轉成 JSON 字串傳。
  function send() {
    document.dispatchEvent(new CustomEvent(EVT_SETTINGS, {
      detail: JSON.stringify({ seq, settings: cached }),
    }));
  }

  function publish(settings) {
    cached = settings;
    seq++;
    send();
  }

  // 握手：bridge.js 可能比 inject.js 晚註冊 listener，也可能早一步就送出設定。
  // 兩邊各主動出手一次，誰先載入都接得上。補送用的是同一個 seq，
  // 而 inject 那邊要求嚴格遞增，所以重複補送不會被當成新設定重跑一次。
  document.addEventListener(EVT_READY, () => {
    if (cached) send();
  });

  // defaults.js 沒載入時要吵。下面的 catch 會把 ReferenceError 一起吃掉，
  // 症狀是「裝了、也啟用了，但每個網站都回真實定位，console 一片乾淨」——
  // 正是本專案最想避免的那種靜默失效。
  if (typeof GEO_MOCK_DEFAULTS === 'undefined') {
    console.error('[geo-mock] defaults.js 未載入，覆寫停用 —— 檢查 manifest 的 content_scripts 順序');
    publish(DISABLED);
    return;
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

    // 改了座標或開關之後，不必重新整理分頁就生效（SPEC 第二版第 6 項）。
    // 注意這只影響頁面**下一次**呼叫 getCurrentPosition —— 已經把位置存起來的
    // 頁面不會自己動，那要 watchPosition（第三版）。
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!WATCHED.some((k) => k in changes)) return;
      // 只把變動的那幾個鍵送過去不夠：使用者可能只改了 lat，其餘欄位仍要帶齊，
      // 所以重讀一次完整設定。
      chrome.storage.local.get(GEO_MOCK_DEFAULTS, (settings) => {
        // 讀不到就維持目前這份設定。這裡不送 DISABLED —— 覆寫已經在運作，
        // 一次讀取失敗不該把它關掉。
        if (chrome.runtime.lastError) return;
        publish(settings);
      });
    });
  } catch (err) {
    // 「Extension context invalidated」這類同步例外：擴充剛被 reload 或停用。
    // 這是比 inject.js 那道逾時更早、更便宜的一道防線。
    // 一定要印出來，否則非預期的程式錯誤也會在這裡消失無蹤。
    console.warn('[geo-mock] 讀取設定失敗，改走真實定位:', err);
    publish(DISABLED);
  }
})();
