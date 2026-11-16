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

function getAiSourceSite(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    if (
      parsed.hostname === 'chatgpt.com' ||
      parsed.hostname === 'chat.openai.com'
    ) return 'chatgpt';
    if (parsed.hostname === 'claude.ai') return 'claude';
    if (parsed.hostname === 'gemini.google.com') return 'gemini';
  } catch (e) {}
  return '';
}

function isAiSourceUrl(url) {
  return !!getAiSourceSite(url);
}

function isAiUrl(url) {
  return isAiSourceUrl(url);
}

function isTelegramDestinationUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'web.telegram.org';
  } catch (e) {
    return false;
  }
}

async function findFirstAiTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*','https://chat.openai.com/*','https://claude.ai/*','https://gemini.google.com/*']
  });
  return tabs[0] || null;
}

function normalizeTabSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch (e) {
    return '';
  }
}

async function resolveAiSourceTab(request, senderTabId) {
  const sourceAiTabId =
    Number(request?.sourceAiTabId || 0);

  const sourceAiUrl =
    normalizeTabSourceUrl(
      request?.sourceAiUrl || ''
    );

  const sourceAiTitle =
    String(
      request?.sourceAiTitle || ''
    ).trim();

  /*
   * Telegram 페이지에서 AI→Telegram을 누른 경우에는
   * 반드시 명시적으로 선택한 AI tab을 source로 사용한다.
   *
   * tab ID가 아직 유효하고 AI URL이며,
   * 저장된 source URL과도 일치하면 그 tab을 사용한다.
   */
  if (sourceAiTabId) {
    try {
      const selected =
        await chrome.tabs.get(
          sourceAiTabId
        );

      if (
        selected &&
        isAiSourceUrl(selected.url)
      ) {
        const selectedUrl =
          normalizeTabSourceUrl(
            selected.url
          );

        if (
          !sourceAiUrl ||
          selectedUrl === sourceAiUrl
        ) {
          return selected;
        }
      }
    } catch (e) {}

    /*
     * tab ID가 stale 되었거나,
     * ID는 존재하지만 저장된 대화 URL과 달라졌다면
     * ID를 그대로 신뢰하지 않는다.
     *
     * 저장된 AI conversation URL로만 복구한다.
     */
    if (!sourceAiUrl) {
      return null;
    }

    const openAiTabs =
      await chrome.tabs.query({
        url: [
          'https://chatgpt.com/*',
          'https://chat.openai.com/*',
          'https://claude.ai/*',
          'https://gemini.google.com/*'
        ]
      });

    const urlMatches =
      openAiTabs.filter(function(tab) {
        return (
          tab &&
          isAiSourceUrl(tab.url) &&
          normalizeTabSourceUrl(
            tab.url
          ) === sourceAiUrl
        );
      });

    if (urlMatches.length === 1) {
      return urlMatches[0];
    }

    if (
      urlMatches.length > 1 &&
      sourceAiTitle
    ) {
      const titleMatches =
        urlMatches.filter(function(tab) {
          return (
            String(tab.title || '').trim() ===
            sourceAiTitle
          );
        });

      if (titleMatches.length === 1) {
        return titleMatches[0];
      }
    }

    return null;
  }

  /*
   * 명시 source가 없는 경우에는
   * 현재 sender 자체가 AI 페이지일 때만 허용한다.
   *
   * Telegram sender는 절대로 fallback source가 될 수 없다.
   */
  if (senderTabId) {
    try {
      const senderTab =
        await chrome.tabs.get(
          senderTabId
        );

      if (
        senderTab &&
        isAiSourceUrl(senderTab.url)
      ) {
        return senderTab;
      }
    } catch (e) {}
  }

  return null;
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

async function captureChatgptCodeByCopyButton(
  tabId,
  copyTrigger,
  options
) {
  const normalizedCopyTrigger =
    copyTrigger === 'queued'
      ? 'queued'
      : 'manual';
  const nativeWaitMs =
    Number.isFinite(options?.nativeWaitMs)
      ? Math.max(
          100,
          Math.min(
            5000,
            options.nativeWaitMs
          )
        )
      : 5000;
  let results;

  try {
    results =
      await chrome.scripting.executeScript({
      target: {
        tabId: tabId
      },
      world: 'MAIN',
      func: async function(
        copyTrigger,
        nativeWaitMs
      ) {
        const sleep =
          function(ms) {
            return new Promise(function(resolve) {
              setTimeout(resolve, ms);
            });
          };

        const normalize =
          function(value) {
            return String(value || '')
              .replace(/\r\n/g, '\n')
              .replace(/\r/g, '\n');
          };

        const assistantCandidates =
          Array.from(
            document.querySelectorAll(
              '[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids], ' +
              'section[data-turn="assistant"], ' +
              '[data-message-author-role="assistant"]'
            )
          ).filter(function(node) {
            return node && node.isConnected;
          });

        if (!assistantCandidates.length) {
          return {
            ok: false,
            copyTrigger: copyTrigger,
            codeBlockFound: false,
            copyButtonFound: false,
            targetReady: false,
            targetReadyElapsedMs: 0,
            errorCode: 'CODE_BLOCK_NOT_FOUND',
            error:
              'ChatGPT 코드박스를 찾지 못했습니다.'
          };
        }

        const assistant =
          assistantCandidates[
            assistantCandidates.length - 1
          ];

        const turn =
          assistant.closest('[data-turn-key]') ||
          assistant.closest(
            '[data-testid^="conversation-turn-"]'
          ) ||
          assistant.closest('article') ||
          assistant;

        const blocks =
          Array.from(
            turn.querySelectorAll(
              '[data-markdown-copy="code-block"]'
            )
          ).filter(function(node) {
            return node && node.isConnected;
          });

        if (!blocks.length) {
          return {
            ok: false,
            copyTrigger: copyTrigger,
            codeBlockFound: false,
            copyButtonFound: false,
            targetReady: false,
            targetReadyElapsedMs: 0,
            errorCode: 'CODE_BLOCK_NOT_FOUND',
            error:
              'ChatGPT 코드박스를 찾지 못했습니다.'
          };
        }

        const block =
          blocks[blocks.length - 1];

        const exactSelectors = [
          'button[data-testid="copy-code-button"]',
          '[data-testid="copy-code-button"]',
          'button[aria-label*="Copy code" i]',
          'button[aria-label*="코드 복사"]',
          'button[title*="Copy code" i]',
          'button[title*="코드 복사"]'
        ];

        let copyButton = null;

        for (const selector of exactSelectors) {
          const candidate =
            block.querySelector(selector);

          if (candidate) {
            copyButton = candidate;
            break;
          }
        }

        if (!copyButton) {
          copyButton =
            Array.from(
              block.querySelectorAll('button')
            ).find(function(button) {
              const label =
                [
                  button.getAttribute(
                    'aria-label'
                  ),
                  button.getAttribute('title'),
                  button.getAttribute(
                    'data-testid'
                  ),
                  button.textContent
                ]
                  .filter(Boolean)
                  .join(' ')
                  .toLowerCase();

              return (
                label.includes('copy') ||
                label.includes('복사')
              );
            }) || null;
        }

        if (!copyButton) {
          return {
            ok: false,
            copyTrigger: copyTrigger,
            codeBlockFound: true,
            copyButtonFound: false,
            targetReady: false,
            targetReadyElapsedMs: 0,
            errorCode: 'COPY_BUTTON_NOT_FOUND',
            error:
              'ChatGPT 복사 버튼을 찾지 못했습니다.'
          };
        }

        async function waitForStableCodeCopyTarget(
          turn,
          block,
          copyButton
        ) {
          const startedAt = Date.now();
          const deadline = startedAt + 4500;

          let previousText = null;
          let stableSince = 0;

          while (Date.now() < deadline) {
            const currentBlocks = Array.from(
              turn.querySelectorAll(
                '[data-markdown-copy="code-block"]'
              )
            ).filter(function(node) {
              return node && node.isConnected;
            });

            const lastBlock =
              currentBlocks[currentBlocks.length - 1];

            const attached =
              block.isConnected &&
              copyButton.isConnected &&
              lastBlock === block &&
              block.contains(copyButton);

            const disabled =
              copyButton.disabled === true ||
              copyButton.getAttribute(
                'aria-disabled'
              ) === 'true';

            const rect =
              copyButton.getBoundingClientRect();

            const style =
              getComputedStyle(copyButton);

            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';

            const renderedText =
              String(block.textContent || '');

            const ready =
              attached &&
              !disabled &&
              visible &&
              renderedText.trim().length > 0;

            if (ready) {
              if (
                renderedText === previousText
              ) {
                if (
                  stableSince &&
                  Date.now() - stableSince >= 700
                ) {
                  return {
                    ok: true,
                    elapsed: Date.now() - startedAt
                  };
                }
              } else {
                previousText = renderedText;
                stableSince = Date.now();
              }
            } else {
              previousText = null;
              stableSince = 0;
            }

            await sleep(100);
          }

          return {
            ok: false,
            elapsed: Date.now() - startedAt,
            error:
              'CODE_COPY_TARGET_NOT_STABLE'
          };
        }

        const copyTargetReady =
          await waitForStableCodeCopyTarget(
            turn,
            block,
            copyButton
          );

        if (!copyTargetReady.ok) {
          return {
            ok: false,
            copyTrigger: copyTrigger,
            codeBlockFound: true,
            copyButtonFound: true,
            targetReady: false,
            targetReadyElapsedMs:
              copyTargetReady.elapsed,
            errorCode:
              'CODE_COPY_TARGET_NOT_STABLE',
            error:
              'ChatGPT 코드박스 준비 상태를 확인하지 못했습니다.'
          };
        }

        const targetReadyElapsedMs =
          copyTargetReady.elapsed;

        function createSourceEvidence() {
          const codeNode =
            block.querySelector('pre code') ||
            block.querySelector('code') ||
            block.querySelector('pre') ||
            block.querySelector('.cm-content');

          if (!codeNode) {
            return {
              fragments: [],
              fullText: '',
              fullTextVerified: false
            };
          }

          const evidenceText =
            normalize(codeNode.textContent || '');
          const virtualized = !!block.querySelector(
            '.cm-editor, .cm-scroller, .cm-content, .cm-line'
          );
          const fragments = [];
          const addFragment = function(value) {
            const fragment = String(value || '').trim();

            if (
              fragment.length >= 3 &&
              !fragments.includes(fragment)
            ) {
              fragments.push(fragment);
            }
          };
          const lines = evidenceText
            .split('\n')
            .filter(function(line) {
              return line.trim().length >= 3;
            });

          if (lines.length) {
            addFragment(lines[0]);
            addFragment(
              lines[Math.floor(lines.length / 2)]
            );
            addFragment(lines[lines.length - 1]);
          }

          if (
            fragments.length < 2 &&
            evidenceText.trim().length >= 16
          ) {
            const compact = evidenceText.trim();
            addFragment(compact.slice(0, 8));
            addFragment(compact.slice(-8));
          }

          return {
            fragments: fragments.slice(0, 3),
            fullText:
              virtualized ? '' : evidenceText,
            fullTextVerified:
              !virtualized && !!evidenceText.trim()
          };
        }

        function getCopyFeedbackState() {
          return JSON.stringify({
            ariaLabel:
              copyButton.getAttribute('aria-label') || '',
            title:
              copyButton.getAttribute('title') || '',
            state:
              copyButton.getAttribute('data-state') || '',
            pressed:
              copyButton.getAttribute('aria-pressed') || '',
            text: copyButton.textContent || '',
            html: copyButton.innerHTML || ''
          });
        }

        const sourceEvidence =
          createSourceEvidence();
        const feedbackStateBefore =
          getCopyFeedbackState();
        let copyClicked = false;
        let copyFeedbackObserved = false;

        let capturedText = '';
        let captureSource = '';
        let captureError = '';
        let failureCode = '';
        let emptyCaptureObserved = false;
        let restoreFailed = false;
        const pendingCaptureTasks = new Set();
        const restoreHooks = [];

        function acceptCapturedText(value, source) {
          const text = normalize(value);

          if (!text.trim()) {
            emptyCaptureObserved = true;
            return false;
          }

          capturedText = text;
          captureSource = source;

          return true;
        }

        async function readClipboardItems(items) {
          if (!Array.isArray(items)) {
            return false;
          }

          for (const item of items) {
            if (
              !item ||
              !Array.isArray(item.types) ||
              !item.types.includes('text/plain') ||
              typeof item.getType !== 'function'
            ) {
              continue;
            }

            try {
              const blob =
                await item.getType('text/plain');

              if (
                !blob ||
                typeof blob.text !== 'function'
              ) {
                continue;
              }

              const value = await blob.text();

              if (
                acceptCapturedText(
                  value,
                  'clipboard.write'
                )
              ) {
                return true;
              }
            } catch (error) {
              captureError =
                error?.message ||
                'ClipboardItem 텍스트 읽기 실패';
              failureCode = 'COPY_TEXT_UNVERIFIED';
            }
          }

          return false;
        }

        function trackCaptureTask(task) {
          const tracked = Promise.resolve(task)
            .catch(function(error) {
              captureError =
                error?.message ||
                '비동기 클립보드 읽기 실패';
              failureCode = 'COPY_TEXT_UNVERIFIED';
              return false;
            })
            .finally(function() {
              pendingCaptureTasks.delete(tracked);
            });

          pendingCaptureTasks.add(tracked);
          return tracked;
        }

        function hookMethod(target, key, replacement) {
          if (
            !target ||
            typeof target[key] !== 'function'
          ) {
            return false;
          }

          const hadOwn =
            Object.prototype.hasOwnProperty.call(
              target,
              key
            );
          const descriptor =
            Object.getOwnPropertyDescriptor(
              target,
              key
            );
          let installed = false;

          try {
            Object.defineProperty(
              target,
              key,
              {
                configurable: true,
                enumerable:
                  descriptor?.enumerable === true,
                writable: true,
                value: replacement
              }
            );
            installed = target[key] === replacement;
          } catch (error) {
            try {
              target[key] = replacement;
              installed = target[key] === replacement;
            } catch (assignmentError) {
              installed = false;
            }
          }

          if (!installed) return false;

          restoreHooks.push({
            target: target,
            key: key,
            hadOwn: hadOwn,
            descriptor: descriptor
          });

          return true;
        }

        function restoreClipboardHooks() {
          for (
            let index = restoreHooks.length - 1;
            index >= 0;
            index -= 1
          ) {
            const hook = restoreHooks[index];

            try {
              if (hook.hadOwn) {
                Object.defineProperty(
                  hook.target,
                  hook.key,
                  hook.descriptor
                );
              } else {
                const removed =
                  delete hook.target[hook.key];

                if (!removed) {
                  restoreFailed = true;
                }
              }
            } catch (error) {
              restoreFailed = true;
            }
          }
        }

        const onCopy =
          function(event) {
            try {
              acceptCapturedText(
                event.clipboardData?.getData(
                  'text/plain'
                ),
                'copy.event'
              );
            } catch (error) {
              captureError =
                error?.message ||
                'copy 이벤트 텍스트 읽기 실패';
            }
          };

        const onCopyCapture =
          function(event) {
            trackCaptureTask(
              Promise.resolve().then(function() {
                try {
                  return acceptCapturedText(
                    event.clipboardData?.getData(
                      'text/plain'
                    ),
                    'copy.event'
                  );
                } catch (error) {
                  captureError =
                    error?.message ||
                    'copy 이벤트 텍스트 읽기 실패';
                  return false;
                }
              })
            );
          };

        document.addEventListener(
          'copy',
          onCopyCapture,
          true
        );

        document.addEventListener(
          'copy',
          onCopy,
          false
        );

        const clipboard =
          navigator.clipboard;

        const clipboardProto =
          clipboard
            ? Object.getPrototypeOf(
                clipboard
              )
            : null;

        const writeTextHook = function(value) {
          acceptCapturedText(
            value,
            'clipboard.writeText'
          );

          return Promise.resolve();
        };

        const writeHook = function(items) {
          return trackCaptureTask(
            readClipboardItems(items)
          );
        };

        const writeTextHooked =
          hookMethod(
            clipboard,
            'writeText',
            writeTextHook
          ) ||
          hookMethod(
            clipboardProto,
            'writeText',
            writeTextHook
          );

        const writeHooked =
          hookMethod(
            clipboard,
            'write',
            writeHook
          ) ||
          hookMethod(
            clipboardProto,
            'write',
            writeHook
          );

        try {
          try {
            copyButton.click();
            copyClicked = true;
          } catch (error) {
            failureCode = 'COPY_EXCEPTION';
            captureError =
              error?.message ||
              '복사 버튼 클릭 실패';
          }

          const deadline =
            Date.now() + nativeWaitMs;

          while (
            !capturedText &&
            failureCode !== 'COPY_EXCEPTION' &&
            Date.now() < deadline
          ) {
            if (
              getCopyFeedbackState() !==
              feedbackStateBefore
            ) {
              copyFeedbackObserved = true;
            }

            if (pendingCaptureTasks.size) {
              await Promise.race([
                Promise.allSettled(
                  Array.from(pendingCaptureTasks)
                ),
                sleep(50)
              ]);
            } else {
              await sleep(50);
            }
          }
        } finally {
          document.removeEventListener(
            'copy',
            onCopyCapture,
            true
          );

          document.removeEventListener(
            'copy',
            onCopy,
            false
          );

          restoreClipboardHooks();
        }

        if (restoreFailed) {
          return {
            ok: false,
            copyTrigger: copyTrigger,
            codeBlockFound: true,
            copyButtonFound: true,
            targetReady: true,
            targetReadyElapsedMs:
              targetReadyElapsedMs,
            copyClicked: copyClicked,
            copyFeedbackObserved:
              copyFeedbackObserved,
            sourceEvidence: sourceEvidence,
            errorCode: 'COPY_EXCEPTION',
            captureSource: captureSource,
            capturedLength: capturedText.length,
            error:
              '코드 복사 처리를 안전하게 복원하지 못했습니다.'
          };
        }

        if (!capturedText) {
          const unsupported =
            !writeTextHooked &&
            !writeHooked;
          const errorCode =
            failureCode ||
            (
              unsupported
                ? 'COPY_API_UNSUPPORTED'
                : emptyCaptureObserved
                  ? 'COPY_TEXT_EMPTY'
                : captureError
                  ? 'COPY_TEXT_UNVERIFIED'
                  : 'COPY_TIMEOUT'
            );
          const error =
            errorCode === 'COPY_API_UNSUPPORTED'
              ? '코드 복사 API를 확인하지 못했습니다.'
              : errorCode === 'COPY_TEXT_EMPTY'
                ? '코드 복사 결과가 비어 있어 전송하지 않았습니다.'
              : errorCode === 'COPY_TEXT_UNVERIFIED'
                ? '코드 원문 전체를 확인하지 못해 전송하지 않았습니다.'
                : errorCode === 'COPY_EXCEPTION'
                  ? 'ChatGPT 코드 복사 중 오류가 발생했습니다.'
                  : '코드 복사 결과를 확인하지 못했습니다.';

          return {
            ok: false,
            copyTrigger: copyTrigger,
            codeBlockFound: true,
            copyButtonFound: true,
            targetReady: true,
            targetReadyElapsedMs:
              targetReadyElapsedMs,
            copyClicked: copyClicked,
            copyFeedbackObserved:
              copyFeedbackObserved,
            sourceEvidence: sourceEvidence,
            errorCode: errorCode,
            captureSource: captureSource,
            capturedLength: 0,
            captureError: captureError,
            error: error
          };
        }

        return {
          ok: true,
          text: capturedText,
          copyTrigger: copyTrigger,
          codeBlockFound: true,
          copyButtonFound: true,
          targetReady: true,
          targetReadyElapsedMs:
            targetReadyElapsedMs,
          copyClicked: copyClicked,
          copyFeedbackObserved:
            copyFeedbackObserved,
          sourceEvidence: sourceEvidence,
          errorCode: '',
          captureSource: captureSource,
          capturedLength: capturedText.length,
          domFallbackUsed: false
        };
      },
      args: [
        normalizedCopyTrigger,
        nativeWaitMs
      ]
    });
  } catch (error) {
    console.warn('[CTB native code copy]', {
      stage: 'execute_script',
      copyTrigger: normalizedCopyTrigger,
      codeBlockFound: false,
      copyButtonFound: false,
      targetReady: false,
      targetReadyElapsedMs: 0,
      captureSource: '',
      capturedLength: 0,
      failureCode: 'COPY_EXCEPTION'
    });

    throw new Error(
      'ChatGPT 코드 복사 중 오류가 발생했습니다.'
    );
  }

  const result =
    results?.[0]?.result;

  if (!result?.ok) {
    console.warn('[CTB native code copy]', {
      stage: 'capture',
      copyTrigger:
        result?.copyTrigger ||
        normalizedCopyTrigger,
      codeBlockFound:
        result?.codeBlockFound === true,
      copyButtonFound:
        result?.copyButtonFound === true,
      targetReady:
        result?.targetReady === true,
      targetReadyElapsedMs:
        Number(
          result?.targetReadyElapsedMs || 0
        ),
      captureSource: result?.captureSource || '',
      capturedLength:
        Number(result?.capturedLength || 0),
      failureCode:
        result?.errorCode || 'COPY_EXCEPTION'
    });

    const captureFailure = new Error(
      result?.error ||
      'ChatGPT 코드 복사에 실패했습니다.'
    );

    captureFailure.ctbNativeCopy = result || null;

    throw captureFailure;
  }

  console.info('[CTB native code copy]', {
    stage: 'capture',
    copyTrigger:
      result.copyTrigger ||
      normalizedCopyTrigger,
    nativeCaptureSucceeded: true,
    nativeCopyClicked:
      result.copyClicked === true,
    copyFeedbackObserved:
      result.copyFeedbackObserved === true,
    clipboardReadBeforeSucceeded: null,
    clipboardReadAfterSucceeded: null,
    clipboardChanged: null,
    sourceEvidenceMatched: null,
    codeBlockFound:
      result.codeBlockFound === true,
    copyButtonFound:
      result.copyButtonFound === true,
    targetReady:
      result.targetReady === true,
    targetReadyElapsedMs:
      Number(
        result.targetReadyElapsedMs || 0
      ),
    captureSource: result.captureSource || '',
    capturedLength: Number(result.capturedLength || 0),
    failureCode: ''
  });

  return {
    text: result.text,
    details: result
  };
}

async function ctbReadChatgptClipboardText(
  tabId,
  timeoutMs
) {
  const readTimeoutMs =
    Number.isFinite(timeoutMs)
      ? Math.max(
          100,
          Math.min(5000, timeoutMs)
        )
      : 5000;

  try {
    const results =
      await chrome.scripting.executeScript({
        target: {
          tabId: tabId
        },
        world: 'ISOLATED',
        func: async function(readTimeoutMs) {
          if (
            !navigator.clipboard ||
            typeof navigator.clipboard.readText !==
              'function'
          ) {
            return {
              ok: false,
              code: 'CLIPBOARD_READ_UNAVAILABLE'
            };
          }

          try {
            const text =
              await Promise.race([
                navigator.clipboard.readText(),
                new Promise(function(
                  resolve,
                  reject
                ) {
                  setTimeout(function() {
                    reject(
                      new Error(
                        'CLIPBOARD_READ_TIMEOUT'
                      )
                    );
                  }, readTimeoutMs);
                })
              ]);

            return {
              ok: true,
              text: String(text ?? '')
            };
          } catch (error) {
            return {
              ok: false,
              code:
                error?.message ===
                  'CLIPBOARD_READ_TIMEOUT'
                  ? 'CLIPBOARD_READ_TIMEOUT'
                  : 'CLIPBOARD_READ_DENIED',
              errorName:
                String(error?.name || '')
            };
          }
        },
        args: [readTimeoutMs]
      });

    return results?.[0]?.result || {
      ok: false,
      code: 'CLIPBOARD_READ_NO_RESULT'
    };
  } catch (error) {
    return {
      ok: false,
      code: 'CLIPBOARD_READ_EXCEPTION',
      errorName:
        String(error?.name || '')
    };
  }
}

function ctbNormalizeClipboardText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function ctbVerifyClipboardSource(text, evidence) {
  const normalized =
    ctbNormalizeClipboardText(text);
  const fragments = Array.isArray(evidence?.fragments)
    ? evidence.fragments
        .map(ctbNormalizeClipboardText)
        .filter(function(fragment) {
          return fragment.trim().length >= 3;
        })
    : [];
  const fragmentsMatched =
    fragments.length >= 2 &&
    fragments.every(function(fragment) {
      return normalized.includes(fragment);
    });
  const fullText =
    ctbNormalizeClipboardText(
      evidence?.fullText || ''
    );
  const fullTextMatched = !!(
    evidence?.fullTextVerified === true &&
    fullText.trim() &&
    normalized === fullText
  );

  return {
    matched:
      fullTextMatched || fragmentsMatched,
    fullTextMatched: fullTextMatched,
    fragmentsMatched: fragmentsMatched
  };
}

function ctbClipboardFailureMessage(code) {
  if (code === 'CLIPBOARD_READ_DENIED') {
    return '클립보드 읽기 권한이 없어 코드를 확인하지 못했습니다. [CLIPBOARD_READ_DENIED]';
  }

  if (
    code === 'CLIPBOARD_READ_UNAVAILABLE' ||
    code === 'CLIPBOARD_READ_TIMEOUT' ||
    code === 'CLIPBOARD_READ_NO_RESULT' ||
    code === 'CLIPBOARD_READ_EXCEPTION'
  ) {
    return '코드 복사 결과를 확인하지 못했습니다. [' + code + ']';
  }

  if (code === 'CLIPBOARD_EMPTY') {
    return '클립보드의 코드 복사 결과가 비어 있습니다. [CLIPBOARD_EMPTY]';
  }

  if (code === 'CLIPBOARD_UNCHANGED_UNVERIFIED') {
    return '변경되지 않은 클립보드가 현재 코드박스의 결과인지 확인하지 못했습니다. [CLIPBOARD_UNCHANGED_UNVERIFIED]';
  }

  return '코드는 복사됐지만 현재 코드박스와의 일치를 확인하지 못했습니다. [CLIPBOARD_SOURCE_UNVERIFIED]';
}

let ctbChatgptCodeCaptureBusy = false;

function ctbTransferNow() {
  return (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  )
    ? performance.now()
    : Date.now();
}

async function ctbCaptureChatgptCodeWithFallback(
  sourceAiTab,
  copyTrigger,
  timing
) {
  const normalizedCopyTrigger =
    copyTrigger === 'queued'
      ? 'queued'
      : 'manual';

  if (ctbChatgptCodeCaptureBusy) {
    throw new Error(
      '다른 ChatGPT 코드 복사 요청을 처리 중입니다.'
    );
  }

  ctbChatgptCodeCaptureBusy = true;

  let before = null;
  let nativeFailure = null;

  try {
    const beforeStartedAt = ctbTransferNow();

    before =
      await ctbReadChatgptClipboardText(
        sourceAiTab.id,
        1200
      );

    timing.clipboardBeforeMs =
      ctbTransferNow() - beforeStartedAt;

    const nativeStartedAt = ctbTransferNow();

    try {
      const nativeResult =
        await captureChatgptCodeByCopyButton(
        sourceAiTab.id,
        normalizedCopyTrigger,
        {
          nativeWaitMs:
            before?.ok === true
              ? 650
              : 5000
        }
      );

      timing.copyTargetReadyMs = Number(
        nativeResult?.details
          ?.targetReadyElapsedMs || 0
      );
      timing.nativeCaptureMs = Math.max(
        0,
        ctbTransferNow() - nativeStartedAt -
          timing.copyTargetReadyMs
      );

      return nativeResult.text;
    } catch (error) {
      nativeFailure = error?.ctbNativeCopy || null;

      timing.copyTargetReadyMs = Number(
        nativeFailure?.targetReadyElapsedMs || 0
      );
      timing.nativeCaptureMs = Math.max(
        0,
        ctbTransferNow() - nativeStartedAt -
          timing.copyTargetReadyMs
      );

      const fallbackCodes = [
        'COPY_API_UNSUPPORTED',
        'COPY_TEXT_EMPTY',
        'COPY_TIMEOUT',
        'COPY_TEXT_UNVERIFIED'
      ];

      if (
        !nativeFailure ||
        nativeFailure.codeBlockFound !== true ||
        nativeFailure.copyButtonFound !== true ||
        nativeFailure.targetReady !== true ||
        nativeFailure.copyClicked !== true ||
        !fallbackCodes.includes(
          nativeFailure.errorCode
        )
      ) {
        throw error;
      }
    }

    const afterStartedAt = ctbTransferNow();
    const afterDeadline = afterStartedAt + 2000;
    let after = null;

    while (ctbTransferNow() < afterDeadline) {
      const remaining =
        afterDeadline - ctbTransferNow();

      after =
        await ctbReadChatgptClipboardText(
          sourceAiTab.id,
          Math.min(1500, remaining)
        );

      if (!after?.ok) break;

      const currentAfterText =
        ctbNormalizeClipboardText(after.text);
      const currentBeforeText = before?.ok
        ? ctbNormalizeClipboardText(before.text)
        : '';
      const currentVerification =
        ctbVerifyClipboardSource(
          currentAfterText,
          nativeFailure?.sourceEvidence
        );
      const unchangedVerified =
        currentVerification.fullTextMatched ||
        (
          nativeFailure?.copyFeedbackObserved === true &&
          currentVerification.fragmentsMatched
        );

      if (
        currentAfterText !== currentBeforeText ||
        unchangedVerified
      ) {
        break;
      }

      await new Promise(function(resolve) {
        setTimeout(resolve, 125);
      });
    }

    timing.clipboardAfterMs =
      ctbTransferNow() - afterStartedAt;

    const currentTab =
      await chrome.tabs.get(sourceAiTab.id);

    if (
      !currentTab ||
      !isAiSourceUrl(currentTab.url) ||
      normalizeTabSourceUrl(currentTab.url) !==
        normalizeTabSourceUrl(sourceAiTab.url)
    ) {
      throw new Error(
        '코드 복사 중 원본 ChatGPT 대화가 변경되었습니다.'
      );
    }

    let failureCode = '';

    if (!before?.ok) {
      failureCode =
        before?.code ||
        'CLIPBOARD_READ_NO_RESULT';
    } else if (!after?.ok) {
      failureCode =
        after?.code ||
        'CLIPBOARD_READ_NO_RESULT';
    }

    const beforeText = before?.ok
      ? ctbNormalizeClipboardText(before.text)
      : '';
    const afterText = after?.ok
      ? ctbNormalizeClipboardText(after.text)
      : '';
    const clipboardChanged = !!(
      before?.ok &&
      after?.ok &&
      beforeText !== afterText
    );
    const verificationStartedAt =
      ctbTransferNow();
    const sourceVerification =
      ctbVerifyClipboardSource(
        afterText,
        nativeFailure?.sourceEvidence
      );

    if (
      !failureCode &&
      !afterText.trim()
    ) {
      failureCode = 'CLIPBOARD_EMPTY';
    }

    if (!failureCode) {
      if (clipboardChanged) {
        if (!sourceVerification.matched) {
          failureCode =
            'CLIPBOARD_SOURCE_UNVERIFIED';
        }
      } else if (
        !sourceVerification.fullTextMatched &&
        !(
          nativeFailure?.copyFeedbackObserved === true &&
          sourceVerification.fragmentsMatched
        )
      ) {
        failureCode =
          'CLIPBOARD_UNCHANGED_UNVERIFIED';
      }
    }

    timing.sourceVerificationMs =
      ctbTransferNow() - verificationStartedAt;

    console.info('[CTB clipboard fallback]', {
      copyTrigger: normalizedCopyTrigger,
      nativeCaptureSucceeded: false,
      nativeCopyClicked:
        nativeFailure?.copyClicked === true,
      copyFeedbackObserved:
        nativeFailure?.copyFeedbackObserved === true,
      clipboardReadBeforeSucceeded:
        before?.ok === true,
      clipboardReadAfterSucceeded:
        after?.ok === true,
      clipboardChanged: clipboardChanged,
      sourceEvidenceMatched:
        sourceVerification.matched,
      capturedLength:
        failureCode ? 0 : afterText.length,
      failureCode: failureCode
    });

    if (failureCode) {
      throw new Error(
        ctbClipboardFailureMessage(
          failureCode
        )
      );
    }

    return String(after.text ?? '');
  } finally {
    ctbChatgptCodeCaptureBusy = false;
  }
}

const CTB_RETURN_VERSION = '061-8';
const CTB_RETURN_KEY = 'bridge_auto_return_routes';
const CTB_CHAIN_APPROVAL_LINE_BG = '실행해';

function ctbChainNormalizeRunText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u200b/g, '')
    .replace(/\n+$/g, '');
}

function ctbChainValidateRunText(value) {
  const text = ctbChainNormalizeRunText(value);
  const lines = text.split('\n');

  return !!(
    text.trim() &&
    lines[0]?.trim() === '/run' &&
    lines[lines.length - 1]?.trim() ===
      CTB_CHAIN_APPROVAL_LINE_BG &&
    lines.filter(function(line) {
      return line.trim() === CTB_CHAIN_APPROVAL_LINE_BG;
    }).length === 1
  );
}
const CTB_AUTO_RETURN_WATCH_ALARM =
  'ctb-auto-return-watch-061';
const CTB_AUTO_RETURN_WATCH_STATUSES = new Set([
  'sending',
  'awaiting_job',
  'awaiting_result'
]);

let ctbReturnDeliveryBusy = false;
let ctbReturnMutationTail = Promise.resolve();

function ctbQueueReturnMutation(operation) {
  const pending = ctbReturnMutationTail.then(operation, operation);

  ctbReturnMutationTail = pending.catch(function() {});

  return pending;
}

async function ctbRunAutoReturnWhenJobSlotReady(
  operation
) {
  const deadline = Date.now() + 20000;

  while (true) {
    const outcome = await ctbQueueReturnMutation(
      async function() {
        const routes = await ctbReadReturnRoutes();

        const pendingJob = routes.some(
          function(route) {
            return (
              ['sending', 'awaiting_job'].includes(
                route.status
              ) &&
              Date.now() -
                Number(route.createdAt || 0) <
                12 * 60 * 60 * 1000
            );
          }
        );

        if (pendingJob) {
          return {
            deferred: true
          };
        }

        return {
          deferred: false,
          result: await operation()
        };
      }
    );

    if (!outcome.deferred) {
      return outcome.result;
    }

    if (Date.now() >= deadline) {
      return {
        ok: false,
        error:
          '이전 Telegram Job ID 등록을 확인하지 못했습니다. 잠시 후 다시 전송해주세요.'
      };
    }

    await new Promise(function(resolve) {
      setTimeout(resolve, 250);
    });
  }
}

function ctbReturnConversationUrl(value) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== 'https:' ||
      !['chatgpt.com', 'chat.openai.com'].includes(url.hostname)
    ) {
      return '';
    }

    const path = url.pathname.replace(/\/$/, '');

    if (!/(?:^|\/)c\/[a-zA-Z0-9-]+$/.test(path)) {
      return '';
    }

    return url.origin + path;
  } catch {
    return '';
  }
}

async function ctbReadReturnRoutes() {
  const data = await chrome.storage.local.get(CTB_RETURN_KEY);

  const routes = Array.isArray(data[CTB_RETURN_KEY])
    ? data[CTB_RETURN_KEY]
    : [];

  return routes.filter(function(route) {
    return (
      route?.routingVersion === CTB_RETURN_VERSION &&
      typeof route.token === 'string' &&
      !!route.token
    );
  });
}

async function ctbReadReturnRoute(token) {
  const routes = await ctbReadReturnRoutes();

  if (token) {
    return routes.find(function(route) {
      return route.token === token;
    }) || null;
  }

  return routes.sort(function(a, b) {
    return Number(b.createdAt || 0) -
      Number(a.createdAt || 0);
  })[0] || null;
}

async function ctbWriteReturnRoute(route) {
  if (
    !route ||
    route.routingVersion !== CTB_RETURN_VERSION ||
    !route.token
  ) {
    throw new Error('자동회신 작업 저장 정보가 올바르지 않습니다.');
  }

  const data = await chrome.storage.local.get(CTB_RETURN_KEY);

  const existing = Array.isArray(data[CTB_RETURN_KEY])
    ? data[CTB_RETURN_KEY]
    : [];

  const retained = existing.filter(function(item) {
    if (item?.routingVersion !== CTB_RETURN_VERSION) {
      return true;
    }

    if (item.token === route.token) {
      return false;
    }

    // 동일 GPT 탭에서 다음 연속 작업으로 교체되는
    // 이전 chain_dispatching 작업만 제외한다.
    const supersededChain = (
      route.status === 'sending' &&
      item.sourceTabId === route.sourceTabId &&
      item.status === 'chain_dispatching' &&
      Number(item.chainCycle || 0) + 1 ===
        Number(route.chainCycle || 0)
    );

    return !supersededChain;
  });

  await chrome.storage.local.set({
    [CTB_RETURN_KEY]: [...retained, route]
  });

  await ctbSyncReturnWatchAlarm(route);
}

async function ctbSyncReturnWatchAlarm() {
  if (!chrome.alarms) return;

  const routes = await ctbReadReturnRoutes();

  const active = routes.some(function(route) {
    return CTB_AUTO_RETURN_WATCH_STATUSES.has(
      route.status
    );
  });

  if (active) {
    chrome.alarms.create(
      CTB_AUTO_RETURN_WATCH_ALARM,
      { periodInMinutes: 0.5 }
    );
    return;
  }

  await chrome.alarms.clear(
    CTB_AUTO_RETURN_WATCH_ALARM
  );
}

async function ctbHandleReturnWatchAlarm() {
  const routes = (await ctbReadReturnRoutes())
    .filter(function(route) {
      return CTB_AUTO_RETURN_WATCH_STATUSES.has(
        route.status
      );
    });

  if (!routes.length) {
    await ctbSyncReturnWatchAlarm();
    return;
  }

  for (const route of routes) {
    let tab = null;

    try {
      tab = await chrome.tabs.get(
        route.telegramTabId
      );
    } catch {}

    if (
      !tab ||
      tab.discarded === true ||
      !isTelegramDestinationUrl(tab.url)
    ) {
      await ctbChangeReturnRoute(
        route.token,
        [route.status],
        {
          phase: 'telegram_watch_failed',
          diagnostic: 'telegram_tab_unavailable',
          diagnosticAt: Date.now()
        }
      );
      continue;
    }

    try {
      const result = await chrome.tabs.sendMessage(
        tab.id,
        {
          action: 'ctbAutoReturnWatch',
          token: route.token
        }
      );

      await ctbChangeReturnRoute(
        route.token,
        [route.status],
        {
          phase: result?.ok
            ? 'telegram_watch_ok'
            : 'telegram_watch_failed',
          diagnostic: result?.ok
            ? ''
            : (
              result?.error ||
              'telegram_watch_unconfirmed'
            ),
          diagnosticAt: Date.now(),
          telegramDocumentHidden:
            result?.documentHidden === true,
          telegramVisibilityState:
            String(result?.visibilityState || '')
        }
      );

      console.info('[CTB auto return watch]', {
        phase: result?.ok
          ? 'telegram_watch_ok'
          : 'telegram_watch_failed',
        jobId: route.jobId || '',
        candidateCount:
          Number(result?.candidateCount || 0),
        documentHidden:
          result?.documentHidden === true,
        visibilityState:
          String(result?.visibilityState || ''),
        status: route.status
      });
    } catch (error) {
      await ctbChangeReturnRoute(
        route.token,
        [route.status],
        {
          phase: 'telegram_watch_failed',
          diagnostic:
            error?.message ||
            'telegram_watch_failed',
          diagnosticAt: Date.now()
        }
      );
    }
  }
}

async function ctbChangeReturnRoute(token, allowedStatuses, patch) {
  const current = await ctbReadReturnRoute(token);

  if (
    !current ||
    current.token !== token ||
    !allowedStatuses.includes(current.status)
  ) {
    return null;
  }

  const updated = {
    ...current,
    ...patch,
    updatedAt: Date.now()
  };

  await ctbWriteReturnRoute(updated);

  return updated;
}

function ctbValidTelegramSender(sender, route, token) {
  return !!(
    sender?.tab &&
    sender.tab.id === route?.telegramTabId &&
    isTelegramDestinationUrl(sender.tab.url) &&
    token &&
    token === route?.token
  );
}

async function ctbHandleReturnJob(message, sender) {
  const route = await ctbReadReturnRoute(message.token);

  if (
    !ctbValidTelegramSender(sender, route, message.token) ||
    !/^J\d{4,}-\d{6}-\d{2}$/.test(message.jobId || '')
  ) {
    return { ok: false, error: '예약 검증 실패' };
  }

  if (
    route.status === 'awaiting_result' &&
    route.jobId === message.jobId
  ) {
    return { ok: true };
  }

  const updated = await ctbChangeReturnRoute(
    message.token,
    ['sending', 'awaiting_job'],
      {
        status: 'awaiting_result',
        jobId: message.jobId,
        phase: 'waiting_begin_or_ready'
    }
  );

  return {
    ok: !!updated,
    error: updated ? '' : 'Job 연결 상태 불일치'
  };
}

async function ctbHandleReturnReady(message, sender) {
  if (ctbReturnDeliveryBusy) {
    return { ok: false, error: '전달 처리 중' };
  }

  const route = await ctbReadReturnRoute(message.token);

  if (
    !ctbValidTelegramSender(sender, route, message.token) ||
    route.status !== 'awaiting_result' ||
    route.jobId !== message.jobId ||
    !/^R[1-9]\d*$/.test(message.sequence || '')
  ) {
    return { ok: false, error: 'Job 또는 종료 신호 불일치' };
  }

  const candidateCount = Number(message.candidateCount);
  const textValid =
    typeof message.text === 'string' &&
    !!message.text.trim() &&
    message.text.length <= 250000;
  const legacyValid =
    message.beginSeen !== true &&
    candidateCount === 1 &&
    message.readyJobId === route.jobId;
  const boundedValid =
    message.beginSeen === true &&
    message.beginJobId === route.jobId &&
    message.readyJobId === route.jobId &&
    message.beginSequence === message.sequence &&
    /^R[1-9]\d*$/.test(message.beginSequence || '') &&
    Number.isSafeInteger(candidateCount) &&
    candidateCount >= 1 &&
    candidateCount <= 200;

  if (!textValid || (!legacyValid && !boundedValid)) {
    await ctbChangeReturnRoute(
      route.token,
      ['awaiting_result'],
      {
        status: 'ambiguous',
        error: '완료보고 경계 또는 후보 검증 실패',
        phase: 'report_merge_failed'
      }
    );

    return {
      ok: false,
      error: '완료보고 검증 실패 · 수동 전달 필요'
    };
  }

  ctbReturnDeliveryBusy = true;

  try {
    const claimed = await ctbChangeReturnRoute(
      route.token,
      ['awaiting_result'],
      {
        status: 'delivering',
        sequence: message.sequence,
        claimedAt: Date.now(),
        phase: 'gpt_target_connecting'
      }
    );

    if (!claimed) {
      return { ok: false, error: '전달 예약 선점 실패' };
    }

    const target = await chrome.tabs.get(route.sourceTabId);

    if (
      !target ||
      ctbReturnConversationUrl(target.url) !==
        route.sourceConversationUrl
    ) {
      throw new Error('원본 ChatGPT 대화 탭이 변경됨');
    }

    // 자동전송은 sendToTab()의 재주입/재시도 경로를 사용하지 않는다.
    // 응답 유실 시 중복 전송을 막기 위해 정확히 한 번만 호출한다.
    const result = await chrome.tabs.sendMessage(
      target.id,
      {
        action: 'ctbAutoReturnDeliver',
        conversationUrl: route.sourceConversationUrl,
        text: message.text,
        chainEnabled: route.chainEnabled === true,
        chainRouteId: route.routeId,
        chainToken: route.token
      }
    );

    const sent = result?.ok === true && result?.sent === true;

    await ctbChangeReturnRoute(
      route.token,
      ['delivering'],
      {
        status: sent ? 'awaiting_gpt' : 'delivery_failed',
        error: sent ? '' : (result?.error || 'ChatGPT 전송 미확인'),
        phase: sent
          ? 'waiting_gpt_response'
          : (result?.phase || 'gpt_send_failed'),
        gptDocumentHidden:
          result?.documentHidden === true,
        gptVisibilityState:
          String(result?.visibilityState || ''),
        completedAt: Date.now()
      }
    );

    return {
      ok: sent,
      error: sent ? '' : (result?.error || 'ChatGPT 전송 미확인')
    };
  } catch (error) {
    try {
      await ctbChangeReturnRoute(
        route.token,
        ['delivering'],
        {
          status: 'ambiguous',
          error: error?.message || '전달 상태 확인 실패',
          phase: 'gpt_target_failed'
        }
      );
    } catch {}

    return {
      ok: false,
      error: error?.message || '자동전달 실패'
    };
  } finally {
    ctbReturnDeliveryBusy = false;
  }
}

async function ctbHandleReturnCancel(message, sender) {
  const routes = await ctbReadReturnRoutes();

  const route = routes.find(function(item) {
    return (
      item.routeId === message.routeId &&
      item.sourceTabId === sender?.tab?.id &&
      item.sourceConversationUrl ===
        ctbReturnConversationUrl(sender?.tab?.url)
    );
  }) || null;
  let senderIsChatgpt = false;

  try {
    const senderUrl = new URL(sender?.tab?.url || '');

    senderIsChatgpt = !!(
      sender?.tab &&
      Number.isInteger(sender.tab.id) &&
      senderUrl.protocol === 'https:' &&
      ['chatgpt.com', 'chat.openai.com'].includes(
        senderUrl.hostname
      )
    );
  } catch {}

  if (
    !route ||
    !senderIsChatgpt ||
    message.routeId !== route.routeId ||
    route.routingVersion !== CTB_RETURN_VERSION ||
    route.autoReturn !== true
  ) {
    return { ok: false, error: '자동회신 예약 검증 실패' };
  }

  const updated = await ctbChangeReturnRoute(
    route.token,
    [
      'sending',
      'awaiting_job',
      'awaiting_result',
      'awaiting_gpt'
    ],
    {
      status: 'cancelled',
      phase: 'cancelled_by_user',
      error: '',
      completedAt: Date.now()
    }
  );

  return {
    ok: !!updated,
    status: updated?.status || route.status || '',
    error: updated
      ? ''
      : '이미 전달이 시작되었거나 취소할 수 없습니다.'
  };
}

async function ctbGetAutoReturnCancelState(sender) {
  const routes = await ctbReadReturnRoutes();

  const route = routes
    .filter(function(item) {
      return (
        item.sourceTabId === sender?.tab?.id &&
        item.sourceConversationUrl ===
          ctbReturnConversationUrl(sender?.tab?.url)
      );
    })
    .sort(function(a, b) {
      return Number(b.createdAt || 0) -
        Number(a.createdAt || 0);
    })[0] || null;
  let senderIsChatgpt = false;

  try {
    const senderUrl = new URL(sender?.tab?.url || '');

    senderIsChatgpt = !!(
      sender?.tab &&
      Number.isInteger(sender.tab.id) &&
      senderUrl.protocol === 'https:' &&
      ['chatgpt.com', 'chat.openai.com'].includes(
        senderUrl.hostname
      )
    );
  } catch {}

  const routeMatches = !!(
    route &&
    senderIsChatgpt &&
    route.routingVersion === CTB_RETURN_VERSION &&
    route.autoReturn === true
  );
  const canCancel = !!(
    routeMatches &&
    [
      'sending',
      'awaiting_job',
      'awaiting_result',
      'awaiting_gpt'
    ].includes(route.status)
  );

  return {
    ok: true,
    canCancel: canCancel,
    routeId: canCancel ? route.routeId : '',
    status: routeMatches ? String(route.status || '') : '',
    updatedAt: routeMatches
      ? Number(route.updatedAt || 0)
      : 0
  };
}

function ctbValidChainSender(sender, route) {
  return !!(
    sender?.tab &&
    sender.tab.id === route?.sourceTabId &&
    ctbReturnConversationUrl(sender.tab.url) ===
      route?.sourceConversationUrl
  );
}

async function ctbHandleAutoChainStop(message, sender) {
  const route = await ctbReadReturnRoute(message.token);
  const allowedReasons = new Set([
    'gpt_response_not_instruction',
    'gpt_response_timeout',
    'gpt_conversation_changed',
    'gpt_user_message_intervened'
  ]);
  const phase = allowedReasons.has(message.reason)
    ? message.reason
    : 'gpt_response_not_instruction';

  if (
    !route ||
    route.routingVersion !== CTB_RETURN_VERSION ||
    route.chainEnabled !== true ||
    route.routeId !== message.routeId ||
    route.token !== message.token ||
    route.status !== 'awaiting_gpt' ||
    !ctbValidChainSender(sender, route)
  ) {
    return { ok: false, error: '연속 작업 종료 검증 실패' };
  }

  const updated = await ctbChangeReturnRoute(
    route.token,
    ['awaiting_gpt'],
    {
      status: 'chain_stopped',
      phase: phase,
      error: '',
      completedAt: Date.now()
    }
  );

  return {
    ok: !!updated,
    status: updated?.status || route.status
  };
}

async function ctbHandleAutoChainNext(message, sender) {
  const route = await ctbReadReturnRoute(message.token);

  if (
    !route ||
    route.routingVersion !== CTB_RETURN_VERSION ||
    route.chainEnabled !== true ||
    route.routeId !== message.routeId ||
    route.token !== message.token ||
    route.status !== 'awaiting_gpt' ||
    !ctbValidChainSender(sender, route)
  ) {
    return { ok: false, error: '연속 작업 전송 검증 실패' };
  }

  const claimed = await ctbChangeReturnRoute(
    route.token,
    ['awaiting_gpt'],
    {
      status: 'chain_dispatching',
      phase: 'chain_dispatching',
      error: ''
    }
  );

  if (!claimed) {
    return { ok: false, error: '다음 작업 전송 선점 실패' };
  }

  let result;

  try {
    result = await handleAiToTelegram(
      route.sourceTabId,
      true,
      {
        sourceAiTabId: route.sourceTabId,
        sourceAiUrl: route.sourceConversationUrl,
        sourceAiTitle: ''
      },
      true,
      'chain',
      true,
      {
        routeId: route.routeId,
        token: route.token,
        chainCycle: route.chainCycle
      }
    );
  } catch (error) {
    result = {
      ok: false,
      error: error?.message || '다음 작업 전송 실패'
    };
  }

  if (result?.ok !== true) {
    await ctbChangeReturnRoute(
      route.token,
      ['chain_dispatching'],
      {
        status: 'awaiting_gpt',
        phase: 'chain_dispatch_failed',
        error: result?.error || '다음 작업 전송 실패',
        updatedAt: Date.now()
      }
    );
  }

  return result;
}

ctbSyncReturnWatchAlarm().catch(function() {});

// AI → Telegram
async function handleAiToTelegram(
  senderTabId,
  autoSend,
  sourceRequest,
  autoReturn,
  copyTrigger,
  strictRun,
  chainContext
) {
  const transferStartedAt = ctbTransferNow();
  const transferTiming = {
    trigger:
      copyTrigger === 'queued'
        ? 'queued'
        : 'manual',
    clipboardBeforeMs: 0,
    copyTargetReadyMs: 0,
    nativeCaptureMs: 0,
    clipboardAfterMs: 0,
    sourceVerificationMs: 0,
    telegramTransferMs: 0,
    totalTransferMs: 0
  };
  let transferTimingLogged = false;
  const logTransferTiming = function(result) {
    if (transferTimingLogged) return;

    transferTimingLogged = true;
    transferTiming.totalTransferMs =
      ctbTransferNow() - transferStartedAt;

    console.info('[CTB transfer timing]', {
      ...transferTiming,
      result: result
    });
  };

  const sourceAiTab =
    await resolveAiSourceTab(
      sourceRequest,
      senderTabId
    );

  if (!sourceAiTab) {
    return {
      ok: false,
      error:
        '선택한 AI 탭을 찾을 수 없습니다.'
    };
  }

  if (!isAiSourceUrl(sourceAiTab.url)) {
    return {
      ok: false,
      error:
        'AI 원본 탭이 올바르지 않습니다.'
    };
  }

  const expectedSourceSite =
    getAiSourceSite(
      sourceAiTab.url
    );

  const streamRes =
    await sendToTab(
      sourceAiTab.id,
      {
        action: 'checkStreaming'
      }
    ).catch(function() {
      return null;
    });

  if (streamRes?.streaming) {
    return {
      ok: false,
      error:
        'AI가 아직 답변 중이에요.'
    };
  }

  let aiRes =
    await sendToTab(
      sourceAiTab.id,
      {
        action: 'getResponse',
        strictRun: strictRun === true
      }
    );

  if (
    aiRes?.sourceSite !==
      expectedSourceSite ||
    !isAiSourceUrl(
      aiRes?.sourceUrl
    ) ||
    normalizeTabSourceUrl(
      aiRes.sourceUrl
    ) !==
      normalizeTabSourceUrl(
        sourceAiTab.url
      )
  ) {
    return {
      ok: false,
      error:
        'AI 원본 응답 출처를 확인할 수 없습니다.'
    };
  }

  if (
    strictRun === true &&
    (
      expectedSourceSite !== 'chatgpt' ||
      aiRes?.strictRunValid !== true ||
      !ctbChainValidateRunText(aiRes?.text)
    )
  ) {
    return {
      ok: false,
      error: '다음 GPT 답변이 실행 지침 형식이 아닙니다.'
    };
  }

  const strictExpectedText =
    strictRun === true
      ? ctbChainNormalizeRunText(aiRes.text)
      : '';

  if (
    expectedSourceSite === 'chatgpt' &&
    aiRes?.useNativeCodeCopy
  ) {
    try {
      aiRes = {
        ...aiRes,
        text:
          await ctbCaptureChatgptCodeWithFallback(
            sourceAiTab,
            copyTrigger,
            transferTiming
          )
      };
    } catch (e) {
      logTransferTiming('failure');

      return {
        ok: false,
        error:
          e?.message ||
          'ChatGPT 코드박스 복사에 실패했습니다.'
      };
    }
  }

  if (
    strictRun === true &&
    ctbChainNormalizeRunText(aiRes?.text) !==
      strictExpectedText
  ) {
    return {
      ok: false,
      error: '실행 지침 원문 검증에 실패했습니다.'
    };
  }

  if (!aiRes?.text) {
    return {
      ok: false,
      error:
        'AI 응답을 찾을 수 없어요.'
    };
  }

  const tgTab =
    await findTelegramTab();

  if (
    !tgTab ||
    !isTelegramDestinationUrl(
      tgTab.url
    )
  ) {
    logTransferTiming('failure');

    return {
      ok: false,
      error:
        'web.telegram.org 탭을 열고 봇 채팅방을 선택해주세요.'
    };
  }

  let returnRoute = null;

  if (autoReturn === true) {
    const conversationUrl =
      ctbReturnConversationUrl(sourceAiTab.url);

    if (
      autoSend !== true ||
      expectedSourceSite !== 'chatgpt' ||
      !conversationUrl
    ) {
      return {
        ok: false,
        error: '자동회신은 원본 ChatGPT 대화와 Telegram 자동전송이 필요합니다.'
      };
    }

    const previousRoutes =
      await ctbReadReturnRoutes();

    const activeStatuses = [
      'sending',
      'awaiting_job',
      'awaiting_result',
      'delivering',
      'awaiting_gpt',
      'chain_dispatching'
    ];

    const conflictingRoute = previousRoutes.find(
      function(previous) {
        const active =
          activeStatuses.includes(previous.status);

        const replacingClaimedChain = !!(
          chainContext &&
          previous.routeId === chainContext.routeId &&
          previous.token === chainContext.token &&
          previous.status === 'chain_dispatching'
        );

        const withinLimit =
          Date.now() -
          Number(previous.createdAt || 0) <
          12 * 60 * 60 * 1000;

        const sameSourceTab =
          previous.sourceTabId === sourceAiTab.id;

        const sameConversation =
          previous.sourceConversationUrl === conversationUrl;

        return (
          active &&
          !replacingClaimedChain &&
          withinLimit &&
          (sameSourceTab || sameConversation)
        );
      }
    );

    if (conflictingRoute) {
      return {
        ok: false,
        error:
          '이전 GPT 자동회신 작업이 아직 진행 중입니다.'
      };
    }

    returnRoute = {
      routingVersion: CTB_RETURN_VERSION,
      routeId: crypto.randomUUID(),
      token: crypto.randomUUID(),
      autoReturn: true,
      sourceTabId: sourceAiTab.id,
      sourceConversationUrl: conversationUrl,
      telegramTabId: tgTab.id,
      jobId: '',
      sequence: '',
      status: 'sending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: '',
      chainEnabled: true,
      chainCycle:
        Number(chainContext?.chainCycle || 0) + 1
    };

    await ctbWriteReturnRoute(returnRoute);
  }

  let telegramStartedAt = 0;

  try {
    telegramStartedAt = ctbTransferNow();
    const result = await sendToTab(
      tgTab.id,
      {
        action: 'sendToTelegram',
        text: aiRes.text,
        autoSend: !!autoSend,
        ctbReturnToken: returnRoute?.token || ''
      }
    );

    transferTiming.telegramTransferMs =
      ctbTransferNow() - telegramStartedAt;

    if (returnRoute) {
      await ctbChangeReturnRoute(
        returnRoute.token,
        ['sending'],
        {
          status:
            result?.ok === true && result?.sent === true
              ? 'awaiting_job'
              : 'ambiguous',
          error:
            result?.ok === true && result?.sent === true
              ? ''
              : (result?.error || 'Telegram 전송 확인 실패')
        }
      );
    }

    logTransferTiming(
      result?.ok === true
        ? 'success'
        : 'failure'
    );

    return result;
  } catch (error) {
    if (telegramStartedAt) {
      transferTiming.telegramTransferMs =
        ctbTransferNow() - telegramStartedAt;
    }

    logTransferTiming('failure');

    if (returnRoute) {
      try {
        await ctbChangeReturnRoute(
          returnRoute.token,
          ['sending'],
          {
            status: 'ambiguous',
            error: error?.message || 'Telegram 전송 상태 불명'
          }
        );
      } catch {}
    }

    throw error;
  }
}
// Telegram → AI
async function findAiTab(aiTarget) {
  const patterns = { chatgpt: 'https://chatgpt.com/*', claude: 'https://claude.ai/*', gemini: 'https://gemini.google.com/*' };
  var key = typeof aiTarget === 'string' ? aiTarget : (aiTarget && aiTarget.site ? aiTarget.site : null);
  var pattern = key ? (patterns[key] || 'https://chatgpt.com/*') : 'https://chatgpt.com/*';
  return findTab(pattern);
}

async function handleTelegramToAi(senderTabId, autoSend, tgCopyMode, aiTarget, targetTabId) {
  const tgTab = await findTelegramTab();
  if (!tgTab) return { ok: false, error: 'web.telegram.org 탭을 열고 봇 채팅방을 선택해주세요.' };
  var aiTab = null;
  if (targetTabId) {
    try {
      const target = await chrome.tabs.get(targetTabId);
      if (target && isAiUrl(target.url)) aiTab = target;
    } catch(e) { aiTab = null; }
  }
  if (!aiTab && senderTabId) {
    try {
      const senderTab = await chrome.tabs.get(senderTabId);
      if (senderTab && isAiUrl(senderTab.url)) aiTab = senderTab;
    } catch(e) { aiTab = null; }
  }
  if (!aiTab) {
    aiTab = await findAiTab(aiTarget || 'chatgpt');
  }
  if (!aiTab) return { ok: false, error: 'AI 탭을 찾을 수 없습니다.' };

  const tgRes = await sendToTab(tgTab.id, { action: 'getTelegramMessage', tgCopyMode: tgCopyMode || 'all' });
  if (!tgRes?.text) return { ok: false, error: 'Telegram 메시지를 찾을 수 없어요.' };

  return sendToTab(aiTab.id, { action: 'pasteToAI', text: tgRes.text, autoSend });
}



// ────────────────────────────────────────
// DeepSeek API 잔액 모니터
// ────────────────────────────────────────
const DEEPSEEK_BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
const DEEPSEEK_BALANCE_ALARM = 'deepseek-balance-1m';
const DEEPSEEK_API_KEY_KEY = 'bridge_deepseek_api_key';
const DEEPSEEK_BALANCE_STATE_KEY = 'bridge_deepseek_balance_state';
const DEEPSEEK_USAGE_HISTORY_KEY = 'bridge_deepseek_usage_history';
const DEEPSEEK_USAGE_HISTORY_LIMIT = 50;

function bridgeStorageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function bridgeStorageSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function pickDeepSeekBalanceInfo(balanceInfos) {
  if (!Array.isArray(balanceInfos) || !balanceInfos.length) return null;
  const usd = balanceInfos.find(function(info) {
    return info && info.currency === 'USD';
  });
  return usd || balanceInfos[0] || null;
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000000) / 1000000;
}

function createDeepSeekBalanceStatePatch(patch) {
  return Object.assign({
    configured: false,
    status: 'idle',
    currency: 'USD',
    amount: null,
    isAvailable: false,
    updatedAt: Date.now(),
    error: ''
  }, patch || {});
}

async function fetchDeepSeekBalance() {
  const store = await bridgeStorageGet([
    DEEPSEEK_API_KEY_KEY,
    DEEPSEEK_BALANCE_STATE_KEY,
    DEEPSEEK_USAGE_HISTORY_KEY
  ]);

  const apiKey = (store[DEEPSEEK_API_KEY_KEY] || '').trim();
  const previousState = store[DEEPSEEK_BALANCE_STATE_KEY] || null;
  const previousHistory = Array.isArray(store[DEEPSEEK_USAGE_HISTORY_KEY])
    ? store[DEEPSEEK_USAGE_HISTORY_KEY]
    : [];

  if (!apiKey) {
    const noKeyState = createDeepSeekBalanceStatePatch({
      configured: false,
      status: 'no_key',
      amount: null,
      error: 'API 키 없음'
    });

    await bridgeStorageSet({
      [DEEPSEEK_BALANCE_STATE_KEY]: noKeyState
    });

    return {
      ok: false,
      error: 'API 키 없음',
      state: noKeyState,
      history: previousHistory
    };
  }

  try {
    const response = await fetch(DEEPSEEK_BALANCE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const json = await response.json();
    const info = pickDeepSeekBalanceInfo(json.balance_infos);

    if (!info) {
      throw new Error('잔액 정보 없음');
    }

    const currency = info.currency || 'USD';
    const currentAmount = roundMoney(info.total_balance);
    const now = Date.now();

    const nextState = createDeepSeekBalanceStatePatch({
      configured: true,
      status: 'ok',
      currency: currency,
      amount: currentAmount,
      isAvailable: !!json.is_available,
      updatedAt: now,
      error: ''
    });

    let nextHistory = previousHistory.slice(0, DEEPSEEK_USAGE_HISTORY_LIMIT);

    if (
      previousState &&
      previousState.status === 'ok' &&
      previousState.currency === currency &&
      Number.isFinite(Number(previousState.amount)) &&
      Number(previousState.amount) > currentAmount
    ) {
      const usedAmount = roundMoney(Number(previousState.amount) - currentAmount);

      if (usedAmount > 0) {
        nextHistory = [{
          amount: usedAmount,
          currency: currency,
          timestamp: now,
          previousAmount: roundMoney(previousState.amount),
          currentAmount: currentAmount
        }].concat(nextHistory).slice(0, DEEPSEEK_USAGE_HISTORY_LIMIT);
      }
    }

    await bridgeStorageSet({
      [DEEPSEEK_BALANCE_STATE_KEY]: nextState,
      [DEEPSEEK_USAGE_HISTORY_KEY]: nextHistory
    });

    return {
      ok: true,
      state: nextState,
      history: nextHistory
    };
  } catch (e) {
    const errorState = createDeepSeekBalanceStatePatch({
      configured: true,
      status: 'error',
      currency: previousState && previousState.currency ? previousState.currency : 'USD',
      amount: previousState && Number.isFinite(Number(previousState.amount)) ? Number(previousState.amount) : null,
      isAvailable: previousState ? !!previousState.isAvailable : false,
      updatedAt: Date.now(),
      error: e && e.message ? e.message : String(e)
    });

    await bridgeStorageSet({
      [DEEPSEEK_BALANCE_STATE_KEY]: errorState
    });

    return {
      ok: false,
      error: errorState.error,
      state: errorState,
      history: previousHistory
    };
  }
}

function ensureDeepSeekBalanceAlarm() {
  if (!chrome.alarms || !chrome.alarms.create) return;

  chrome.alarms.create(DEEPSEEK_BALANCE_ALARM, {
    periodInMinutes: 1
  });
}

ensureDeepSeekBalanceAlarm();

if (chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(function() {
    ensureDeepSeekBalanceAlarm();
    fetchDeepSeekBalance().catch(function() {});
  });
}

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function() {
    ensureDeepSeekBalanceAlarm();
    fetchDeepSeekBalance().catch(function() {});
  });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(function(alarm) {
    if (alarm && alarm.name === DEEPSEEK_BALANCE_ALARM) {
      fetchDeepSeekBalance().catch(function() {});
    }

    if (
      alarm &&
      alarm.name === CTB_AUTO_RETURN_WATCH_ALARM
    ) {
      ctbQueueReturnMutation(function() {
        return ctbHandleReturnWatchAlarm();
      }).catch(function() {});
    }
  });
}


// ────────────────────────────────────────
// 기존 탭 content.js 자동 주입
//────────────────────────────────────────
const BRIDGE_CONTENT_URL_PATTERNS = [
 'https://claude.ai/*',
 'https://chat.openai.com/*',
 'https://chatgpt.com/*',
 'https://gemini.google.com/*',
 'https://web.telegram.org/*'
];

function isBridgeContentUrl(url) {
 if (!url) return false;

 return url.indexOf('https://claude.ai/') === 0 ||
 url.indexOf('https://chat.openai.com/') === 0 ||
 url.indexOf('https://chatgpt.com/') === 0 ||
 url.indexOf('https://gemini.google.com/') === 0 ||
 url.indexOf('https://web.telegram.org/') === 0;
}

async function injectBridgeContentIntoTab(tabId) {
 if (!tabId || !chrome.scripting || !chrome.scripting.executeScript) return false;

 try {
 await chrome.scripting.executeScript({
 target: { tabId: tabId },
 files: ['content.js']
 });
 return true;
 } catch (e) {
 return false;
 }
}

async function injectBridgeContentIntoOpenTabs() {
 if (!chrome.tabs || !chrome.tabs.query) return;

 const tabs = await chrome.tabs.query({
 url: BRIDGE_CONTENT_URL_PATTERNS
 });

 await Promise.all((tabs || []).map(function(tab) {
 return injectBridgeContentIntoTab(tab.id);
 }));
}

function scheduleBridgeContentInjection() {
 setTimeout(function() {
 injectBridgeContentIntoOpenTabs().catch(function() {});
 }, 1200);
}

scheduleBridgeContentInjection();

if (chrome.runtime && chrome.runtime.onInstalled) {
 chrome.runtime.onInstalled.addListener(function() {
 scheduleBridgeContentInjection();
 });
}

if (chrome.runtime && chrome.runtime.onStartup) {
 chrome.runtime.onStartup.addListener(function() {
 scheduleBridgeContentInjection();
 });
}

if (chrome.tabs && chrome.tabs.onUpdated) {
 chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
 if (changeInfo && changeInfo.status === 'complete' && tab && isBridgeContentUrl(tab.url)) {
 injectBridgeContentIntoTab(tabId).catch(function() {});
 }
 });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const aiTabId = sender.tab?.id;

  if (msg.action === 'getAiTabs') {
    var sId = sender.tab ? sender.tab.id : null;
    chrome.tabs.query({ url: ['https://chatgpt.com/*','https://chat.openai.com/*','https://claude.ai/*','https://gemini.google.com/*'] }, (tabs) => {
      var mapped = tabs.map(function(t){ return { id: t.id, title: t.title, url: t.url }; });
      mapped.sort(function(a,b){ if (a.id === sId) return -1; if (b.id === sId) return 1; return 0; });
      sendResponse({ tabs: mapped, senderTabId: sId });
    });
    return true;
  }

  if (msg.action === 'checkAiTabStreaming') {
    (async () => {
      const aiTab = await resolveAiSourceTab({
        sourceAiTabId: msg.sourceAiTabId,
        sourceAiUrl: msg.sourceAiUrl,
        sourceAiTitle: msg.sourceAiTitle
      }, sender.tab?.id);

      if (!aiTab) {
        sendResponse({
          ok: false,
          streaming: false,
          error: 'AI 탭을 찾을 수 없습니다.'
        });
        return;
      }

      const streamRes = await sendToTab(aiTab.id, { action: 'checkStreaming' }).catch(() => null);

      sendResponse({
        ok: true,
        streaming: !!streamRes?.streaming,
        tabId: aiTab.id,
        title: aiTab.title || '',
        url: aiTab.url || '',
        sourceSite: getAiSourceSite(aiTab.url)
      });
    })();

    return true;
  }

  if (msg.action === 'ctbAutoReturnJob') {
    ctbQueueReturnMutation(function() {
      return ctbHandleReturnJob(msg, sender);
    })
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'ctbAutoReturnReady') {
    ctbQueueReturnMutation(function() {
      return ctbHandleReturnReady(msg, sender);
    })
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'ctbAutoReturnCancel') {
    ctbQueueReturnMutation(function() {
      return ctbHandleReturnCancel(msg, sender);
    })
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'ctbAutoChainNext') {
    ctbQueueReturnMutation(function() {
      return ctbHandleAutoChainNext(msg, sender);
    })
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'ctbAutoChainStop') {
    ctbQueueReturnMutation(function() {
      return ctbHandleAutoChainStop(msg, sender);
    })
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'ctbGetAutoReturnCancelState') {
    ctbGetAutoReturnCancelState(sender)
      .then(sendResponse)
      .catch(function(error) {
        sendResponse({
          ok: false,
          canCancel: false,
          routeId: '',
          status: '',
          error: error?.message || String(error)
        });
      });

    return true;
  }

  if (msg.action === 'aiToTelegram') {
    const performTransfer = function() {
      return handleAiToTelegram(
        aiTabId,
        msg.autoSend,
        {
          sourceAiTabId: msg.sourceAiTabId,
          sourceAiUrl: msg.sourceAiUrl,
          sourceAiTitle: msg.sourceAiTitle
        },
        msg.autoReturn,
        msg.copyTrigger,
        false,
        null
      );
    };

    const transfer =
      msg.autoReturn === true
        ? ctbRunAutoReturnWhenJobSlotReady(
            performTransfer
          )
        : performTransfer();

    transfer
      .then(sendResponse)
      .catch(function(e) {
        sendResponse({
          ok: false,
          error:
            e?.message ||
            String(e)
        });
      });

    return true;
  }
  if (msg.action === 'telegramToAI') {
    handleTelegramToAi(aiTabId, msg.autoSend, msg.tgCopyMode, msg.aiTarget, msg.targetTabId)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// ────────────────────────────────────────
// AI 응답 완료 알림
// ────────────────────────────────────────
const BRIDGE_NOTIFY_POPUP_ENABLED_KEY_BG = 'bridge_notify_popup_enabled';
const BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY_BG = 'bridge_notify_attention_enabled';
const BRIDGE_NOTIFICATION_PREFIX = 'bridge-complete-';

function getBridgeNotificationIconUrl() {
 try {
 const manifest = chrome.runtime.getManifest();
 const icons = manifest && manifest.icons ? manifest.icons : {};
 const iconPath = icons['128'] || icons['48'] || icons['32'] || icons['16'];

 if (iconPath) {
 return chrome.runtime.getURL(iconPath);
 }
 } catch (e) {}

 return chrome.runtime.getURL('bridge-notification-icon.png');
}

function getBridgeNotifySettings(callback) {
 chrome.storage.local.get({
 [BRIDGE_NOTIFY_POPUP_ENABLED_KEY_BG]: true,
 [BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY_BG]: true
 }, (res) => {
 callback({
 popupEnabled: res[BRIDGE_NOTIFY_POPUP_ENABLED_KEY_BG] !== false,
 attentionEnabled: res[BRIDGE_NOTIFY_ATTENTION_ENABLED_KEY_BG] !== false
 });
 });
}

function drawBridgeNotificationAttention(tab) {
 if (!tab || !tab.windowId || !chrome.windows || !chrome.windows.update) return;

 try {
 chrome.windows.update(tab.windowId, { drawAttention: true }, () => {
 void chrome.runtime.lastError;
 });
 } catch (e) {}
}

function focusBridgeNotificationTab(notificationId) {
 if (!notificationId || notificationId.indexOf(BRIDGE_NOTIFICATION_PREFIX) !== 0) return;

 const rest = notificationId.slice(BRIDGE_NOTIFICATION_PREFIX.length);
 const tabIdText = rest.split('-')[0];
 const tabId = Number(tabIdText);

 if (!Number.isFinite(tabId) || !chrome.tabs || !chrome.tabs.get) return;

 chrome.tabs.get(tabId, (tab) => {
 if (chrome.runtime.lastError || !tab) return;

 if (chrome.windows && chrome.windows.update && tab.windowId) {
 chrome.windows.update(tab.windowId, { focused: true, drawAttention: false }, () => {
 void chrome.runtime.lastError;
 });
 }

 chrome.tabs.update(tabId, { active: true }, () => {
 void chrome.runtime.lastError;
 });
 });

 if (chrome.notifications && chrome.notifications.clear) {
 chrome.notifications.clear(notificationId, () => {
 void chrome.runtime.lastError;
 });
 }
}

function createBridgeNotification(tab, payload, sendResponse) {
 getBridgeNotifySettings((settings) => {
 if (settings.attentionEnabled) {
 drawBridgeNotificationAttention(tab);
 }

 if (!settings.popupEnabled) {
 sendResponse({ ok: true, popup: 'disabled', attention: settings.attentionEnabled });
 return;
 }

 if (!chrome.notifications || !chrome.notifications.create) {
 sendResponse({ ok: false, error: 'notifications_unavailable', attention: settings.attentionEnabled });
 return;
 }

 const tabId = tab && tab.id ? tab.id : 0;
 const type = payload && payload.type ? String(payload.type) : 'complete';
 const notificationId = BRIDGE_NOTIFICATION_PREFIX + tabId + '-' + type + '-' + Date.now();

 chrome.notifications.create(notificationId, {
 type: 'basic',
 iconUrl: getBridgeNotificationIconUrl(),
 title: payload && payload.title ? payload.title : '작업 완료',
 message: payload && payload.message ? payload.message : '새 작업 상태가 도착했습니다.',
 priority: 2
 }, () => {
 const err = chrome.runtime.lastError;
 if (err) {
 sendResponse({ ok: false, error: err.message, attention: settings.attentionEnabled });
 return;
 }

 sendResponse({ ok: true, notificationId, attention: settings.attentionEnabled });
 });
 });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
 if (!msg || msg.action !== 'bridgeNotifyComplete') return false;

 // Telegram은 자체 알림을 사용하고 확장프로그램 알림에서는 제외한다.
 if (msg.type !== 'ai') {
 sendResponse({ ok: true, ignored: 'non_ai_notification' });
 return false;
 }

 createBridgeNotification(sender && sender.tab ? sender.tab : null, msg, sendResponse);
 return true;
});

if (chrome.notifications && chrome.notifications.onClicked) {
 chrome.notifications.onClicked.addListener((notificationId) => {
 focusBridgeNotificationTab(notificationId);
 });
}
