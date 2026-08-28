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

  // 使用者可能整串網址貼進來（複製網址列的習慣），也可能只打網域。
  // 一律收斂成 host（含埠號）；認不得就回空字串讓呼叫端報錯。
  function normalize(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    // 萬用字元原樣收下 —— 它不是合法網址，URL() 解不開
    if (raw.startsWith('*.')) return raw.toLowerCase();
    try {
      return new URL(raw.includes('://') ? raw : `http://${raw}`).host.toLowerCase();
    } catch {
      return '';
    }
  }

  return { matches, excluded, normalize };
})();

// node 端（tools/verify.js 的靜態檢查）用；瀏覽器裡沒有 module，這行會被跳過。
if (typeof module !== 'undefined' && module.exports) module.exports = GEO_MOCK_SITES;
