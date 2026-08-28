// geo-mock 設定頁 —— 讀寫 chrome.storage.local 的座標欄位。
// 這裡不放啟用開關，那個在 popup（SPEC：Options 頁只放不常改的欄位）。
(() => {
  'use strict';

  const { t } = GEO_MOCK_I18N;

  // 先用「跟隨瀏覽器」套一次，讀到設定再套第二次，免得選了 English 的人
  // 每次開這頁都先閃一下中文。
  GEO_MOCK_I18N.setLocale('auto');
  GEO_MOCK_I18N.apply();

  const FIELDS = ['lat', 'lng', 'accuracy', 'jitterRadius'];
  // 半徑沒有上限的話，多按幾個零就會讓抖動算出跨半個地球的座標。
  // inject.js 那邊會夾回合法範圍，但使用者看到的行為會很莫名。
  const JITTER_MAX = 100000;   // 公尺
  const el = Object.fromEntries(FIELDS.map(k => [k, document.getElementById(k)]));
  const form = document.getElementById('form');
  const status = document.getElementById('status');

  function say(text, kind) {
    status.textContent = text;
    status.className = kind;
  }

  // 讀的是完整預設（含 enabled、mode、places），但只回填與寫出 FIELDS ——
  // 那幾個歸 popup 管，這裡不能順手把一份陳舊的值寫回去。
  chrome.storage.local.get(GEO_MOCK_DEFAULTS, (saved) => {
    if (chrome.runtime.lastError) {
      say(t('loadFailed', chrome.runtime.lastError.message), 'err');
      return;
    }
    // 語言在 popup 選，這裡只跟著跑
    GEO_MOCK_I18N.setLocale(saved.locale);
    GEO_MOCK_I18N.apply();
    // 這一句帶參數（上限值），apply() 填不了
    document.getElementById('radiusHint').textContent = t('radiusHint', JITTER_MAX);

    for (const k of FIELDS) el[k].value = saved[k];
  });

  // Google Maps 右鍵複製出來的是「緯度, 經度」一整串，
  // type=number 的欄位吃不下（逗號會讓 valueAsNumber 變 NaN），所以另開一個
  // 文字欄接住它，拆完填進下面兩欄。範圍檢查仍走 submit 那條共同路徑。
  document.getElementById('paste').addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    if (!raw) { say('', ''); return; }
    // 逗號或空白分隔都收；科學記號不收，貼上來的座標不會長那樣
    const m = raw.match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) { say(t('pasteBadFormat'), 'err'); return; }
    el.lat.value = m[1];
    el.lng.value = m[2];
    say(t('pasteSplit'), 'ok');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    // 逐欄檢查，不能靠 HTML 的 min/max —— 使用者貼上非數字時 valueAsNumber 會是 NaN
    const values = {};
    for (const k of FIELDS) {
      const n = el[k].valueAsNumber;
      if (!Number.isFinite(n)) { say(t('notANumber', k), 'err'); el[k].focus(); return; }
      values[k] = n;
    }
    if (Math.abs(values.lat) > 90)  { say(t('latRange'), 'err'); el.lat.focus(); return; }
    if (Math.abs(values.lng) > 180) { say(t('lngRange'), 'err'); el.lng.focus(); return; }
    if (values.accuracy < 0)        { say(t('accuracyNegative'), 'err'); el.accuracy.focus(); return; }
    if (values.jitterRadius < 0 || values.jitterRadius > JITTER_MAX) {
      say(t('radiusRange', JITTER_MAX), 'err'); el.jitterRadius.focus(); return;
    }

    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        say(t('saveFailed', chrome.runtime.lastError.message), 'err');
        return;
      }
      say(t('saved'), 'ok');
    });
  });
})();
