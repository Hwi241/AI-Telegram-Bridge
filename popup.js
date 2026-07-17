const DEEPSEEK_API_KEY_KEY = 'bridge_deepseek_api_key';
const DEEPSEEK_BALANCE_STATE_KEY = 'bridge_deepseek_balance_state';
const DEEPSEEK_USAGE_HISTORY_KEY = 'bridge_deepseek_usage_history';

function $(id) {
  return document.getElementById(id);
}

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '저장됨';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function formatCurrency(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '-';
  if (currency === 'USD') return '$' + n.toFixed(2);
  if (currency === 'CNY') return '¥' + n.toFixed(2);
  return currency + ' ' + n.toFixed(2);
}

function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return yy + '.' + mm + '.' + dd + ' ' + hh + ':' + mi;
}

function renderState(res) {
  const key = res[DEEPSEEK_API_KEY_KEY] || '';
  const state = res[DEEPSEEK_BALANCE_STATE_KEY] || null;
  const history = Array.isArray(res[DEEPSEEK_USAGE_HISTORY_KEY]) ? res[DEEPSEEK_USAGE_HISTORY_KEY] : [];

  const keyStatus = $('deepseek-key-status');
  const balanceStatus = $('deepseek-balance-status');

  if (key) {
    keyStatus.textContent = '저장됨: ' + maskApiKey(key);
  } else {
    keyStatus.textContent = 'API 키 없음';
  }

  if (!state || !state.configured) {
    balanceStatus.textContent = '잔액 미조회';
    return;
  }

  if (state.status === 'error') {
    balanceStatus.textContent = '잔액 조회 실패: ' + (state.error || '알 수 없음');
    return;
  }

  if (state.status === 'ok') {
    const current = formatCurrency(state.amount, state.currency);
    const latestUsage = history.length ? formatCurrency(history[0].amount, history[0].currency) : '$0.00';
    const updated = state.updatedAt ? formatDateTime(state.updatedAt) : '';
    balanceStatus.textContent = '현재 ' + current + ' / 최근 사용 ' + latestUsage + (updated ? ' / ' + updated : '');
    return;
  }

  balanceStatus.textContent = '잔액 대기 중';
}

function refreshPopupState() {
  chrome.storage.local.get([
    DEEPSEEK_API_KEY_KEY,
    DEEPSEEK_BALANCE_STATE_KEY,
    DEEPSEEK_USAGE_HISTORY_KEY
  ], renderState);
}

function requestBalanceRefresh() {
  const balanceStatus = $('deepseek-balance-status');
  balanceStatus.textContent = '잔액 조회 중...';

  chrome.runtime.sendMessage({ action: 'refreshDeepSeekBalance' }, function(res) {
    const runtimeError = chrome.runtime.lastError;
    if (runtimeError) {
      balanceStatus.textContent = '조회 실패: ' + runtimeError.message;
      return;
    }

    if (!res || !res.ok) {
      balanceStatus.textContent = '조회 실패: ' + (res && res.error ? res.error : '알 수 없음');
      refreshPopupState();
      return;
    }

    refreshPopupState();
  });
}

document.addEventListener('DOMContentLoaded', function() {
  const input = $('deepseek-api-key');
  const saveBtn = $('save-deepseek-key');
  const clearBtn = $('clear-deepseek-key');
  const refreshBtn = $('refresh-deepseek-balance');

  refreshPopupState();

  saveBtn.addEventListener('click', function() {
    const key = input.value.trim();

    if (!key) {
      $('deepseek-key-status').textContent = '저장할 API 키를 입력하세요.';
      return;
    }

    chrome.storage.local.set({ [DEEPSEEK_API_KEY_KEY]: key }, function() {
      input.value = '';
      $('deepseek-key-status').textContent = '저장됨: ' + maskApiKey(key);
      requestBalanceRefresh();
    });
  });

  clearBtn.addEventListener('click', function() {
    chrome.storage.local.remove([
      DEEPSEEK_API_KEY_KEY,
      DEEPSEEK_BALANCE_STATE_KEY,
      DEEPSEEK_USAGE_HISTORY_KEY
    ], function() {
      input.value = '';
      $('deepseek-key-status').textContent = 'API 키 삭제됨';
      $('deepseek-balance-status').textContent = '잔액 미조회';
    });
  });

  refreshBtn.addEventListener('click', requestBalanceRefresh);
});
// ────────────────────────────────────────
// AI 응답 완료 알림 설정
// ────────────────────────────────────────
const BRIDGE_NOTIFY_POPUP_ENABLED_KEY = 'bridge_notify_popup_enabled';
const BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY = 'bridge_notify_attention_enabled';

function setBridgeCompleteNotifyStatus() {
 const status = document.getElementById('bridge-complete-notify-status');
 const popupToggle = document.getElementById('bridge-notify-popup-toggle');
 const attentionToggle = document.getElementById('bridge-notify-attention-toggle');

 if (!status || !popupToggle || !attentionToggle) return;

 const popupText = popupToggle.checked ? '팝업 ON' : '팝업 OFF';
 const attentionText = attentionToggle.checked ? '깜빡임 ON' : '깜빡임 OFF';

 status.textContent = popupText + ' / ' + attentionText + ' · AI 응답 완료에만 적용';
}

function initBridgeCompleteNotifyToggles() {
 const popupToggle = document.getElementById('bridge-notify-popup-toggle');
 const attentionToggle = document.getElementById('bridge-notify-attention-toggle');

 if (!popupToggle || !attentionToggle) return;
 if (popupToggle.dataset.bridgeNotifyReady === 'true') return;

 popupToggle.dataset.bridgeNotifyReady = 'true';
 attentionToggle.dataset.bridgeNotifyReady = 'true';

 chrome.storage.local.get({
 [BRIDGE_NOTIFY_POPUP_ENABLED_KEY]: true,
 [BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY]: true
 }, (res) => {
 popupToggle.checked = res[BRIDGE_NOTIFY_POPUP_ENABLED_KEY] !== false;
 attentionToggle.checked = res[BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY] !== false;
 setBridgeCompleteNotifyStatus();
 });

 popupToggle.addEventListener('change', () => {
 chrome.storage.local.set({
 [BRIDGE_NOTIFY_POPUP_ENABLED_KEY]: !!popupToggle.checked
 }, setBridgeCompleteNotifyStatus);
 });

 attentionToggle.addEventListener('change', () => {
 chrome.storage.local.set({
 [BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY]: !!attentionToggle.checked
 }, setBridgeCompleteNotifyStatus);
 });
}

if (document.readyState === 'loading') {
 document.addEventListener('DOMContentLoaded', initBridgeCompleteNotifyToggles);
} else {
 initBridgeCompleteNotifyToggles();
}
