// geo-mock service worker —— 只有一個任務：代替 popup 執行地址查詢。
//
// 為什麼查詢不留在 popup 自己做：popup 只要點到外面就整個銷毀，JS 環境跟著沒了。
// 查詢途中被關掉的話，結果永遠寫不進快取 —— 重開再查同一個字串就是第二次相同
// 請求，正是 Nominatim 政策列為 faulty client、會被封鎖的行為，而使用者完全沒有
// 線索知道這件事發生了。service worker 的生命週期不綁 popup：popup 關掉之後
// fetch 照樣跑完、快取照樣落地，下次查同一個字串就命中快取。
//
// 附帶的好處是速率閘門的狀態集中在單一實例上，不再是「每個 popup 各有一份記憶體
// 狀態，靠 storage 的時間戳兜起來」。storage 那份仍留著，service worker 被
// Chrome 回收後重啟時要靠它。
importScripts('geocode.js');

// popup.js 送的訊息型別。兩邊各寫一次字面值：popup 不載入 geocode.js
// （查詢改走這裡了），沒有現成的共用檔可放，為一個字串新增一支檔案不划算。
const SEARCH = 'geo-mock:search';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== SEARCH) return undefined;   // 不是給我們的，讓別的 listener 處理

  if (typeof msg.query !== 'string') {
    // 少了這道，normalize() 的 query.trim() 會拋，使用者看到的是
    // 「Cannot read properties of undefined」這種對他毫無意義的訊息。
    sendResponse({ error: '查詢字串不見了' });
    return true;
  }

  GEO_MOCK_GEOCODE.search(msg.query).then(
    (results) => sendResponse({ results }),
    // 用 then 的第二個參數而不是接一個 .catch：後者連上面那句 sendResponse
    // 自己丟的例外也會接到，變成同一個請求回覆兩次。
    // String(...) 兜底是因為 error 分支若送出 { error: undefined }，
    // popup 那邊的 if (res.error) 判為 falsy，會往下 render(undefined)。
    (err) => sendResponse({ error: String(err?.message || err) }),
  );

  // true = 稍後才回覆。popup 若已經關掉，這個回覆送不出去（會靜默失敗），
  // 但上面那條 promise 仍會跑完 —— 快取落地正是靠這一點，
  // cachePut 是在 search 內部就 await 掉的，不經過這個回覆通道。
  return true;
});
