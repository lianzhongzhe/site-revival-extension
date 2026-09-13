// 弹窗逻辑：展示待恢复列表 + 设置

const DEFAULTS = { autoReopen: true, notify: true, intervalSec: 300 }; // 300 秒 = 5 分钟

function $(sel) { return document.querySelector(sel); }

function fmtTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return m + ' 分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时前';
  return Math.floor(h / 24) + ' 天前';
}

async function load() {
  const data = await chrome.storage.local.get(null);
  const settings = Object.assign({}, DEFAULTS, data.settings || {});
  // 兼容旧版按分钟存储的设置
  if (!Number.isFinite(Number(settings.intervalSec)) || Number(settings.intervalSec) <= 0) {
    const legacy = Number(data.settings && data.settings.checkIntervalMin);
    settings.intervalSec = Number.isFinite(legacy) && legacy > 0 ? Math.round(legacy * 60) : DEFAULTS.intervalSec;
  }
  settings.intervalSec = Math.round(Number(settings.intervalSec));
  $('#autoReopen').checked = settings.autoReopen;
  $('#notify').checked = settings.notify;
  intervalUnit = settings.intervalSec < 60 ? 'sec' : 'min';
  $('#unit').value = intervalUnit;
  $('#interval').value = displayInterval(settings.intervalSec, intervalUnit);

  const keys = Object.keys(data).filter((k) => k.startsWith('pending:'));
  const items = keys.map((k) => data[k]).filter(Boolean).sort((a, b) => b.savedAt - a.savedAt);

  const list = $('#list');
  list.innerHTML = '';
  $('#empty').style.display = items.length ? 'none' : 'block';
  $('#badge').textContent = items.length ? items.length + ' 个待恢复' : '一切正常';

  for (const e of items) {
    const div = document.createElement('div');
    div.className = 'item';

    const main = document.createElement('div');
    main.className = 'item-main';
    main.title = e.url;
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = e.url.replace(/^https?:\/\//, '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (e.error || '') + ' · 失效于 ' + fmtTime(e.savedAt) + ' · 已探测 ' + (e.attempts || 0) + ' 次';
    main.append(url, meta);

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const open = document.createElement('button');
    open.className = 'btn open';
    open.textContent = '打开';
    open.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'OPEN_NOW', url: e.url });
      load();
    });
    const del = document.createElement('button');
    del.className = 'btn del';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'DELETE_PENDING', url: e.url });
      load();
    });
    actions.append(open, del);

    div.append(main, actions);
    list.appendChild(div);
  }
}

$('#checkNow').addEventListener('click', async () => {
  $('#status').textContent = '正在检查，完成后自动刷新…';
  await chrome.runtime.sendMessage({ type: 'CHECK_NOW' });
  setTimeout(load, 2500);
  setTimeout(load, 9000);
});

async function saveSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: Object.assign({}, DEFAULTS, settings || {}, patch) });
  await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
}

$('#autoReopen').addEventListener('change', (e) => saveSettings({ autoReopen: e.target.checked }));
$('#notify').addEventListener('change', (e) => saveSettings({ notify: e.target.checked }));

// 检查间隔：分钟（1–1440 整数）或秒（10–60 整数），统一换算成秒存储
let intervalUnit = 'min';

function readIntervalSec(unit) {
  const n = Math.round(Number($('#interval').value));
  if (!(Number.isFinite(n) && n > 0)) return unit === 'sec' ? 30 : 300; // 非法输入回到默认值
  if (unit === 'sec') return Math.min(60, Math.max(10, n));
  return Math.min(1440, Math.max(1, n)) * 60;
}

function displayInterval(sec, unit) {
  if (unit === 'sec') return String(Math.min(60, Math.max(10, Math.round(sec))));
  return String(Math.max(1, Math.round(sec / 60)));
}

$('#interval').addEventListener('change', async () => {
  const sec = readIntervalSec(intervalUnit);
  $('#interval').value = displayInterval(sec, intervalUnit); // 非法输入自动纠正
  await saveSettings({ intervalSec: sec });
});

$('#unit').addEventListener('change', async (e) => {
  const oldUnit = intervalUnit;
  intervalUnit = e.target.value;
  const sec = readIntervalSec(oldUnit);
  $('#interval').value = displayInterval(sec, intervalUnit); // 切换单位时自动换算
  await saveSettings({ intervalSec: sec });
});

load();
