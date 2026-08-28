// geo-mock 介面文字 —— 繁體中文與英文兩份，以及套用到 DOM 的工具。
//
// 為什麼不用 Chrome 原生的 `_locales/` + chrome.i18n.getMessage：那套跟隨的是
// 瀏覽器的 UI 語言，擴充自己**沒辦法**在執行時切換。這是開發工具，想看英文介面
// 時不該逼人去改整台瀏覽器的語言設定，所以字串表自己拿著，語言存在 storage 裡。
// （`_locales/` 仍用在 manifest 的擴充名稱與描述 —— 那兩個 Chrome 只認原生機制。）
//
// popup 與 options 兩頁共用這一份。載入順序是 defaults.js → i18n.js → 頁面自己的
// script，跟 content script 那邊一樣有順序依賴。
const GEO_MOCK_I18N = (() => {
  'use strict';

  const FALLBACK = 'en';

  // key 命名以「哪一塊 + 做什麼」為準，不要用文字本身當 key ——
  // 文案改了 key 就得跟著改，兩邊很容易漂掉。
  const STRINGS = {
    'zh-TW': {
      switchTitle: '啟用／停用定位覆寫',
      searchPlaceholder: '地址或地標，按 Enter 搜尋',
      searchLabel: '搜尋地址或地標',
      searchButton: '搜尋',
      attribution: '地址資料來源：',
      modeLabel: '模式',
      modeFixed: '固定',
      modeJitter: '抖動',
      stateLoading: '讀取中…',
      stateOn: '覆寫中',
      stateOff: '未覆寫，走真實定位',
      fieldLat: '緯度',
      fieldLng: '經度',
      fieldAccuracy: 'accuracy',
      fieldRadius: '抖動半徑',
      addPlace: '＋ 存目前座標',
      placesFull: '已存滿 {0} 個',
      placeNamePlaceholder: '給這個地點一個名字',
      placeNameLabel: '地點名稱',
      save: '存',
      cancel: '取消',
      deletePlace: '刪除',
      deletePlaceLabel: '刪除 {0}',
      liveNote: '改完即時生效，不必重新整理。但頁面要再呼叫一次定位才看得到 —— 已經抓過位置的頁面不會自己更新。',
      openOptions: '進階設定',
      languageLabel: '語言',
      languageAuto: '跟隨瀏覽器',

      // 排除清單
      excludeThis: '這個網站不要覆寫',
      includeThis: '恢復覆寫這個網站',
      siteExcluded: '這個網站已排除，走真實定位',
      excludedName: '不覆寫的網站',
      excludedHint: '列在這裡的網站走真實定位，其餘網站照常覆寫。比對網域含埠號（localhost:3000），也吃 *.example.com 這種子網域寫法。',
      excludedEmpty: '目前沒有排除任何網站',
      sitePlaceholder: 'example.com 或 localhost:3000',
      addSite: '新增',
      badSite: '認不得這個網址，直接填網域就好',
      siteAlready: '這個網站已經在清單上了',

      // popup 的動態訊息
      searching: '搜尋中…',
      noResults: '找不到符合的地點',
      searchFailed: '搜尋失敗:{0}',
      applied: '已套用',
      loadFailed: '讀取設定失敗:{0}',
      saveFailed: '儲存失敗:{0}',
      modeSaveFailed: '模式儲存失敗:{0}',
      placeSaveFailed: '地點儲存失敗:{0}',
      badPlaceCoords: '這個地點的座標壞掉了',
      noCoordsYet: '還沒讀到目前座標，等一下再試',
      modeFixedSet: '固定模式',
      modeJitterSet: '抖動模式，半徑 {0} m',
      noWorker: 'service worker 沒有回應',
      noQuery: '查詢字串不見了',
      httpError: 'Nominatim 回應 {0}',
      timeout: '連線逾時',
      badJson: 'Nominatim 回應不是有效的 JSON',
      offline: '連不上 Nominatim',
      badFormat: 'Nominatim 回應格式不符預期',

      // options 頁
      optionsTitle: 'geo-mock 設定',
      optionsSub: '這裡設定回報給網站的座標。存檔即時生效，不必重新整理分頁 —— 但頁面要再呼叫一次定位才看得到，已經抓過位置的頁面不會自己更新。',
      pasteName: '貼上座標',
      pasteHint: '從 Google Maps 右鍵複製的那一串，例如 24.262246621321527, 120.62450392661896 —— 會自動拆進下面兩欄',
      pastePlaceholder: '緯度, 經度',
      latName: '緯度 latitude',
      latHint: '-90 ～ 90',
      lngName: '經度 longitude',
      lngHint: '-180 ～ 180',
      accuracyName: 'accuracy',
      accuracyHint: '公尺，回報給網站的定位誤差半徑',
      radiusName: '抖動半徑',
      radiusHint: '公尺，上限 {0}（100 公里）。抖動模式下以上面的座標為中心，每次定位在這個半徑內隨機取一點',
      saveButton: '儲存',
      optionsFooter: 'altitude、heading、speed 等欄位尚未實作（見 SPEC.md 第三版）。模式切換（固定／抖動）在 popup。',
      pasteBadFormat: '認不得這個格式，預期「緯度, 經度」',
      pasteSplit: '已拆進下面兩欄，記得按儲存',
      notANumber: '{0} 不是有效的數字',
      latRange: '緯度必須在 -90 ～ 90 之間',
      lngRange: '經度必須在 -180 ～ 180 之間',
      accuracyNegative: 'accuracy 不能是負數',
      radiusRange: '抖動半徑要在 0 ～ {0} 之間',
      saved: '已儲存，即時生效',
    },
    en: {
      switchTitle: 'Enable / disable location override',
      searchPlaceholder: 'Address or landmark, press Enter',
      searchLabel: 'Search for an address or landmark',
      searchButton: 'Search',
      attribution: 'Address data from ',
      modeLabel: 'Mode',
      modeFixed: 'Fixed',
      modeJitter: 'Jitter',
      stateLoading: 'Loading…',
      stateOn: 'Overriding',
      stateOff: 'Not overriding, using real location',
      fieldLat: 'Latitude',
      fieldLng: 'Longitude',
      fieldAccuracy: 'Accuracy',
      fieldRadius: 'Jitter radius',
      addPlace: '+ Save current',
      placesFull: '{0} saved (full)',
      placeNamePlaceholder: 'Name this place',
      placeNameLabel: 'Place name',
      save: 'Save',
      cancel: 'Cancel',
      deletePlace: 'Delete',
      deletePlaceLabel: 'Delete {0}',
      liveNote: 'Changes apply immediately — no reload needed. But the page only sees them the next time it asks for a location; pages that already cached one will not update on their own.',
      openOptions: 'Advanced settings',
      languageLabel: 'Language',
      languageAuto: 'Follow browser',

      excludeThis: "Don't override this site",
      includeThis: 'Override this site again',
      siteExcluded: 'This site is skipped — using real location',
      excludedName: 'Sites to skip',
      excludedHint: 'Sites listed here use the real location; every other site is still overridden. Matching is on host including port (localhost:3000), and *.example.com covers subdomains.',
      excludedEmpty: 'No sites are being skipped',
      sitePlaceholder: 'example.com or localhost:3000',
      addSite: 'Add',
      badSite: "Can't read that as an address — just the domain is enough",
      siteAlready: 'That site is already on the list',

      searching: 'Searching…',
      noResults: 'No matching place found',
      searchFailed: 'Search failed: {0}',
      applied: 'Applied',
      loadFailed: 'Could not read settings: {0}',
      saveFailed: 'Save failed: {0}',
      modeSaveFailed: 'Could not save mode: {0}',
      placeSaveFailed: 'Could not save place: {0}',
      badPlaceCoords: 'This place has broken coordinates',
      noCoordsYet: 'Current coordinates not loaded yet, try again in a moment',
      modeFixedSet: 'Fixed mode',
      modeJitterSet: 'Jitter mode, radius {0} m',
      noWorker: 'No response from the service worker',
      noQuery: 'The query string went missing',
      httpError: 'Nominatim responded {0}',
      timeout: 'Connection timed out',
      badJson: 'Nominatim did not return valid JSON',
      offline: 'Cannot reach Nominatim',
      badFormat: 'Unexpected response shape from Nominatim',

      optionsTitle: 'geo-mock settings',
      optionsSub: 'The coordinates reported to websites. Saving applies immediately, no reload needed — but the page only sees them the next time it asks for a location.',
      pasteName: 'Paste coordinates',
      pasteHint: 'The string you get from right-clicking in Google Maps, e.g. 24.262246621321527, 120.62450392661896 — it will be split into the two fields below',
      pastePlaceholder: 'latitude, longitude',
      latName: 'Latitude',
      latHint: '-90 to 90',
      lngName: 'Longitude',
      lngHint: '-180 to 180',
      accuracyName: 'Accuracy',
      accuracyHint: 'Metres. The accuracy radius reported to websites',
      radiusName: 'Jitter radius',
      radiusHint: 'Metres, up to {0} (100 km). In jitter mode each fix lands somewhere inside this radius around the coordinates above',
      saveButton: 'Save',
      optionsFooter: 'altitude, heading and speed are not implemented yet (see SPEC.md, third pass). The fixed/jitter switch lives in the popup.',
      pasteBadFormat: 'Unrecognised format, expected "latitude, longitude"',
      pasteSplit: 'Split into the two fields below — remember to save',
      notANumber: '{0} is not a valid number',
      latRange: 'Latitude must be between -90 and 90',
      lngRange: 'Longitude must be between -180 and 180',
      accuracyNegative: 'Accuracy cannot be negative',
      radiusRange: 'Jitter radius must be between 0 and {0}',
      saved: 'Saved, applied immediately',
    },
  };

  // storage 存的偏好；'auto' 以外的值才是真的鎖定語言。
  // 從 STRINGS 長出來，多一種語言時不必記得回來補這一行。
  const LOCALES = ['auto', ...Object.keys(STRINGS)];

  let locale = FALLBACK;

  // 'auto' 時跟隨瀏覽器。chrome.i18n 在擴充頁一定有，但 getUILanguage 回的是
  // 'zh-TW' / 'en-US' / 'ja' 這類 BCP 47，只看語言部分就夠了。
  //
  // 認得的語系直接以 STRINGS 為準，不再另外寫死一份語言清單 —— 兩邊分開寫的話，
  // 加第三種語言時很容易只加了字串表，卻忘了這裡，症狀是「選了就是沒反應」。
  // 用 hasOwn 而不是 in：storage 讀回來的值可能是 'toString' 這種原型鏈上的名字。
  function resolve(pref) {
    if (Object.hasOwn(STRINGS, pref)) return pref;
    const ui = chrome.i18n?.getUILanguage?.() || '';
    return ui.toLowerCase().startsWith('zh') ? 'zh-TW' : FALLBACK;
  }

  function setLocale(pref) {
    locale = resolve(pref);
    // service worker 也載入這支檔案（background.js 要翻譯查詢失敗的訊息），
    // 那裡沒有 document。
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
    return locale;
  }

  // 找不到 key 就回 key 本身：畫面上會出現一個突兀的英數字串，
  // 比默默顯示空白容易發現。{0} {1} 依序換成後面的參數；
  // 沒給對應參數的佔位符原樣留著，同樣是為了讓漏帶參數看得出來。
  function t(key, ...args) {
    // 用 Object.hasOwn 而不是 ?? ：'toString'、'constructor' 這種名字在原型鏈上
    // 找得到，?? 會判為非 nullish，於是三層退回整個失效、raw 變成一個函式，
    // 下一行的 raw.replace 直接丟 TypeError —— 而這個例外發生在 apply() 的迴圈裡，
    // 後面的元素全都不會被翻譯，popup 會永遠停在「讀取中…」。
    // resolve() 與 tools/verify.js 的 checkLocales() 都特地防了這一類，只有這裡漏掉。
    const table = STRINGS[locale];
    const fallback = STRINGS[FALLBACK];
    const raw = Object.hasOwn(table, key) ? table[key]
      : Object.hasOwn(fallback, key) ? fallback[key]
        : key;
    return raw.replace(/\{(\d+)\}/g, (placeholder, i) => args[i] ?? placeholder);
  }

  // 把 data-i18n="key" 的元素填上文字，data-i18n-attr="placeholder:key,title:key"
  // 的元素填上屬性。靜態文字全部走這條，不要散在各自的 JS 裡。
  function apply(root) {
    const scope = root || document;
    for (const el of scope.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.dataset.i18n);
    }
    for (const el of scope.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split(':').map((part) => part.trim());
        // 半套的標記（少了冒號、或空白的屬性名）直接跳過。setAttribute('') 會丟
        // InvalidCharacterError，一個手誤就會讓整頁的翻譯停在那一行。
        if (!attr || !key) continue;
        el.setAttribute(attr, t(key));
      }
    }
  }

  // STRINGS 一併交出去，讓 tools/verify.js 能靜態比對兩份表的 key 有沒有漂掉 ——
  // 少一個 key 的那一邊會默默 fallback 成英文，畫面上看不出是漏譯還是刻意不譯。
  // current() 給 geocode.js 用：Nominatim 的 accept-language 要跟著介面語系走
  return { t, apply, setLocale, resolve, current: () => locale, LOCALES, STRINGS };
})();

// node 端（給驗證腳本比對兩份表的 key 是否一致）用；瀏覽器裡沒有 module，會跳過。
if (typeof module !== 'undefined' && module.exports) module.exports = GEO_MOCK_I18N;
