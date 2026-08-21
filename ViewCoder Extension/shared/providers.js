(() => {
  "use strict";

  const common = Object.freeze({
    codeSelectors: [
      "pre code",
      "pre[data-language]",
      "[class*='code-block' i] pre",
      "code[class*='language-']",
      "[data-language] code",
    ],
    sendSelectors: [
      "button[type='submit']",
      "button[aria-label*='send' i]",
    ],
    stopSelectors: [
      "button[aria-label*='stop' i]",
      "button[title*='stop' i]",
      "button[aria-label*='cancel generation' i]",
    ],
    thinkingSelectors: [
      "[class*='thinking' i]",
      "[data-testid*='thinking' i]",
    ],
    generationSelectors: [],
    commandWrapperSelectors: ["pre"],
    commandMaskRootSelectors: [],
    replySelectors: [],
    userTurnSelectors: [
      "[data-message-author-role='user']",
      "[data-testid*='user-message' i]",
      "[data-author='user']",
      ".user-message",
    ],
    assistantTurnSelectors: [
      "[data-message-author-role='assistant']",
      "[data-testid*='assistant-message' i]",
      "[data-author='assistant']",
      ".assistant-message",
      "model-response",
    ],
    turnSelectors: [
      "[data-message-author-role]",
      "[data-testid*='message' i]",
      "[data-virtual-list-item-key]",
      "article",
    ],
  });

  function adapter(overrides) {
    const result = {};
    for (const key of Object.keys(common)) {
      result[key] = Object.freeze([
        ...(overrides[key] ?? []),
        ...common[key],
      ]);
    }
    result.editorSelectors = Object.freeze(
      overrides.editorSelectors ?? [],
    );
    result.composerSelectors = Object.freeze(
      overrides.composerSelectors ?? [],
    );
    return Object.freeze(result);
  }

  globalThis.ViewCoderProviders = Object.freeze([
    {
      id: "deepseek",
      name: "DeepSeek",
      domain: "chat.deepseek.com",
      url: "https://chat.deepseek.com/",
      hosts: ["chat.deepseek.com"],
      accent: "#5b79ff",
      adapter: adapter({
        editorSelectors: [
          "textarea",
          "textarea[placeholder*='message' i]",
          "#chat-input",
          "[data-testid*='chat-input' i]",
          "[contenteditable='true'][role='textbox']",
        ],
        composerSelectors: [
          "form",
          "[class*='chat-input' i]",
          "[class*='composer' i]",
        ],
        codeSelectors: [
          ".ds-markdown pre code",
          ".ds-markdown pre",
          ".ds-markdown code[class*='language-']",
        ],
        generationSelectors: [".ds-loading"],
        commandWrapperSelectors: [".ds-markdown pre"],
        commandMaskRootSelectors: [".ds-message"],
        replySelectors: [".ds-markdown"],
        sendSelectors: [".ds-button--primary"],
        stopSelectors: [
          "button[aria-label*='stop' i]",
          "button[title*='stop' i]",
          ".ds-button--primary[aria-label*='stop' i]",
        ],
        thinkingSelectors: [".ds-think-content"],
        userTurnSelectors: [
          ".ds-message.d29f3d7d",
          ".ds-message:has(.d29f3d7d)",
          ".ds-message:has(.fbb737a4)",
          ".d29f3d7d",
          ".fbb737a4",
          "[data-role='user']",
          "[class*='user-message' i]",
        ],
        assistantTurnSelectors: [
          ".ds-message:has(.ds-markdown)",
          ".ds-markdown",
          "[data-role='assistant']",
          "[class*='assistant-message' i]",
        ],
        turnSelectors: [".ds-message"],
      }),
    },
    {
      id: "gemini",
      name: "Google Gemini",
      domain: "gemini.google.com",
      url: "https://gemini.google.com/app",
      hosts: ["gemini.google.com"],
      accent: "#8ab4f8",
      adapter: adapter({
        editorSelectors: [
          ".ql-editor[contenteditable='true'][role='textbox']",
          ".ql-editor[contenteditable='true']",
          "[contenteditable='true'][aria-label*='prompt' i]",
        ],
        composerSelectors: [
          ".input-area-container",
          ".input-area",
          ".text-input-field",
          "input-area-v2",
          "form",
        ],
        codeSelectors: [
          "model-response code-block",
          "model-response code-block code",
          "message-content code-block",
          "message-content code-block code",
          "model-response pre code",
          "model-response pre",
          ".markdown-main-panel pre code",
        ],
        commandWrapperSelectors: [
          "code-block",
          "pre",
        ],
        commandMaskRootSelectors: [
          "message-content",
          "model-response",
        ],
        replySelectors: [
          "message-content",
          "structured-content-container.model-response-text",
          "model-response",
        ],
        sendSelectors: [
          "input-area-v2 button",
          "button.send-button",
          "button[aria-label*='send message' i]",
          "button[aria-label*='send prompt' i]",
        ],
        stopSelectors: [
          "button[aria-label*='stop response' i]",
          "button.stop",
        ],
        thinkingSelectors: ["model-thoughts"],
        userTurnSelectors: ["user-query"],
        assistantTurnSelectors: [
          "model-response",
          "message-content",
          "structured-content-container.model-response-text",
          ".model-response-text",
          "[data-message-author-role='assistant']",
          "[data-testid*='assistant' i]",
          "[class*='assistant-response' i]",
        ],
        turnSelectors: [
          "user-query",
          "model-response",
          ".conversation-container",
        ],
      }),
    },
    {
      id: "kimi",
      name: "Kimi Chat",
      domain: "kimi.com",
      url: "https://www.kimi.com/",
      hosts: [
        "kimi.moonshot.cn",
        "kimi.com",
        "www.kimi.com",
      ],
      accent: "#ff8b63",
      adapter: adapter({
        editorSelectors: [
          ".chat-input-editor",
          ".chat-input-editor[contenteditable='true']",
          "[data-lexical-editor='true'][role='textbox']",
          "[contenteditable='true'][role='textbox']",
          "textarea[placeholder*='ask' i]",
        ],
        composerSelectors: [
          ".chat-box",
          ".chat-editor",
          "[class*='chat-input' i]",
          "[class*='composer' i]",
          "form",
        ],
        codeSelectors: [
          ".segment-assistant .segment-code",
          "[class*='markdown' i] pre code",
          "[class*='markdown' i] pre",
          "[class*='segment-code' i] code",
        ],
        generationSelectors: [
          ".send-button-container.stop",
        ],
        commandWrapperSelectors: [
          ".segment-code",
          "pre",
        ],
        commandMaskRootSelectors: [
          ".segment-content-box",
          ".segment-assistant",
        ],
        replySelectors: [".segment-content-box"],
        sendSelectors: [
          ".send-button-container",
          "button[class*='send' i]",
          "[class*='send-button' i]",
        ],
        stopSelectors: [
          ".send-button-container.stop",
          "button[class*='stop' i]",
          "[class*='stop-button' i]",
        ],
        thinkingSelectors: [".thinking-container"],
        userTurnSelectors: [
          ".segment-user",
          "[class*='message-user' i]",
        ],
        assistantTurnSelectors: [
          ".segment-assistant",
          "[class*='message-assistant' i]",
        ],
        turnSelectors: [".segment"],
      }),
    },
    {
      id: "glm",
      name: "Z.ai / GLM",
      domain: "chat.z.ai",
      url: "https://chat.z.ai/",
      hosts: ["chat.z.ai"],
      accent: "#8b7cff",
      adapter: adapter({
        editorSelectors: [
          "#chat-input",
          "textarea[placeholder*='help' i]",
          "[contenteditable='true'][role='textbox']",
        ],
        composerSelectors: [
          ".messageInputContainer",
          "form",
          "[class*='chat-input' i]",
        ],
        codeSelectors: [
          ".chat-assistant div[class*='rounded-xl']:has(.copy-code-button)",
          ".chat-assistant .cm-editor",
          "[class*='markdown' i] pre code",
          "[class*='markdown' i] pre",
          "[class*='prose' i] pre code",
        ],
        commandWrapperSelectors: [
          "div[class*='rounded-xl']:has(.copy-code-button)",
          ".cm-editor",
          "pre",
        ],
        commandMaskRootSelectors: [
          ".chat-assistant",
        ],
        replySelectors: [".chat-assistant"],
        sendSelectors: [
          "#send-message-button",
          ".sendMessageButton",
        ],
        stopSelectors: [
          "button[class*='stop' i]",
          "#stop-message-button",
        ],
        thinkingSelectors: [".thinking-chain-container"],
        userTurnSelectors: [".user-message"],
        assistantTurnSelectors: [".chat-assistant"],
        turnSelectors: [
          ".user-message",
          ".chat-assistant",
        ],
      }),
    },
    {
      id: "qwen",
      name: "Qwen",
      domain: "chat.qwen.ai",
      url: "https://chat.qwen.ai/",
      hosts: ["chat.qwen.ai"],
      accent: "#8a73ff",
      adapter: adapter({
        editorSelectors: [
          "textarea.message-input-textarea",
          "textarea[placeholder*='help' i]",
          "[contenteditable='true'][role='textbox']",
          "[data-testid*='chat-input' i]",
        ],
        composerSelectors: [
          ".message-input-wrapper",
          "[class*='message-input' i]",
          "[class*='chat-input' i]",
          "[class*='composer' i]",
          "form",
        ],
        codeSelectors: [
          ".qwen-chat-message-assistant pre.qwen-markdown-code",
          "[class*='markdown' i] pre code",
          "[class*='markdown' i] pre",
          "[class*='message-content' i] pre code",
        ],
        commandWrapperSelectors: [
          "pre.qwen-markdown-code",
          "pre",
        ],
        commandMaskRootSelectors: [
          ".response-message-content",
          ".qwen-chat-message-assistant",
        ],
        replySelectors: [".response-message-content"],
        sendSelectors: [
          "button.send-button",
          ".message-input-right-button-send button",
          "button[class*='send' i]",
          ".message-input-send-button",
        ],
        stopSelectors: [
          "button.stop-button",
          "button[class*='stop' i]",
        ],
        thinkingSelectors: [
          ".qwen-chat-thinking-tool-status-card-wraper",
        ],
        userTurnSelectors: [
          ".qwen-chat-message-user",
          "[class*='message-user' i]",
          "[data-message-author-role='user']",
        ],
        assistantTurnSelectors: [
          ".qwen-chat-message-assistant",
          "[class*='message-assistant' i]",
          "[data-message-author-role='assistant']",
        ],
        turnSelectors: [".qwen-chat-message"],
      }),
    },
    {
      id: "arena",
      name: "LMSYS Arena",
      domain: "arena.ai",
      url: "https://arena.ai/",
      hosts: ["arena.ai", "lmarena.ai", "www.lmarena.ai"],
      accent: "#39c99b",
      adapter: adapter({
        editorSelectors: [
          "form textarea",
          "textarea[name='message']",
          "textarea[placeholder*='Ask anything' i]",
          "[contenteditable='true'][role='textbox']",
        ],
        composerSelectors: ["form"],
        codeSelectors: [
          "ol.flex-col-reverse div.not-prose:has(pre)",
          "[data-message-author-role='assistant'] pre code",
          "[data-message-author-role='assistant'] pre",
          "[class*='prose' i] pre code",
        ],
        commandWrapperSelectors: [
          "div.not-prose:has(pre)",
          "pre",
        ],
        commandMaskRootSelectors: [
          "[data-message-author-role='assistant']",
          "ol.flex-col-reverse > *:has(.prose)",
        ],
        replySelectors: [".prose"],
        sendSelectors: [
          "button[aria-label='Send message']",
        ],
        stopSelectors: [
          "button[aria-label*='stop' i]",
        ],
        assistantTurnSelectors: [
          "[data-message-author-role='assistant']",
          "ol.flex-col-reverse > *:has(.prose):not(:has(.justify-end))",
          "[class*='prose' i]",
        ],
        userTurnSelectors: [
          "[data-message-author-role='user']",
          "ol.flex-col-reverse > *:has(.justify-end)",
        ],
        turnSelectors: ["ol.flex-col-reverse > *"],
      }),
    },
    {
      id: "meta",
      name: "Meta AI",
      domain: "meta.ai",
      url: "https://www.meta.ai/",
      hosts: ["meta.ai", "www.meta.ai"],
      accent: "#31a1ff",
      adapter: adapter({
        editorSelectors: [
          "[data-testid='composer-input']",
          "input[aria-label='Ask Meta AI']",
          "input[placeholder*='Ask Meta AI' i]",
          "[contenteditable='true'][role='textbox']",
          "textarea[placeholder*='Ask Meta' i]",
        ],
        composerSelectors: [
          "form",
          "[class*='composer' i]",
        ],
        codeSelectors: [
          "[data-testid='assistant-message'] .ur-code-block",
          "[data-testid*='assistant' i] pre code",
          "[data-testid*='assistant' i] pre",
          "[class*='message' i] pre code",
        ],
        commandWrapperSelectors: [
          ".ur-code-block",
          "pre",
        ],
        commandMaskRootSelectors: [
          "[data-testid='assistant-message']",
        ],
        replySelectors: [
          "[data-testid='assistant-message']",
        ],
        sendSelectors: [
          "[data-testid='composer-send-button']",
          "button[aria-label='Send']",
        ],
        stopSelectors: [
          "[data-testid='composer-stop-button']",
          "button[aria-label*='stop' i]",
        ],
        thinkingSelectors: [
          "[data-testid='thinking-status']",
          "[data-testid='subagent-cot-list']",
        ],
        assistantTurnSelectors: [
          "[data-testid='assistant-message']",
          "[data-testid*='assistant' i]",
          "[data-message-author-role='assistant']",
        ],
        userTurnSelectors: [
          "[data-testid='user-message']",
          "[data-message-author-role='user']",
        ],
        turnSelectors: [
          "[data-testid*='message' i]",
          "[class*='message' i]",
        ],
      }),
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      domain: "chatgpt.com",
      url: "https://chatgpt.com/",
      hosts: ["chatgpt.com", "chat.openai.com"],
      accent: "#10a37f",
      adapter: adapter({
        editorSelectors: [
          "#prompt-textarea",
          "[contenteditable='true'][data-virtualkeyboard='true']",
          "[contenteditable='true'][role='textbox']",
          "textarea[placeholder*='message' i]",
        ],
        composerSelectors: [
          "form[data-type='unified-composer']",
          "form",
          "[class*='composer' i]",
        ],
        codeSelectors: [
          "[data-message-author-role='assistant'] pre code",
          "[data-message-author-role='assistant'] pre",
          ".markdown pre code",
          ".markdown pre",
        ],
        commandWrapperSelectors: ["pre"],
        commandMaskRootSelectors: [
          "[data-message-author-role='assistant']",
          "article:has([data-message-author-role='assistant'])",
        ],
        replySelectors: [
          "[data-message-author-role='assistant'] .markdown",
          "[data-message-author-role='assistant']",
        ],
        sendSelectors: [
          "button[data-testid='send-button']",
          "button[aria-label*='send' i]",
        ],
        stopSelectors: [
          "button[data-testid='stop-button']",
          "button[aria-label*='stop' i]",
        ],
        thinkingSelectors: [
          "[data-testid*='thinking' i]",
          "[class*='reasoning' i]",
        ],
        assistantTurnSelectors: [
          "[data-message-author-role='assistant']",
        ],
        userTurnSelectors: [
          "[data-message-author-role='user']",
        ],
        turnSelectors: [
          "article:has([data-message-author-role])",
          "[data-message-author-role]",
        ],
      }),
    },
    {
      id: "claude",
      name: "Claude",
      domain: "claude.ai",
      url: "https://claude.ai/new",
      hosts: ["claude.ai"],
      accent: "#d97757",
      adapter: adapter({
        editorSelectors: [
          "[data-testid='chat-input']",
          "[contenteditable='true'][aria-label='Write your prompt to Claude']",
        ],
        composerSelectors: [
          "fieldset:has([data-testid='chat-input'])",
          "fieldset",
        ],
        codeSelectors: [
          "[data-is-streaming] .font-claude-response pre code",
          "[data-is-streaming] .font-claude-response pre",
        ],
        commandWrapperSelectors: ["pre"],
        commandMaskRootSelectors: [
          "[data-is-streaming]:has(.font-claude-response)",
        ],
        replySelectors: [
          "[data-is-streaming] .font-claude-response",
          ".font-claude-response",
        ],
        sendSelectors: [
          "button[aria-label='Send message']",
        ],
        stopSelectors: [
          "button[aria-label*='stop' i]",
          "button[data-testid*='stop' i]",
        ],
        thinkingSelectors: [
          "[data-testid*='thinking' i]",
          "[class*='thinking' i]",
        ],
        assistantTurnSelectors: [
          "[data-is-streaming]:has(.font-claude-response)",
        ],
        userTurnSelectors: [
          "[data-testid='user-message']",
        ],
        turnSelectors: [
          "[data-testid='user-message']",
          "[data-is-streaming]:has(.font-claude-response)",
        ],
      }),
    },
  ]);

  globalThis.ViewCoderProviderForHost = function providerForHost(
    hostname,
  ) {
    const normalized = String(hostname || "").toLowerCase();
    return globalThis.ViewCoderProviders.find((provider) =>
      provider.hosts.includes(normalized),
    );
  };
})();
