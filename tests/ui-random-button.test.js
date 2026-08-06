const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const rootDir = path.join(__dirname, "..");

function readProjectFile(filename) {
  return fs.readFileSync(path.join(rootDir, filename), "utf8");
}

test("main page removes duplicate gallery shortcut and includes random generation button", () => {
  const html = readProjectFile("index.html");

  assert.ok(!html.includes("brand-back"));
  assert.ok(!html.includes(">打开图片库</a>"));
  assert.ok(html.includes('id="random-generate-button"'));
  assert.ok(html.includes(">随机生图</button>"));
});

test("main page uses compact single-line product name", () => {
  const html = readProjectFile("index.html");
  const styles = readProjectFile("styles.css");

  assert.ok(html.includes("<title>图生图长 · AI创作台</title>"));
  assert.ok(html.includes('<h1 class="brand-title">图生图长 · AI创作台</h1>'));
  assert.ok(styles.includes(".brand-title"));
  assert.ok(styles.includes("white-space: nowrap;"));
});

test("random generation has thirty built-in prompts and submits through the existing composer", () => {
  const config = readProjectFile("app-config.js");
  const script = readProjectFile("app.js");
  const promptMatches = config.match(/title:\s*"/g) || [];

  assert.strictEqual(promptMatches.length, 30);
  assert.ok(script.includes("randomGenerateButton"));
  assert.ok(script.includes("function startRandomGeneration()"));
  assert.ok(script.includes("elements.composer.requestSubmit()"));
});

test("main page includes batch generation controls", () => {
  const html = readProjectFile("index.html");

  assert.ok(html.includes('id="task-mode-switch"'));
  assert.ok(html.includes('data-task-mode="single"'));
  assert.ok(html.includes('data-task-mode="batch"'));
  assert.ok(html.includes('id="batch-prompt-input"'));
  assert.ok(html.includes('id="clear-batch-prompts"'));
  assert.ok(html.includes('id="batch-panel"'));
  assert.ok(html.includes('id="batch-queue-list"'));
});

test("main page no longer includes image-to-image / reverse prompt controls", () => {
  const html = readProjectFile("index.html");

  assert.ok(html.includes('id="control-deck"'));
  assert.ok(html.includes('id="model-channel-link"'));
  assert.ok(!html.includes('data-mode="reverse"'));
  assert.ok(!html.includes(">图片反推</button>"));
  assert.ok(!html.includes('data-mode="edit"'));
  assert.ok(!html.includes(">图生图</button>"));
  assert.ok(!html.includes('id="upload-label"'));
  assert.ok(!html.includes('id="source-image-input"'));
  assert.ok(html.includes('id="generation-options-grid"'));
  assert.ok(html.includes('id="image-quality"'));
  assert.ok(html.includes('id="task-mode-field"'));
  assert.ok(!html.includes('id="gpt-api-key"'));
  assert.ok(!html.includes('id="gpt-api-key-field"'));
  assert.ok(!html.includes('id="reverse-api-key"'));
  assert.ok(!html.includes('id="api-key"'));
  assert.ok(!html.includes('id="base-url"'));
});

test("image reverse prompt and Gemini reverse inference are removed from the project", () => {
  const config = readProjectFile("app-config.js");
  const script = readProjectFile("app.js");

  assert.ok(!config.includes('reverseApiKey: "jiaoge-ai-toolbox:gemini-reverse-api-key"'));
  assert.ok(!config.includes("REVERSE_PROMPT_MODEL"));
  assert.ok(!config.includes("OFFICIAL_FALLBACK_MODEL"));
  assert.ok(!config.includes("generateReversePrompt"));
  assert.ok(!script.includes("function generateReversePrompt("));
  assert.ok(!script.includes("skipSave: true"));
  assert.ok(!script.includes("result.skipSave"));
  assert.ok(!config.includes("English Prompt:"));
  assert.ok(!config.includes("99% 视觉相似度"));
});

test("control deck is reduced to model selection and channel settings", () => {
  const html = readProjectFile("index.html");
  const styles = readProjectFile("styles.css");

  assert.ok(html.includes('id="model-name"'));
  assert.ok(html.includes('id="model-channel-link"'));
  assert.ok(!html.includes('id="toggle-control-deck"'));
  assert.ok(!html.includes('id="control-stack"'));
  assert.ok(styles.includes(".model-channel-card"));
  assert.ok(!styles.includes("max-height: min(720px, calc(100vh - 190px));"));
});

test("preview panel can be collapsed and remembers state", () => {
  const html = readProjectFile("index.html");
  const config = readProjectFile("app-config.js");
  const script = readProjectFile("app.js");
  const styles = readProjectFile("styles.css");

  assert.ok(html.includes('id="toggle-preview-panel"'));
  assert.ok(html.includes('id="preview-panel"'));
  assert.ok(html.includes('id="chat-workspace"'));
  assert.ok(config.includes('previewPanelCollapsed: "jiaoge-ai-toolbox:preview-panel-collapsed"'));
  assert.ok(script.includes("function setPreviewPanelCollapsed(collapsed)"));
  assert.ok(script.includes("function initPreviewPanelCollapse()"));
  assert.ok(script.includes("togglePreviewPanel.addEventListener"));
  assert.ok(styles.includes(".chat-panel.is-collapsed"));
  assert.ok(styles.includes(".chat-workspace[hidden]"));
});

test("dynamic image channel system supports multiple APIs with names and modes", () => {
  const config = readProjectFile("app-config.js");
  const utils = readProjectFile("app-utils.js");
  const settingsHtml = readProjectFile("settings.html");
  const settingsScript = readProjectFile("settings.js");
  const script = readProjectFile("app.js");
  const styles = readProjectFile("styles.css");

  // 新的存储键
  assert.ok(config.includes('imageChannels: "jiaoge-ai-toolbox:image-channels-v1"'));

  // 通道类型定义
  assert.ok(config.includes("CHANNEL_TYPES"));
  assert.ok(config.includes('"openai_images"'));
  assert.ok(config.includes('"agnes"'));
  assert.ok(!config.includes('value: "gemini"'));

  // 通道模式定义
  assert.ok(config.includes("CHANNEL_MODES"));
  assert.ok(config.includes('"auto"'));
  assert.ok(config.includes('"sync"'));
  assert.ok(config.includes('"async"'));

  // 默认通道和迁移
  assert.ok(config.includes("getDefaultImageChannels"));
  assert.ok(config.includes("migrateImageChannels"));

  // 工具函数
  assert.ok(utils.includes("getImageChannels"));
  assert.ok(utils.includes("saveImageChannels"));
  assert.ok(utils.includes("getImageChannelById"));
  assert.ok(utils.includes("getImageChannelByModel"));
  assert.ok(utils.includes("createChannelId"));

  // 设置页 HTML 结构
  assert.ok(settingsHtml.includes('id="image-channel-list"'));
  assert.ok(settingsHtml.includes('id="add-image-channel-btn"'));
  assert.ok(settingsHtml.includes('data-channel="image-channels"'));

  // 设置页 JS 逻辑
  assert.ok(settingsScript.includes("renderChannelList"));
  assert.ok(settingsScript.includes("renderChannelCard"));
  assert.ok(settingsScript.includes("saveChannelFromCard"));
  assert.ok(settingsScript.includes("testChannelFromCard"));
  assert.ok(settingsScript.includes("deleteChannel"));
  assert.ok(settingsScript.includes("addChannel"));
  assert.ok(settingsScript.includes("callImageChannel"));

  // 前台生图调度
  assert.ok(script.includes("generateImageChannel"));
  assert.ok(script.includes("getImageChannelByModel"));

  // CSS 样式
  assert.ok(styles.includes(".image-channel-card"));
  assert.ok(styles.includes(".ch-card-header"));
  assert.ok(styles.includes(".ch-card-actions"));
  assert.ok(styles.includes(".ch-test-result"));
});

test("image channels support sync and async auto-detection", () => {
  const utils = readProjectFile("app-utils.js");
  const script = readProjectFile("app.js");
  const settingsScript = readProjectFile("settings.js");

  // extractSyncImageUrls 函数
  assert.ok(script.includes("extractSyncImageUrls") || settingsScript.includes("extractSyncImages"));
  assert.ok(settingsScript.includes("extractSyncImages") || script.includes("extractSyncImageUrls"));

  // 异步轮询
  assert.ok(script.includes("pollGptImageTask") || settingsScript.includes("pollTaskResult"));
  assert.ok(settingsScript.includes("pollTaskResult") || script.includes("pollGptImageTask"));
});

test("gemini 2.5 flash image is removed from the project", () => {
  const script = readProjectFile("app.js");
  const historyIndex = readProjectFile("generated-images/index.json");

  assert.ok(!script.includes("gemini-2.5-flash-image"));
  assert.ok(!historyIndex.includes("gemini-2.5-flash-image"));
});

test("batch generation parses blank-line separated prompts and runs sequentially", () => {
  const script = readProjectFile("app.js");
  const utils = readProjectFile("app-utils.js");

  assert.ok(utils.includes("parseBatchPrompts = function") || script.includes("function parseBatchPrompts(text)"));
  assert.ok(script.includes("function startBatchGeneration()"));
  assert.ok(script.includes("function clearBatchPrompts()"));
  assert.ok(script.includes("batchPromptInput"));
  assert.ok(script.includes("clearBatchPrompts"));
  assert.ok(script.includes("batchQueueList"));
  assert.ok(script.includes("Math.random() * 1000"));
  assert.ok(script.includes("failedCount += 1"));
  assert.ok(script.includes("entry.status = \"error\""));
  assert.ok(script.includes("function scrollBatchQueueItemIntoView(entryId)"));
  assert.ok(script.includes("renderBatchQueue(nextEntry ? nextEntry.id : entry.id)"));
  assert.ok(script.includes("if (index < state.batchQueue.length - 1)"));
});

test("preview and history panels use adjusted scrollable heights", () => {
  const styles = readProjectFile("styles.css");

  assert.ok(styles.includes("height: var(--chat-panel-height, min(1940px, calc(200vh - 380px)));"));
  assert.ok(styles.includes("max-height: 360px;"));
  assert.ok(styles.includes("overscroll-behavior: contain;"));
});

test("action buttons use compact Muji-style visual hierarchy", () => {
  const styles = readProjectFile("styles.css");
  const galleryStyles = readProjectFile("gallery.css");

  assert.ok(styles.includes("--button-paper: rgba(255, 253, 248, 0.82);"));
  assert.ok(styles.includes("min-height: 38px;"));
  assert.ok(styles.includes("border-radius: 8px;"));
  assert.ok(styles.includes("background: var(--button-primary);"));
  assert.ok(styles.includes(".ghost-button.danger:hover"));

  assert.ok(galleryStyles.includes("--button-paper:") === false, "CSS 变量已统一到 styles.css");
  assert.ok(galleryStyles.includes(".download-link"));
  assert.ok(galleryStyles.includes("#delete-selected-records"));
  assert.ok(galleryStyles.includes(".delete-record-button"));
  assert.ok(galleryStyles.includes(".record-pick"));
});
