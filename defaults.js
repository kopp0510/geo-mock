// 設定的預設值與欄位定義 —— 唯一的一份。
//
// 三個地方共用：bridge.js（content script，ISOLATED world）、options.js（擴充頁面）、
// tools/verify.js（node）。無 build 工具，所以靠 content_scripts 的多檔載入
// 與尾端的 module.exports 同時餵給瀏覽器和 node，不要改成 ESM。
// 用 var 而非 const 是刻意的，但理由不是「const 跨檔讀不到」——
// 已實測改成 const 時 verify.js 四項仍全 PASS，classic script 的頂層 const
// 後續檔案讀得到。真正的理由是：var 掛在 globalThis 上，且重複宣告不會丟
// SyntaxError —— 萬一這支檔案被二次注入，const 會直接炸掉整個 content script。
var GEO_MOCK_DEFAULTS = {
  enabled: true,      // 有 popup 開關之後仍維持開啟，理由見 CLAUDE.md「已知限制」
  lat: 25.0330,       // 台北 101 附近
  lng: 121.5654,
  accuracy: 20,       // 公尺
  // 'fixed' = 就回報上面那組座標；'jitter' = 以它為中心隨機偏移。
  // **預設必須是 fixed** —— 好幾項驗證斷言比對的是精確座標，預設抖動會全紅。
  mode: 'fixed',
  jitterRadius: 50,   // 公尺。jitter 模式的最大偏移半徑
  // 已存地點。只有 popup 讀寫，bridge.js 的 WATCHED 刻意不含它 ——
  // 存一個地點不該對每個開著的分頁推一次設定。
  places: [],         // [{ label, lat, lng }]，上限見 popup.js 的 PLACE_MAX
};

// node 端（tools/verify.js）用；瀏覽器裡沒有 module，這行會被跳過。
if (typeof module !== 'undefined' && module.exports) module.exports = GEO_MOCK_DEFAULTS;
