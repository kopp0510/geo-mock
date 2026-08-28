// 設定的預設值與欄位定義 —— 唯一的一份。
//
// 三個地方共用：bridge.js（content script，ISOLATED world）、options.js（擴充頁面）、
// tools/verify.js（node）。無 build 工具，所以靠 content_scripts 的多檔載入
// 與尾端的 module.exports 同時餵給瀏覽器和 node，不要改成 ESM。
// 用 var 是刻意的：content script 之間共享的是同一個 world 的全域，
// 頂層 const 的 lexical scope 在跨檔存取上不保險。
var GEO_MOCK_DEFAULTS = {
  enabled: true,      // 第一版沒有 popup 開關，預設開著否則無從驗證（task 3 再檢討）
  lat: 25.0330,       // 台北 101 附近
  lng: 121.5654,
  accuracy: 20,       // 公尺
};

// node 端（tools/verify.js）用；瀏覽器裡沒有 module，這行會被跳過。
if (typeof module !== 'undefined' && module.exports) module.exports = GEO_MOCK_DEFAULTS;
