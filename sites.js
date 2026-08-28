// 排除清單的比對規則 —— content script（bridge.js）與擴充頁（popup/options）共用。
//
// 為什麼要獨立一支檔案：規則若手抄兩份，改了一邊就會漂掉，而症狀是
// 「popup 說這個站排除了，實際上還在覆寫」——「拆得掉的副本就拆掉」，
// 跟 bridge.js 的 WATCHED 從 defaults 派生是同一個理由（見 tools/CLAUDE.md）。
//
// 用 var 而非 const：跟 defaults.js 同理，這支檔案會被注入每個頁面，
// 萬一二次注入，const 會直接丟 SyntaxError 炸掉整個 content script。
var GEO_MOCK_SITES = (() => {
  'use strict';

  // 比對 location.host —— **含埠號**。開發場景幾乎一定會用到 localhost:3000
  // 這種寫法，只比網域的話那條規則會漏掉。
  // `*.example.com` 只吃子網域，不含 example.com 本身，跟一般的直覺一致。
  function matches(pattern, host) {
    const p = String(pattern || '').trim().toLowerCase();
    const h = String(host || '').trim().toLowerCase();
    if (!p || !h) return false;
    if (p.startsWith('*.')) return h.endsWith(p.slice(1));
    return h === p;
  }

  function excluded(list, host) {
    return (Array.isArray(list) ? list : []).some((pattern) => matches(pattern, host));
  }

  // host 最長 253 個字元，再給埠號一點空間。沒有上限的話 300 字元的垃圾也會被
  // 原樣寫進 storage.local，而那塊配額跟 geocodeCache 是共用的。
  const MAX_LENGTH = 300;

  // 使用者可能整串網址貼進來（複製網址列的習慣），也可能只打網域。
  // 一律收斂成 host（含埠號）；認不得就回空字串讓呼叫端報錯。
  //
  // **萬用字元也要走同一套驗證**：早期版本直接把 `*.` 開頭的原樣收下，結果
  // `*.example.com/`（多貼一個斜線）會存進一條長得很正常、卻永遠不會命中的
  // 死規則 —— 使用者去該站測試發現還是被覆寫，唯一能得到的結論是「功能壞了」。
  // 走 URL() 還順便拿到 IDN → punycode 的轉換（location.host 給的是 punycode）。
  function normalize(input) {
    const raw = String(input || '').trim();
    if (!raw || raw.length > MAX_LENGTH) return '';

    const wildcard = raw.startsWith('*.');
    const body = wildcard ? raw.slice(2) : raw;
    if (!body) return '';

    try {
      const { host } = new URL(body.includes('://') ? body : `http://${body}`);
      if (!host) return '';
      return wildcard ? `*.${host.toLowerCase()}` : host.toLowerCase();
    } catch {
      return '';
    }
  }

  return { matches, excluded, normalize };
})();

// node 端（tools/verify.js 的靜態檢查）用；瀏覽器裡沒有 module，這行會被跳過。
if (typeof module !== 'undefined' && module.exports) module.exports = GEO_MOCK_SITES;
