// 网站恢复助手 —— 后台 Service Worker
// 职责：记录加载失败的网页；定时探测是否恢复；恢复后自动重新访问

const DEFAULT_SETTINGS = { autoReopen: true, intervalSec: 300, notify: true }; // intervalSec: 检查间隔（秒）
const CHECK_TIMEOUT_MS = 12000;
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 草稿保留 7 天
const ALARM_NAME = 'checkPendingSites';
const STARTUP_CHECK_ALARM = 'startupCheck';

// 视为"可重试的网络故障"的错误码（排除被拦截、用户中止等）
const RETRYABLE_ERRORS = new Set([
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_ABORTED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_DNS_TIMED_OUT',
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_TIMED_OUT',
  'net::ERR_EMPTY_RESPONSE',
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_HTTP2_PROTOCOL_ERROR',
  'net::ERR_SOCKET_NOT_CONNECTED',
]);

function normalizeUrl(u) {
  try { const url = new URL(u); url.hash = ''; return url.href; }
  catch (e) { return u; }
}

function isHttpUrl(u) {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; }
  catch (e) { return false; }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  // 兼容旧版按分钟存储的 checkIntervalMin
  const sec = Number(s.intervalSec);
  if (!Number.isFinite(sec) || sec <= 0) {
    const legacy = Number(settings && settings.checkIntervalMin);
    s.intervalSec = Number.isFinite(legacy) && legacy > 0 ? Math.round(legacy * 60) : DEFAULT_SETTINGS.intervalSec;
  } else {
    s.intervalSec = Math.round(sec);
  }
  return s;
}

async function updateBadge() {
  const data = await chrome.storage.local.get(null);
  const count = Object.keys(data).filter((k) => k.startsWith('pending:')).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  if (count > 0) {
    try {
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    } catch (e) { /* 老版本浏览器忽略 */ }
  }
}

async function setupAlarm(intervalSec) {
  const sec = Math.round(Number(intervalSec));
  // 支持最短 10 秒、最长 24 小时；浏览器自身对闹钟频率另有下限
  const periodSec = Number.isFinite(sec) && sec > 0 ? Math.min(86400, Math.max(10, sec)) : DEFAULT_SETTINGS.intervalSec;
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodSec / 60 });
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: s });
  await setupAlarm(s.intervalSec);
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  await setupAlarm(s.intervalSec);
  await updateBadge();
  // 设置与待恢复列表都保存在 chrome.storage.local，重启浏览器后自动恢复；
  // 启动 15 秒后先做一轮检查，让之前打不开的网页尽快得到探测
  await chrome.alarms.clear(STARTUP_CHECK_ALARM);
  await chrome.alarms.create(STARTUP_CHECK_ALARM, { when: Date.now() + 15000 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === STARTUP_CHECK_ALARM) checkAll();
});

// 记录主框架加载失败（仅网络类错误，排除被其他扩展拦截、用户中止等）
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isHttpUrl(details.url)) return;
  if (!RETRYABLE_ERRORS.has(details.error)) return;
  recordFailure(details.url, details.error);
});

async function recordFailure(url, error) {
  const key = normalizeUrl(url);
  const data = await chrome.storage.local.get(null);
  const draft = data['draft:' + key];
  await chrome.storage.local.set({
    ['pending:' + key]: {
      url: key,
      title: (draft && draft.title) || '',
      error: error,
      savedAt: Date.now(),
      attempts: 0,
      lastChecked: 0,
      lastStatus: '待检查',
    },
  });
  await updateBadge();
}

/* ---------- 恢复探测 ---------- */

let checking = false;

async function checkAll() {
  if (checking) return;
  checking = true;
  try {
    const settings = await getSettings();
    await pruneDrafts();
    const data = await chrome.storage.local.get(null);
    const keys = Object.keys(data).filter((k) => k.startsWith('pending:'));
    for (const k of keys) {
      const entry = data[k];
      if (!entry) continue;
      const ok = await checkUrl(entry.url);
      if (ok) {
        await chrome.storage.local.remove(k);
        await updateBadge();
        if (settings.autoReopen) await reopen(entry.url);
        if (settings.notify) notify('网站已恢复 ✓', entry.url);
      } else {
        // 期间列表可能被用户改动，重新读取后再更新状态
        const fresh = await chrome.storage.local.get(k);
        if (fresh[k]) {
          fresh[k].attempts = (fresh[k].attempts || 0) + 1;
          fresh[k].lastChecked = Date.now();
          fresh[k].lastStatus = '仍不可访问';
          await chrome.storage.local.set({ [k]: fresh[k] });
        }
      }
    }
  } finally {
    checking = false;
  }
}

async function probe(url, method) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { method: method, cache: 'no-store', signal: ctrl.signal });
    return resp.status < 500; // 4xx 也说明服务器已经响应了
  } catch (e) {
    return false; // 连接失败 / 超时
  } finally {
    clearTimeout(timer);
  }
}

async function checkUrl(url) {
  if (await probe(url, 'HEAD')) return true;
  return await probe(url, 'GET'); // 有些服务器不支持 HEAD，兜底再试 GET
}

async function reopen(url) {
  const key = normalizeUrl(url);
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url && normalizeUrl(t.url) === key);
  if (target) {
    chrome.tabs.reload(target.id, { bypassCache: true }).catch(() => {});
  } else {
    chrome.tabs.create({ url: url, active: false }).catch(() => {});
  }
}

// 清理 7 天前的旧草稿（对应的页面仍待恢复时除外）
async function pruneDrafts() {
  const data = await chrome.storage.local.get(null);
  const now = Date.now();
  const stale = Object.keys(data).filter((k) => {
    if (!k.startsWith('draft:')) return false;
    if (data['pending:' + k.slice('draft:'.length)]) return false;
    const snap = data[k];
    return !snap || !snap.savedAt || now - snap.savedAt > DRAFT_MAX_AGE_MS;
  });
  if (stale.length) await chrome.storage.local.remove(stale);
}

function notify(title, message) {
  try {
    const p = chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message && message.length > 200 ? message.slice(0, 200) + '…' : (message || ''),
    });
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ---------- 与内容脚本 / 弹窗的消息协议 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || !msg.type) return sendResponse({ ok: false });
    switch (msg.type) {
      case 'CHECK_RECOVERY': {
        const key = normalizeUrl(msg.url);
        const data = await chrome.storage.local.get(null);
        if (data['pending:' + key]) {
          sendResponse({ found: true, snapshot: data['draft:' + key] || null });
        } else {
          sendResponse({ found: false });
        }
        break;
      }
      case 'RECOVERED': {
        // 页面已成功打开（自动重开或用户手动访问），清理记录
        const key = normalizeUrl(msg.url);
        await chrome.storage.local.remove(['pending:' + key, 'draft:' + key]);
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case 'CHECK_NOW':
        checkAll().catch(() => {});
        sendResponse({ ok: true });
        break;
      case 'OPEN_NOW': {
        const key = normalizeUrl(msg.url);
        await reopen(msg.url);
        await chrome.storage.local.remove('pending:' + key);
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case 'DELETE_PENDING': {
        const key = normalizeUrl(msg.url);
        await chrome.storage.local.remove('pending:' + key);
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case 'SETTINGS_UPDATED': {
        const s = await getSettings();
        await setupAlarm(s.intervalSec);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
  })();
  return true; // 异步应答
});
