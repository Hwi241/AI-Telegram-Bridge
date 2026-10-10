(() => {
if (window.__AI_TELEGRAM_BRIDGE_CONTENT_LOADED__) {
 return;
}
window.__AI_TELEGRAM_BRIDGE_CONTENT_LOADED__ = true;

// content.js v5.0
// Claude, ChatGPT, Gemini, Telegram 범용 지원
const CTB_RUNTIME_BUILD = '059-12';

console.log(
  '[CTB] content runtime ' +
  CTB_RUNTIME_BUILD
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 현재 사이트 감지 ──
const SITE = (() => {
  const h = location.hostname;
  if (h === 'claude.ai') return 'claude';
  if (h === 'chat.openai.com' || h === 'chatgpt.com') return 'chatgpt';
  if (h === 'gemini.google.com') return 'gemini';
  if (h.includes('web.telegram.org')) return 'telegram';
  return null;
})();

const SITE_NAME = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', telegram: 'Telegram' }[SITE] || 'AI';

// ── 복사 모드: 'full' | 'code' (AI→TG)
let copyMode = 'code'; // 기본값: 코드블록
// ── TG→AI 모드: 'all' | 'last'
let tgCopyMode = 'all'; // 기본값: 답변전체

// ── 공통 입력 함수 ──
function normalizeBridgeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getContentEditablePlainText(el) {
  return normalizeBridgeText(el.innerText || el.textContent || '');
}

function setContentEditableTextWithBreaks(el, text) {
  const normalizedText = normalizeBridgeText(text);

  el.textContent = '';

  const lines = normalizedText.split('\n');
  lines.forEach(function(line, index) {
    if (index > 0) {
      el.appendChild(document.createElement('br'));
    }
    if (line) {
      el.appendChild(document.createTextNode(line));
    }
  });

  el.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    data: normalizedText,
    inputType: 'insertText'
  }));
}

function dispatchPasteText(el, text) {
  const normalizedText = normalizeBridgeText(text);

  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', normalizedText);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer
    });

    el.dispatchEvent(pasteEvent);
    return true;
  } catch (e) {
    return false;
  }
}

function setInput(el, text) {
  const normalizedText = normalizeBridgeText(text);

  el.focus();

  if (el.isContentEditable) {
    document.execCommand('selectAll', false, null);

    const pasteDispatched = dispatchPasteText(el, normalizedText);

    setTimeout(function() {
      const currentText = getContentEditablePlainText(el).trim();
      const expectedText = normalizedText.trim();

      if (!currentText || currentText !== expectedText) {
        document.execCommand('selectAll', false, null);
        const inserted = document.execCommand('insertText', false, normalizedText);

        const afterInsertText = getContentEditablePlainText(el).trim();

        if (!inserted || !afterInsertText || afterInsertText !== expectedText) {
          document.execCommand('selectAll', false, null);
          setContentEditableTextWithBreaks(el, normalizedText);
        }
      }
    }, pasteDispatched ? 80 : 0);

    return;
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, normalizedText);
  else el.value = normalizedText;

  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── 토큰 추정 ──
function estimateTokens(text) {
  if (!text) return 0;
  const korean = (text.match(/[가-힣]/g) || []).length;
  const others = text.length - korean;
  return Math.ceil(korean / 2 + others / 4);
}

// ────────────────────────────────────────
// Claude
// ────────────────────────────────────────
function claude_getResponse() {
  const selectors = ['.font-claude-message', '[data-testid="assistant-message"]', '.prose', '.standard-markdown'];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (!els.length) continue;
    const last = els[els.length - 1];
    const code = last.querySelectorAll('pre');
    if (copyMode === 'code' && code.length) return code[code.length - 1].innerText?.trim() || null;
    return last.innerText?.trim() || null;
  }
  return null;
}

function claude_isStreaming() {
  const stops = [
    'button[aria-label="Stop generating"]', 'button[aria-label="Stop response"]',
    'button[aria-label="응답 중지"]', 'button[data-testid="stop-button"]', 'button[aria-label="Stop"]'
  ];
  return stops.some(s => document.querySelector(s));
}

async function claude_pasteInput(text, autoSend) {
  const input = document.querySelector('[data-testid="chat-input"]');
  if (!input) return { ok: false, error: '입력창을 찾을 수 없어요.' };
  setInput(input, text);
  if (!autoSend) return { ok: true };
  await sleep(400);
  const btn = document.querySelector('button[aria-label="메시지 보내기"], button[aria-label="Send message"]');
  if (!btn || btn.disabled) return { ok: false, error: '전송 버튼을 찾을 수 없어요.' };
  btn.click();
  return { ok: true };
}

function claude_getInputEl() {
  return document.querySelector('[data-testid="chat-input"]');
}

// ────────────────────────────────────────
// ChatGPT
// ────────────────────────────────────────
const CHATGPT_ROLLOUT_ASSISTANT_SELECTOR =
  '[data-chatgpt-search-unit-key$=":assistant"]' +
  '[data-chatgpt-search-message-ids]';

const CHATGPT_ROLLOUT_ASSISTANT_MARKER_SELECTOR =
  '[data-conversation-role="assistant"], ' +
  '[data-chatgpt-agent-turn-start]';

function chatgpt_readCodeNodeText(node) {
  if (!node) {
    return '';
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || '';
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  if (node.tagName === 'BR') {
    return '\n';
  }

  if (
    node.matches?.(
      '[data-markdown-copy="exclude"]'
    )
  ) {
    return '';
  }

  return Array.from(node.childNodes)
    .map(chatgpt_readCodeNodeText)
    .join('');
}

function chatgpt_extractRolloutCode(widget) {
  if (!widget) {
    return '';
  }

  const editor =
    widget.querySelector(
      '[role="textbox"][aria-label="Edit code"]'
    ) ||
    widget.querySelector(
      '[role="textbox"][data-language]'
    ) ||
    widget.querySelector(
      '[contenteditable="true"][data-language]'
    );

  if (editor) {
    const lines =
      Array.from(
        editor.querySelectorAll('.cm-line')
      );

    if (lines.length) {
      return lines
        .map(function(line) {
          return line.textContent || '';
        })
        .join('\n')
        .replace(/\u00a0/g, ' ')
        .replace(/\u200b/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n+$/g, '');
    }

    const editorText =
      editor.textContent || '';

    if (editorText.trim()) {
      return editorText
        .replace(/\u00a0/g, ' ')
        .replace(/\u200b/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\n+$/g, '');
    }
  }

  const code =
    Array.from(
      widget.querySelectorAll(
        'pre code, code'
      )
    ).find(function(node) {
      return !node.closest?.(
        '[data-markdown-copy="exclude"]'
      );
    });

  if (code) {
    return chatgpt_readCodeNodeText(code)
      .replace(/\u00a0/g, ' ')
      .replace(/\u200b/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/g, '');
  }

  return '';
}

function chatgpt_extractCodeText(root) {
  if (!root) {
    return '';
  }

  if (
    root.matches?.(
      '[data-markdown-copy="code-block"]'
    )
  ) {
    const rolloutText =
      chatgpt_extractRolloutCode(root);

    if (rolloutText.trim()) {
      return rolloutText;
    }
  }

  const source =
    root.querySelector?.(
      'pre.cm-content code, ' +
      '.cm-content code, ' +
      'pre code, ' +
      'code'
    ) ||
    (
      root.matches?.('.cm-content')
        ? root
        : root.querySelector?.(
            '.cm-content'
          )
    ) ||
    root;

  return chatgpt_readCodeNodeText(source)
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/g, '');
}

function chatgpt_getLatestAssistantContext() {
  /*
   * 최신 ChatGPT DOM 우선:
   * section[data-turn="assistant"]
   *
   * 구버전 fallback:
   * [data-message-author-role="assistant"]
   */
  const rolloutAssistants =
    Array.from(
      document.querySelectorAll(
        CHATGPT_ROLLOUT_ASSISTANT_SELECTOR
      )
    ).filter(function(node) {
      return node && node.isConnected;
    });

  if (rolloutAssistants.length) {
    const message =
      rolloutAssistants[
        rolloutAssistants.length - 1
      ];

    const turn =
      message.closest('[data-turn-key]') ||
      message.closest(
        '[data-testid^="conversation-turn-"]'
      ) ||
      message.closest('article') ||
      message;

    const assistant =
      message.querySelector(
        '[data-markdown-text-style="assistant-message"]'
      ) ||
      message.querySelector('.markdown') ||
      message;

    return {
      assistant: assistant,
      message: message,
      turn: turn,
      renderer: 'rollout'
    };
  }

  const rolloutTurns =
    Array.from(
      document.querySelectorAll(
        '[data-turn-key]'
      )
    ).filter(function(turn) {
      return (
        turn.isConnected &&
        turn.querySelector(
          CHATGPT_ROLLOUT_ASSISTANT_MARKER_SELECTOR
        )
      );
    });

  if (rolloutTurns.length) {
    const turn =
      rolloutTurns[
        rolloutTurns.length - 1
      ];

    const message =
      turn.querySelector(
        CHATGPT_ROLLOUT_ASSISTANT_SELECTOR
      );

    const assistant =
      message?.querySelector(
        '[data-markdown-text-style="assistant-message"]'
      ) ||
      turn.querySelector(
        '[data-markdown-text-style="assistant-message"]'
      ) ||
      message ||
      turn;

    return {
      assistant: assistant,
      message: message || assistant,
      turn: turn,
      renderer: 'rollout'
    };
  }

  const turnSelectors = [
    'main section[data-turn="assistant"]',
    'section[data-turn="assistant"]'
  ];

  let turns = [];

  for (const selector of turnSelectors) {
    turns = Array.from(
      document.querySelectorAll(selector)
    ).filter(function(node) {
      return node && node.isConnected;
    });

    if (turns.length) {
      break;
    }
  }

  if (turns.length) {
    const turn =
      turns[turns.length - 1];

    const assistant =
      turn.querySelector(
        '[data-message-author-role="assistant"]'
      ) ||
      turn.querySelector('.markdown') ||
      turn.querySelector('[class*="markdown"]') ||
      turn;

    return {
      assistant: assistant,
      turn: turn
    };
  }

  const legacy =
    Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      )
    ).filter(function(node) {
      return node && node.isConnected;
    });

  if (!legacy.length) {
    return null;
  }

  const assistant =
    legacy[legacy.length - 1];

  const turn =
    assistant.closest(
      'section[data-turn="assistant"]'
    ) ||
    assistant.closest(
      '[data-testid^="conversation-turn-"]'
    ) ||
    assistant.closest('article') ||
    assistant;

  return {
    assistant: assistant,
    turn: turn
  };
}

function chatgpt_getCodeBlockCandidates(
  assistant,
  turn
) {
  const roots = [];

  if (turn) {
    roots.push(turn);
  }

  if (
    assistant &&
    assistant !== turn
  ) {
    roots.push(assistant);
  }

  const selectors = [
    '[data-markdown-copy="code-block"]',
    '[id="code-block-viewer"]',
    '[id="code-block-viewer"] .cm-content',
    'pre.cm-content',
    '.markdown pre',
    '.cm-content',
    'pre'
  ];

  const seen =
    new Set();

  const candidates =
    [];

  roots.forEach(function(root) {
    if (!root || !root.querySelectorAll) {
      return;
    }

    selectors.forEach(function(selector) {
      Array.from(
        root.querySelectorAll(selector)
      ).forEach(function(node) {
        if (
          !node ||
          !node.isConnected ||
          seen.has(node)
        ) {
          return;
        }

        const owningRolloutWidget =
          node.closest?.(
            '[data-markdown-copy="code-block"]'
          );

        if (
          owningRolloutWidget &&
          owningRolloutWidget !== node &&
          seen.has(owningRolloutWidget)
        ) {
          return;
        }

        /*
         * code-block-viewer 내부의 pre와
         * 동일한 실제 코드블록이 중복 수집될 수 있으므로
         * 실제 target을 정규화한다.
         */
        const target =
          node.matches(
            '[id="code-block-viewer"]'
          )
            ? (
                node.querySelector(
                  'pre.cm-content'
                ) ||
                node.querySelector(
                  '.cm-content'
                ) ||
                node.querySelector(
                  'pre'
                ) ||
                node
              )
            : node;

        if (
          !target ||
          seen.has(target)
        ) {
          return;
        }

        seen.add(node);
        seen.add(target);
        candidates.push(target);
      });
    });
  });

  if (!candidates.length && assistant) {
    Array.from(
      assistant.querySelectorAll('code')
    ).forEach(function(node) {
      if (
        node &&
        node.isConnected &&
        chatgpt_isVisible(node) &&
        (node.textContent || '').trim() &&
        !seen.has(node)
      ) {
        seen.add(node);
        candidates.push(node);
      }
    });
  }

  /*
   * DOM 순서대로 정렬.
   * 마지막 코드블록을 정확히 선택하기 위함.
   */
  candidates.sort(function(a, b) {
    if (a === b) {
      return 0;
    }

    const position =
      a.compareDocumentPosition(b);

    if (
      position &
      Node.DOCUMENT_POSITION_FOLLOWING
    ) {
      return -1;
    }

    if (
      position &
      Node.DOCUMENT_POSITION_PRECEDING
    ) {
      return 1;
    }

    return 0;
  });

  return candidates;
}

function chatgpt_collectResponseDiagnostics() {
  const rolloutAssistants =
    document.querySelectorAll(
      CHATGPT_ROLLOUT_ASSISTANT_SELECTOR
    ).length;

  const turnKeys =
    document.querySelectorAll(
      '[data-turn-key]'
    ).length;

  const assistantMarkdown =
    document.querySelectorAll(
      '[data-markdown-text-style="assistant-message"]'
    ).length;

  const codeWidgets =
    document.querySelectorAll(
      '[data-markdown-copy="code-block"]'
    ).length;

  const codeEditors =
    document.querySelectorAll(
      '[role="textbox"][aria-label="Edit code"]'
    ).length;

  const cmLines =
    document.querySelectorAll(
      '.cm-line'
    ).length;

  const assistantSections =
    document.querySelectorAll(
      'section[data-turn="assistant"]'
    ).length;

  const legacyAssistants =
    document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    ).length;

  const codeViewers =
    document.querySelectorAll(
      '[id="code-block-viewer"]'
    ).length;

  const cmContents =
    document.querySelectorAll(
      '.cm-content'
    ).length;

  const preBlocks =
    document.querySelectorAll(
      'pre'
    ).length;

  const codeNodes =
    document.querySelectorAll(
      'code'
    ).length;

  const latestContext =
    chatgpt_getLatestAssistantContext?.();

  const turnCodeViewers =
    latestContext?.turn
      ? latestContext.turn.querySelectorAll(
          '[id="code-block-viewer"]'
        ).length
      : 0;

  const turnCmContents =
    latestContext?.turn
      ? latestContext.turn.querySelectorAll(
          '.cm-content'
        ).length
      : 0;

  const turnPreBlocks =
    latestContext?.turn
      ? latestContext.turn.querySelectorAll(
          'pre'
        ).length
      : 0;

  const turnCodeNodes =
    latestContext?.turn
      ? latestContext.turn.querySelectorAll(
          'code'
        ).length
      : 0;

  return {
    build: CTB_RUNTIME_BUILD,
    copyMode:
      typeof copyMode !== 'undefined'
        ? copyMode
        : 'unknown',
    rolloutAssistants,
    turnKeys,
    assistantMarkdown,
    codeWidgets,
    codeEditors,
    cmLines,
    assistantSections,
    legacyAssistants,
    codeViewers,
    cmContents,
    preBlocks,
    codeNodes,
    latestContext:
      !!latestContext,
    turnCodeViewers,
    turnCmContents,
    turnPreBlocks,
    turnCodeNodes
  };
}

function chatgpt_formatResponseDiagnostics(diag) {
  return (
    'AI 응답을 찾을 수 없어요.\n' +
    '[' + diag.build + ']\n' +
    'rollout=' + diag.rolloutAssistants +
    ' / turns=' + diag.turnKeys +
    ' / markdown=' + diag.assistantMarkdown + '\n' +
    'widgets=' + diag.codeWidgets +
    ' / editors=' + diag.codeEditors +
    ' / lines=' + diag.cmLines + '\n' +
    'assistant=' + diag.assistantSections +
    ' / legacy=' + diag.legacyAssistants + '\n' +
    'viewer=' + diag.codeViewers +
    ' / cm=' + diag.cmContents +
    ' / pre=' + diag.preBlocks +
    ' / code=' + diag.codeNodes + '\n' +
    'turn viewer=' + diag.turnCodeViewers +
    ' / cm=' + diag.turnCmContents +
    ' / pre=' + diag.turnPreBlocks +
    ' / code=' + diag.turnCodeNodes
  );
}

function chatgpt_logResponseDebug() {
  const diag =
    chatgpt_collectResponseDiagnostics();

  window.__ctbLastResponseDiagnostic =
    chatgpt_formatResponseDiagnostics(diag);

  console.warn(
    '[CTB ChatGPT response debug]',
    diag
  );

  const statusEl =
    document.querySelector(
      '#ctb-ai-panel #ctb-status'
    );

  if (statusEl) {
    setPanelStatus(
      statusEl,
      window.__ctbLastResponseDiagnostic,
      'err'
    );
  }
}

function chatgpt_getResponse() {
  const context =
    chatgpt_getLatestAssistantContext();

  if (!context) {
    chatgpt_logResponseDebug();
    return null;
  }

  const assistant =
    context.assistant;

  const turn =
    context.turn;

  if (copyMode === 'code') {
    const candidates =
      chatgpt_getCodeBlockCandidates(
        assistant,
        turn
      );

    for (
      let index =
        candidates.length - 1;
      index >= 0;
      index -= 1
    ) {
      const text =
        chatgpt_extractCodeText(
          candidates[index]
        );

      if (text.trim()) {
        return text;
      }
    }

    chatgpt_logResponseDebug();
    return null;
  }

  const fullText =
    typeof assistant.innerText === 'string'
      ? assistant.innerText
      : assistant.textContent || '';

  const response =
    fullText.trim() || null;

  if (!response) {
    chatgpt_logResponseDebug();
  }

  return response;
}

function chatgpt_isVisible(el) {
 if (!el) return false;

 const style = window.getComputedStyle(el);

 if (
 style.display === 'none' ||
 style.visibility === 'hidden' ||
 Number(style.opacity) === 0
 ) {
 return false;
 }

 const rect = el.getBoundingClientRect();
 return rect.width > 0 && rect.height > 0;
}

function chatgpt_getVisibleInnerText(el) {
 if (!el || !chatgpt_isVisible(el)) {
   return '';
 }

 if (
   el.closest(
     '[hidden], [aria-hidden="true"], [inert]'
   )
 ) {
   return '';
 }

 const value = typeof el.innerText === 'string' ?
   el.innerText :
   '';

 return String(value)
   .replace(/\u200b/g, '')
   .replace(/\s+/g, ' ')
   .trim();
}

function chatgpt_hasVisibleSearchInLatestTurn() {
 const assistantMessages = Array.from(
   document.querySelectorAll(
     '[data-message-author-role="assistant"]'
   )
 );

 if (!assistantMessages.length) {
   return false;
 }

 const latestAssistant =
   assistantMessages[assistantMessages.length - 1];

 const latestTurn =
   latestAssistant.closest(
     '[data-testid^="conversation-turn-"]'
   ) ||
   latestAssistant.closest('article') ||
   latestAssistant.parentElement;

 if (!latestTurn) {
   return false;
 }

 const candidates = Array.from(
   latestTurn.querySelectorAll(
     '[role="status"], ' +
     '[aria-live], ' +
     '[data-testid*="search"], ' +
     '[data-testid*="browse"], ' +
     '[data-testid*="web"], ' +
     'span, p'
   )
 );

 const searchPattern = /^(?:웹\s*)?검색(?:하는)?\s*중(?:입니다)?(?:\s|[.…·•:：-]|$)/i;

 const matchingElements = candidates.slice(-180).filter(function(el) {
   const text = chatgpt_getVisibleInnerText(el);

   if (!text || text.length > 120) {
     return false;
   }

   if (!searchPattern.test(text)) {
     return false;
   }

   const hasMatchingVisibleChild =
     Array.from(el.children || []).some(function(child) {
       const childText =
         chatgpt_getVisibleInnerText(child);
       return (
         childText &&
         childText.length <= 120 &&
         searchPattern.test(childText)
       );
     });

   return !hasMatchingVisibleChild;
 });

 const hasVisibleSearch = matchingElements.length > 0;

 if (hasVisibleSearch) {
   chatgpt_hasVisibleSearchInLatestTurn.__lastSeenAt = Date.now();
 }

 return hasVisibleSearch;
}
function chatgpt_hasActiveWorkIndicator() {
 if (chatgpt_hasVisibleSearchInLatestTurn()) {
 return true;
 }

 const activeControls = Array.from(document.querySelectorAll(
 'button[data-testid*="stop"], ' +
 'button[aria-label*="Stop"], ' +
 'button[aria-label*="stop"], ' +
 'button[aria-label*="중지"], ' +
 '[aria-busy="true"], ' +
 '[role="progressbar"]'
 ));

 if (activeControls.some(chatgpt_isVisible)) {
 return true;
 }

 const statusElements = Array.from(document.querySelectorAll(
 '[role="status"], ' +
 '[data-testid*="search"], ' +
 '[data-testid*="thinking"], ' +
 '[data-testid*="tool"]'
 ));

 const activeTextPatterns = [
 /^(웹\s*)?검색\s*중/i,
 /^자료를\s*찾는\s*중/i,
 /^생각\s*중/i,
 /^분석\s*중/i,
 /^searching(?:\s+the\s+web)?/i,
 /^browsing/i,
 /^thinking/i,
 /^analyzing/i,
 /^reading/i
 ];

 return statusElements.slice(-30).some(function(el) {
 if (!chatgpt_isVisible(el)) return false;

 const text = chatgpt_getVisibleInnerText(el);

 if (!text || text.length > 120) return false;

 return activeTextPatterns.some(function(pattern) {
 return pattern.test(text);
 });
 });
}

const CHATGPT_SEARCH_TRANSITION_GRACE_MS = 8000;

function chatgpt_isStreaming() {
 const activeWork = chatgpt_hasActiveWorkIndicator();

 if (activeWork) {
   return true;
 }

 const lastVisibleSearchAt = Number(
   chatgpt_hasVisibleSearchInLatestTurn.
   __lastSeenAt || 0
 );

 if (
   lastVisibleSearchAt > 0 &&
   Date.now() - lastVisibleSearchAt <
   CHATGPT_SEARCH_TRANSITION_GRACE_MS
 ) {
   return true;
 }

 return false;
}

const CHATGPT_SEND_SELECTORS = [
  '#composer-submit-button',
  'button[data-testid="send-button"]',
  'button[type="submit"]',
  'button[aria-label="Send prompt"]',
  'button.composer-submit-btn'
];

function chatgpt_getInputEl() {
 const candidates = [
 document.querySelector('#prompt-textarea'),
 document.querySelector(
 'div[contenteditable="true"]' +
 '[data-lexical-editor]'
 ),
 document.querySelector(
 'form div[contenteditable="true"]'
 )
 ];

 return (
 candidates.find(function(input) {
 return (
 input &&
 input.isConnected &&
 chatgpt_isVisible(input)
 );
 }) ||
 null
 );
}

function chatgpt_getComposerForm(input) {
  if (input && input.isConnected) {
    return (
      input.closest('form') ||
      input.closest(
        '[data-type="unified-composer"]'
      ) ||
      input.closest(
        '[data-testid*="composer"]'
      ) ||
      input.parentElement ||
      null
    );
  }

  return (
    document.querySelector(
      'form[data-type="unified-composer"]'
    ) ||
    null
  );
}

function chatgpt_getComposerObserverScope(input) {
  if (!input || !input.isConnected) {
    return null;
  }

  const form =
    chatgpt_getComposerForm(input);

  return (
    form ||
    input.parentElement ||
    null
  );
}

function chatgpt_isSendButtonReady(button) {
  if (!button || !button.isConnected) {
    return false;
  }

  if (
    button.disabled ||
    button.getAttribute('aria-disabled') === 'true'
  ) {
    return false;
  }

  const rect =
    button.getBoundingClientRect();

  if (
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return false;
  }

  const style =
    window.getComputedStyle(button);

  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.pointerEvents === 'none'
  ) {
    return false;
  }

  return true;
}

function chatgpt_findSendButton(
 input,
 composerRoot
) {
 const form =
 input?.closest?.('form') ||
 composerRoot?.closest?.('form') ||
 (
 composerRoot?.matches?.('form')
 ? composerRoot
 : null
 );

 const scopes = [];

 if (form) {
 scopes.push(form);
 }

 if (
 composerRoot &&
 composerRoot !== form
 ) {
 scopes.push(composerRoot);
 }

 for (const scope of scopes) {
 for (
 const selector
 of CHATGPT_SEND_SELECTORS
 ) {
 const buttons =
 Array.from(
 scope.querySelectorAll(selector)
 );

 for (const button of buttons) {
 if (!button || !button.isConnected) {
 continue;
 }

 const testId =
 button.getAttribute(
 'data-testid'
 ) || '';

 const ariaLabel =
 button.getAttribute(
 'aria-label'
 ) || '';

 if (
 testId === 'stop-button' ||
 /stop/i.test(ariaLabel)
 ) {
 continue;
 }

 return button;
 }
 }
 }

 return null;
}

function chatgpt_getReadySendButton(input) {
 const composerRoot =
 chatgpt_getComposerForm(input);

 const button =
 chatgpt_findSendButton(
 input,
 composerRoot
 );

 return chatgpt_isSendButtonReady(button)
 ? button
 : null;
}

function chatgpt_collectSendDiagnostics(
 input,
 composerRoot,
 state
) {
 const form =
 input?.closest?.('form') ||
 composerRoot?.closest?.('form') ||
 (
 composerRoot?.matches?.('form')
 ? composerRoot
 : null
 );

 const scopes = [];

 if (form) {
 scopes.push(form);
 }

 if (
 composerRoot &&
 composerRoot !== form
 ) {
 scopes.push(composerRoot);
 }

 const seenButtons =
 new Set();

 const sendButtons =
 [];

 scopes.forEach(function(scope) {
 CHATGPT_SEND_SELECTORS.forEach(function(selector) {
 Array.from(
 scope.querySelectorAll(selector)
 ).forEach(function(button) {
 const testId =
 button?.getAttribute?.(
 'data-testid'
 ) || '';

 const ariaLabel =
 button?.getAttribute?.(
 'aria-label'
 ) || '';

 if (
 button &&
 button.isConnected &&
 testId !== 'stop-button' &&
 !/stop/i.test(ariaLabel) &&
 !seenButtons.has(button)
 ) {
 seenButtons.add(button);
 sendButtons.push(button);
 }
 });
 });
 });

 const readyButtons =
 sendButtons.filter(
 chatgpt_isSendButtonReady
 );

 return {
 build: CTB_RUNTIME_BUILD,
 inputFound:
 !!input,
 composerFound:
 !!composerRoot,
 inputTextLength:
 input
 ? (
 typeof input.value === 'string'
 ? input.value.length
 : (input.textContent || '').length
 )
 : 0,
 sendButtonCount:
 sendButtons.length,
 readySendButtonCount:
 readyButtons.length,
 composerSubmit:
 composerRoot
 ? composerRoot.querySelectorAll(
 '#composer-submit-button'
 ).length
 : 0,
 formSubmit:
 composerRoot
 ? composerRoot.querySelectorAll(
 'button[type="submit"]'
 ).length
 : 0,
 payloadChanged:
 !!state?.payloadChanged,
 mutationSeen:
 !!state?.mutationSeen,
 attachmentChanged:
 !!state?.attachmentChanged,
 sendBecameReady:
 !!state?.sendBecameReady,
 busy:
 !!state?.busy
 };
}

function chatgpt_formatSendDiagnostics(diag) {
 const yesNo = function(value) {
 return value ? 'YES' : 'NO';
 };

 return (
 'ChatGPT 자동 전송 실패 [' +
 diag.build + ']\n' +
 'input=' + yesNo(diag.inputFound) + '\n' +
 'composer=' + yesNo(diag.composerFound) + '\n' +
 'send=' + diag.sendButtonCount +
 ' / ready=' + diag.readySendButtonCount + '\n' +
 'composerSubmit=' + diag.composerSubmit +
 ' / formSubmit=' + diag.formSubmit + '\n' +
 'payload=' + yesNo(diag.payloadChanged) + '\n' +
 'mutation=' + yesNo(diag.mutationSeen) + '\n' +
 'attachment=' + yesNo(diag.attachmentChanged) + '\n' +
 'becameReady=' + yesNo(diag.sendBecameReady) + '\n' +
 'busy=' + yesNo(diag.busy)
 );
}

const CHATGPT_ATTACHMENT_REMOVE_SELECTOR =
  'button[aria-label^="Remove file"], ' +
  'button[aria-label*="Remove file"], ' +
  'button[aria-label^="파일 제거"], ' +
  'button[aria-label*="파일 제거"]';

const CHATGPT_ATTACHMENT_TILE_SELECTOR =
  '[class*="file-tile"], ' +
  '[data-testid*="file-tile"], ' +
  '[data-testid*="attachment"]';

function chatgpt_getAttachmentState(input) {
  const form =
    chatgpt_getComposerForm(input);

  if (!form) {
    return {
      count: 0,
      busy: false
    };
  }

  const removeButtons =
    Array.from(
      form.querySelectorAll(
        CHATGPT_ATTACHMENT_REMOVE_SELECTOR
      )
    ).filter(chatgpt_isVisible);

  const fileTiles =
    Array.from(
      form.querySelectorAll(
        CHATGPT_ATTACHMENT_TILE_SELECTOR
      )
    ).filter(function(tile) {
      if (!chatgpt_isVisible(tile)) {
        return false;
      }

      if (
        tile.closest(
          'button[data-testid="composer-plus-btn"]'
        )
      ) {
        return false;
      }

      return true;
    });

  const busyIndicators =
    Array.from(
      form.querySelectorAll(
        '[role="progressbar"], ' +
        'progress, ' +
        '[aria-busy="true"]'
      )
    ).filter(chatgpt_isVisible);

  return {
    count:
      Math.max(
        removeButtons.length,
        fileTiles.length
      ),
    busy:
      busyIndicators.length > 0
  };
}

function chatgpt_normalizeComposerText(text) {
 return normalizeBridgeText(text)
 .replace(/\u00a0/g, ' ')
 .replace(/\u200b/g, '')
 .replace(/[ \t]+\n/g, '\n')
 .replace(/\n+$/g, '');
}

function chatgpt_composerMatches(input, expectedText) {
 if (!input || !input.isConnected) {
 return false;
 }

 const currentText =
 chatgpt_normalizeComposerText(
 getContentEditablePlainText(input)
 );

 return (
 currentText.length === expectedText.length &&
 currentText === expectedText
 );
}

function chatgpt_pasteOnce(
 input,
 expectedText
) {
 if (!input || !input.isConnected) {
 return false;
 }

 input.focus();

 document.execCommand(
 'selectAll',
 false,
 null
 );

 return dispatchPasteText(
 input,
 expectedText
 );
}

function chatgpt_getComparableText(
 text
) {
 return normalizeBridgeText(text)
 .replace(/\u00a0/g, ' ')
 .replace(/\u200b/g, '')
 .replace(/\s+/g, ' ')
 .trim();
}

function chatgpt_getTransferAnchors(
 expectedText
) {
 const comparable =
 chatgpt_getComparableText(
 expectedText
 );

 const anchorSize =
 Math.min(
 96,
 comparable.length
 );

 const middleStart =
 Math.max(
 0,
 Math.floor(
 (
 comparable.length -
 anchorSize
 ) / 2
 )
 );

 return {
 comparable: comparable,
 start:
 comparable.slice(
 0,
 anchorSize
 ),
 middle:
 comparable.slice(
 middleStart,
 middleStart +
 anchorSize
 ),
 end:
 comparable.slice(
 -anchorSize
 )
 };
}

function chatgpt_composerLooksComplete(
 input,
 anchors
) {
 if (
 !input ||
 !input.isConnected ||
 !anchors ||
 !anchors.comparable
 ) {
 return false;
 }

 const rawText =
 getContentEditablePlainText(
 input
 );

 const comparable =
 chatgpt_getComparableText(
 rawText
 );

 const minimumLength =
 Math.floor(
 anchors.comparable.length *
 0.92
 );

 if (
 comparable.length <
 minimumLength
 ) {
 return false;
 }

 return (
 comparable.startsWith(
 anchors.start
 ) &&
 comparable.includes(
 anchors.middle
 ) &&
 comparable.endsWith(
 anchors.end
 )
 );
}

function chatgpt_waitForReadyAndSend(
 expectedText,
 timeoutMs,
 changeTracker
) {
 return new Promise(function(resolve) {
 const anchors =
 chatgpt_getTransferAnchors(
 expectedText
 );

 const tracker =
 changeTracker || {};

 const initialAttachmentCount =
 Number.isFinite(Number(tracker.attachmentCount))
 ? Number(tracker.attachmentCount)
 : 0;

 const baselineText =
 String(tracker.text || '');

 const baselineSendReady =
 tracker.sendReady === true;

 let finished = false;
 let scopeObserver = null;
 let inputObserver = null;
 let timer = null;
 let observedScope = null;
 let observedInput = null;
 let checkQueued = false;
 let stableSince = 0;
 let stableMutationVersion = -1;
 let stableTimer = null;
 const diagnosticState = {
 payloadChanged: false,
 mutationSeen: false,
 attachmentChanged: false,
 sendBecameReady: false,
 busy: false
 };

 const markMutation = function() {
 tracker.mutationSeen = true;
 tracker.mutationVersion =
 Number(tracker.mutationVersion || 0) + 1;
 requestCheck();
 };

 const cleanup = function() {
 if (scopeObserver) {
 scopeObserver.disconnect();
 }

 if (inputObserver) {
 inputObserver.disconnect();
 }

 if (timer) {
 clearTimeout(timer);
 }

 if (stableTimer) {
 clearTimeout(stableTimer);
 }

 if (tracker.observer) {
 tracker.observer.disconnect();
 }

 tracker.onMutation = null;
 };

 const finish = function(result) {
 if (finished) {
 return;
 }

 finished = true;
 cleanup();
 resolve(result);
 };

 const requestCheck = function() {
 if (
 finished ||
 checkQueued
 ) {
 return;
 }

 checkQueued = true;

 queueMicrotask(function() {
 checkQueued = false;
 check();
 });
 };

 const scheduleStableCheck = function(delay) {
 if (stableTimer) {
 clearTimeout(stableTimer);
 }

 stableTimer = setTimeout(
 requestCheck,
 delay
 );
 };

 const observeScope = function(scope) {
 if (
 !scope ||
 !scope.isConnected ||
 scope === observedScope
 ) {
 return;
 }

 if (scopeObserver) {
 scopeObserver.disconnect();
 }

 observedScope = scope;

 scopeObserver.observe(
 observedScope,
 {
 subtree: true,
 childList: true,
 characterData: true,
 attributes: true,
 attributeFilter: [
 'disabled',
 'aria-disabled',
 'aria-busy',
 'data-state',
 'class'
 ]
 }
 );
 };

 const observeInput = function(input) {
 if (
 !input ||
 !input.isConnected ||
 input === observedInput
 ) {
 return;
 }

 if (inputObserver) {
 inputObserver.disconnect();
 }

 observedInput = input;

 inputObserver.observe(
 observedInput,
 {
 subtree: true,
 childList: true,
 characterData: true
 }
 );
 };

 const check = function() {
 if (finished) {
 return;
 }

 const input =
 chatgpt_getInputEl();

 if (!input) {
 return;
 }

 observeInput(input);

 observeScope(
 chatgpt_getComposerObserverScope(
 input
 )
 );

 const attachmentState =
 chatgpt_getAttachmentState(
 input
 );

 const currentText =
 String(
 chatgpt_normalizeComposerText(
 getContentEditablePlainText(input)
 ) || ''
 );

 const button =
 chatgpt_findSendButton(
 input,
 chatgpt_getComposerForm(input)
 );

 const sendButtonReady =
 chatgpt_isSendButtonReady(button);

 const payloadChanged =
 currentText !== baselineText ||
 attachmentState.count >
 initialAttachmentCount ||
 tracker.mutationSeen === true ||
 (
 !baselineSendReady &&
 sendButtonReady
 );

 diagnosticState.payloadChanged =
 payloadChanged;
 diagnosticState.mutationSeen =
 tracker.mutationSeen === true;
 diagnosticState.attachmentChanged =
 attachmentState.count >
 initialAttachmentCount;
 diagnosticState.sendBecameReady =
 !baselineSendReady &&
 sendButtonReady;
 diagnosticState.busy =
 attachmentState.busy;

 const ready =
 payloadChanged &&
 sendButtonReady &&
 !attachmentState.busy;

 if (!ready) {
 stableSince = 0;
 stableMutationVersion = -1;

 if (stableTimer) {
 clearTimeout(stableTimer);
 stableTimer = null;
 }

 return;
 }

 const mutationVersion =
 Number(tracker.mutationVersion || 0);

 if (
 stableSince === 0 ||
 stableMutationVersion !== mutationVersion
 ) {
 stableSince = Date.now();
 stableMutationVersion = mutationVersion;
 scheduleStableCheck(500);
 return;
 }

 const stableElapsed =
 Date.now() - stableSince;

 if (stableElapsed < 500) {
 scheduleStableCheck(500 - stableElapsed);
 return;
 }

 const latestInput =
 chatgpt_getInputEl();

 const latestComposerRoot =
 chatgpt_getComposerForm(
 latestInput
 );

 const latestButton =
 chatgpt_findSendButton(
 latestInput,
 latestComposerRoot
 );

 const latestAttachmentState =
 chatgpt_getAttachmentState(latestInput);

 if (
 !chatgpt_isSendButtonReady(latestButton) ||
 latestAttachmentState.busy
 ) {
 stableSince = 0;
 stableMutationVersion = -1;
 return;
 }

 finished = true;
 cleanup();

 latestButton.click();

 resolve({
 ok: true,
 pasted: true,
 sent: true,
 transferMode:
 latestAttachmentState.count >
 initialAttachmentCount
 ? 'attachment'
 : 'inline'
 });
 };

 scopeObserver =
 new MutationObserver(
 markMutation
 );

 inputObserver =
 new MutationObserver(
 markMutation
 );

 tracker.onMutation =
 requestCheck;

 const initialInput =
 chatgpt_getInputEl();

 if (initialInput) {
 observeInput(initialInput);

 observeScope(
 chatgpt_getComposerObserverScope(
 initialInput
 )
 );
 }

 timer = setTimeout(function() {
 const timeoutInput =
 chatgpt_getInputEl();

 const composerRoot =
 chatgpt_getComposerForm(
 timeoutInput
 );

 const timeoutAttachmentState =
 chatgpt_getAttachmentState(
 timeoutInput
 );

 const timeoutSendReady =
 chatgpt_isSendButtonReady(
 chatgpt_findSendButton(
 timeoutInput,
 composerRoot
 )
 );

 const timeoutText =
 timeoutInput
 ? String(
 chatgpt_normalizeComposerText(
 getContentEditablePlainText(
 timeoutInput
 )
 ) || ''
 )
 : '';

 diagnosticState.payloadChanged =
 timeoutText !== baselineText ||
 timeoutAttachmentState.count >
 initialAttachmentCount ||
 tracker.mutationSeen === true ||
 (
 !baselineSendReady &&
 timeoutSendReady
 );
 diagnosticState.mutationSeen =
 tracker.mutationSeen === true;
 diagnosticState.attachmentChanged =
 timeoutAttachmentState.count >
 initialAttachmentCount;
 diagnosticState.sendBecameReady =
 !baselineSendReady &&
 timeoutSendReady;
 diagnosticState.busy =
 timeoutAttachmentState.busy;

 const diag =
 chatgpt_collectSendDiagnostics(
 timeoutInput,
 composerRoot,
 diagnosticState
 );

 finish({
 ok: false,
 error:
 chatgpt_formatSendDiagnostics(
 diag
 )
 });
 }, timeoutMs);

 requestCheck();
 });
}

async function chatgpt_pasteInput(
 text,
 autoSend
) {
 if (chatgpt_pasteInput.__busy) {
 return {
 ok: false,
 error:
 'ChatGPT 전송이 이미 진행 중이에요.'
 };
 }

 chatgpt_pasteInput.__busy = true;

 try {
 const input =
 chatgpt_getInputEl();

 if (!input) {
 return {
 ok: false,
 error:
 'ChatGPT 입력창을 찾을 수 없어요.'
 };
 }

 const expectedText =
 chatgpt_normalizeComposerText(
 text
 );

 if (!expectedText) {
 return {
 ok: false,
 error:
 '전송할 내용이 없어요.'
 };
 }

 const attachmentStateBefore =
 chatgpt_getAttachmentState(
 input
 );

 const sendButtonBefore =
 chatgpt_findSendButton(
 input,
 chatgpt_getComposerForm(input)
 );

 const changeTracker = {
 text:
 chatgpt_normalizeComposerText(
 getContentEditablePlainText(input)
 ),
 attachmentCount:
 attachmentStateBefore.count,
 sendReady:
 chatgpt_isSendButtonReady(
 sendButtonBefore
 ),
 mutationSeen: false,
 mutationVersion: 0,
 onMutation: null,
 observer: null
 };

 if (autoSend) {
 const composerRoot =
 chatgpt_getComposerForm(input);

 if (composerRoot) {
 changeTracker.observer =
 new MutationObserver(function() {
 changeTracker.mutationSeen = true;
 changeTracker.mutationVersion += 1;

 if (changeTracker.onMutation) {
 changeTracker.onMutation();
 }
 });

 changeTracker.observer.observe(
 composerRoot,
 {
 childList: true,
 subtree: true,
 characterData: true,
 attributes: true,
 attributeFilter: [
 'disabled',
 'aria-disabled',
 'data-state',
 'class'
 ]
 }
 );
 }
 }

 const pasted =
 chatgpt_pasteOnce(
 input,
 expectedText
 );

 if (!pasted) {
 if (changeTracker.observer) {
 changeTracker.observer.disconnect();
 }

 return {
 ok: false,
 error:
 'ChatGPT 입력창에 붙여넣지 못했어요.'
 };
 }

 if (!autoSend) {
 return {
 ok: true,
 pasted: true,
 sent: false
 };
 }

 return await
 chatgpt_waitForReadyAndSend(
 expectedText,
 20000,
 changeTracker
 );
 } finally {
 chatgpt_pasteInput.__busy =
 false;
 }
}

// ────────────────────────────────────────
// Gemini
// ────────────────────────────────────────
function gemini_getResponse() {
  const selectors = [
    'model-response .response-content',
    '.model-response-text',
    'message-content',
    '.response-container-scrollable'
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (!els.length) continue;
    const last = els[els.length - 1];
    const code = last.querySelectorAll('pre');
    if (copyMode === 'code' && code.length) return code[code.length - 1].innerText?.trim() || null;
    return last.innerText?.trim() || null;
  }
  return null;
}

function gemini_isStreaming() {
  return !!document.querySelector('.loading-indicator, [aria-label="Stop generating"], .progress-container');
}

async function gemini_pasteInput(text, autoSend) {
  const input = document.querySelector('rich-textarea div[contenteditable="true"]') ||
                document.querySelector('.ql-editor') ||
                document.querySelector('div[contenteditable="true"]');
  if (!input) return { ok: false, error: '입력창을 찾을 수 없어요.' };
  setInput(input, text);
  if (!autoSend) return { ok: true };
  await sleep(400);
  const btn = document.querySelector('button[aria-label="Send message"], button.send-button');
  if (!btn || btn.disabled) return { ok: false, error: '전송 버튼을 찾을 수 없어요.' };
  btn.click();
  return { ok: true };
}

function gemini_getInputEl() {
  return document.querySelector('rich-textarea div[contenteditable="true"]') ||
         document.querySelector('div[contenteditable="true"]');
}

// ────────────────────────────────────────
// Telegram
// ────────────────────────────────────────
const telegramAnswerBatchCache = {
 chatKey: '',
 boundaryKey: '',
 boundaryOrder: null,
 messages: [],
 messageIndexByKey: new Map(),
 nextSequence: 1,
 root: null,
 observer: null,
 ensureTimer: null,
 captureQueued: false
};

function telegram_cacheIsOutgoingBubble(
 bubble
) {
 if (!bubble) {
 return false;
 }

 if (
 typeof telegram_isOutgoingBubble ===
 'function'
 ) {
 return telegram_isOutgoingBubble(
 bubble
 );
 }

 return (
 bubble.classList.contains('is-out') ||
 !!bubble.closest('.is-out')
 );
}

function telegram_cacheIsVisibleBubble(
 bubble
) {
 if (
 !bubble ||
 !bubble.isConnected
 ) {
 return false;
 }

 const style =
 window.getComputedStyle(bubble);

 if (
 style.display === 'none' ||
 style.visibility === 'hidden'
 ) {
 return false;
 }

 return (
 bubble.getClientRects().length > 0
 );
}

function telegram_cacheBubbleText(
 bubble
) {
 if (!bubble) {
 return '';
 }

 const rawText =
 typeof bubble.innerText === 'string'
 ? bubble.innerText
 : bubble.textContent || '';

 return normalizeBridgeText(rawText)
 .replace(/\u00a0/g, ' ')
 .replace(/\u200b/g, '')
 .trim();
}

function telegram_cacheHashText(
 text
) {
 let hash = 2166136261;

 for (
 let index = 0;
 index < text.length;
 index += 1
 ) {
 hash ^= text.charCodeAt(index);

 hash = Math.imul(
 hash,
 16777619
 );
 }

 return (
 hash >>> 0
 ).toString(36);
}

function telegram_cacheNumericOrder(
 value
) {
 if (
 value === null ||
 typeof value === 'undefined'
 ) {
 return null;
 }

 const matches =
 String(value).match(/\d+/g);

 if (!matches || !matches.length) {
 return null;
 }

 const numericValue =
 Number(
 matches[matches.length - 1]
 );

 return Number.isSafeInteger(
 numericValue
 )
 ? numericValue
 : null;
}

function telegram_cacheTimeInfo(
 bubble
) {
 if (!bubble) {
 return {
 raw: '',
 order: null
 };
 }

 const timeElement =
 bubble.querySelector(
 'time, [data-timestamp], .time'
 );

 if (!timeElement) {
 return {
 raw: '',
 order: null
 };
 }

 const raw =
 timeElement.getAttribute(
 'datetime'
 ) ||
 timeElement.getAttribute(
 'data-timestamp'
 ) ||
 timeElement.textContent ||
 '';

 let order =
 telegram_cacheNumericOrder(raw);

 if (order === null) {
 const parsed = Date.parse(raw);

 if (Number.isFinite(parsed)) {
 order = parsed;
 }
 }

 return {
 raw: String(raw).trim(),
 order: order
 };
}

function telegram_cacheBubbleDescriptor(
 bubble,
 direction
) {
 if (!bubble) {
 return {
 key: '',
 order: null,
 text: ''
 };
 }

 const attributeNames = [
 'data-mid',
 'data-message-id',
 'data-msg-id',
 'data-id'
 ];

 const text =telegram_cacheBubbleText(
 bubble
 );

 for (const name of attributeNames) {
 const value =
 bubble.getAttribute(name);

 if (!value) {
 continue;
 }

 return {
 key:
 direction +
 ':' +
 name +
 ':' +
 value,
 order:
 telegram_cacheNumericOrder(
 value
 ),
 text: text
 };
 }

 if (bubble.id) {
 return {
 key:
 direction +
 ':id:' +
 bubble.id,
 order:
 telegram_cacheNumericOrder(
 bubble.id
 ),
 text: text
 };
 }

 const timeInfo =
 telegram_cacheTimeInfo(
 bubble
 );

 if (timeInfo.raw) {
 return {
 key:
 direction +
 ':time:' +
 timeInfo.raw +
 ':' +
 telegram_cacheHashText(
 text.slice(0, 96)
 ),
 order: timeInfo.order,
 text: text
 };
 }

 return {
 key:
 direction +
 ':text:' +
 telegram_cacheHashText(
 text.slice(0, 160)
 ),
 order: null,
 text: text
 };
}

function telegram_findMessageRoot() {
 const visibleBubbles =
 Array.from(
 document.querySelectorAll(
 '.bubble'
 )
 ).filter(
 telegram_cacheIsVisibleBubble
 );

 const anchorBubble =
 visibleBubbles[
 visibleBubbles.length - 1
 ] ||
 document.querySelector('.bubble');

 if (!anchorBubble) {
 return null;
 }

 return (
 anchorBubble.closest(
 '.bubbles-inner'
 ) ||
 anchorBubble.closest(
 '.bubbles'
 ) ||
 anchorBubble.parentElement ||
 null
 );
}

function telegram_cacheRootIsNearBottom(
 root
) {
 if (!root) {
 return false;
 }

 let scrollElement = root;

 while (
 scrollElement &&
 scrollElement !== document.body
 ) {
 if (
 scrollElement.scrollHeight >
 scrollElement.clientHeight + 40
 ) {
 break;
 }

 scrollElement =
 scrollElement.parentElement;
 }

 if (
 !scrollElement ||
 scrollElement === document.body
 ) {
 return true;
 }

 const remaining =
 scrollElement.scrollHeight -
 scrollElement.scrollTop -
 scrollElement.clientHeight;

 return remaining < 240;
}

function telegram_resetAnswerBatchCache(
 chatKey,
 boundaryDescriptor
) {
 telegramAnswerBatchCache.chatKey =
 chatKey || '';

 telegramAnswerBatchCache.boundaryKey =
 boundaryDescriptor
 ? boundaryDescriptor.key
 : '';

 telegramAnswerBatchCache.boundaryOrder =
 boundaryDescriptor
 ? boundaryDescriptor.order
 : null;

 telegramAnswerBatchCache.messages = [];

 telegramAnswerBatchCache
 .messageIndexByKey
 .clear();

 telegramAnswerBatchCache.nextSequence =
 1;
}

function telegram_shouldResetForBoundary(
 descriptor,
 lastOutgoingIndex,
 bubbleCount,
 root
) {
 if (
 !descriptor ||
 !descriptor.key
 ) {
 return false;
 }

 if (
 !telegramAnswerBatchCache
 .boundaryKey
 ) {
 return true;
 }

 if (
 descriptor.key ===
 telegramAnswerBatchCache
 .boundaryKey
 ) {
 return false;
 }

 const currentOrder =
 telegramAnswerBatchCache
 .boundaryOrder;

 if (
 typeof descriptor.order ===
 'number' &&
 typeof currentOrder ===
 'number'
 ) {
 return (
 descriptor.order >
 currentOrder
 );
 }

 const outgoingNearEnd =
 lastOutgoingIndex >=
 bubbleCount - 2;

 return (
 outgoingNearEnd &&
 telegram_cacheRootIsNearBottom(
 root
 )
 );
}

function telegram_rebuildMessageIndex() {
 telegramAnswerBatchCache
 .messageIndexByKey
 .clear();

 telegramAnswerBatchCache
 .messages
 .forEach(function(message, index) {
 telegramAnswerBatchCache
 .messageIndexByKey
 .set(
 message.key,
 index
 );
 });
}

function telegram_sortCachedMessages() {
 telegramAnswerBatchCache
 .messages
 .sort(function(a, b) {
 if (
 typeof a.order === 'number' &&
 typeof b.order === 'number' &&
 a.order !== b.order
 ) {
 return a.order -b.order;
 }

 return a.sequence - b.sequence;
 });

 telegram_rebuildMessageIndex();
}

function telegram_storeCachedMessage(
  descriptor
) {
 if (
 !descriptor ||
 !descriptor.key ||
 !descriptor.text
 ) {
 return;
 }

 const existingIndex =
 telegramAnswerBatchCache
 .messageIndexByKey
 .get(descriptor.key);

 if (
 typeof existingIndex ===
 'number'
 ) {
 const existing =
 telegramAnswerBatchCache
 .messages[existingIndex];

 existing.text = descriptor.text;

 if (
 typeof descriptor.order ===
 'number'
 ) {
 existing.order =
 descriptor.order;
 }

 telegram_notifyRouteIncoming(
 descriptor
 );

 return;
 }

 telegramAnswerBatchCache
 .messages
 .push({
 key: descriptor.key,
 order: descriptor.order,
 sequence:
 telegramAnswerBatchCache
 .nextSequence,
 text: descriptor.text
 });

 telegramAnswerBatchCache
 .nextSequence += 1;

 telegram_sortCachedMessages();

 telegram_notifyRouteIncoming(
 descriptor
 );
}

const telegramRouteIncomingKeys =
 new Set();

function telegram_notifyRouteIncoming(
 descriptor
) {
 if (
 SITE !== 'telegram' ||
 !descriptor ||
 !descriptor.key ||
 !descriptor.text ||
 telegramRouteIncomingKeys.has(
 descriptor.key + ':' +
 telegram_cacheHashText(descriptor.text)
 )
 ) {
 return;
 }

 telegramRouteIncomingKeys.add(
 descriptor.key + ':' +
 telegram_cacheHashText(descriptor.text)
 );

 chrome.runtime.sendMessage({
 action: 'telegramRouteIncoming',
 chatKey:
 telegram_getCurrentChatKey(),
 key: descriptor.key,
 order: descriptor.order,
 text: descriptor.text
 }, function() {
 void chrome.runtime.lastError;
 });
}

function telegram_getRouteContext() {
 const bubbles =
 Array.from(
 document.querySelectorAll('.bubble')
 ).filter(
 telegram_cacheIsVisibleBubble
 );

 const bubble =
 bubbles.length
 ? bubbles[bubbles.length - 1]
 : null;

 const routeRoot =
 telegram_findMessageRoot();
 const allBubbles =
 routeRoot
 ? Array.from(
 routeRoot.querySelectorAll('.bubble')
 )
 : bubbles;
 const bubbleIndex =
 bubble ? allBubbles.indexOf(bubble) : -1;

 const descriptor =
 bubble
 ? telegram_cacheBubbleDescriptor(
 bubble,
 telegram_cacheIsOutgoingBubble(bubble)
 ? 'out'
 : 'in'
 )
 : null;

 return {
 chatKey:
 telegram_getCurrentChatKey(),
 anchorKey:
 descriptor?.key || '',
 anchorOrder:
 typeof descriptor?.order === 'number'
 ? descriptor.order
 : (
 bubbleIndex >= 0
 ? bubbleIndex
 : null
 )
 };
}

let telegramRouteReconcileTimer = null;

function telegram_reconcileRouteMessages() {
 if (SITE !== 'telegram') return;

 const chatKey =
 telegram_getCurrentChatKey();
 const root =
 telegram_findMessageRoot();

 if (!chatKey || !root) return;

 const messages = [];
 const bubbles =
 Array.from(root.querySelectorAll('.bubble'));

 bubbles.forEach(function(bubble, domIndex) {
 if (telegram_cacheIsOutgoingBubble(bubble)) return;

 const descriptor =
 telegram_cacheBubbleDescriptor(bubble, 'in');

 if (!descriptor.key || !descriptor.text) return;

 messages.push({
 key: descriptor.key,
 order:
 typeof descriptor.order === 'number'
 ? descriptor.order
 : domIndex,
 text: descriptor.text
 });
 });

 if (!messages.length) return;

 chrome.runtime.sendMessage({
 action: 'telegramRouteReconcile',
 chatKey: chatKey,
 messages: messages
 }, function() {
 void chrome.runtime.lastError;
 });
}

function telegram_queueRouteReconciliation() {
 if (telegramRouteReconcileTimer) {
 clearTimeout(telegramRouteReconcileTimer);
 }

 telegramRouteReconcileTimer =
 setTimeout(function() {
 telegramRouteReconcileTimer = null;
 telegram_reconcileRouteMessages();
 }, 250);
}

function telegram_captureAnswerBatch() {
 const chatKey =
 telegram_getCurrentChatKey();

 if (!chatKey) {
 return;
 }

 const root =
 telegram_findMessageRoot();

 if (!root) {
 return;
 }

 const bubbles =
 Array.from(
 root.querySelectorAll(
 '.bubble'
 )
 );

 if (!bubbles.length) {
 return;
 }

 let lastOutgoingIndex = -1;
 let latestBoundary = null;

 for (
 let index = 0;
 index < bubbles.length;
 index += 1
 ) {
 const bubble = bubbles[index];

 if (
 !telegram_cacheIsOutgoingBubble(
 bubble
 )
 ) {
 continue;
 }

 lastOutgoingIndex = index;

 latestBoundary =
 telegram_cacheBubbleDescriptor(
 bubble,
 'out'
 );
 }

 const chatChanged =
 telegramAnswerBatchCache.chatKey !==
 chatKey;

 if (chatChanged) {
 telegram_resetAnswerBatchCache(
 chatKey,
 latestBoundary
 );
 } else if (
 telegram_shouldResetForBoundary(
 latestBoundary,
 lastOutgoingIndex,
 bubbles.length,
 root
 )
 ) {
 telegram_resetAnswerBatchCache(
 chatKey,
 latestBoundary
 );
 } else if (
 !telegramAnswerBatchCache.chatKey
 ) {
 telegramAnswerBatchCache.chatKey =
 chatKey;
 }

 for (
 let index = lastOutgoingIndex + 1;
 index < bubbles.length;
 index += 1
 ) {
 const bubble = bubbles[index];

 if (
 telegram_cacheIsOutgoingBubble(
 bubble
 )
 ) {
 continue;
 }

 const descriptor =
 telegram_cacheBubbleDescriptor(
 bubble,
 'in'
 );

 telegram_storeCachedMessage(
 descriptor
 );
 }
}

function telegram_queueAnswerBatchCapture() {
 if (
 telegramAnswerBatchCache.captureQueued
 ) {
 return;
 }

 telegramAnswerBatchCache.captureQueued =
 true;

 queueMicrotask(function() {
 telegramAnswerBatchCache.captureQueued =
 false;

 telegram_captureAnswerBatch();
 telegram_queueRouteReconciliation();
 });
}

function telegram_ensureAnswerBatchObserver() {
 const root =
 telegram_findMessageRoot();

 if (!root) {
 return;
 }

 if (
 telegramAnswerBatchCache.root ===
 root &&
 telegramAnswerBatchCache.observer
 ) {
 telegram_captureAnswerBatch();
 telegram_queueRouteReconciliation();
 return;
 }

 if (
 telegramAnswerBatchCache.observer
 ) {
 telegramAnswerBatchCache
 .observer
 .disconnect();
 }

 telegramAnswerBatchCache.root = root;

 telegramAnswerBatchCache.observer =
 new MutationObserver(
 telegram_queueAnswerBatchCapture
 );

 telegramAnswerBatchCache
 .observer
 .observe(
 root,
 {
 subtree: true,
 childList: true,
 characterData: true
 }
 );

 telegram_captureAnswerBatch();
 telegram_queueRouteReconciliation();
}

function telegram_getAllLastBotMessages() {
 telegram_ensureAnswerBatchObserver();
 telegram_captureAnswerBatch();

 return telegramAnswerBatchCache
 .messages
 .map(function(message) {
 return message.text;
 })
 .filter(Boolean)
 .join('\n\n');
}

if (
 location.hostname ===
 'web.telegram.org' ||
 location.hostname.endsWith('.telegram.org'
 )
) {
 telegram_ensureAnswerBatchObserver();

 telegramAnswerBatchCache.ensureTimer =
 setInterval(
 telegram_ensureAnswerBatchObserver,
 1000
 );

 telegramAnswerBatchCache.routeTimer =
 setInterval(
 telegram_reconcileRouteMessages,
 1500
 );
}

function telegram_getLastBotMessage() {
  // ── K 버전: .bubble:not(.is-out) ──
  const bubbles = document.querySelectorAll('.bubble:not(.is-out)');
  if (bubbles.length) {
    const last = bubbles[bubbles.length - 1];
    const text = last.querySelector('.text, .message, [class*="text-content"]')?.innerText?.trim();
    if (text) return text;
  }

  // ── A 버전: .messages-container .message ──
  const aMsgs = document.querySelectorAll('.messages-container .message, [data-message-id]');
  const aBotMsgs = Array.from(aMsgs).filter(m =>
    !m.classList.contains('own') && !m.classList.contains('is-outgoing')
  );
  if (aBotMsgs.length) {
    const last = aBotMsgs[aBotMsgs.length - 1];
    const text = last.querySelector('.text-content, .message-text, [data-message-text]')?.innerText?.trim();
    if (text) return text;
  }

  return null;
}

// tgCopyMode에 따라 적절한 함수 호출 (파라미터로 전달받은 mode 사용)
function telegram_getMessageForMode(mode) {
  if (mode === 'all') {
    const all = telegram_getAllLastBotMessages();
    if (all) return all;
  }
  return telegram_getLastBotMessage();
}

const TELEGRAM_SEND_BUTTON_SELECTOR = 'button.btn-send, ' + 'button.bubbles-corner-button:not(.chat-secondary-button), ' + 'button[aria-label*="Send"], ' + 'button[aria-label*="보내"]';
const TELEGRAM_SAFE_INSTRUCTION_CHUNK_LIMIT = 900;
const TELEGRAM_SAFE_LONG_LINE_LIMIT = 1400;

function telegram_splitTextIntoChunks(
  text
) {
  const source =
    telegram_getExactComposerText(text);

  if (!source) {
    return {
      ok: false,
      chunks: [],
      source: '',
      error: '전송할 내용이 없어요.'
    };
  }

  if (
    source.length <=
    TELEGRAM_SAFE_INSTRUCTION_CHUNK_LIMIT
  ) {
    return {
      ok: true,
      chunks: [source],
      source: source
    };
  }

  const chunks = [];
  let offset = 0;

  while (offset < source.length) {
    const remaining = source.length - offset;

    if (
      remaining <=
      TELEGRAM_SAFE_INSTRUCTION_CHUNK_LIMIT
    ) {
      chunks.push(source.slice(offset));
      break;
    }

    const normalLimit =
      offset +
      TELEGRAM_SAFE_INSTRUCTION_CHUNK_LIMIT;
    let boundary = source.lastIndexOf(
      '\n',
      normalLimit
    );

    if (boundary <= offset) {
      const forwardBoundary = source.indexOf(
        '\n',
        normalLimit
      );

      if (
        forwardBoundary < 0 ||
        forwardBoundary - offset >
          TELEGRAM_SAFE_LONG_LINE_LIMIT
      ) {
        return {
          ok: false,
          chunks: [],
          source: source,
          error:
            '1400자 안에 줄바꿈이 없는 긴 줄은 원문을 보존해 안전하게 분할할 수 없어 전송을 중단했습니다.'
        };
      }

      boundary = forwardBoundary;
    }

    const chunk = source.slice(offset, boundary);

    if (!chunk) {
      return {
        ok: false,
        chunks: [],
        source: source,
        error:
          'Telegram 메시지 경계를 안전하게 결정하지 못했습니다.'
      };
    }

    chunks.push(chunk);
    offset = boundary + 1;
  }

  if (chunks.join('\n') !== source) {
    return {
      ok: false,
      chunks: [],
      source: source,
      error:
        'Telegram 메시지 분할 후 원문 재구성 검증에 실패했습니다.'
    };
  }

  return {
    ok: true,
    chunks: chunks,
    source: source
  };
}
function telegram_isVisibleElement(el) { if (!el || !el.isConnected) { return false; } if (el.closest('[hidden], [aria-hidden="true"], [inert]')) { return false; } const style = window.getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || style.pointerEvents === 'none') { return false; } const rect = el.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) { return false; } return (rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth);}function telegram_getVisibleComposerInputs() { return Array.from(document.querySelectorAll('div.input-message-input[contenteditable="true"]')).filter(telegram_isVisibleElement);}function telegram_getVisibleButtonsInScope(scope) { if (!scope || !scope.querySelectorAll) { return []; } return Array.from(scope.querySelectorAll(TELEGRAM_SEND_BUTTON_SELECTOR)).filter(telegram_isVisibleElement);}function telegram_findComposerScope(input) { if (!input || !input.isConnected) { return null; } let node = input.parentElement; while (node && node !== document.body) { if (telegram_getVisibleButtonsInScope(node).length > 0) { return node; } node = node.parentElement; } return (input.closest('main') || input.parentElement || document.body);}function telegram_getNearestSendButton(scope, input) { const buttons = telegram_getVisibleButtonsInScope(scope); if (!buttons.length) { return null; } if (!input) { return buttons[0]; } const inputRect = input.getBoundingClientRect(); const inputX = inputRect.left + inputRect.width / 2; const inputY = inputRect.top + inputRect.height / 2; return buttons.map(function(button) { const rect = button.getBoundingClientRect(); const buttonX = rect.left + rect.width / 2; const buttonY = rect.top + rect.height / 2; return { button: button, distance: Math.abs(buttonX - inputX) + Math.abs(buttonY - inputY) }; }).sort(function(a, b) { return a.distance - b.distance; })[0].button;}function telegram_getComposerInput() { const candidates = telegram_getVisibleComposerInputs(); if (!candidates.length) { return null; } const activeElement = document.activeElement; if (activeElement && candidates.includes(activeElement)) { return activeElement; } const pairedCandidates = candidates.filter(function(input) { const scope = telegram_findComposerScope(input); return !!telegram_getNearestSendButton(scope, input); }); const source = pairedCandidates.length ? pairedCandidates : candidates; return source.map(function(input) { const rect = input.getBoundingClientRect(); const scope = telegram_findComposerScope(input); const button = telegram_getNearestSendButton(scope, input); return { input: input, hasButton: !!button, bottom: rect.bottom, area: rect.width * rect.height }; }).sort(function(a, b) { if (a.hasButton !== b.hasButton) { return a.hasButton ? -1 : 1; } if (a.bottom !== b.bottom) { return b.bottom - a.bottom; } return b.area - a.area; })[0].input;}function telegram_getSendButton(scope, input) { return telegram_getNearestSendButton(scope, input);}function telegram_getCurrentChatKey() {
 return (
 String(location.pathname || '') +
 String(location.hash || '')
 );
}

function telegram_createTransferContext() {
 const chatKey =
 telegram_getCurrentChatKey();

 if (!location.hash || !chatKey) {
 return null;
 }

 const input =
 telegram_getComposerInput();

 if (!input) {
 return null;
 }

 const scope =
 telegram_findComposerScope(input);

 if (!scope) {
 return null;
 }

 return {
 chatKey: chatKey,
 input: input,
 scope: scope
 };
}

function telegram_isTransferChatCurrent(
 transferContext
) {
 if (
 !transferContext ||
 !transferContext.chatKey
 ) {
 return false;
 }

 return (
 telegram_getCurrentChatKey() ===
 transferContext.chatKey
 );
}

function telegram_refreshTransferContext(
 transferContext
) {
 if (
 !telegram_isTransferChatCurrent(
 transferContext
 )
 ) {
 return null;
 }

 const currentInput =
 telegram_getComposerInput();

 if (!currentInput) {
 return null;
 }

 const currentScope =
 telegram_findComposerScope(
 currentInput
 );

 if (!currentScope) {
 return null;
 }

 transferContext.input =
 currentInput;

 transferContext.scope =
 currentScope;

 return currentInput;
}

function telegram_isTransferContextCurrent(
 transferContext
) {
 return !!telegram_refreshTransferContext(
 transferContext
 );
}

function telegram_getTransferSendButton(
 transferContext
) {
 const input =
 telegram_refreshTransferContext(
 transferContext
 );

 if (!input) {
 return null;
 }

 return telegram_getSendButton(
 transferContext.scope,
 input
 );
}

function telegram_createTextFileName() {
  const now = new Date();

  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  return (
    'ai-response-' +
    yyyy +
    mm +
    dd +
    '-' +
    hh +
    mi +
    ss +
    '.txt'
  );
}

function telegram_createTextFile(text) {
  return new File(
    [text],
    telegram_createTextFileName(),
    {
      type: 'text/plain;charset=utf-8',
      lastModified: Date.now()
    }
  );
}

function telegram_getFileInputCandidates(transferContext) {
  const roots = [];

  if (
    transferContext &&
    transferContext.scope
  ) {
    roots.push(transferContext.scope);
  }

  roots.push(document);

  const found = [];
  const seen = new Set();

  roots.forEach(function(root) {
    if (!root || !root.querySelectorAll) {
      return;
    }

    Array.from(
      root.querySelectorAll(
        'input[type="file"]'
      )
    ).forEach(function(input) {
      if (
        !input ||
        !input.isConnected ||
        seen.has(input)
      ) {
        return;
      }

      seen.add(input);
      found.push(input);
    });
  });

  /*
   * 일반 파일을 받을 가능성이 높은 input 우선.
   * accept가 없는 input을 최우선으로 한다.
   */
  found.sort(function(a, b) {
    const acceptA =
      String(a.getAttribute('accept') || '');

    const acceptB =
      String(b.getAttribute('accept') || '');

    const score = function(accept) {
      if (!accept) return 0;

      if (
        accept.includes('text') ||
        accept.includes('*/*') ||
        accept.includes('application')
      ) {
        return 1;
      }

      return 2;
    };

    return score(acceptA) - score(acceptB);
  });

  return found;
}

function telegram_assignFileToInput(
  input,
  file
) {
  if (
    !input ||
    !input.isConnected ||
    !file
  ) {
    return false;
  }

  try {
    const dataTransfer =
      new DataTransfer();

    dataTransfer.items.add(file);

    const filesSetter =
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'files'
      )?.set;

    if (filesSetter) {
      filesSetter.call(
        input,
        dataTransfer.files
      );
    } else {
      input.files =
        dataTransfer.files;
    }

    input.dispatchEvent(
      new Event(
        'input',
        {
          bubbles: true
        }
      )
    );

    input.dispatchEvent(
      new Event(
        'change',
        {
          bubbles: true
        }
      )
    );

    return true;
  } catch (e) {
    return false;
  }
}

function telegram_getVisibleSendButtons() {
  return Array.from(
    document.querySelectorAll(
      TELEGRAM_SEND_BUTTON_SELECTOR
    )
  ).filter(
    telegram_isVisibleElement
  );
}

function telegram_getVisibleFilePopup() {
  const selectors = [
    '.popup-new-media',
    '.popup-send-photo'
  ];

  const candidates = [];

  selectors.forEach(function(selector) {
    document
      .querySelectorAll(selector)
      .forEach(function(node) {
        if (
          telegram_isVisibleElement(node) &&
          !candidates.includes(node)
        ) {
          candidates.push(node);
        }
      });
  });

  return candidates.length
    ? candidates[candidates.length - 1]
    : null;
}

function telegram_getFilePopupSendButton(
  popup
) {
  if (!popup) {
    return null;
  }

  const selectors = [
    'button.btn-primary.btn-color-primary',
    '.btn-primary.btn-color-primary'
  ];

  for (const selector of selectors) {
    const buttons =
      Array.from(
        popup.querySelectorAll(selector)
      );

    for (const button of buttons) {
      if (
        !(button instanceof HTMLElement) ||
        !telegram_isVisibleElement(button)
      ) {
        continue;
      }

      if (
        button.disabled ||
        button.getAttribute(
          'aria-disabled'
        ) === 'true'
      ) {
        continue;
      }

      return button;
    }
  }

  return null;
}

function telegram_isFilePopupBusy(
  popup
) {
  if (!popup) {
    return true;
  }

  const busySelectors = [
    '[aria-busy="true"]',
    '[role="progressbar"]',
    'progress',
    '.progress',
    '.progress-circle',
    '[class*="upload-progress"]',
    '[class*="progress-circle"]',
    '[class*="spinner"]'
  ];

  return busySelectors.some(
    function(selector) {
      return Array.from(
        popup.querySelectorAll(selector)
      ).some(
        telegram_isVisibleElement
      );
    }
  );
}

function telegram_collectFilePopupDiagnostics() {
  const popups =
    Array.from(
      document.querySelectorAll(
        '.popup-new-media, ' +
        '.popup-send-photo'
      )
    ).filter(
      telegram_isVisibleElement
    );

  const popup =
    popups.length
      ? popups[popups.length - 1]
      : null;

  const confirms =
    popup
      ? Array.from(
          popup.querySelectorAll(
            'button.btn-primary.btn-color-primary, ' +
            '.btn-primary.btn-color-primary'
          )
        ).filter(
          telegram_isVisibleElement
        )
      : [];

  return {
    popupCount: popups.length,
    confirmCount: confirms.length,
    busy:
      popup
        ? telegram_isFilePopupBusy(popup)
        : false,
    fileInputCount:
      document.querySelectorAll(
        'input[type="file"]'
      ).length
  };
}

function telegram_formatFilePopupDiagnostics(
  diag
) {
  return (
    '[058-14]\n' +
    'popup=' + diag.popupCount + '\n' +
    'confirm=' + diag.confirmCount + '\n' +
    'busy=' +
      (diag.busy ? 'YES' : 'NO') + '\n' +
    'fileInputs=' + diag.fileInputCount
  );
}

function telegram_getFileSendUi(
  previousButtons
) {
  void previousButtons;

  const popup =
    telegram_getVisibleFilePopup();

  const button =
    telegram_getFilePopupSendButton(
      popup
    );

  return popup && button
    ? {
        root: popup,
        button: button
      }
    : null;
}

function telegram_fileUiIsBusy(root) {
  return telegram_isFilePopupBusy(root);
}

async function telegram_waitForFileSendUi(
  transferContext,
  previousButtons,
  timeoutMs
) {
  const deadline =
    Date.now() + timeoutMs;

  let stableSince = 0;
  let stablePopup = null;
  let stableButton = null;

  while (Date.now() < deadline) {
    if (
      !telegram_isTransferChatCurrent(
        transferContext
      )
    ) {
      return {
        ok: false,
        changedChat: true,
        ui: null
      };
    }

    const popup =
      telegram_getVisibleFilePopup();

    const button =
      telegram_getFilePopupSendButton(
        popup
      );

    if (
      popup &&
      button &&
      !telegram_isFilePopupBusy(
        popup
      )
    ) {
      if (
        stablePopup !== popup ||
        stableButton !==
        button
      ) {
        stablePopup = popup;
        stableButton =
          button;

        stableSince =
          Date.now();
      }

      /*
       * 첨부 UI가 순간적으로 나타난 직후가 아니라
       * 500ms 이상 안정된 뒤 전송한다.
       */
      if (
        Date.now() -
        stableSince >=
        500
      ) {
        return {
          ok: true,
          changedChat: false,
          ui: {
            root: popup,
            button: button
          }
        };
      }
    } else {
      stablePopup = null;
      stableButton = null;
      stableSince = 0;
    }

    await sleep(150);
  }

  return {
    ok: false,
    changedChat:
      !telegram_isTransferChatCurrent(
        transferContext
      ),
    ui: null
  };
}

async function telegram_waitForFileSendCompletion(
  transferContext,
  fileUi,
  timeoutMs
) {
  const deadline =
    Date.now() + timeoutMs;

  let completedSince = 0;

  while (Date.now() < deadline) {
    if (
      !telegram_isTransferChatCurrent(
        transferContext
      )
    ) {
      return {
        ok: false,
        changedChat: true,
        uncertain: true
      };
    }

    /*
     * 첨부 dialog 또는 사용했던 send button이
     * DOM에서 사라지면 전송 완료로 본다.
     */
    const rootGone =
      !fileUi.root ||
      !fileUi.root.isConnected ||
      !telegram_isVisibleElement(
        fileUi.root
      );

    const buttonGone =
      !fileUi.button ||
      !fileUi.button.isConnected ||
      !telegram_isVisibleElement(
        fileUi.button
      );

    const currentPopup =
      telegram_getVisibleFilePopup();

    const replacementPopup =
      currentPopup &&
      currentPopup !== fileUi.root;

    if (
      (rootGone || buttonGone) &&
      !replacementPopup
    ) {
      if (!completedSince) {
        completedSince = Date.now();
      }

      if (
        Date.now() - completedSince >=
        300
      ) {
        return {
          ok: true,
          changedChat: false,
          uncertain: false
        };
      }
    } else {
      completedSince = 0;
    }

    await sleep(100);
  }

  return {
    ok: false,
    changedChat:
      !telegram_isTransferChatCurrent(
        transferContext
      ),
    uncertain: true
  };
}

async function telegram_sendTextFile(
  text,
  autoSend,
  transferContext
) {
  const file =
    telegram_createTextFile(text);

  const candidates =
    telegram_getFileInputCandidates(
      transferContext
    );

  if (!candidates.length) {
    return {
      ok: false,
      error:
        'Telegram 파일 첨부 입력을 찾을 수 없어요.'
    };
  }

  const previousButtons =
    telegram_getVisibleSendButtons();

  let attached = false;

  for (const input of candidates) {
    if (
      telegram_assignFileToInput(
        input,
        file
      )
    ) {
      /*
       * Telegram이 change 이벤트를 처리할 시간을 준다.
       */
      await sleep(250);

      const earlyUi =
        telegram_getFileSendUi(
          previousButtons
        );

      if (
        earlyUi ||
        (
          input.files &&
          input.files.length
        )
      ) {
        attached = true;
        break;
      }

      /*
       * Telegram이 input.files를 즉시 비우면서
       * 내부 상태로 가져가는 경우도 있으므로
       * 짧게 한 번 더 확인한다.
       */
      await sleep(350);

      if (
        telegram_getFileSendUi(
          previousButtons
        )
      ) {
        attached = true;
        break;
      }
    }
  }

  if (!attached) {
    return {
      ok: false,
      error:
        'Telegram에 .txt 파일을 첨부하지 못했어요.'
    };
  }

  const ready =
    await telegram_waitForFileSendUi(
      transferContext,
      previousButtons,
      12000
    );

  if (ready.changedChat) {
    return {
      ok: false,
      error:
        '파일 첨부 중 Telegram 채팅이 변경되어 중단했습니다.'
    };
  }

  if (!ready.ok) {
    const diag =
      telegram_collectFilePopupDiagnostics();

    return {
      ok: false,
      error:
        'Telegram 파일 첨부는 시작됐지만 전송 준비 완료를 확인하지 못했습니다.\n' +
        telegram_formatFilePopupDiagnostics(
          diag
        )
    };
  }

  if (!autoSend) {
    return {
      ok: true,
      pasted: true,
      sent: false,
      transferMode: 'file',
      fileName: file.name
    };
  }

  const finalPopup =
    telegram_getVisibleFilePopup();

  const finalButton =
    telegram_getFilePopupSendButton(
      finalPopup
    );

  if (
    !finalPopup ||
    !telegram_isVisibleElement(
      finalPopup
    ) ||
    !finalButton ||
    !telegram_isVisibleElement(
      finalButton
    ) ||
    finalButton.disabled ||
    finalButton.getAttribute(
      'aria-disabled'
    ) === 'true' ||
    telegram_isFilePopupBusy(
      finalPopup
    )
  ) {
    return {
      ok: false,
      error:
        'Telegram 파일 전송 버튼 상태가 변경되었습니다. 직접 전송해주세요.'
    };
  }

  /*
   * 파일 전송 버튼은 정확히 한 번만 클릭한다.
   */
  finalButton.click();

  const completion =
    await telegram_waitForFileSendCompletion(
      transferContext,
      {
        root: finalPopup,
        button: finalButton
      },
      12000
    );

  if (completion.ok) {
    return {
      ok: true,
      pasted: true,
      sent: true,
      transferMode: 'file',
      fileName: file.name
    };
  }

  if (completion.changedChat) {
    return {
      ok: false,
      error:
        '파일 전송 버튼은 한 번 클릭했지만 채팅이 변경되어 결과를 확인할 수 없습니다.'
    };
  }

  return {
    ok: false,
    error:
      '파일 전송 버튼은 한 번 클릭했지만 완료를 확인하지 못했습니다. 중복 방지를 위해 다시 전송하지 않았습니다.'
  };
}

function telegram_normalizeComposerVerificationText(text) {
 return normalizeBridgeText(text)
 .replace(/\u00a0/g, ' ')
 .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '')
 .replace(/[ \t]+\n/g, '\n')
 .replace(/\n+$/g, '');
}

function telegram_normalizeComposerText(text) {
 return telegram_normalizeComposerVerificationText(
 text
 );
}

function telegram_readComposerText(input) {
 if (!input) {
  return '';
 }

 return telegram_normalizeComposerText(
  typeof input.innerText === 'string'
  ? input.innerText
  : ''
 );
}

function telegram_getComparableTransferText(
 text
) {
 return normalizeBridgeText(text)
 .replace(/\u00a0/g, ' ')
 .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '')
 .replace(/\s+/g, ' ')
 .trim();
}

function telegram_readComparableTransferText(
 input
) {
 if (!input) {
  return '';
 }

 const rawText =
  typeof input.innerText === 'string'
  ? input.innerText
  : (
   typeof input.textContent === 'string'
   ? input.textContent
   : ''
  );

 return telegram_getComparableTransferText(
  rawText
 );
}

function telegram_getTransferAnchors(
 expectedText
) {
 const comparable =
  telegram_getComparableTransferText(
   expectedText
  );

 const anchorSize =
  Math.min(
   96,
   comparable.length
  );

 const middleStart =
  Math.max(
   0,
   Math.floor(
    (
     comparable.length -
     anchorSize
    ) / 2
   )
  );

 return {
  comparable: comparable,
  start:
   comparable.slice(
    0,
    anchorSize
   ),
  middle:
   comparable.slice(
    middleStart,
    middleStart +
    anchorSize
   ),
  end:
   comparable.slice(
    -anchorSize
   )
 };
}

function telegram_composerMatches(
 input,
 expectedText
) {
 if (
  !input ||
  !input.isConnected
 ) {
  return false;
 }

 const anchors =
  telegram_getTransferAnchors(
   expectedText
  );

 if (
  !anchors.comparable
 ) {
  return false;
 }

 const currentComparable =
  telegram_readComparableTransferText(
   input
  );

 if (!currentComparable) {
  return false;
 }

 const minimumLength =
  Math.floor(
   anchors.comparable.length *
   0.90
  );

 if (
  currentComparable.length <
  minimumLength
 ) {
  return false;
 }

 return (
  currentComparable.startsWith(
   anchors.start
  ) &&
  currentComparable.includes(
   anchors.middle
  ) &&
  currentComparable.endsWith(
   anchors.end
  )
 );
}

function telegram_getExactComposerText(text) {
 return telegram_normalizeComposerVerificationText(
 text
 );
}

function telegram_readComposerDomText(node) {
 if (!node) return '';

 if (node.nodeType === Node.TEXT_NODE) {
 return node.nodeValue || '';
 }

 if (node.nodeType !== Node.ELEMENT_NODE) {
 return '';
 }

 if (node.tagName === 'BR') {
 return '\n';
 }

 return Array.from(node.childNodes)
 .map(telegram_readComposerDomText)
 .join('');
}

function telegram_readComposerCandidates(input) {
 if (!input) {
 return {
 innerText: '',
 textContent: '',
 domWalker: ''
 };
 }

 return {
 innerText:
 telegram_normalizeComposerVerificationText(
 typeof input.innerText === 'string'
 ? input.innerText
 : ''
 ),
 textContent:
 telegram_normalizeComposerVerificationText(
 input.textContent || ''
 ),
 domWalker:
 telegram_normalizeComposerVerificationText(
 telegram_readComposerDomText(input)
 )
 };
}

function telegram_getExactComposerCandidate(
 input,
 expectedText
) {
 if (!input || !input.isConnected) {
 return null;
 }

 const expected =
 telegram_getExactComposerText(expectedText);
 const candidates =
 telegram_readComposerCandidates(input);

 for (const source of [
 'innerText',
 'textContent',
 'domWalker'
 ]) {
 if (candidates[source] === expected) {
 return {
 source: source,
 text: candidates[source],
 candidates: candidates
 };
 }
 }

 return null;
}

function telegram_composerIsEmpty(input) {
 const candidates =
 telegram_readComposerCandidates(input);

 return Object.values(candidates).every(
 function(value) {
 return value === '';
 }
 );
}

function telegram_composerExactlyMatches(
 input,
 expectedText
) {
 if (!input || !input.isConnected) {
 return false;
 }

 return !!telegram_getExactComposerCandidate(
 input,
 expectedText
 );
}

function telegram_findFirstMismatchIndex(a, b) {
 const limit = Math.min(a.length, b.length);

 for (let index = 0; index < limit; index += 1) {
 if (a.charAt(index) !== b.charAt(index)) {
 return index;
 }
 }

 return a.length === b.length ? -1 : limit;
}

async function telegram_fillComposerIncrementallyLegacy(
 transferContext,
 expectedText,
 chunkMeta
) {
 const expected =
 telegram_getExactComposerText(expectedText);

 if (!expected) {
 return {
 ok: false,
 error: '전송할 내용이 없어요.'
 };
 }

 let input =
 telegram_getTransferComposer(transferContext);

 if (!input) {
 return {
 ok: false,
 error: 'Telegram 입력창을 찾을 수 없어요.'
 };
 }

 if (telegram_readComposerText(input) !== '') {
 return {
 ok: false,
 residual: true,
 error:
 'Telegram 입력창에 기존 내용이 남아 있어 전송을 중단했습니다.'
 };
 }

 let stalledAttempts = 0;
 let verifiedLength = 0;

 while (true) {
 if (!telegram_isTransferChatCurrent(transferContext)) {
 return {
 ok: false,
 changedChat: true,
 error:
 '전송 중 Telegram 채팅이 변경되어 중단했습니다.'
 };
 }

 input = telegram_getTransferComposer(transferContext);

 if (!input) {
 return {
 ok: false,
 error: 'Telegram 입력창을 찾을 수 없어요.'
 };
 }

 let current = telegram_readComposerText(input);

 if (current === expected) {
 const stable =
 await telegram_waitForComposerExactStable(
 transferContext,
 expected,
 12000,
 600
 );

 if (stable.changedChat) {
 return {
 ok: false,
 changedChat: true,
 error:
 '전송 중 Telegram 채팅이 변경되어 중단했습니다.'
 };
 }

 if (!stable.ok) {
 return {
 ok: false,
 error:
 'Telegram 입력이 완전히 안정되지 않아 자동 전송을 중단했습니다.'
 };
 }

 return {
 ok: true,
 input: stable.input
 };
 }

 if (!expected.startsWith(current)) {
 const recovered =
 await telegram_waitForComposerPrefix(
 transferContext,
 expected,
 800,
 verifiedLength
 );

 if (recovered.changedChat) {
 return {
 ok: false,
 changedChat: true,
 error:
 '전송 중 Telegram 채팅이 변경되어 중단했습니다.'
 };
 }

 if (!recovered.ok) {
 return telegram_createComposerMismatchResult(
 expected,
 recovered.current,
 chunkMeta
 );
 }

 input = recovered.input;
 current = recovered.current;
 }

 verifiedLength = Math.max(
 verifiedLength,
 current.length
 );

 const beforeLength = current.length;
 const targetLength =
 telegram_getComposerSegmentEnd(
 expected,
 beforeLength
 );
 const segment = expected.slice(
 beforeLength,
 targetLength
 );

 const inserted =
 telegram_appendComposerText(
 input,
 segment
 );

 if (!inserted) {
 return {
 ok: false,
 error:
 'Telegram 입력을 삽입하지 못해 전송을 중단했습니다.'
 };
 }

 const progressDeadline = Date.now() + 1500;
 let progressed = false;

 while (Date.now() < progressDeadline) {
 if (!telegram_isTransferChatCurrent(transferContext)) {
 return {
 ok: false,
 changedChat: true,
 error:
 '전송 중 Telegram 채팅이 변경되어 중단했습니다.'
 };
 }

 input = telegram_getTransferComposer(transferContext);
 let updated = telegram_readComposerText(input);

 if (!expected.startsWith(updated)) {
 const recovered =
 await telegram_waitForComposerPrefix(
 transferContext,
 expected,
 800,
 beforeLength
 );

 if (recovered.changedChat) {
 return {
 ok: false,
 changedChat: true,
 error:
 '전송 중 Telegram 채팅이 변경되어 중단했습니다.'
 };
 }

 if (!recovered.ok) {
 return telegram_createComposerMismatchResult(
 expected,
 recovered.current,
 chunkMeta
 );
 }

 input = recovered.input;
 updated = recovered.current;
 }

 if (updated.length > beforeLength) {
 progressed = true;
 verifiedLength = Math.max(
 verifiedLength,
 updated.length
 );
 break;
 }

 await sleep(100);
 }

 if (progressed) {
 stalledAttempts = 0;
 } else {
 stalledAttempts += 1;

 if (stalledAttempts >= 3) {
 return {
 ok: false,
 residual: true,
 error:
 'Telegram 입력이 진행되지 않아 전송을 중단했습니다.'
 };
 }
 }
 }
}

function telegram_createComposerCandidateDiagnostic(
 expected,
 candidates,
 chunkMeta
) {
 const candidateDiagnostics = {};

 for (const source of [
 'innerText',
 'textContent',
 'domWalker'
 ]) {
 const candidate = candidates[source] || '';
 const mismatch =
 telegram_findFirstMismatchIndex(
 expected,
 candidate
 );

 candidateDiagnostics[source] = {
 length: candidate.length,
 firstMismatchIndex: mismatch,
 expectedCharCode:
 mismatch >= 0 && mismatch < expected.length
 ? expected.charCodeAt(mismatch)
 : null,
 candidateCharCode:
 mismatch >= 0 && mismatch < candidate.length
 ? candidate.charCodeAt(mismatch)
 : null
 };
 }

 const diagnostic = {
 build: CTB_RUNTIME_BUILD,
 chunkIndex: chunkMeta?.chunkIndex || null,
 chunkCount: chunkMeta?.chunkCount || null,
 expectedLength: expected.length,
 candidates: candidateDiagnostics,
 insertionMethod: 'single_native_paste'
 };

 console.warn(
 '[CTB Telegram composer verification]',
 diagnostic
 );

 return {
 ok: false,
 residual: true,
 diagnostic: diagnostic,
 error:
 'Telegram 입력 검증 실패 · inner ' +
 candidateDiagnostics.innerText.length +
 ' / text ' +
 candidateDiagnostics.textContent.length +
 ' / expected ' +
 expected.length
 };
}

async function telegram_fillComposerReliably(
 transferContext,
 expectedText,
 chunkMeta
) {
 const expected =
 telegram_getExactComposerText(expectedText);

 if (!expected) {
 return {
 ok: false,
 error: '전송할 내용이 없어요.'
 };
 }

 let input =
 telegram_getTransferComposer(transferContext);

 if (!input) {
 return {
 ok: false,
 error: 'Telegram 입력창을 찾을 수 없어요.'
 };
 }

 if (!telegram_composerIsEmpty(input)) {
 return {
 ok: false,
 residual: true,
 error:
 'Telegram 입력창에 기존 내용이 남아 있어 전송을 중단했습니다.'
 };
 }

 input.focus();

 if (!dispatchPasteText(input, expected)) {
 return {
 ok: false,
 error:
 'Telegram 입력창에 내용을 붙여넣지 못했습니다.'
 };
 }

 const deadline = Date.now() + 5000;
 let stableSince = 0;

 while (Date.now() < deadline) {
 if (!telegram_isTransferChatCurrent(transferContext)) {
 return {
 ok: false,
 changedChat: true,
 error:
 '전송 중 Telegram 채팅이 변경되어 중단했습니다.'
 };
 }

 input = telegram_getTransferComposer(transferContext);
 const exact =
 telegram_getExactComposerCandidate(
 input,
 expected
 );

 if (exact) {
 if (!stableSince) {
 stableSince = Date.now();
 }

 if (Date.now() - stableSince >= 400) {
 return {
 ok: true,
 input: input,
 candidateSource: exact.source
 };
 }
 } else {
 stableSince = 0;
 }

 await sleep(100);
 }

 return telegram_createComposerCandidateDiagnostic(
 expected,
 telegram_readComposerCandidates(input),
 chunkMeta
 );
}

function telegram_getTransferComposer(
 transferContext
) {
 return telegram_refreshTransferContext(
 transferContext
 );
}

async function telegram_waitForComposerMatch(
 transferContext,
 expectedText,
 timeoutMs
) {
 const deadline =
 Date.now() + timeoutMs;

 while (Date.now() < deadline) {
 if (
 !telegram_isTransferChatCurrent(
 transferContext
 )
 ) {
 return {
 ok: false,
 changedChat: true,
 input: null
 };
 }

 const input =
 telegram_getTransferComposer(
 transferContext
 );

 if (
 input &&
 telegram_composerMatches(
 input,
 expectedText
 )
 ) {
 return {
 ok: true,
 changedChat: false,
 input: input
 };
 }

 await sleep(250);
 }

 return {
 ok: false,
 changedChat:
 !telegram_isTransferChatCurrent(
 transferContext
 ),
 input:
 telegram_getTransferComposer(
 transferContext
 )
 };
}

async function telegram_waitForComposerExactStable(
 transferContext,
 expectedText,
 timeoutMs,
 stableMs
) {
 const deadline = Date.now() + timeoutMs;
 let stableSince = 0;

 while (Date.now() < deadline) {
 if (!telegram_isTransferChatCurrent(transferContext)) {
 return { ok: false, changedChat: true, input: null };
 }

 const input =
 telegram_getTransferComposer(transferContext);

 if (
 input &&
 telegram_composerExactlyMatches(input, expectedText)
 ) {
 if (!stableSince) stableSince = Date.now();

 if (Date.now() - stableSince >= stableMs) {
 return { ok: true, changedChat: false, input: input };
 }
 } else {
 stableSince = 0;
 }

 await sleep(100);
 }

 return {
 ok: false,
 changedChat:
 !telegram_isTransferChatCurrent(transferContext),
 input: telegram_getTransferComposer(transferContext)
 };
}

async function telegram_clearComposer(input) { if (!input || !input.isConnected) { return false; } input.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null })); await sleep(120); return (telegram_readComposerText(input) === '');}async function telegram_insertByPaste(input, text) { if (!input || !input.isConnected) { return false; } input.focus(); return dispatchPasteText(input, text);}async function telegram_insertByTextFallback(input, text) { if (!input || !input.isConnected) { return false; } const cleared = await telegram_clearComposer(input); if (!cleared) { return false; } input.focus(); const inserted = document.execCommand('insertText', false, text); input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })); return !!inserted;}async function telegram_waitForSendButton(
 transferContext,
 expectedText,
 timeoutMs
) {
 const deadline =
 Date.now() + timeoutMs;

 while (Date.now() < deadline) {
 if (
 !telegram_isTransferChatCurrent(
 transferContext
 )
 ) {
 return {
 ok: false,
 changedChat: true,
 button: null
 };
 }

 const input =
 telegram_getTransferComposer(
 transferContext
 );

 if (!input) {
 await sleep(250);
 continue;
 }

 if (
 !telegram_composerExactlyMatches(
 input,
 expectedText
 )
 ) {
 return {
 ok: false,
 changedChat: false,
 button: null
 };
 }

 const button =
 telegram_getTransferSendButton(
 transferContext
 );

 if (
 button &&
 button.isConnected &&
 telegram_isVisibleElement(button) &&
 !button.disabled &&
 button.getAttribute(
 'aria-disabled'
 ) !== 'true'
 ) {
 return {
 ok: true,
 changedChat: false,
 button: button
 };
 }

 await sleep(250);
 }

 return {
 ok: false,
 changedChat:
 !telegram_isTransferChatCurrent(
 transferContext
 ),
 button: null
 };
}

function telegram_readOutgoingMessageText(bubble) {
 if (!bubble) return '';

 const body = bubble.querySelector(
 '.message .text-content, ' +
 '.text-content, ' +
 '.message-text, ' +
 '[data-message-text], ' +
 '[class*="text-content"], ' +
 '.text'
 );
 const rawText = body
 ? (
 typeof body.innerText === 'string'
 ? body.innerText
 : body.textContent || ''
 )
 : telegram_cacheBubbleText(bubble);

 return telegram_getExactComposerText(rawText);
}

function telegram_getOutgoingBubbleEntries() {
 const root = telegram_findMessageRoot();

 if (!root) return [];

 return Array.from(
 root.querySelectorAll('.bubble')
 ).map(function(bubble, domIndex) {
 if (!telegram_cacheIsOutgoingBubble(bubble)) {
 return null;
 }

 const descriptor =
 telegram_cacheBubbleDescriptor(bubble, 'out');

 return {
 key: descriptor.key,
 order: descriptor.order,
 text: telegram_readOutgoingMessageText(bubble),
 domIndex: domIndex,
 bubble: bubble
 };
 }).filter(Boolean);
}

function telegram_captureOutgoingBaseline() {
 const entries = telegram_getOutgoingBubbleEntries();
 const numericOrders = entries
 .map(function(entry) {
 return entry.order;
 })
 .filter(function(order) {
 return typeof order === 'number';
 });
 const last = entries.length
 ? entries[entries.length - 1]
 : null;

 return {
 keys: new Set(
 entries.map(function(entry) {
 return entry.key;
 })
 ),
 nodes: new Set(
 entries.map(function(entry) {
 return entry.bubble;
 })
 ),
 maxNumericOrder: numericOrders.length
 ? Math.max(...numericOrders)
 : null,
 bubbleCount: entries.length,
 lastKey: last?.key || '',
 lastOrder:
 typeof last?.order === 'number'
 ? last.order
 : null,
 lastDomIndex: last?.domIndex ?? -1
 };
}

function telegram_findNewOutgoingBubble(baseline) {
 const entries = telegram_getOutgoingBubbleEntries();

 for (const entry of entries) {
 if (
 typeof entry.order === 'number' &&
 typeof baseline?.maxNumericOrder === 'number' &&
 entry.order > baseline.maxNumericOrder
 ) {
 return entry;
 }

 const hasStableKey =
 !!entry.key &&
 !entry.key.startsWith('out:text:');

 if (
 hasStableKey &&
 !baseline?.keys?.has(entry.key)
 ) {
 return entry;
 }

 if (
 entries.length >
 (baseline?.bubbleCount || 0) &&
 entry.domIndex >
 (baseline?.lastDomIndex ?? -1) &&
 !baseline?.nodes?.has(entry.bubble)
 ) {
 return entry;
 }
 }

 return null;
}

function telegram_createOutgoingTextDiagnostic(
 expectedText,
 outgoingText
) {
 const expected =
 telegram_getExactComposerText(expectedText);
 const outgoing =
 telegram_getExactComposerText(outgoingText);

 return {
 exactMatch: outgoing === expected,
 expectedLength: expected.length,
 outgoingReadLength: outgoing.length,
 firstMismatchIndex:
 telegram_findFirstMismatchIndex(
 expected,
 outgoing
 )
 };
}

async function telegram_waitForSendCompletion(
 transferContext,
 expectedText,
 timeoutMs,
 outgoingBaseline
) {
 const deadline =
 Date.now() + timeoutMs;

 let emptySince = 0;
 let sawEmpty = false;
 let sentBubble = null;

 while (Date.now() < deadline) {
 if (
 !telegram_isTransferChatCurrent(
 transferContext
 )
 ) {
 return {
 ok: false,
 changedChat: true,
 uncertain: true
 };
 }

 const input =
 telegram_getTransferComposer(
 transferContext
 );

 if (!input) {
 emptySince = 0;
 await sleep(100);
 continue;
 }

 if (telegram_composerIsEmpty(input)) {
 sawEmpty = true;

 if (!emptySince) {
 emptySince = Date.now();
 }

 const newOutgoing =
 telegram_findNewOutgoingBubble(
 outgoingBaseline
 );

 if (newOutgoing && !sentBubble) {
 const textDiagnostic =
 telegram_createOutgoingTextDiagnostic(
 expectedText,
 newOutgoing.text
 );

 if (!textDiagnostic.exactMatch) {
 console.warn(
 '[CTB Telegram outgoing text diagnostic]',
 textDiagnostic
 );
 }

 newOutgoing.textDiagnostic = textDiagnostic;
 }

 sentBubble = sentBubble || newOutgoing;

 if (
 sentBubble &&
 Date.now() - emptySince >= 700
 ) {
 return {
 ok: true,
 changedChat: false,
 uncertain: false,
 sentBubble: sentBubble
 };
 }
 } else {
 if (sawEmpty) {
 return {
 ok: false,
 changedChat: false,
 uncertain: true,
 residual: true
 };
 }

 emptySince = 0;
 }

 await sleep(100);
 }

 return {
 ok: false,
 changedChat:
 !telegram_isTransferChatCurrent(
 transferContext
 ),
 uncertain: true,
 residual:
 !telegram_composerIsEmpty(
 telegram_getTransferComposer(
 transferContext
 )
 ),
 outgoingFound: !!sentBubble
 };
}

async function telegram_sendMessage(
 text,
 autoSend,
 chunkMeta
) {
 if (telegram_sendMessage.__busy) {
 return {
 ok: false,
 error:
 'Telegram 전송이 이미 진행 중이에요.'
 };
 }

 telegram_sendMessage.__busy = true;

 try {
 const fileText =
 normalizeBridgeText(
 text
 );

 if (!fileText.trim()) {
 return {
 ok: false,
 error:
 '전송할 내용이 없어요.'
 };
 }

 const transferContext =
 telegram_createTransferContext();

 const input =
 transferContext
 ? transferContext.input
 : null;

 if (!input) {
 return {
 ok: false,
 error:
 'Telegram 입력창을 찾을 수 없어요.'
 };
 }

 if (!telegram_composerIsEmpty(input)) {
 return {
 ok: false,
 error:
 '이전 Telegram 전송 내용이 입력창에 남아 있어 다음 조각 전송을 중단했습니다.',
 residual: true
 };
 }

 const normalizedText =
 normalizeBridgeText(
 text
 );

 if (!normalizedText) {
 return {
 ok: false,
 error:
 '전송할 내용이 없어요.'
 };
 }

 const pasteResult =
 await telegram_fillComposerReliably(
 transferContext,
 normalizedText,
 chunkMeta
 );

 if (pasteResult.changedChat) {
 return {
 ok: false,
 error:
 '전송 중 Telegram 채팅이 변경되어 중단했습니다.'
 };
 }

 if (!pasteResult.ok) {
 return {
 ...pasteResult,
 ok: false,
 error:
 pasteResult.error ||
 '긴 코드 입력 완료를 확인하지 못했습니다. 입력된 내용은 지우지 않았습니다.',
 chunkIndex: chunkMeta?.chunkIndex,
 chunkCount: chunkMeta?.chunkCount
 };
 }

 if (!autoSend) {
 return {
 ok: true,
 pasted: true,
 sent: false
 };
 }

 const buttonResult =
 await telegram_waitForSendButton(
 transferContext,
 normalizedText,
 8000
 );

 if (buttonResult.changedChat) {
 return {
 ok: false,
 error:
 '전송 직전 Telegram 채팅이 변경되어 자동 전송을 중단했습니다.'
 };
 }

 if (!buttonResult.ok) {
 return {
 ok: false,
 error:
 '코드는 입력됐지만 Telegram 전송 버튼이 활성화되지 않았습니다. 직접 전송해주세요.'
 };
 }

 const finalInput =
 telegram_getTransferComposer(
 transferContext
 );

 if (
 !telegram_composerExactlyMatches(
 finalInput,
 normalizedText
 )
 ) {
 return {
 ok: false,
 error:
 'Telegram 입력이 완전히 안정되지 않아 자동 전송을 중단했습니다.'
 };
 }

 const button =
 buttonResult.button;

 const outgoingBaseline =
 telegram_captureOutgoingBaseline();

 if (
 !telegram_isTransferChatCurrent(
 transferContext
 ) ||
 !button ||
 !button.isConnected ||
 !telegram_isVisibleElement(button) ||
 button.disabled ||
 button.getAttribute(
 'aria-disabled'
 ) === 'true'
 ) {
 return {
 ok: false,
 error:
 'Telegram 전송 버튼 상태가 변경되었습니다. 직접 전송해주세요.'
 };
 }

 button.click();

 const completion =
 await telegram_waitForSendCompletion(
 transferContext,
 normalizedText,
 10000,
 outgoingBaseline
 );

 if (completion.ok) {
 return {
 ok: true,
 pasted: true,
 sent: true
 };
 }

 if (completion.changedChat) {
 return {
 ok: false,
 error:
 '전송 버튼은 한 번 클릭했지만 채팅이 변경되어 결과를 확인할 수 없습니다.'
 };
 }

 if (completion.residual) {
 return {
 ok: false,
 error:
 'Telegram 전송 후 일부 내용이 입력창에 남아 중단했습니다. 남은 내용은 삭제하지 않았습니다.',
 residual: true
 };
 }

 return {
 ok: false,
 error:
 'Telegram 전송 결과를 확인하지 못해 중단했습니다. 중복 전송 방지를 위해 다시 보내지 않았습니다.',
 chunkIndex: chunkMeta?.chunkIndex,
 chunkCount: chunkMeta?.chunkCount
 };
 } finally {
 telegram_sendMessage.__busy =
 false;
 }
}

async function telegram_sendTextChunks(
 text,
 autoSend
) {
 const splitResult =
 telegram_splitTextIntoChunks(text);
 const chunks = splitResult.chunks;

 if (!splitResult.ok || !chunks.length) {
 return {
 ok: false,
 error:
 splitResult.error ||
 '전송할 내용이 없어요.'
 };
 }

 if (!autoSend) {
 return telegram_sendMessage(
 splitResult.source,
 false,
 {
 chunkIndex: 1,
 chunkCount: 1
 }
 );
 }

 let result = null;

 for (
 let index = 0;
 index < chunks.length;
 index += 1
 ) {
 result =
 await telegram_sendMessage(
 chunks[index],
 true,
 {
 chunkIndex: index + 1,
 chunkCount: chunks.length
 }
 );

 if (!result?.ok) {
 return {
 ...result,
 chunkIndex: index + 1,
 chunkCount: chunks.length,
 error:
 'Telegram ' +
 (index + 1) +
 '/' +
 chunks.length +
 ' 전송 중단: ' +
 (result?.error || '전송 결과를 확인하지 못했습니다.')
 };
 }
 }

 return result;
}

async function telegram_sendWholeTextOnce(
  text,
  autoSend
) {
  if (
    telegram_sendWholeTextOnce.__busy
  ) {
    return {
      ok: false,
      error:
        'Telegram 전송이 이미 진행 중이에요.'
    };
  }

  telegram_sendWholeTextOnce.__busy =
    true;

  try {
    const source =
      normalizeBridgeText(text);

    if (!source.trim()) {
      return {
        ok: false,
        error:
          '전송할 내용이 없어요.'
      };
    }

    const transferContext =
      telegram_createTransferContext();

    if (!transferContext) {
      return {
        ok: false,
        error:
          'Telegram 입력창을 찾을 수 없어요.'
      };
    }

    let input =
      telegram_refreshTransferContext(
        transferContext
      );

    if (!input) {
      return {
        ok: false,
        error:
          'Telegram 입력창을 찾을 수 없어요.'
      };
    }

    /*
     * 기존 작성 중인 내용은 절대 지우지 않는다.
     */
    if (
      telegram_readComposerText(
        input
      ).trim()
    ) {
      return {
        ok: false,
        error:
          'Telegram 입력창에 기존 내용이 있어 전송하지 않았습니다.'
      };
    }

    input.focus();

    /*
     * 핵심:
     * 전체 원문을 딱 한 번만 paste.
     */
    const pasted =
      dispatchPasteText(
        input,
        source
      );

    if (!pasted) {
      return {
        ok: false,
        error:
          'Telegram에 전체 코드를 붙여넣지 못했습니다.'
      };
    }

    /*
     * Telegram DOM 표현을 원문과 exact 비교하지 않는다.
     * 붙여넣기 후 실제 입력 내용이 생겼는지만 확인한다.
     */
    const pasteDeadline =
      Date.now() + 5000;

    while (
      Date.now() < pasteDeadline
    ) {
      if (
        !telegram_isTransferChatCurrent(
          transferContext
        )
      ) {
        return {
          ok: false,
          error:
            '붙여넣는 중 Telegram 채팅이 변경되었습니다.'
        };
      }

      input =
        telegram_refreshTransferContext(
          transferContext
        );

      if (
        input &&
        telegram_readComposerText(
          input
        ).length > 0
      ) {
        break;
      }

      await sleep(100);
    }

    if (
      !input ||
      !telegram_readComposerText(
        input
      ).length
    ) {
      return {
        ok: false,
        error:
          'Telegram 입력창에 전체 코드가 들어오지 않았습니다.'
      };
    }

    if (!autoSend) {
      return {
        ok: true,
        pasted: true,
        sent: false
      };
    }

    /*
     * Send 버튼도 딱 한 번 클릭.
     * Telegram이 긴 메시지를 나누는 것은
     * Telegram 자체 동작에 맡긴다.
     */
    const buttonDeadline =
      Date.now() + 5000;

    let button = null;

    while (
      Date.now() < buttonDeadline
    ) {
      button =
        telegram_getTransferSendButton(
          transferContext
        );

      if (
        button &&
        button.isConnected &&
        telegram_isVisibleElement(
          button
        ) &&
        !button.disabled &&
        button.getAttribute(
          'aria-disabled'
        ) !== 'true'
      ) {
        break;
      }

      button = null;
      await sleep(100);
    }

    if (!button) {
      return {
        ok: false,
        error:
          'Telegram 전송 버튼을 찾을 수 없습니다.'
      };
    }

    button.click();

    /*
     * 반복 전송/재클릭 없음.
     * Telegram composer가 완전히 비어 있는 상태가
     * 700ms 유지되면 완료로 본다.
     */
    const sendDeadline =
      Date.now() + 15000;

    let emptySince = 0;

    while (
      Date.now() < sendDeadline
    ) {
      if (
        !telegram_isTransferChatCurrent(
          transferContext
        )
      ) {
        return {
          ok: false,
          error:
            '전송 중 Telegram 채팅이 변경되었습니다.'
        };
      }

      input =
        telegram_refreshTransferContext(
          transferContext
        );

      if (!input) {
        await sleep(100);
        continue;
      }

      const current =
        telegram_readComposerText(
          input
        );

      if (!current) {
        if (!emptySince) {
          emptySince = Date.now();
        }

        if (
          Date.now() -
            emptySince >=
          700
        ) {
          return {
            ok: true,
            pasted: true,
            sent: true,
            singlePaste: true,
            singleSendClick: true
          };
        }
      } else {
        emptySince = 0;
      }

      await sleep(100);
    }

    return {
      ok: false,
      error:
        'Telegram 전송 버튼은 한 번 눌렀지만 입력창이 비워지지 않았습니다. 자동 재전송하지 않았습니다.'
    };
  } finally {
    telegram_sendWholeTextOnce.__busy =
      false;
  }
}

// ────────────────────────────────────────
// 사이트별 디스패처
// ────────────────────────────────────────
function getResponse() {
  if (SITE === 'claude')  return claude_getResponse();
  if (SITE === 'chatgpt') return chatgpt_getResponse();
  if (SITE === 'gemini')  return gemini_getResponse();
  return null;
}

function isStreaming() {
  if (SITE === 'claude')  return claude_isStreaming();
  if (SITE === 'chatgpt') return chatgpt_isStreaming();
  if (SITE === 'gemini')  return gemini_isStreaming();
  return false;
}

async function pasteToAI(text, autoSend) {
  if (SITE === 'claude')  return claude_pasteInput(text, autoSend);
  if (SITE === 'chatgpt') return chatgpt_pasteInput(text, autoSend);
  if (SITE === 'gemini')  return gemini_pasteInput(text, autoSend);
  return { ok: false, error: '지원하지 않는 사이트예요.' };
}

function getInputEl() {
  if (SITE === 'claude')  return claude_getInputEl();
  if (SITE === 'chatgpt') return chatgpt_getInputEl();
  if (SITE === 'gemini')  return gemini_getInputEl();
  return null;
}

// ────────────────────────────────────────
// 공통 모듈 (CSS, 드래그, 상태)
// ────────────────────────────────────────
const PANEL_STYLES = `
    .ctb-btn {
      display: block !important; width: 100% !important; padding: 9px 8px !important;
      border: none !important; border-radius: 7px !important; font-size: 10px !important; font-weight: 500 !important;
      cursor: pointer !important; margin-bottom: 5px !important;
      color: #fff !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
    }
    .ctb-btn:hover { opacity: 0.85; }
    .ctb-btn:active { opacity: 0.65; }
    .ctb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #ctb-deepseek-balance-row {
      display: flex !important;
      flex-direction: column !important;
      gap: 3px !important;
      width: 100% !important;
      margin-bottom: 5px !important;
      align-items: stretch !important;
    }
    #ctb-deepseek-current,
    #ctb-deepseek-usage {
      height: 22px !important;
      min-width: 0 !important;
      border: 1px solid #333366 !important;
      border-radius: 6px !important;
      background: #111122 !important;
      color: #facc15 !important;
      font-size: 9px !important;
      font-weight: 700 !important;
      line-height: 20px !important;
      text-align: center !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    #ctb-deepseek-current {
      flex: none !important;
      width: 100% !important;
      padding: 0 3px !important;
    }
    #ctb-deepseek-usage {
      flex: none !important;
      width: 100% !important;
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      padding: 0 2px !important;
    }
    .ctb-deepseek-arrow {
      width: 14px !important;
      height: 20px !important;
      border: none !important;
      background: transparent !important;
      color: #a78bfa !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      line-height: 20px !important;
      padding: 0 !important;
      cursor: pointer !important;
      flex-shrink: 0 !important;
    }
    .ctb-deepseek-arrow:disabled {
      opacity: 0.25 !important;
      cursor: default !important;
    }
    #ctb-deepseek-usage-value {
      flex: 1 !important;
      min-width: 0 !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      text-align: center !important;
    }
    #ctb-deepseek-balance-row.ctb-deepseek-peak #ctb-deepseek-current,
    #ctb-deepseek-balance-row.ctb-deepseek-peak #ctb-deepseek-usage,
    #ctb-deepseek-balance-row.ctb-deepseek-peak #ctb-deepseek-usage-value {
      color: #f87171 !important;
    }
    #ctb-deepseek-balance-row.ctb-deepseek-peak #ctb-deepseek-current,
    #ctb-deepseek-balance-row.ctb-deepseek-peak #ctb-deepseek-usage {
      border-color: #7f1d1d !important;
      background: #2a1118 !important;
    }
    .ctb-tg { background: #2AABEE !important; }
    .ctb-cls { background: #a78bfa !important; }
    #ctb-ai-autosend-label, #ctb-ai-auto-return-label, #ctb-tg-autosend-label {
      display: flex !important; align-items: center !important; gap: 4px;
      margin-top: 2px; cursor: pointer; user-select: none;
    }
    #ctb-ai-autosend-label span, #ctb-ai-auto-return-label span, #ctb-tg-autosend-label span { font-size: 9px !important; color: #a0a0b0 !important; line-height: 1.2; }
    #ctb-autosend { width: 11px; height: 11px; accent-color: #2AABEE; cursor: pointer; flex-shrink: 0; }
    #ctb-mode-row {
      display: flex; gap: 4px; margin-bottom: 5px;
    }
    #ctb-tgmode-row {
      display: flex; gap: 4px; margin-bottom: 5px;
    }
    .ctb-mode-btn {
      flex: 1; padding: 3px 0; font-size: 9px; font-weight: 600;
      border: 1px solid #333355; border-radius: 5px;
      background: none; color: #555577; cursor: pointer; transition: all 0.15s;
    }
    .ctb-mode-btn:hover { border-color: #a78bfa; color: #a78bfa; }
    .ctb-mode-active { background: #2a2a55 !important; border-color: #a78bfa !important; color: #a78bfa !important; }
    #ctb-status { color: #a0a0b0 !important;
      margin-top: 6px; font-size: 9px; text-align: center;
      min-height: 12px; color: #a0a0b0; line-height: 1.3;
      word-break: keep-all; white-space: pre-wrap;
    }
    #ctb-status.ok  { color: #4ade80; }
    #ctb-status.err { color: #f87171; }
    .ctb-runtime-build {
      position: absolute; right: 4px; bottom: 1px;
      font-size: 7px; line-height: 1; color: #555577;
      pointer-events: none;
    }
    #ctb-token-counter {
      position: absolute; font-size: 10px; color: #888;
      pointer-events: none; z-index: 99998; background: transparent; transition: color 0.2s;
    }
    #ctb-token-counter.warn   { color: #f59e0b; }
    #ctb-token-counter.danger { color: #f87171; }
    /* AI 위젯 */
    #ctb-ai-panel { position:fixed !important; right:16px; bottom:120px;  z-index:99999 !important; background:#1a1a2e; border:1px solid #3a3a5c !important; border-radius:12px !important; padding:9px 10px !important; width:110px !important; box-shadow:0 4px 20px rgba(0,0,0,0.4) !important; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important; user-select:none !important; }
    #ctb-ai-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; cursor:grab; }
    #ctb-ai-title:active { cursor:grabbing; }
    #ctb-ai-title-text { font-size:10px; font-weight:600; color:#a78bfa; letter-spacing:0.5px; flex:1; text-align:center; }
    #ctb-ai-controls { display:flex; gap:2px; flex-shrink:0; }
    #ctb-ai-controls button { background:none; border:none; color:#555; font-size:11px; cursor:pointer; padding:0 3px; line-height:1; border-radius:3px; transition:color 0.15s; }
    #ctb-ai-controls button:hover { color:#a78bfa; }
    /* TG 위젯 */
    #ctb-tg-panel { position:fixed !important; right:16px; bottom:120px;  z-index:99999 !important; background:#1a1a2e !important; border:1px solid #3a3a5c !important; border-radius:12px !important; padding:9px 10px !important; width:110px !important; box-shadow:0 4px 20px rgba(0,0,0,0.4) !important; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif !important; user-select:none !important; }
    #ctb-tg-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:7px; cursor:grab; }
    #ctb-tg-title:active { cursor:grabbing; }
    #ctb-tg-title-text { font-size:10px; font-weight:600; color:#a78bfa; letter-spacing:0.5px; flex:1; text-align:center; }
    #ctb-tg-controls { display:flex; gap:2px; flex-shrink:0; }
    #ctb-tg-controls button { background:none; border:none; color:#555; font-size:11px; cursor:pointer; padding:0 3px; line-height:1; border-radius:3px; transition:color 0.15s; }
    #ctb-tg-controls button:hover { color:#a78bfa; }
    .ctb-switch-btn {
      display:block; width:100%; padding:3px 0; margin-top:5px;
      font-size:11px; text-align:center; cursor:pointer;
      background:none; border:1px solid #3a3a5c; border-radius:5px;
      color:#555; transition:color 0.15s,border-color 0.15s;
    }
    .ctb-switch-btn:hover { color:#a78bfa; border-color:#a78bfa; }
`;

function clampPanelPosition(panel, left, top) {
 const margin = 8;
 const panelWidth = panel && panel.offsetWidth ? panel.offsetWidth : 110;
 const panelHeight = panel && panel.offsetHeight ? panel.offsetHeight : 36;

 let nextLeft = Number(left);
 let nextTop = Number(top);

 if (!Number.isFinite(nextLeft)) nextLeft = margin;
 if (!Number.isFinite(nextTop)) nextTop = margin;

 const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
 const maxTop = Math.max(margin, window.innerHeight - panelHeight - margin);

 nextLeft = Math.min(Math.max(margin, nextLeft), maxLeft);
 nextTop = Math.min(Math.max(margin, nextTop), maxTop);

 return {
 left: Math.round(nextLeft),
 top: Math.round(nextTop)
 };
}

function applyPreferredPanelPosition(panel) {
  if (
    !panel ||
    !panel.isConnected
  ) {
    return;
  }

  if (
    getComputedStyle(panel)
      .display === 'none'
  ) {
    return;
  }

  const preferred =
    panel.__ctbPreferredPosition;

  if (
    !preferred ||
    !Number.isFinite(
      Number(preferred.left)
    ) ||
    !Number.isFinite(
      Number(preferred.top)
    )
  ) {
    return;
  }

  const clamped =
    clampPanelPosition(
      panel,
      preferred.left,
      preferred.top
    );

  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.left =
    clamped.left + 'px';
  panel.style.top =
    clamped.top + 'px';
}

function savePanelPosition(
  panel,
  storageKey
) {
  if (
    !panel ||
    !storageKey ||
    !panel.isConnected
  ) {
    return;
  }

  if (
    getComputedStyle(panel)
      .display === 'none'
  ) {
    return;
  }

  const rect =
    panel.getBoundingClientRect();

  if (
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return;
  }

  const clamped =
    clampPanelPosition(
      panel,
      rect.left,
      rect.top
    );

  const preferred = {
    left: clamped.left,
    top: clamped.top
  };

  panel.__ctbPreferredPosition =
    preferred;

  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.left =
    preferred.left + 'px';
  panel.style.top =
    preferred.top + 'px';

  chrome.storage.local.set({
    [storageKey]:
      preferred
  });
}

function applyStoredPanelPosition(
  panel,
  storageKey,
  pos
) {
  if (
    !panel ||
    !pos
  ) {
    return;
  }

  const left =
    Number(pos.left);

  const top =
    Number(pos.top);

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top)
  ) {
    return;
  }

  const preferred = {
    left: Math.round(left),
    top: Math.round(top)
  };

  panel.__ctbPreferredPosition =
    preferred;

  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.left =
    preferred.left + 'px';
  panel.style.top =
    preferred.top + 'px';

  requestAnimationFrame(function() {
    applyPreferredPanelPosition(
      panel
    );
  });
}

function normalizePanelUiState(state) {
  if (
    state === 'minimized' ||
    state === 'closed'
  ) {
    return state;
  }

  return 'normal';
}

function syncPanelDisplay(panel) {
  if (!panel) {
    return;
  }

  const routeVisible =
    panel.dataset.ctbRouteVisible ===
    'true';

  const uiState =
    normalizePanelUiState(
      panel.dataset.ctbUiState
    );

  if (
    !routeVisible ||
    uiState === 'closed'
  ) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display =
    uiState === 'minimized'
      ? 'flex'
      : '';

  requestAnimationFrame(function() {
    applyPreferredPanelPosition(
      panel
    );
  });
}

function setPanelUiState(
  panel,
  storageKey,
  state,
  persist
) {
  if (!panel) {
    return;
  }

  const nextState =
    normalizePanelUiState(
      state
    );

  panel.dataset.ctbUiState =
    nextState;

  if (
    typeof panel.__ctbApplyVisualState ===
    'function'
  ) {
    panel.__ctbApplyVisualState(
      nextState
    );
  }

  syncPanelDisplay(
    panel
  );

  if (
    persist &&
    storageKey
  ) {
    chrome.storage.local.set({
      [storageKey]:
        nextState
    });
  }
}

function makeDraggable(
  panel,
  handleSelector,
  storageKey
) {
  const handle =
    panel.querySelector(
      handleSelector
    );

  if (!handle) {
    return;
  }

  let dragging = false;
  let dragX = 0;
  let dragY = 0;

  handle.addEventListener(
    'mousedown',
    function(e) {
      if (
        panel.dataset.ctbUiState ===
        'minimized'
      ) {
        return;
      }

      dragging = true;

      const rect =
        panel.getBoundingClientRect();

      dragX =
        e.clientX - rect.left;

      dragY =
        e.clientY - rect.top;

      panel.style.right = 'auto';
      panel.style.bottom = 'auto';

      e.preventDefault();
    }
  );

  document.addEventListener(
    'mousemove',
    function(e) {
      if (!dragging) {
        return;
      }

      const clamped =
        clampPanelPosition(
          panel,
          e.clientX - dragX,
          e.clientY - dragY
        );

      panel.style.left =
        clamped.left + 'px';

      panel.style.top =
        clamped.top + 'px';
    }
  );

  document.addEventListener(
    'mouseup',
    function() {
      if (!dragging) {
        return;
      }

      dragging = false;

      savePanelPosition(
        panel,
        storageKey
      );
    }
  );

  window.addEventListener(
    'resize',
    function() {
      requestAnimationFrame(
        function() {
          applyPreferredPanelPosition(
            panel
          );
        }
      );
    }
  );
}

function copyPanelPosition(
  fromPanel,
  toPanel,
  storageKey
) {
  if (
    !fromPanel ||
    !toPanel ||
    fromPanel === toPanel
  ) {
    return;
  }

  const rect =
    fromPanel.getBoundingClientRect();

  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top)
  ) {
    return;
  }

  const preferred = {
    left: Math.round(rect.left),
    top: Math.round(rect.top)
  };

  toPanel.__ctbPreferredPosition =
    preferred;

  toPanel.style.right = 'auto';
  toPanel.style.bottom = 'auto';
  toPanel.style.left =
    preferred.left + 'px';
  toPanel.style.top =
    preferred.top + 'px';

  if (storageKey) {
    chrome.storage.local.set({
      [storageKey]:
        preferred
    });
  }

  requestAnimationFrame(function() {
    applyPreferredPanelPosition(
      toPanel
    );
  });
}

function setPanelStatus(statusEl, msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}
function setPanelBtnsDisabled(btns, v) {
  btns.forEach(b => { if (b) b.disabled = v; });
}

function getBridgeRefreshHandlers() {
  window.__ctbRefreshHandlers = window.__ctbRefreshHandlers || {};
  return window.__ctbRefreshHandlers;
}

function registerBridgeRefreshHandler(key, handler) {
  if (!key || typeof handler !== 'function') return;
  getBridgeRefreshHandlers()[key] = handler;
}

function runBridgeRefreshHandler(key, done) {
  var handler = getBridgeRefreshHandlers()[key];
  if (typeof handler === 'function') { handler(done); return; }
  if (typeof done === 'function') done();
}

function isBridgeAIPage() {
  return SITE === 'chatgpt' || SITE === 'claude' || SITE === 'gemini';
}

function syncBridgeTargetPickerVisibility() {
  var isAIPage = isBridgeAIPage();
  var currentTitle = document.title || SITE_NAME || '현재 AI 탭';

  var aiSourceSelect = document.getElementById('ctb-ai-source-select');
  var aiCurrentTabLabel = document.getElementById('ctb-ai-current-tab-label');

  var tgAiSelect = document.getElementById('ctb-ai-select');
  var tgCurrentTabLabel = document.getElementById('ctb-tg-current-tab-label');

  if (isAIPage) {
    if (aiSourceSelect) aiSourceSelect.style.display = 'none';
    if (aiCurrentTabLabel) {
      aiCurrentTabLabel.style.display = 'block';
      aiCurrentTabLabel.textContent = currentTitle;
      aiCurrentTabLabel.title = currentTitle;
    }
    if (tgAiSelect) tgAiSelect.style.display = 'none';
    if (tgCurrentTabLabel) {
      tgCurrentTabLabel.style.display = 'block';
      tgCurrentTabLabel.textContent = currentTitle;
      tgCurrentTabLabel.title = currentTitle;
    }
    return;
  }

  if (aiSourceSelect) aiSourceSelect.style.display = '';
  if (aiCurrentTabLabel) {
    aiCurrentTabLabel.style.display = 'none';
    aiCurrentTabLabel.textContent = '';
    aiCurrentTabLabel.title = '';
  }
  if (tgAiSelect) tgAiSelect.style.display = '';
  if (tgCurrentTabLabel) {
    tgCurrentTabLabel.style.display = 'none';
    tgCurrentTabLabel.textContent = '';
    tgCurrentTabLabel.title = '';
  }
}


// ────────────────────────────────────────
// AI 위젯 (AI→TG 전용)
// ────────────────────────────────────────
function normalizeAutoReturnConversationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch (error) {
    return '';
  }
}

function getAutoReturnRouteStatusView(status) {
  const views = {
    awaiting_job: ['⏳ GPT 회신 예약 · Job 연결 대기', ''],
    awaiting_result: ['⏳ GPT 회신 예약 · 완료 대기', ''],
    collecting_result: ['⏳ 완료보고 수집 중...', ''],
    delivering: ['⏳ GPT로 완료보고 전달 중...', ''],
    delivered: ['✅ 완료보고 GPT 전달 완료', 'ok'],
    ambiguous: ['⚠️ GPT 회신 연결 확인 필요', 'err'],
    delivery_failed: ['❌ GPT 자동전달 실패', 'err'],
    cancelled: ['⚠️ GPT 회신 예약 취소', 'err']
  };
  return views[status] || null;
}

function injectAIWidget() {
  if (document.getElementById('ctb-ai-panel')) return;

  // CSS 주입 (최초 1회)
  if (!document.getElementById('ctb-bridge-style')) {
    const style = document.createElement('style');
    style.id = 'ctb-bridge-style';
    style.textContent = PANEL_STYLES;
    document.head.appendChild(style);
  }

  const panel = document.createElement('div');
  panel.id = 'ctb-ai-panel';
  panel.innerHTML = `
    <div id="ctb-ai-title">
      <span id="ctb-ai-title-text">🔗 → Telegram</span>
      <div id="ctb-ai-controls">
        <button id="ctb-ai-minimize" title="최소화">−</button>
        <button id="ctb-ai-refresh" title="새로고침">↺</button>
        <button id="ctb-ai-close" title="닫기">✕</button>
      </div>
    </div>
    <div id="ctb-body">
      <div id="ctb-deepseek-balance-row">
        <div id="ctb-deepseek-current" title="DeepSeek 현재 잔액">$KEY</div>
        <div id="ctb-deepseek-usage" title="기록된 1분 사용금액"><button id="ctb-deepseek-prev" class="ctb-deepseek-arrow" title="이전 사용 기록">&lt;</button>
          <span id="ctb-deepseek-usage-value">$0.00</span>
          <button id="ctb-deepseek-next" class="ctb-deepseek-arrow" title="다음 사용 기록">&gt;</button>
        </div>
      </div>
      <button id="ctb-ai-btn1" class="ctb-btn ctb-tg">📤 → Telegram</button>
      <select id="ctb-ai-source-select" style="width:100%;margin-bottom:5px;padding:2px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;"><option value="">AI 탭 목록 받는 중...</option></select>
      <div id="ctb-ai-current-tab-label" style="display:none;width:100%;margin-bottom:5px;padding:3px 4px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
      <div id="ctb-mode-row">
        <button id="ctb-ai-mode-full" class="ctb-mode-btn">전체</button>
        <button id="ctb-ai-mode-code" class="ctb-mode-btn ctb-mode-active">코드</button>
      </div>
      <label id="ctb-ai-autosend-label" style="display:flex !important;align-items:center;gap:4px;margin-top:2px;cursor:pointer">
        <input type="checkbox" id="ctb-ai-autosend" checked style="width:13px;height:13px;opacity:1;display:inline;flex-shrink:0;position:static;appearance:auto;accent-color:#2AABEE" />
        <span>전송까지 자동으로</span>
      </label>
      <label id="ctb-ai-auto-return-label" style="display:flex !important;align-items:center;gap:4px;margin-top:2px;cursor:pointer">
        <input type="checkbox" id="ctb-ai-auto-return" checked style="width:13px;height:13px;opacity:1;display:inline;flex-shrink:0;position:static;appearance:auto;accent-color:#2AABEE" />
        <span>완료보고 → GPT 자동전달</span>
      </label>
      <button id="ctb-ai-switch" class="ctb-switch-btn">🔁 위젯 전환</button>
      <div id="ctb-status"></div>
    </div>
    <span class="ctb-runtime-build">${CTB_RUNTIME_BUILD}</span>
  `;

  document.body.appendChild(panel);

  panel.dataset.ctbUiState =
    'normal';

  panel.dataset.ctbRouteVisible =
    'false';

  makeDraggable(
    panel,
    '#ctb-ai-title',
    'widgetPos_ai'
  );

  // ── 최소화/복원 ──
  let isMinimized = false;

  const bodyEl =
    panel.querySelector(
      '#ctb-body'
    );

  const controlsEl =
    panel.querySelector(
      '#ctb-ai-controls'
    );

  const titleTextEl =
    panel.querySelector(
      '#ctb-ai-title-text'
    );

  const titleEl =
    panel.querySelector(
      '#ctb-ai-title'
    );

  function applyAIMinimizedVisual() {
    isMinimized = true;

    bodyEl.style.display =
      'none';

    controlsEl.style.display =
      'none';

    panel.style.setProperty(
      'width',
      '36px',
      'important'
    );

    panel.style.height =
      '36px';

    panel.style.setProperty(
      'border-radius',
      '50%',
      'important'
    );

    panel.style.setProperty(
      'padding',
      '0',
      'important'
    );

    panel.style.justifyContent =
      'center';

    panel.style.alignItems =
      'center';

    panel.style.cursor =
      'pointer';

    titleEl.style.marginBottom =
      '0';

    titleEl.style.cursor =
      'pointer';

    titleTextEl.style.fontSize =
      '18px';

    titleTextEl.textContent =
      '🔗';
  }

  function applyAINormalVisual() {
    isMinimized = false;

    bodyEl.style.display =
      '';

    controlsEl.style.display =
      '';

    panel.style.setProperty(
      'width',
      '110px',
      'important'
    );

    panel.style.height =
      '';

    panel.style.setProperty(
      'border-radius',
      '12px',
      'important'
    );

    panel.style.setProperty(
      'padding',
      '9px 10px',
      'important'
    );

    panel.style.justifyContent =
      '';

    panel.style.alignItems =
      '';

    panel.style.cursor =
      '';

    titleEl.style.marginBottom =
      '7px';

    titleEl.style.cursor =
      'grab';

    titleTextEl.style.fontSize =
      '10px';

    titleTextEl.textContent =
      '🔗 → Telegram';
  }

  panel.__ctbApplyVisualState =
    function(state) {
      if (state === 'minimized') {
        applyAIMinimizedVisual();
      } else {
        applyAINormalVisual();
      }
    };

  panel
    .querySelector(
      '#ctb-ai-minimize'
    )
    .addEventListener(
      'click',
      function(e) {
        e.stopPropagation();

        setPanelUiState(
          panel,
          'widgetUiState_ai',
          'minimized',
          true
        );
      }
    );

  panel.querySelector('#ctb-ai-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    runBridgeRefreshHandler('aiSource', function() {
      syncBridgeTargetPickerVisibility();
      setStatus('\u21BA \uC0C8\uB85C\uACE0\uCE68 \uC644\uB8CC', 'ok');
    });
  });

  panel.addEventListener(
    'click',
    function() {
      if (
        panel.dataset.ctbUiState ===
        'minimized'
      ) {
        setPanelUiState(
          panel,
          'widgetUiState_ai',
          'normal',
          true
        );
      }
    }
  );

  panel
    .querySelector(
      '#ctb-ai-close'
    )
    .addEventListener(
      'click',
      function(e) {
        e.stopPropagation();

        setPanelUiState(
          panel,
          'widgetUiState_ai',
          'closed',
          true
        );
      }
    );

  // ── 복사 모드 토글 ──
  const modFullBtn = panel.querySelector('#ctb-ai-mode-full');
  const modCodeBtn = panel.querySelector('#ctb-ai-mode-code');
  const applyCopyMode = (mode) => {
    if (mode === 'full') {
      copyMode = 'full';
      modFullBtn.classList.add('ctb-mode-active');
      modCodeBtn.classList.remove('ctb-mode-active');
    } else {
      copyMode = 'code';
      modCodeBtn.classList.add('ctb-mode-active');
      modFullBtn.classList.remove('ctb-mode-active');
    }
  };
  chrome.storage.local.get(['bridge_mode'], (res) => {
    if (res?.bridge_mode) applyCopyMode(res.bridge_mode);
  });
  modFullBtn.addEventListener('click', () => {
    copyMode = 'full'; chrome.storage.local.set({ bridge_mode: 'full' });
    modFullBtn.classList.add('ctb-mode-active');
    modCodeBtn.classList.remove('ctb-mode-active');
  });
  modCodeBtn.addEventListener('click', () => {
    copyMode = 'code'; chrome.storage.local.set({ bridge_mode: 'code' });
    modCodeBtn.classList.add('ctb-mode-active');
    modFullBtn.classList.remove('ctb-mode-active');
  });

  // ── 상태 표시 ──
  const statusEl = panel.querySelector('#ctb-status');
  const btn1 = panel.querySelector('#ctb-ai-btn1');
  const autoCheck = panel.querySelector('#ctb-ai-autosend');
  const autoReturnCheck = panel.querySelector('#ctb-ai-auto-return');
  const deepSeekCurrentEl = panel.querySelector('#ctb-deepseek-current');
  const deepSeekUsageEl = panel.querySelector('#ctb-deepseek-usage');
  const deepSeekUsageValueEl = panel.querySelector('#ctb-deepseek-usage-value');
  const deepSeekPrevBtn = panel.querySelector('#ctb-deepseek-prev');
  const deepSeekNextBtn = panel.querySelector('#ctb-deepseek-next');
  let deepSeekBalanceState = null;
  let deepSeekUsageHistory = [];
  let deepSeekUsageIndex = 0;

  function formatDeepSeekMoney(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n)) {
      if (currency === 'CNY') return '¥--';
      if (currency && currency !== 'USD') return currency + ' --';
      return '$--';
    }
    if (currency === 'CNY') return '¥' + n.toFixed(2);
    if (currency && currency !== 'USD') return currency + ' ' + n.toFixed(2);
    return '$' + n.toFixed(2);
  }

  function formatDeepSeekRecordTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return yy + '.' + mm + '.' + dd + ' ' + hh + ':' + mi;
  }

  const DEEPSEEK_CHINA_PUBLIC_HOLIDAYS_2026 =
    new Set([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',

      '2026-02-15',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-02-21',
      '2026-02-22',
      '2026-02-23',

      '2026-04-04',
      '2026-04-05',
      '2026-04-06',

      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
      '2026-05-04',
      '2026-05-05',

      '2026-06-19',
      '2026-06-20',
      '2026-06-21',

      '2026-09-25',
      '2026-09-26',
      '2026-09-27',

      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07'
    ]);

  function getDeepSeekChinaDateInfo(now) {
    const formatter =
      new Intl.DateTimeFormat(
        'en-CA',
        {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          weekday: 'short'
        }
      );

    const values = {};

    formatter
      .formatToParts(now)
      .forEach(function(part) {
        if (
          part.type !== 'literal'
        ) {
          values[part.type] =
            part.value;
        }
      });

    return {
      dateKey:
        values.year +
        '-' +
        values.month +
        '-' +
        values.day,
      weekday:
        values.weekday || ''
    };
  }

  function getDeepSeekPeakStateNow() {
    const now =
      new Date();

    const china =
      getDeepSeekChinaDateInfo(
        now
      );

    const isWeekend =
      china.weekday === 'Sat' ||
      china.weekday === 'Sun';

    if (isWeekend) {
      return {
        isPeak: false,
        reason: '주말'
      };
    }

    if (
      DEEPSEEK_CHINA_PUBLIC_HOLIDAYS_2026
        .has(china.dateKey)
    ) {
      return {
        isPeak: false,
        reason: '중국 공휴일'
      };
    }

    const utcHour =
      now.getUTCHours();

    const isPeak =
      (
        utcHour >= 1 &&
        utcHour < 4
      ) ||
      (
        utcHour >= 6 &&
        utcHour < 10
      );

    return {
      isPeak: isPeak,
      reason:
        isPeak
          ? '피크 시간'
          : '일반 시간'
    };
  }

  function isDeepSeekPeakHourNow() {
    return (
      getDeepSeekPeakStateNow()
        .isPeak
    );
  }

  function applyDeepSeekPeakStyle() {
    const row =
      panel.querySelector(
        '#ctb-deepseek-balance-row'
      );

    if (!row) {
      return;
    }

    const peakState =
      getDeepSeekPeakStateNow();

    row.classList.toggle(
      'ctb-deepseek-peak',
      peakState.isPeak
    );

    if (peakState.isPeak) {
      row.title =
        'DeepSeek 피크: 월-금 UTC 01:00-04:00 / 06:00-10:00';
    } else {
      row.title =
        'DeepSeek 오프피크: ' +
        peakState.reason;
    }
  }

  function clampDeepSeekUsageIndex() {
    if (!deepSeekUsageHistory.length) {
      deepSeekUsageIndex = 0;
      return;
    }
    if (deepSeekUsageIndex < 0) deepSeekUsageIndex = 0;
    if (deepSeekUsageIndex > deepSeekUsageHistory.length - 1) {
      deepSeekUsageIndex = deepSeekUsageHistory.length - 1;
    }
  }

  function renderDeepSeekBalanceBox() {
    if (!deepSeekCurrentEl || !deepSeekUsageEl || !deepSeekUsageValueEl) return;

    applyDeepSeekPeakStyle();

    const state = deepSeekBalanceState;

    if (!state || !state.configured) {
      deepSeekCurrentEl.textContent = '$KEY';
      deepSeekCurrentEl.title = '설정창에서 DeepSeek API 키를 저장하세요.';
    } else if (state.status === 'error') {
      deepSeekCurrentEl.textContent = '$ERR';
      deepSeekCurrentEl.title = state.error || 'DeepSeek 잔액 조회 실패';
    } else if (state.status === 'ok') {
      deepSeekCurrentEl.textContent = formatDeepSeekMoney(state.amount, state.currency || 'USD');
      deepSeekCurrentEl.title = 'DeepSeek 현재 잔액' + (state.updatedAt ? ' / ' + formatDeepSeekRecordTime(state.updatedAt) : '');
    } else {
      deepSeekCurrentEl.textContent = '$--';
      deepSeekCurrentEl.title = 'DeepSeek 잔액 대기 중';
    }

    clampDeepSeekUsageIndex();

    const record = deepSeekUsageHistory[deepSeekUsageIndex] || null;
    const fallbackCurrency = state && state.currency ? state.currency : 'USD';

    if (record) {
      deepSeekUsageValueEl.textContent = formatDeepSeekMoney(record.amount, record.currency || fallbackCurrency);
      deepSeekUsageEl.title = formatDeepSeekRecordTime(record.timestamp);
    } else {
      deepSeekUsageValueEl.textContent = formatDeepSeekMoney(0, fallbackCurrency);
      deepSeekUsageEl.title = '기록된 사용금액 없음';
    }

    if (deepSeekPrevBtn) {
      deepSeekPrevBtn.disabled = !deepSeekUsageHistory.length || deepSeekUsageIndex >= deepSeekUsageHistory.length - 1;
    }
    if (deepSeekNextBtn) {
      deepSeekNextBtn.disabled = !deepSeekUsageHistory.length || deepSeekUsageIndex <= 0;
    }
  }

  function applyDeepSeekBalanceResponse(res) {
    if (!res || !res.ok) {
      if (!deepSeekBalanceState) {
        deepSeekBalanceState = {
          configured: false,
          status: 'idle',
          currency: 'USD',
          amount: null
        };
      }
      renderDeepSeekBalanceBox();
      return;
    }
    deepSeekBalanceState = res.state || null;
    deepSeekUsageHistory = Array.isArray(res.history) ? res.history : [];
    clampDeepSeekUsageIndex();
    renderDeepSeekBalanceBox();
  }

  function refreshDeepSeekBalanceBox() {
    try {
      chrome.runtime.sendMessage({ action: 'getDeepSeekBalanceState' }, function(res) {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          renderDeepSeekBalanceBox();
          return;
        }
        applyDeepSeekBalanceResponse(res);
      });
    } catch (e) {
      renderDeepSeekBalanceBox();
    }
  }

  if (deepSeekPrevBtn) {
    deepSeekPrevBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (deepSeekUsageIndex < deepSeekUsageHistory.length - 1) {
        deepSeekUsageIndex += 1;
        renderDeepSeekBalanceBox();
      }
    });
  }

  if (deepSeekNextBtn) {
    deepSeekNextBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (deepSeekUsageIndex > 0) {
        deepSeekUsageIndex -= 1;
        renderDeepSeekBalanceBox();
      }
    });
  }

  refreshDeepSeekBalanceBox();
  applyDeepSeekPeakStyle();
  setInterval(refreshDeepSeekBalanceBox, 15000);
  setInterval(function() {
    applyDeepSeekPeakStyle();
    renderDeepSeekBalanceBox();
  }, 60000);

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function(changes, areaName) {
      if (areaName !== 'local') return;
      if (changes.bridge_deepseek_balance_state || changes.bridge_deepseek_usage_history) {
        if (changes.bridge_deepseek_balance_state) {
          deepSeekBalanceState = changes.bridge_deepseek_balance_state.newValue || null;
        }
        if (changes.bridge_deepseek_usage_history) {
          deepSeekUsageHistory = Array.isArray(changes.bridge_deepseek_usage_history.newValue)
            ? changes.bridge_deepseek_usage_history.newValue
            : [];
        }
        clampDeepSeekUsageIndex();
        renderDeepSeekBalanceBox();
      }
    });
  }
  const AI_SOURCE_COLORS = { chatgpt: '#10A37F', claude: '#D97757', gemini: '#EA4335' };
  let aiSourceTarget = null;
  const aiSourceSelect = panel.querySelector('#ctb-ai-source-select');
  const aiCurrentTabLabel = panel.querySelector('#ctb-ai-current-tab-label');
  const isCurrentPageAI = SITE === 'chatgpt' || SITE === 'claude' || SITE === 'gemini';
  const applyAISource = function(tabInfo) {
    aiSourceTarget = tabInfo;
    renderTelegramQueueButton();
  };

  function getSelectedAISourceTabId() {
    if (aiSourceSelect && aiSourceSelect.value) {
      return Number(aiSourceSelect.value);
    }
    return aiSourceTarget ? aiSourceTarget.id : null;
  }

  function getSelectedAISource() {
    /*
     * AI 사이트 자체에서 버튼을 누른 경우에는
     * 현재 탭이 source다.
     *
     * id:null은 background에서 sender.tab을 사용하라는 뜻이며,
     * sender가 AI URL일 때만 허용된다.
     */
    if (isCurrentPageAI) {
      return {
        id: null,
        url: location.href,
        title:
          document.title ||
          SITE_NAME ||
          ''
      };
    }

    /*
     * Telegram 페이지에서는 select에서 사용자가 선택한
     * 실제 AI tab만 source가 될 수 있다.
     */
    if (
      !aiSourceSelect ||
      aiSourceSelect.selectedIndex < 0
    ) {
      return null;
    }

    const selected =
      aiSourceSelect.options[
        aiSourceSelect.selectedIndex
      ];

    if (
      !selected ||
      !selected.value
    ) {
      return null;
    }

    const id =
      Number(selected.value);

    const url =
      String(
        selected.dataset.url || ''
      );

    const title =
      String(
        selected.title ||
        selected.textContent ||
        ''
      );

    if (
      !Number.isFinite(id) ||
      id <= 0
    ) {
      return null;
    }

    let validAiUrl = false;

    try {
      const parsed =
        new URL(url);

      validAiUrl =
        parsed.protocol === 'https:' &&
        (
          parsed.hostname ===
            'chatgpt.com' ||
          parsed.hostname ===
            'chat.openai.com' ||
          parsed.hostname ===
            'claude.ai' ||
          parsed.hostname ===
            'gemini.google.com'
        );
    } catch (e) {
      validAiUrl = false;
    }

    if (!validAiUrl) {
      return null;
    }

    return {
      id: id,
      url: url,
      title: title
    };
  }

  function updateAISourcePanelUI() {
    if (isCurrentPageAI) {
      if (aiSourceSelect) {
        aiSourceSelect.style.display = 'none';
      }
      if (aiCurrentTabLabel) {
        var currentTitle = document.title || SITE_NAME || '현재 AI 탭';
        aiCurrentTabLabel.style.display = 'block';
        aiCurrentTabLabel.textContent = currentTitle;
        aiCurrentTabLabel.title = currentTitle;
      }
      return;
    }
    if (aiSourceSelect) {
      aiSourceSelect.style.display = '';
    }
    if (aiCurrentTabLabel) {
      aiCurrentTabLabel.style.display = 'none';
      aiCurrentTabLabel.textContent = '';
      aiCurrentTabLabel.title = '';
    }
  }

  const refreshAiSourceTabs = function(done) {
    try {
      chrome.runtime.sendMessage({ action: 'getAiTabs' }, function(res) {
        if (!res || !res.tabs || !res.tabs.length) {
          aiSourceSelect.innerHTML = '<option value="">AI 탭 없음</option>';
          applyAISource(null);
          updateAISourcePanelUI();
          if (typeof done === 'function') done();
          return;
        }
        var tabs = res.tabs;
        var previousTargetId = aiSourceTarget ? Number(aiSourceTarget.id) : null;
        var senderTabId = res.senderTabId ? Number(res.senderTabId) : null;
        aiSourceSelect.innerHTML = '';
        tabs.forEach(function(t) {
          var site = 'ai', siteName = 'AI';
          if (t.url.indexOf('chatgpt.com') >= 0 || t.url.indexOf('chat.openai.com') >= 0) { site = 'chatgpt'; siteName = 'ChatGPT'; }
          else if (t.url.indexOf('claude.ai') >= 0) { site = 'claude'; siteName = 'Claude'; }
          else if (t.url.indexOf('gemini.google.com') >= 0) { site = 'gemini'; siteName = 'Gemini'; }
          var o = document.createElement('option');
          o.value = String(t.id); o.textContent = t.title || siteName;
          o.title = t.title || siteName;
          o.dataset.site = site; o.dataset.siteName = siteName;
          o.dataset.url = t.url || '';
          aiSourceSelect.appendChild(o);
        });
        var selectedTabId = null;
        if (isCurrentPageAI && senderTabId && tabs.some(function(tx) { return Number(tx.id) === senderTabId; })) {
          selectedTabId = senderTabId;
        } else if (previousTargetId && tabs.some(function(tx) { return Number(tx.id) === previousTargetId; })) {
          selectedTabId = previousTargetId;
        } else {
          selectedTabId = Number(tabs[0].id);
        }
        aiSourceSelect.value = String(selectedTabId);
        var selectedOption = Array.from(aiSourceSelect.options).find(function(x) { return Number(x.value) === selectedTabId; });
        var selectedTab = tabs.find(function(x) { return Number(x.id) === selectedTabId; });
        if (selectedOption && selectedTab) {
          applyAISource({ site: selectedOption.dataset.site, siteName: selectedOption.dataset.siteName, title: selectedTab.title || selectedOption.textContent, id: selectedTab.id, url: selectedTab.url || '' });
        }
        updateAISourcePanelUI();
        if (typeof done === 'function') done();
      });
    } catch(e) {
      aiSourceSelect.innerHTML = '<option value="">AI 탭 오류</option>';
      applyAISource(null);
      updateAISourcePanelUI();
      if (typeof done === 'function') done();
    }
  };

  refreshAiSourceTabs();
  registerBridgeRefreshHandler('aiSource', refreshAiSourceTabs);
  aiSourceSelect.addEventListener('change', function() {
    if (telegramSendQueued) {
      cancelTelegramSendQueue(
        '예약 취소 · AI 대상 변경'
      );
    }

    const selected = this.options[this.selectedIndex];

    if (selected && selected.value) {
      applyAISource({
        site: selected.dataset.site,
        siteName: selected.dataset.siteName,
        title: selected.title || selected.textContent,
        id: Number(selected.value),
        url: selected.dataset.url || ''
      });
    } else {
      applyAISource(null);
    }

    _prevStreaming = null;
    checkStreaming();
  });
  chrome.storage.local.get(['bridge_autosend_ai'], (res) => {
    if (res?.bridge_autosend_ai !== undefined) autoCheck.checked = res.bridge_autosend_ai;
  });
  autoCheck.addEventListener('change', () => {
    chrome.storage.local.set({ bridge_autosend_ai: autoCheck.checked });
  });
  chrome.storage.local.get(['bridge_auto_return_enabled'], (res) => {
    autoReturnCheck.checked =
      res?.bridge_auto_return_enabled !== false;
  });
  autoReturnCheck.addEventListener('change', () => {
    chrome.storage.local.set({
      bridge_auto_return_enabled:
        autoReturnCheck.checked
    });
  });
  const setStatus = (msg, type) => setPanelStatus(statusEl, msg, type);
  const setBtnsDisabled = (v) => setPanelBtnsDisabled([btn1], v);

  function applyAutoReturnRouteStatus(routes) {
    if (SITE !== 'chatgpt' || !Array.isArray(routes)) return;

    const currentUrl =
      normalizeAutoReturnConversationUrl(location.href);
    const route = routes
      .filter(function(item) {
        return (
          item?.sourceConversationUrl === currentUrl &&
          item.routingVersion === '059-3' &&
          item.autoReturn === true
        );
      })
      .sort(function(a, b) {
        return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
      })[0];

    if (!route) return;
    const view = getAutoReturnRouteStatusView(route.status);
    if (!view) return;

    setStatus(view[0], view[1]);

    if (
      route.status === 'ambiguous' ||
      route.status === 'delivery_failed'
    ) {
      console.warn('[CTB auto return route]', {
        routeId: route.routeId,
        stage: route.stage,
        jobId: route.jobId,
        status: route.status,
        error: route.error || ''
      });
    }
  }

  function refreshAutoReturnRouteStatus() {
    chrome.storage.local.get(
      ['bridge_auto_return_routes'],
      function(res) {
        applyAutoReturnRouteStatus(
          res?.bridge_auto_return_routes
        );
      }
    );
  }

  chrome.storage.onChanged.addListener(
    function(changes, areaName) {
      if (
        areaName === 'local' &&
        changes?.bridge_auto_return_routes
      ) {
        applyAutoReturnRouteStatus(
          changes.bridge_auto_return_routes.newValue
        );
      }
    }
  );

  refreshAutoReturnRouteStatus();

  let telegramSendQueued = false;
  let telegramSendQueueSending = false;
  let telegramSendQueueSource = null;
  let telegramSendQueueAutoSend = true;
  let telegramSendQueueAutoReturn = true;

  function renderTelegramQueueButton() {
    if (telegramSendQueued) {
      btn1.textContent = '⏱ Telegram 예약중';

      btn1.style.setProperty(
        'background',
        '#FFFFFF',
        'important'
      );

      btn1.style.setProperty(
        'color',
        '#2AABEE',
        'important'
      );

      btn1.style.setProperty(
        'border',
        '1px solid #2AABEE',
        'important'
      );

      btn1.title =
        'AI 응답 완료 후 Telegram으로 자동 전송합니다. 다시 누르면 예약을 취소합니다.';

      return;
    }

    btn1.textContent = '📤 → Telegram';

    btn1.style.removeProperty('background');
    btn1.style.removeProperty('color');
    btn1.style.removeProperty('border');

    if (aiSourceTarget) {
      btn1.title =
        (aiSourceTarget.siteName || 'AI') +
        ' - ' +
        (aiSourceTarget.title || '');
    } else {
      btn1.title = '';
    }
  }

  function cancelTelegramSendQueue(message) {
    if (!telegramSendQueued) {
      return;
    }

    telegramSendQueued = false;
    telegramSendQueueSending = false;
    telegramSendQueueSource = null;

    renderTelegramQueueButton();

    if (message) {
      setStatus(message, 'ok');
    }
  }

  function queueTelegramSend(
    sourceAi,
    autoSend,
    autoReturn
  ) {
    telegramSendQueued = true;
    telegramSendQueueSending = false;

    telegramSendQueueSource = sourceAi
      ? {
          id: sourceAi.id ? Number(sourceAi.id) : null,
          url: sourceAi.url || '',
          title: sourceAi.title || ''
        }
      : null;

    telegramSendQueueAutoSend =
      !!autoSend;

    telegramSendQueueAutoReturn =
      !!autoReturn;

    renderTelegramQueueButton();

    setStatus(
      '⏱ Telegram 전송 예약됨'
    );
  }

  function sendAiResponseToTelegram(options) {
    const opts = options || {};

    const sourceAi =
      Object.prototype.hasOwnProperty.call(
        opts,
        'sourceAi'
      )
        ? opts.sourceAi
        : getSelectedAISource();

    if (!sourceAi) {
      setStatus('❌ 선택한 AI 탭을 찾을 수 없습니다.', 'err');
      return;
    }

    const autoSend =
      Object.prototype.hasOwnProperty.call(
        opts,
        'autoSend'
      )
        ? !!opts.autoSend
        : autoCheck.checked;

    const queued = !!opts.queued;

    const autoReturn =
      Object.prototype.hasOwnProperty.call(
        opts,
        'autoReturn'
      )
        ? !!opts.autoReturn
        : autoReturnCheck.checked;

    if (queued) {
      if (
        !telegramSendQueued ||
        telegramSendQueueSending
      ) {
        return;
      }

      telegramSendQueueSending = true;
    }

    setBtnsDisabled(true);

    setStatus(
      queued
        ? '⏳ 예약 전송 중...'
        : '⏳ 처리 중...'
    );

    chrome.runtime.sendMessage(
      {
        action: 'aiToTelegram',
        autoSend: autoSend,
        autoReturn: autoReturn,
        sourceAiTabId: sourceAi.id,
        sourceAiUrl: sourceAi.url,
        sourceAiTitle: sourceAi.title
      },
      function(res) {
        setBtnsDisabled(false);

        const runtimeError =
          chrome.runtime.lastError;

        if (queued) {
          telegramSendQueueSending = false;
        }

        if (runtimeError) {
          if (queued) {
            telegramSendQueued = false;
            telegramSendQueueSource = null;
            renderTelegramQueueButton();
          }

          setStatus(
            '❌ ' + runtimeError.message,
            'err'
          );

          return;
        }

        if (res?.ok) {
          if (queued) {
            telegramSendQueued = false;
            telegramSendQueueSource = null;
            renderTelegramQueueButton();
          }

          setStatus(
            res.autoReturnReserved
              ? (
                  queued
                    ? '✅ 예약 Telegram 전송! · GPT 회신 예약'
                    : '✅ Telegram 전송! · GPT 회신 예약'
                )
              : (
                  res.autoReturnFailed
                    ? '⚠️ Telegram 전송됨 · 회신 예약 실패'
                    : (
                        queued
                          ? '✅ 예약 Telegram 전송!'
                          : '✅ Telegram 전송!'
                      )
                ),
            'ok'
          );

          if (res.autoReturnReserved) {
            setTimeout(
              refreshAutoReturnRouteStatus,
              400
            );
          }

          return;
        }

        const errorMessage =
          res?.error || '실패';

        const displayedError =
          SITE === 'chatgpt' &&
          /AI 응답을 찾을 수 없어요/.test(
            errorMessage
          ) &&
          window.__ctbLastResponseDiagnostic
            ? window.__ctbLastResponseDiagnostic
            : errorMessage;

        if (
          queued &&
          telegramSendQueued &&
          /아직\s*답변\s*중/.test(
            errorMessage
          )
        ) {
          setStatus(
            '⏱ 완료 확인 중...'
          );

          setTimeout(
            function() {
              if (
                !telegramSendQueued ||
                telegramSendQueueSending
              ) {
                return;
              }

              sendAiResponseToTelegram({
                queued: true,
                sourceAi:
                  telegramSendQueueSource,
                autoSend:
                  telegramSendQueueAutoSend,
                autoReturn:
                  telegramSendQueueAutoReturn
              });
            },
            1500
          );

          return;
        }

        if (queued) {
          telegramSendQueued = false;
          telegramSendQueueSource = null;
          renderTelegramQueueButton();
        }

      setStatus(
        '❌ ' + displayedError,
        'err'
      );
      }
    );
  }

  // ── AI → Telegram ──
  btn1.addEventListener(
    'click',
    function() {
      if (telegramSendQueued) {
        cancelTelegramSendQueue(
          '예약 취소됨'
        );

        return;
      }

      const autoSend =
        autoCheck.checked;

      const autoReturn =
        autoReturnCheck.checked;

      const sourceAi = getSelectedAISource();

      if (!sourceAi) {
        setStatus('❌ 선택한 AI 탭을 찾을 수 없습니다.', 'err');
        return;
      }

      if (isCurrentPageAI) {
        let currentlyStreaming =
          _streaming;

        try {
          currentlyStreaming =
            !!isStreaming();
        } catch (e) {
          currentlyStreaming =
            _streaming;
        }

        if (currentlyStreaming) {
          queueTelegramSend(
            sourceAi,
            autoSend,
            autoReturn
          );

          return;
        }

        sendAiResponseToTelegram({
          sourceAi: sourceAi,
          autoSend: autoSend,
          autoReturn: autoReturn,
          queued: false
        });

        return;
      }

      setBtnsDisabled(true);

      setStatus(
        '⏳ 상태 확인 중...'
      );

      chrome.runtime.sendMessage(
        {
          action: 'checkAiTabStreaming',
          sourceAiTabId: sourceAi.id,
          sourceAiUrl: sourceAi.url,
          sourceAiTitle: sourceAi.title
        },
        function(res) {
          setBtnsDisabled(false);

          const runtimeError =
            chrome.runtime.lastError;

          if (runtimeError) {
            setStatus(
              '❌ ' +
              runtimeError.message,
              'err'
            );

            return;
          }

          if (!res || !res.ok) {
            setStatus(
              '❌ ' +
              (
                res?.error ||
                'AI 상태를 확인할 수 없어요.'
              ),
              'err'
            );

            return;
          }

          if (res.streaming) {
            queueTelegramSend(
              {
                id: res.tabId,
                url: res.url || sourceAi.url,
                title: res.title || sourceAi.title
              },
              autoSend,
              autoReturn
            );

            return;
          }

          sendAiResponseToTelegram({
            sourceAi: {
              id: res.tabId,
              url: res.url || sourceAi.url,
              title: res.title || sourceAi.title
            },
            autoSend: autoSend,
            autoReturn: autoReturn,
            queued: false
          });
        }
      );
    }
  );

  // ── 위젯 스위치 ──
  panel.querySelector('#ctb-ai-switch').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOtherWidget();
  });

  // ── AI 작성 중 감지 ──
  var _streaming = false;
  var _prevStreaming = null;
  var _streamingCheckBusy = false;
  var _streamingFalseSince = 0;
  const STREAMING_COMPLETE_STABLE_MS = 3000;

  function applyStreamingPanelState(streaming) {
    _streaming = streaming;

    if (streaming) {
      if (telegramSendQueued) {
        setStatus(
          '⏱ Telegram 전송 예약됨'
        );
      } else {
        setStatus(
          '⏳ 작성 중...'
        );
      }

      panel.style.background = '#ffffff';
      panel.style.borderColor = '#d0d0d0';

      return;
    }

    if (telegramSendQueued) {
      setStatus(
        '⏳ 예약 전송 준비...'
      );
    } else {
      setStatus(
        '✅ 완료'
      );
    }

    panel.style.background = '#1a1a2e';
    panel.style.borderColor = '#3a3a5c';
  }

  function updateStreamingState(streaming) {
    const rawStreaming = !!streaming;
    const now = Date.now();

    if (rawStreaming) {
      _streamingFalseSince = 0;
    } else if (_prevStreaming === true) {
      if (!_streamingFalseSince) {
        _streamingFalseSince = now;
        return;
      }

      if (now - _streamingFalseSince < STREAMING_COMPLETE_STABLE_MS) {
        return;
      }
    } else {
      _streamingFalseSince = 0;
    }

    const nextStreaming = rawStreaming;
    const wasStreaming = _prevStreaming === true;

    if (nextStreaming === _prevStreaming) return;

    _prevStreaming = nextStreaming;
    applyStreamingPanelState(nextStreaming);

    if (wasStreaming && !nextStreaming) {
      const bridgeAiNotifyHost = String(location.hostname || '');
      const bridgeAiNotifyIsAiPage =
        bridgeAiNotifyHost === 'chatgpt.com' ||
        bridgeAiNotifyHost === 'chat.openai.com' ||
        bridgeAiNotifyHost === 'claude.ai' ||
        bridgeAiNotifyHost === 'gemini.google.com';

      const bridgeAiNotifyNow = Date.now();
      const bridgeAiNotifyLastAt =
        Number(updateStreamingState.__bridgeAiNotifyLastAt || 0);

      if (
        bridgeAiNotifyIsAiPage &&
        bridgeAiNotifyNow - bridgeAiNotifyLastAt >= 10000 &&
        typeof chrome !== 'undefined' &&
        chrome.runtime &&
        chrome.runtime.sendMessage
      ) {
        updateStreamingState.__bridgeAiNotifyLastAt = bridgeAiNotifyNow;

        setTimeout(() => {
          chrome.runtime.sendMessage({
            action: 'bridgeNotifyComplete',
            type: 'ai',
            title: 'AI 응답 완료',
            message: 'AI 응답 생성이 완료되었습니다. 클릭하면 해당 탭으로 이동합니다.'
          }, () => {
            void chrome.runtime.lastError;
          });
        }, 350);
      }

      if (
        telegramSendQueued &&
        !telegramSendQueueSending
      ) {
        const queuedSourceAi =
          telegramSendQueueSource;

        const queuedAutoSend =
          telegramSendQueueAutoSend;

        const queuedAutoReturn =
          telegramSendQueueAutoReturn;

        setTimeout(
          function() {
            if (
              !telegramSendQueued ||
              telegramSendQueueSending
            ) {
              return;
            }

            sendAiResponseToTelegram({
              queued: true,
              sourceAi:
                queuedSourceAi,
              autoSend:
                queuedAutoSend,
              autoReturn:
                queuedAutoReturn
            });
          },
          350
        );
      }
    }
  }

  function checkStreaming() {
    if (isCurrentPageAI) {
      var localStreaming = false;
      try {
        localStreaming = isStreaming();
      } catch (e) {
        localStreaming = false;
      }
      updateStreamingState(localStreaming);
      return;
    }

    if (_streamingCheckBusy) return;
    _streamingCheckBusy = true;

    var selectedAiSource =
      telegramSendQueued && telegramSendQueueSource
        ? telegramSendQueueSource
        : getSelectedAISource();
    var selectedAiTabId = selectedAiSource?.id || null;
    console.log('[AI-STREAM-REMOTE] selectedAiTabId=', selectedAiTabId, 'aiSourceTarget=', aiSourceTarget ? aiSourceTarget.id : null);

    try {
      chrome.runtime.sendMessage({
        action: 'checkAiTabStreaming',
        sourceAiTabId: selectedAiTabId,
        sourceAiUrl: selectedAiSource?.url || '',
        sourceAiTitle: selectedAiSource?.title || ''
      }, function(res) {
        var runtimeError = chrome.runtime.lastError;

        _streamingCheckBusy = false;

        if (runtimeError) {
          console.log('[AI-STREAM-REMOTE-ERR]', runtimeError.message);
          return;
        }

        console.log('[AI-STREAM-REMOTE-RES]', res);

        if (!res || !res.ok) {
          return;
        }

        updateStreamingState(!!res.streaming);
      });
    } catch (e) {
      console.log('[AI-STREAM-REMOTE-THROW]', e && e.message ? e.message : e);
      _streamingCheckBusy = false;
    }
  }

  checkStreaming();
  setInterval(checkStreaming, 1500);

  syncBridgeTargetPickerVisibility();
}

// ────────────────────────────────────────
// TG 위젯 (TG→AI 전용)
// ────────────────────────────────────────
function injectTGWidget() {
  if (document.getElementById('ctb-tg-panel')) return;

  // CSS 주입 (최초 1회)
  if (!document.getElementById('ctb-bridge-style')) {
    const style = document.createElement('style');
    style.id = 'ctb-bridge-style';
    style.textContent = PANEL_STYLES;
    document.head.appendChild(style);
  }

  const panel = document.createElement('div');
  panel.id = 'ctb-tg-panel';
  panel.innerHTML = `
    <div id="ctb-tg-title">
      <span id="ctb-tg-title-text">📥 → AI</span>
      <div id="ctb-tg-controls">
        <button id="ctb-tg-minimize" title="최소화">−</button>
        <button id="ctb-tg-refresh" title="새로고침">↺</button>
        <button id="ctb-tg-close" title="닫기">✕</button>
      </div>
    </div>
    <div id="ctb-body">
      <button id="ctb-tg-btn2" class="ctb-btn">📥 → GPT</button>
      <div id="ctb-tgmode-row">
        <button id="ctb-tgmode-all" class="ctb-mode-btn ctb-mode-active">답변전체</button>
        <button id="ctb-tgmode-last" class="ctb-mode-btn">마지막1개</button>
      </div>
      <select id="ctb-ai-select" style="width:100%;margin-bottom:5px;padding:2px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;"><option value="">탭 목록 받는 중...</option></select>
      <div id="ctb-tg-current-tab-label" style="display:none;width:100%;margin-bottom:5px;padding:3px 4px;font-size:9px;background:#2a2a55;color:#a78bfa;border:1px solid #3a3a5c;border-radius:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div><label id="ctb-tg-autosend-label" style="display:flex !important;align-items:center;gap:4px;margin-top:2px;cursor:pointer">
        <input type="checkbox" id="ctb-tg-autosend" checked style="width:13px;height:13px;opacity:1;display:inline;flex-shrink:0;position:static;appearance:auto;accent-color:#2AABEE" />
        <span>전송까지 자동으로</span>
      </label>
      <button id="ctb-tg-switch" class="ctb-switch-btn">🔁 위젯 전환</button>
      <div id="ctb-status"></div>
    </div>
    <span class="ctb-runtime-build">${CTB_RUNTIME_BUILD}</span>
  `;

  document.body.appendChild(panel);

  panel.dataset.ctbUiState =
    'normal';

  panel.dataset.ctbRouteVisible =
    'false';

  makeDraggable(
    panel,
    '#ctb-tg-title',
    'widgetPos_tg'
  );

  // ── 최소화/복원 ──
  let isMinimized = false;

  const bodyEl =
    panel.querySelector(
      '#ctb-body'
    );

  const controlsEl =
    panel.querySelector(
      '#ctb-tg-controls'
    );

  const titleTextEl =
    panel.querySelector(
      '#ctb-tg-title-text'
    );

  const titleEl =
    panel.querySelector(
      '#ctb-tg-title'
    );

  function applyTGMinimizedVisual() {
    isMinimized = true;

    bodyEl.style.display =
      'none';

    controlsEl.style.display =
      'none';

    panel.style.setProperty(
      'width',
      '36px',
      'important'
    );

    panel.style.height =
      '36px';

    panel.style.setProperty(
      'border-radius',
      '50%',
      'important'
    );

    panel.style.setProperty(
      'padding',
      '0',
      'important'
    );

    panel.style.justifyContent =
      'center';

    panel.style.alignItems =
      'center';

    panel.style.cursor =
      'pointer';

    titleEl.style.marginBottom =
      '0';

    titleEl.style.cursor =
      'pointer';

    titleTextEl.style.fontSize =
      '18px';

    titleTextEl.textContent =
      '📥';
  }

  function applyTGNormalVisual() {
    isMinimized = false;

    bodyEl.style.display =
      '';

    controlsEl.style.display =
      '';

    panel.style.setProperty(
      'width',
      '110px',
      'important'
    );

    panel.style.height =
      '';

    panel.style.setProperty(
      'border-radius',
      '12px',
      'important'
    );

    panel.style.setProperty(
      'padding',
      '9px 10px',
      'important'
    );

    panel.style.justifyContent =
      '';

    panel.style.alignItems =
      '';

    panel.style.cursor =
      '';

    titleEl.style.marginBottom =
      '7px';

    titleEl.style.cursor =
      'grab';

    titleTextEl.style.fontSize =
      '10px';

    titleTextEl.textContent =
      '📥 → AI';
  }

  panel.__ctbApplyVisualState =
    function(state) {
      if (state === 'minimized') {
        applyTGMinimizedVisual();
      } else {
        applyTGNormalVisual();
      }
    };

  panel
    .querySelector(
      '#ctb-tg-minimize'
    )
    .addEventListener(
      'click',
      function(e) {
        e.stopPropagation();

        setPanelUiState(
          panel,
          'widgetUiState_tg',
          'minimized',
          true
        );
      }
    );

  panel.querySelector('#ctb-tg-refresh').addEventListener('click', (e) => {
    e.stopPropagation();
    runBridgeRefreshHandler('tgTarget', function() {
      syncBridgeTargetPickerVisibility();
      setStatus('\u21BA \uC0C8\uB85C\uACE0\uCE68 \uC644\uB8CC', 'ok');
    });
  });

  panel.addEventListener(
    'click',
    function() {
      if (
        panel.dataset.ctbUiState ===
        'minimized'
      ) {
        setPanelUiState(
          panel,
          'widgetUiState_tg',
          'normal',
          true
        );
      }
    }
  );

  panel
    .querySelector(
      '#ctb-tg-close'
    )
    .addEventListener(
      'click',
      function(e) {
        e.stopPropagation();

        setPanelUiState(
          panel,
          'widgetUiState_tg',
          'closed',
          true
        );
      }
    );

  // ── AI 탭 동적 선택 ──
  const SITE_COLORS = { chatgpt: '#10A37F', claude: '#D97757', gemini: '#EA4335' };
  let aiTarget = null;
  const aiSelect = panel.querySelector('#ctb-ai-select');
  const tgCurrentTabLabel = panel.querySelector('#ctb-tg-current-tab-label');
  const tgBtn2 = panel.querySelector('#ctb-tg-btn2');
  const isCurrentPageAIForTG = SITE === 'chatgpt' || SITE === 'claude' || SITE === 'gemini';
  var applyAI = function(tabInfo) {
    aiTarget = tabInfo;
    var siteName = tabInfo ? (tabInfo.siteName || 'AI') : 'AI';
    tgBtn2.textContent = '\u{1F4E5} \u2192 ' + siteName;
    tgBtn2.style.background = tabInfo && SITE_COLORS[tabInfo.site] ? SITE_COLORS[tabInfo.site] : '#a78bfa';
    tgBtn2.title = tabInfo ? tabInfo.title : '';
  };
  var updateTGTargetPanelUI = function() {
    if (isCurrentPageAIForTG) {
      if (aiSelect) aiSelect.style.display = 'none';
      if (tgCurrentTabLabel) {
        var currentTitle = document.title || SITE_NAME || '현재 AI 탭';
        tgCurrentTabLabel.style.display = 'block';
        tgCurrentTabLabel.textContent = currentTitle;
        tgCurrentTabLabel.title = currentTitle;
      }
    } else {
      if (aiSelect) aiSelect.style.display = '';
      if (tgCurrentTabLabel) { tgCurrentTabLabel.style.display = 'none'; tgCurrentTabLabel.textContent = ''; tgCurrentTabLabel.title = ''; }
    }
  };

  var refreshAiTabs = function() {
    try {
      chrome.runtime.sendMessage({ action: 'getAiTabs' }, function(res) {
        if (!res || !res.tabs || !res.tabs.length) {
          aiSelect.innerHTML = '<option value="">AI 탭 없음</option>';
          applyAI(null);
          updateTGTargetPanelUI();
          return;
        }
        var tabs = res.tabs;
        var previousTargetId = aiTarget ? Number(aiTarget.id) : null;
        var senderTabId = res.senderTabId ? Number(res.senderTabId) : null;
        aiSelect.innerHTML = '';
        tabs.forEach(function(t) {
          var site = 'ai', siteName = 'AI';
          if (t.url.indexOf('chatgpt.com') >= 0 || t.url.indexOf('chat.openai.com') >= 0) { site = 'chatgpt'; siteName = 'ChatGPT'; }
          else if (t.url.indexOf('claude.ai') >= 0) { site = 'claude'; siteName = 'Claude'; }
          else if (t.url.indexOf('gemini.google.com') >= 0) { site = 'gemini'; siteName = 'Gemini'; }
          var o = document.createElement('option');
          o.value = String(t.id); o.textContent = t.title || siteName;
          o.title = t.title || siteName;
          o.dataset.site = site; o.dataset.siteName = siteName;
          aiSelect.appendChild(o);
        });
        var selectedTabId = null;
        if (isCurrentPageAIForTG && senderTabId && tabs.some(function(tx) { return Number(tx.id) === senderTabId; })) {
          selectedTabId = senderTabId;
        } else if (previousTargetId && tabs.some(function(tx) { return Number(tx.id) === previousTargetId; })) {
          selectedTabId = previousTargetId;
        } else {
          selectedTabId = Number(tabs[0].id);
        }
        aiSelect.value = String(selectedTabId);
        var selectedOption = Array.from(aiSelect.options).find(function(x) { return Number(x.value) === selectedTabId; });
        var selectedTab = tabs.find(function(x) { return Number(x.id) === selectedTabId; });
        if (selectedOption && selectedTab) {
          applyAI({ site: selectedOption.dataset.site, siteName: selectedOption.dataset.siteName, title: selectedTab.title || selectedOption.textContent, id: selectedTab.id });
        }
        updateTGTargetPanelUI();
      });
    } catch(e) {
      aiSelect.innerHTML = '<option value="">AI 탭 오류</option>';
      applyAI(null);
      updateTGTargetPanelUI();
    }
  };

  refreshAiTabs();
  registerBridgeRefreshHandler('tgTarget', refreshAiTabs);

  aiSelect.addEventListener('change', function() {
    var sel = this.options[this.selectedIndex];
    if (sel && sel.value) {
      applyAI({ site: sel.dataset.site, siteName: sel.dataset.siteName, title: sel.title || sel.textContent, id: Number(sel.value) });
    }
  });


  // ── TG→AI 모드 토글 ──
  const modAllBtn = panel.querySelector('#ctb-tgmode-all');
  const modLastBtn = panel.querySelector('#ctb-tgmode-last');
  const applyTGMode = (mode) => {
    if (mode === 'all') {
      tgCopyMode = 'all';
      modAllBtn.classList.add('ctb-mode-active');
      modLastBtn.classList.remove('ctb-mode-active');
    } else {
      tgCopyMode = 'last';
      modLastBtn.classList.add('ctb-mode-active');
      modAllBtn.classList.remove('ctb-mode-active');
    }
  };
  chrome.storage.local.get(['bridge_tgmode'], (res) => {
    if (res?.bridge_tgmode) applyTGMode(res.bridge_tgmode);
  });
  modAllBtn.addEventListener('click', () => {
    tgCopyMode = 'all'; chrome.storage.local.set({ bridge_tgmode: 'all' });
    modAllBtn.classList.add('ctb-mode-active');
    modLastBtn.classList.remove('ctb-mode-active');
  });
  modLastBtn.addEventListener('click', () => {
    tgCopyMode = 'last'; chrome.storage.local.set({ bridge_tgmode: 'last' });
    modLastBtn.classList.add('ctb-mode-active');
    modAllBtn.classList.remove('ctb-mode-active');
  });

  // ── 상태 표시 ──
  const statusEl = panel.querySelector('#ctb-status');
  const btn2 = panel.querySelector('#ctb-tg-btn2');
  const autoCheck = panel.querySelector('#ctb-tg-autosend');
  chrome.storage.local.get(['bridge_autosend_tg'], (res) => {
    if (res?.bridge_autosend_tg !== undefined) autoCheck.checked = res.bridge_autosend_tg;
  });
  autoCheck.addEventListener('change', () => {
    chrome.storage.local.set({ bridge_autosend_tg: autoCheck.checked });
  });
  const setStatus = (msg, type) => setPanelStatus(statusEl, msg, type);
  const setBtnsDisabled = (v) => setPanelBtnsDisabled([btn2], v);

  // ── CHECKBOX 진단 ──
  const tgChk = panel.querySelector('#ctb-tg-autosend');
  if (tgChk) {
    const r = tgChk.getBoundingClientRect();
    const cs = getComputedStyle(tgChk);
    console.log('[TG-CHK] found=', !!tgChk, 'rect=', r.width, r.height, 'display=', cs.display, 'visibility=', cs.visibility, 'opacity=', cs.opacity, 'position=', cs.position);
  } else {
    console.log('[TG-CHK] NOT FOUND in panel!');
  }

  // ── Telegram → AI ──
  btn2.addEventListener('click', () => {
    const autoSend = autoCheck.checked;
    setBtnsDisabled(true);
    setStatus('⏳ 처리 중...');
    chrome.runtime.sendMessage({ action: 'telegramToAI', autoSend, tgCopyMode, aiTarget, targetTabId: isCurrentPageAIForTG ? null : (aiTarget ? aiTarget.id : null) }, (res) => {
      setBtnsDisabled(false);
      if (chrome.runtime.lastError) { setStatus(`❌ ${chrome.runtime.lastError.message}`, 'err'); return; }
      if (res?.ok) setStatus(autoSend ? '✅ AI 전송!' : '✅ AI 입력!', 'ok');
      else         setStatus(`❌ ${res?.error || '실패'}`, 'err');
    });
  });

  // ── 위젯 스위치 ──
  panel.querySelector('#ctb-tg-switch').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOtherWidget();
  });

  syncBridgeTargetPickerVisibility();
}

// ────────────────────────────────────────
// 토큰 카운터
// ────────────────────────────────────────
function injectTokenCounter() {
  if (document.getElementById('ctb-token-counter')) return;
  const counter = document.createElement('div');
  counter.id = 'ctb-token-counter';
  document.body.appendChild(counter);

  function update() {
    const input = getInputEl();
    if (!input) { counter.textContent = ''; return; }
    const rect   = input.getBoundingClientRect();
    const text   = input.innerText || input.value || '';
    const tokens = estimateTokens(text);
    if (!text.trim()) { counter.textContent = ''; return; }
    counter.style.left = (rect.right - 65 + window.scrollX) + 'px';
    counter.style.top  = (rect.bottom - 18 + window.scrollY) + 'px';
    counter.textContent = `~${tokens} tokens`;
    counter.className = tokens > 3000 ? 'danger' : tokens > 1500 ? 'warn' : '';
  }

  document.addEventListener('input', update, true);
  setInterval(update, 800);
}

// ────────────────────────────────────────
// 메시지 리스너
// ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'getResponse') {
    if (SITE === 'telegram') {
      sendResponse({
        text: null,
        error:
          'telegram_cannot_be_ai_source',
        sourceSite: 'telegram',
        sourceUrl: location.href
      });

      return true;
    }

    /*
     * ChatGPT 코드 모드는 background가
     * 실제 코드박스 Copy 버튼을 눌러 원문을 확보한다.
     */
    if (
      SITE === 'chatgpt' &&
      copyMode === 'code'
    ) {
      sendResponse({
        text: null,
        useNativeCodeCopy: true,
        sourceSite: SITE,
        sourceUrl: location.href
      });

      return true;
    }

    sendResponse({
      text: getResponse(),
      useNativeCodeCopy: false,
      sourceSite: SITE,
      sourceUrl: location.href
    });

    return true;
  }
  if (msg.action === 'checkStreaming') {
    sendResponse({ streaming: isStreaming() });
    return true;
  }
  if (msg.action === 'pasteToAI') {
    pasteToAI(msg.text, msg.autoSend).then(sendResponse);
    return true;
  }
  if (msg.action === 'getTelegramMessage') {
    sendResponse({ text: telegram_getMessageForMode(msg.tgCopyMode || 'all') });
    return true;
  }
  if (msg.action === 'getTelegramRouteContext') {
    sendResponse(
      telegram_getRouteContext()
    );
    return true;
  }
  if (msg.action === 'sendToTelegram') {
    telegram_sendWholeTextOnce(
      msg.text,
      msg.autoSend
    ).then(sendResponse);
    return true;
  }
});

// ── 위젯 스위치 탭 간 동기화 ──
chrome.storage.onChanged.addListener((changes) => {
  if (changes?.bridge_mode) {
    copyMode = changes.bridge_mode.newValue;
    document.querySelectorAll('#ctb-ai-mode-full, #ctb-ai-mode-code').forEach(b => {
      b.classList.toggle('ctb-mode-active',
        (b.id === 'ctb-ai-mode-full' && copyMode === 'full') ||
        (b.id === 'ctb-ai-mode-code' && copyMode === 'code'));
    });
  }
  if (changes?.bridge_tgmode) {
    tgCopyMode = changes.bridge_tgmode.newValue;
    document.querySelectorAll('#ctb-tgmode-all, #ctb-tgmode-last').forEach(b => {
      b.classList.toggle('ctb-mode-active',
        (b.id === 'ctb-tgmode-all' && tgCopyMode === 'all') ||
        (b.id === 'ctb-tgmode-last' && tgCopyMode === 'last'));
    });
  }
  if (changes?.widget_state) {
    applyState(changes.widget_state.newValue || 'normal', true);
  }
  if (changes?.widgetUiState_ai) {
    const aiPanel =
      document.getElementById(
        'ctb-ai-panel'
      );

    if (aiPanel) {
      setPanelUiState(
        aiPanel,
        'widgetUiState_ai',
        changes.widgetUiState_ai
          .newValue ||
          'normal',
        false
      );
    }
  }

  if (changes?.widgetUiState_tg) {
    const tgPanel =
      document.getElementById(
        'ctb-tg-panel'
      );

    if (tgPanel) {
      setPanelUiState(
        tgPanel,
        'widgetUiState_tg',
        changes.widgetUiState_tg
          .newValue ||
          'normal',
        false
      );
    }
  }
  console.log('[ONCHANGED] full keys=', JSON.stringify(Object.keys(changes||{})));
});

// ── 위젯 상태 적용 ──
function applyState(state, keepPosition) {
  var ai = document.getElementById('ctb-ai-panel');
  var tg = document.getElementById('ctb-tg-panel');
  if (!ai || !tg) return;

  var isTG = location.hostname.indexOf('web.telegram.org') >= 0;
  var showAI = (state === 'swapped') ? isTG : !isTG;

  var currentPanel = null;
  if (getComputedStyle(ai).display !== 'none') {
    currentPanel = ai;
  } else if (getComputedStyle(tg).display !== 'none') {
    currentPanel = tg;
  }

  var nextPanel = showAI ? ai : tg;
  var nextStorageKey = showAI ? 'widgetPos_ai' : 'widgetPos_tg';

  console.log('[APPLYSTATE] state=', state, ' isTG=', isTG, ' showAI=', showAI, 'keepPosition=', !!keepPosition);

  if (keepPosition && currentPanel && currentPanel !== nextPanel) {
    copyPanelPosition(currentPanel, nextPanel, nextStorageKey);
  }

  ai.dataset.ctbRouteVisible =
    showAI
      ? 'true'
      : 'false';

  tg.dataset.ctbRouteVisible =
    showAI
      ? 'false'
      : 'true';

  syncPanelDisplay(ai);
  syncPanelDisplay(tg);

  syncBridgeTargetPickerVisibility();
}

// ── 위젯 스위치 ──
function toggleOtherWidget() {
  console.log('[TOGGLE] called');
  const aiPanel = document.getElementById('ctb-ai-panel');
  const tgPanel = document.getElementById('ctb-tg-panel');
  if (!aiPanel || !tgPanel) return;
  chrome.storage.local.get(['widget_state'], function(res) {
    var current = res && res.widget_state === 'swapped' ? 'swapped' : 'normal';
    var next = current === 'normal' ? 'swapped' : 'normal';
    applyState(next, true);
    chrome.storage.local.set({ widget_state: next });
  });
}

// ── 사이트별 위젯 주입 ──
if (SITE === 'telegram' || SITE) {
  const onReady = () => {
    console.log("[Bridge] SITE=", SITE, "readyState=", document.readyState, "body=", !!document.body);
    injectAIWidget();
    injectTGWidget();
    injectTokenCounter();

    chrome.storage.local.get(
      [
        'widget_state',
        'widgetUiState_ai',
        'widgetUiState_tg',
        'widgetPos_ai',
        'widgetPos_tg'
      ],
      function(res) {
        const aiPanel =
          document.getElementById(
            'ctb-ai-panel'
          );

        const tgPanel =
          document.getElementById(
            'ctb-tg-panel'
          );

        if (aiPanel) {
          setPanelUiState(
            aiPanel,
            'widgetUiState_ai',
            res?.widgetUiState_ai ||
              'normal',
            false
          );

          if (res?.widgetPos_ai) {
            applyStoredPanelPosition(
              aiPanel,
              'widgetPos_ai',
              res.widgetPos_ai
            );
          }
        }

        if (tgPanel) {
          setPanelUiState(
            tgPanel,
            'widgetUiState_tg',
            res?.widgetUiState_tg ||
              'normal',
            false
          );

          if (res?.widgetPos_tg) {
            applyStoredPanelPosition(
              tgPanel,
              'widgetPos_tg',
              res.widgetPos_tg
            );
          }
        }

        console.log(
          '[INIT] widget_state=',
          res?.widget_state,
          'SITE=',
          SITE
        );

        applyState(
          res?.widget_state ||
          'normal'
        );
      }
    );
  };

  if (document.readyState !== 'loading') { onReady(); }
  else { document.addEventListener('DOMContentLoaded', onReady); }
}

})();
