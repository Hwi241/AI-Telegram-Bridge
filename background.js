// background.js v5.0
// AI ↔ Telegram Bridge
// web.telegram.org DOM 방식으로 전송 (유저 계정으로 봇에 전달)

async function findTab(pattern) {
  const tabs = await chrome.tabs.query({ url: pattern });
  return tabs[0] || null;
}

async function findTelegramTab() {
  return findTab('https://web.telegram.org/*');
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 300));
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e2) {
      throw new Error('탭에 연결할 수 없어요: ' + e2.message);
    }
  }
}

// AI → Telegram
async function handleAiToTelegram(aiTabId, autoSend) {
  const streamRes = await sendToTab(aiTabId, { action: 'checkStreaming' }).catch(() => null);
  if (streamRes?.streaming) {
    return { ok: false, error: 'AI가 아직 답변 중이에요. 완료 후 다시 눌러주세요.' };
  }

  const aiRes = await sendToTab(aiTabId, { action: 'getResponse' });
  if (!aiRes?.text) return { ok: false, error: 'AI 응답을 찾을 수 없어요.' };

  const tgTab = await findTelegramTab();
  if (!tgTab) return { ok: false, error: 'web.telegram.org 탭을 열고 봇 채팅방을 선택해주세요.' };

  return sendToTab(tgTab.id, { action: 'sendToTelegram', text: aiRes.text, autoSend });
}

// Telegram → AI
async function findAiTab(aiTarget) {
  const patterns = {
    chatgpt: 'https://chatgpt.com/*',
    claude: 'https://claude.ai/*',
    gemini: 'https://gemini.google.com/*',
  };
  const pattern = patterns[aiTarget] || 'https://chatgpt.com/*';
  return findTab(pattern);
}

async function handleTelegramToAi(aiTabId, autoSend, tgCopyMode, aiTarget, targetTabId) {
  const tgTab = await findTelegramTab();
  if (!tgTab) return { ok: false, error: 'web.telegram.org 탭을 열고 봇 채팅방을 선택해주세요.' };
  var aiTab = null;
  if (targetTabId) {
    try { aiTab = await chrome.tabs.get(targetTabId); } catch(e) { aiTab = null; }
  }
  if (!aiTab) {
    aiTab = await findAiTab(aiTarget || 'chatgpt');
  }
  if (!aiTab) return { ok: false, error: 'AI 탭을 찾을 수 없습니다.' };

  const tgRes = await sendToTab(tgTab.id, { action: 'getTelegramMessage', tgCopyMode: tgCopyMode || 'all' });
  if (!tgRes?.text) return { ok: false, error: 'Telegram 메시지를 찾을 수 없어요.' };

  return sendToTab(aiTab.id, { action: 'pasteToAI', text: tgRes.text, autoSend });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const aiTabId = sender.tab?.id;

  if (msg.action === 'getAiTabs') {
    chrome.tabs.query({ url: ['https://chatgpt.com/*','https://chat.openai.com/*','https://claude.ai/*','https://gemini.google.com/*'] }, (tabs) => {
      sendResponse({ tabs: tabs.map(function(t){ return { id: t.id, title: t.title, url: t.url }; }) });
    });
    return true;
  }

  if (msg.action === 'aiToTelegram') {
    handleAiToTelegram(aiTabId, msg.autoSend)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'telegramToAI') {
    handleTelegramToAi(aiTabId, msg.autoSend, msg.tgCopyMode, msg.aiTarget)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
