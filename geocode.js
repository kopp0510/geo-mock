// geo-mock 地址搜尋 —— 包住 Nominatim 的查詢、快取與速率閘門。
//
// 由 service worker（background.js）以 importScripts 載入，不是 content script，
// 所以這裡可以直接用 chrome.storage 的 promise 版 API，也不必像 defaults.js 那樣
// 防二次注入。
// **popup 不載入這支檔案** —— 它改用 sendMessage 請 service worker 查，
// 理由見 background.js 開頭（popup 中途關閉時快取要能落地）。
//
// ── Nominatim 使用政策（硬約束，違反會被封鎖）───────────────────────────
// https://operations.osmfoundation.org/policies/nominatim/
// 這支檔案是唯一送出請求的地方，政策的每一條都兌現在這裡：
//
// Requirements
//   · 絕對上限每秒 1 次        → gate()，時間戳同時看記憶體與 storage
//   · 必須提供可識別應用程式的 Referer 或 User-Agent，政策原文明寫
//     「stock User-Agents as set by http libraries will not do」
//                              → rules.json 的 declarativeNetRequest 規則。
//                                fetch 設不了 User-Agent（瀏覽器禁止的 header），
//                                只能在送出前由 DNR 改寫。**別把那條規則刪掉**
//   · 必須顯示出處              → popup.html 的 .attrib
//
// Unacceptable Use（政策原文：strictly forbidden and will get you banned）
//   · Auto-complete search：「you must not implement such a service on the
//     client side using the API」→ 所以搜尋只由 Enter 或搜尋鈕觸發，
//     **不做打字即查**。這條跟速率無關，debounce 拉多長都不合規，別加回來
//   · 重複送同一個 query 會被歸類為 faulty client → 快取 + in-flight 去重
const GEO_MOCK_GEOCODE = (() => {
  'use strict';

  const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  const CACHE_KEY = 'geocodeCache';
  const LAST_AT_KEY = 'geocodeLastAt';

  const MIN_INTERVAL_MS = 1000;    // 兩次實際送出之間的硬下限
  // 兩個理由，第二個是硬上限：
  //   1. 沒有這道，卡住的請求會鎖死整條 chain
  //   2. **必須明顯小於 30000** —— Chrome 會終止「fetch 超過 30 秒還沒回應」的
  //      service worker，而 gate() 的時間戳在 fetch 之前就寫進 storage 了。
  //      被砍在中間的話結果到不了 cachePut，下次查同一個字串就重送一次，
  //      正是 background.js 開頭那段要修掉的行為。tools/verify.js 第 1 項守著這條
  const TIMEOUT_MS = 8000;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_MAX = 50;            // 快取筆數上限，超過丟最舊的
  const LIMIT = 5;                 // 候選清單長度

  // service worker 被 Chrome 回收、下次事件再重啟時是全新的 JS 環境，
  // 記憶體裡的時間戳會歸零 —— 所以真正把關的是存進 storage 的那份，
  // 記憶體這份只是省一次讀取。
  let lastRequestAt = 0;
  let chain = Promise.resolve();
  const inflight = new Map();      // 正規化後的查詢字串 → 還在路上的那一發

  // 快取鍵：去頭尾、壓縮空白、轉小寫。「 台北  車站 」與「台北 車站」算同一筆。
  function normalize(query) {
    return query.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // chrome.storage.local.get 回的是整包物件，取單一鍵要寫 computed-key 解構、
  // 鍵名得重複兩次。包一層讓下面的呼叫端讀起來是「拿這個鍵，沒有就給預設」。
  async function readLocal(key, fallback) {
    const stored = await chrome.storage.local.get(key);
    return stored[key] === undefined ? fallback : stored[key];
  }

  async function cacheGet(key) {
    const cache = await readLocal(CACHE_KEY, {});
    const hit = cache[key];
    if (!hit || Date.now() - hit.ts > CACHE_TTL_MS) return null;
    return hit.results;
  }

  async function cachePut(key, results) {
    const cache = await readLocal(CACHE_KEY, {});
    const next = { ...cache, [key]: { ts: Date.now(), results } };

    const keys = Object.keys(next);
    const excess = keys.length - CACHE_MAX;
    if (excess > 0) {
      keys.sort((a, b) => next[a].ts - next[b].ts);
      for (const stale of keys.slice(0, excess)) delete next[stale];
    }

    await chrome.storage.local.set({ [CACHE_KEY]: next });
  }

  // 送出前先擋住，確保與上一次送出至少隔 MIN_INTERVAL_MS。
  async function gate() {
    const storedAt = await readLocal(LAST_AT_KEY, 0);
    // 取兩者較大的：storage 那份跨 popup 開關有效，記憶體那份反映本次剛送出的。
    const wait = MIN_INTERVAL_MS - (Date.now() - Math.max(storedAt, lastRequestAt));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    // 時間戳刻意在 fetch 之前就先落地：寫入失敗就直接 throw，請求根本不會送出，
    // 不會出現「送了但沒記錄」而讓下一發提早穿過閘門。
    await chrome.storage.local.set({ [LAST_AT_KEY]: lastRequestAt });
  }

  async function fetchRemote(query) {
    await gate();
    const url = `${ENDPOINT}?format=jsonv2&limit=${LIMIT}`
      + `&accept-language=zh-TW&q=${encodeURIComponent(query)}`;

    // 讀 body 也要包在 try 裡：captive portal／公司 proxy 會回一頁 HTML，
    // 那時炸的是 res.json() 而不是 fetch，漏在外面的話使用者會看到
    // 「搜尋失敗:Unexpected token '<'」。逾時也可能發生在 body 還在讀的階段。
    let raw;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      // 帶 cause 標記，好讓下面的 catch 認出「連得上、但對方回了錯誤碼」，
      // 不要把它一併翻譯成「連不上」。
      if (!res.ok) throw new Error(`Nominatim 回應 ${res.status}`, { cause: 'http' });
      raw = await res.json();
    } catch (err) {
      // 原始錯誤是英文的 TimeoutError／SyntaxError／TypeError，直接丟給使用者
      // 看沒有意義；但也不能整個吞掉，留一份原文在 console。
      console.error('[geo-mock] Nominatim 請求失敗:', err);
      if (err.cause === 'http') throw err;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('連線逾時');
      if (err.name === 'SyntaxError') throw new Error('Nominatim 回應不是有效的 JSON');
      throw new Error('連不上 Nominatim');
    }

    // 正常是一個陣列。擋掉錯誤物件之類的回應，否則錯誤訊息會變成
    // 「raw.map is not a function」，對使用者毫無意義。
    if (!Array.isArray(raw)) throw new Error('Nominatim 回應格式不符預期');

    // lat/lon 回來是字串，不轉的話存進 storage 的是字串，
    // 畫面上看起來一模一樣，但 inject.js 拿到的座標型別就錯了。
    return raw
      .map((place) => ({
        label: place.display_name,
        lat: parseFloat(place.lat),
        lng: parseFloat(place.lon),
      }))
      .filter((place) => place.label
        && Number.isFinite(place.lat) && Number.isFinite(place.lng));
  }

  // 查一組候選。先看快取，沒有才送出。
  async function search(query) {
    const key = normalize(query);
    if (!key) return [];

    const hit = await cacheGet(key);
    if (hit) return hit;

    // 同一個字串已經在路上就共用那一發。快取要等結果回來才寫得進去，
    // 少了這道去重，連按兩次 Enter 就是兩發一模一樣的請求 ——
    // 政策把「repeatedly the same query」列為會被封鎖的行為。
    const pending = inflight.get(key);
    if (pending) return pending;

    // 同時只讓一發在路上（串成鏈），否則兩發併行會一起穿過 gate()，
    // 變成同一秒兩次請求。
    const next = chain.catch(() => {}).then(() => fetchRemote(key));
    chain = next.catch(() => {});   // 前一發失敗不能卡死後面的

    const task = next
      .then(async (results) => {
        // 快取是最佳努力。寫不進去也不該把已經到手的結果丟掉 ——
        // 那等於白打一發請求還兩手空空，下次查同一個字串又得再送一遍。
        await cachePut(key, results)
          .catch((err) => console.error('[geo-mock] 快取寫入失敗:', err));
        return results;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
  }

  return { search };
})();
