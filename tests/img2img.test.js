/**
 * 图生图工作台板块测试
 *
 * 两层验证：
 * 1. 真实逻辑：用 node:vm 沙箱加载 app-config.js / app-utils.js（mock window），
 *    实际执行图生图依赖的纯函数（比例匹配、视觉消息构建、既有生图尺寸回归）
 * 2. 结构与集成：断言 img2img 三件套的页面结构、关键函数、
 *    各页面入口链接与 README 文档均已就位
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");

const rootDir = path.join(__dirname, "..");

function readProjectFile(filename) {
  return fs.readFileSync(path.join(rootDir, filename), "utf8");
}

/** 构造内存版 localStorage mock */
function createMockStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  };
}

/**
 * 在 vm 沙箱中依次加载 app-config.js 与 app-utils.js，
 * 返回挂到 window.__APP 上的命名空间（真实执行全部顶层逻辑）。
 * 注意：页面脚本同时使用 `window.__APP` 与裸 `__APP`（浏览器中两者等价），
 * 因此沙箱里让 window 对象自身充当全局对象（window.window = window）。
 */
function loadAppNamespace() {
  const storage = createMockStorage();
  const quietConsole = { log() {}, warn() {}, error() {} };
  const windowObj = { localStorage: storage, console: quietConsole };
  windowObj.window = windowObj;
  const context = vm.createContext(windowObj);
  vm.runInContext(readProjectFile("app-config.js"), context, { filename: "app-config.js" });
  vm.runInContext(readProjectFile("app-utils.js"), context, { filename: "app-utils.js" });
  return { __APP: windowObj.__APP, storage };
}

// ==================== 真实逻辑测试 ====================

test("pickNearestAspectRatio matches the closest preset for landscape, portrait and square images", () => {
  const { __APP } = loadAppNamespace();
  const ratios = [
    { value: "1:1" },
    { value: "3:4" },
    { value: "4:3" },
    { value: "9:16" },
    { value: "16:9" },
    { value: "21:9" }
  ];

  // 横图 1920×1080 → 16:9
  assert.strictEqual(__APP.pickNearestAspectRatio(1920, 1080, ratios), "16:9");
  // 竖图 1080×1920 → 9:16
  assert.strictEqual(__APP.pickNearestAspectRatio(1080, 1920, ratios), "9:16");
  // 方图 800×800 → 1:1
  assert.strictEqual(__APP.pickNearestAspectRatio(800, 800, ratios), "1:1");
  // 竖版海报 900×1200（0.75）→ 3:4
  assert.strictEqual(__APP.pickNearestAspectRatio(900, 1200, ratios), "3:4");
  // 横版画幅 1200×900 → 4:3
  assert.strictEqual(__APP.pickNearestAspectRatio(1200, 900, ratios), "4:3");
  // 超宽 2560×1080（≈2.37）→ 21:9
  assert.strictEqual(__APP.pickNearestAspectRatio(2560, 1080, ratios), "21:9");
});

test("pickNearestAspectRatio tolerates invalid sizes and custom preset lists", () => {
  const { __APP } = loadAppNamespace();

  // 非法尺寸按 1 处理，不抛异常：双方均非法时回落 1:1
  assert.strictEqual(__APP.pickNearestAspectRatio(0, 0), "1:1");
  assert.strictEqual(__APP.pickNearestAspectRatio(-5, -100), "1:1");
  assert.strictEqual(__APP.pickNearestAspectRatio(undefined, null), "1:1");
  // 单边非法时按 1×100 计算，最近比例应为 9:16（行为正确而非抛错）
  assert.strictEqual(__APP.pickNearestAspectRatio(-5, 100), "9:16");

  // 自定义预设列表生效
  const custom = [{ value: "2:3" }, { value: "5:4" }];
  assert.strictEqual(__APP.pickNearestAspectRatio(200, 300, custom), "2:3");
  assert.strictEqual(__APP.pickNearestAspectRatio(500, 400, custom), "5:4");

  // 空预设回落 1:1
  assert.strictEqual(__APP.pickNearestAspectRatio(100, 100, []), "1:1");
});

test("buildVisionMessages produces OpenAI-compatible multimodal messages", () => {
  const { __APP } = loadAppNamespace();

  const messages = __APP.buildVisionMessages("系统指令", "用户要求", "data:image/jpeg;base64,QUJD");
  assert.strictEqual(Array.isArray(messages), true);
  assert.strictEqual(messages.length, 2);

  assert.strictEqual(messages[0].role, "system");
  assert.strictEqual(messages[0].content, "系统指令");

  assert.strictEqual(messages[1].role, "user");
  assert.strictEqual(Array.isArray(messages[1].content), true);
  const textPart = messages[1].content.find((part) => part.type === "text");
  const imagePart = messages[1].content.find((part) => part.type === "image_url");
  assert.ok(textPart, "用户消息必须包含文本段");
  assert.strictEqual(textPart.text, "用户要求");
  assert.ok(imagePart, "用户消息必须包含图片段");
  assert.strictEqual(imagePart.image_url.url, "data:image/jpeg;base64,QUJD");
});

test("image generation size table keeps working for the img2img flow (regression)", () => {
  const { __APP } = loadAppNamespace();

  assert.strictEqual(__APP.getGptImageSize("3:4", "2K", "pixels"), "1536x2048");
  assert.strictEqual(__APP.getGptImageSize("1:1", "1K", "pixels"), "1024x1024");
  assert.strictEqual(__APP.getGptImageSize("16:9", "4K", "ratio"), "16:9");
  // 非法比例回落 1:1 的对应尺寸
  assert.strictEqual(__APP.getGptImageSize("7:5", "2K", "pixels"), "2048x2048");
});

// ==================== 生图通道多模型支持 ====================

/** 向沙箱 localStorage 写入指定通道并返回 __APP 命名空间 */
function loadAppNamespaceWithChannels(channels) {
  const app = loadAppNamespace();
  app.storage.setItem("image-studio:image-channels-v1", JSON.stringify(channels));
  return app;
}

/** vm 沙箱跨 realm 的数组无法用 deepStrictEqual 比较，统一序列化后断言 */
function assertJsonEquals(actual, expected, message) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

test("getChannelModels reads the models array with legacy single-model fallback", () => {
  const { __APP } = loadAppNamespace();

  // 新版：models 数组优先
  assertJsonEquals(
    __APP.getChannelModels({ model: "gpt-image-2", models: ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.6"] }),
    ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.6"]
  );
  // 旧版：回退到单 model 字符串
  assertJsonEquals(__APP.getChannelModels({ model: "gpt-image-2" }), ["gpt-image-2"]);
  // 空通道与非法输入
  assertJsonEquals(__APP.getChannelModels({}), []);
  assertJsonEquals(__APP.getChannelModels(null), []);
  // 数组中的空白项会被清理
  assertJsonEquals(__APP.getChannelModels({ models: [" a ", "", "b"] }), ["a", "b"]);
});

test("getModelOptions expands one channel with multiple models and keeps channel-scoped values", () => {
  const { __APP } = loadAppNamespaceWithChannels([
    { id: "ch-a", name: "通道A", type: "openai_images", mode: "auto", model: "m-old", models: ["m-1", "m-2"], enabled: true },
    { id: "ch-b", name: "通道B", type: "agnes", mode: "sync", model: "m-1", enabled: true },
    { id: "ch-c", name: "禁用通道", type: "openai_images", mode: "auto", models: ["m-x"], enabled: false }
  ]);

  const options = __APP.getModelOptions();
  // 通道A 两个模型 + 通道B 一个模型；禁用通道不出现
  assertJsonEquals(options.map((o) => o.value), ["m-1|ch-a", "m-2|ch-a", "m-1|ch-b"]);
  // 相同模型名在不同通道下共存（value 含通道 ID）
  assert.strictEqual(options[0].channelName, "通道A");
  assert.strictEqual(options[2].channelName, "通道B");
  assert.strictEqual(options[2].model, "m-1");
});

test("resolveImageChannel returns the channel with the user-selected model applied", () => {
  const { __APP } = loadAppNamespaceWithChannels([
    { id: "ch-a", name: "通道A", type: "openai_images", mode: "auto", model: "m-1", models: ["m-1", "m-2"], enabled: true }
  ]);

  // 选中 m-2：返回的通道 model 已覆盖为 m-2，请求链路无需感知差异
  const resolved = __APP.resolveImageChannel("m-2|ch-a");
  assert.ok(resolved, "应能解析出通道");
  assert.strictEqual(resolved.model, "m-2");
  assert.strictEqual(resolved.channel.model, "m-2");
  assert.strictEqual(resolved.channel.id, "ch-a");
  // 选中 m-1
  assert.strictEqual(__APP.resolveImageChannel("m-1|ch-a").model, "m-1");
  // 未知模型回落通道第一个模型
  assert.strictEqual(__APP.resolveImageChannel("m-unknown|ch-a").model, "m-1");
  // 通道不存在
  assert.strictEqual(__APP.resolveImageChannel("m-1|ch-none"), null);
  // 旧版纯模型名兼容
  assert.strictEqual(__APP.resolveImageChannel("m-1").channel.id, "ch-a");
});

test("getModelOptionsGrouped groups enabled channels with their models", () => {
  const { __APP } = loadAppNamespaceWithChannels([
    { id: "ch-a", name: "通道A", type: "openai_images", mode: "auto", models: ["m-1", "m-2"], enabled: true },
    { id: "ch-b", name: "通道B", type: "agnes", mode: "sync", model: "only-b", enabled: true }
  ]);

  const groups = __APP.getModelOptionsGrouped();
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].name, "通道A");
  assertJsonEquals(groups[0].options.map((o) => o.value), ["m-1|ch-a", "m-2|ch-a"]);
  // 旧版单模型通道也被归组
  assert.strictEqual(groups[1].name, "通道B");
  assertJsonEquals(groups[1].options.map((o) => o.model), ["only-b"]);
});

test("settings page supports multi-model input and pages render grouped model selects", () => {
  // 设置页：模型名输入框带多模型提示
  const settingsJs = readProjectFile("settings.js");
  assert.ok(settingsJs.includes("parseChannelModelsText"), "设置页必须解析多模型输入");
  assert.ok(settingsJs.includes("models: models"), "保存通道时必须写入 models 数组");
  assert.ok(settingsJs.includes("模型名（支持多个）"), "模型名标签需注明支持多个");

  // 三个页面的模型下拉统一走分组渲染
  const renderCall = "__APP.renderModelSelectOptions(";
  assert.ok(readProjectFile("app.js").includes(renderCall));
  assert.ok(readProjectFile("img2img.js").includes(renderCall));
  assert.ok(readProjectFile("xhs.js").includes(renderCall));

  // 请求链路统一通过 resolveImageChannel 取通道与所选模型
  const resolveCall = "__APP.resolveImageChannel(";
  assert.ok(readProjectFile("app.js").includes(resolveCall));
  assert.ok(readProjectFile("img2img.js").includes(resolveCall));
  assert.ok(readProjectFile("xhs.js").includes(resolveCall));

  // 内置模板带默认多模型
  const { __APP } = loadAppNamespace();
  __APP.getDefaultImageChannels().forEach((ch) => {
    assertJsonEquals(ch.models, ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.6"]);
  });
});

test("img2img draft and vision-model storage keys are registered with the unified namespace", () => {
  const { __APP } = loadAppNamespace();

  assert.strictEqual(__APP.STORAGE_KEYS.img2imgDraft, "image-studio:img2img-draft");
  assert.strictEqual(__APP.STORAGE_KEYS.img2imgVisionModel, "image-studio:img2img-vision-model");
});

test("img2img constants define three functional modes and extraction/edit instructions", () => {
  const { __APP } = loadAppNamespace();

  assert.strictEqual(Array.isArray(__APP.IMG2IMG_MODES), true);
  assert.strictEqual(__APP.IMG2IMG_MODES.length, 3);
  const values = Array.from(__APP.IMG2IMG_MODES.map((mode) => mode.value));
  assert.deepStrictEqual(values, ["extract", "edit", "compose"]);
  __APP.IMG2IMG_MODES.forEach((mode) => {
    assert.ok(mode.label && mode.desc && mode.runLabel, "每种功能模式必须带名称、说明与执行标签");
    assert.ok(typeof mode.maxImages === "number" && mode.maxImages >= 1, "maxImages 必须为正整数");
    assert.ok(typeof mode.needGeneration === "boolean", "needGeneration 必须为布尔值");
  });

  // 提取指令要求模型输出双语提示词
  assert.ok(__APP.IMG2IMG_EXTRACT_INSTRUCTION.includes('"promptZh"'));
  assert.ok(__APP.IMG2IMG_EXTRACT_INSTRUCTION.includes('"promptEn"'));
  assert.ok(__APP.IMG2IMG_EXTRACT_INSTRUCTION.includes("严格只输出 JSON"));

  // 修改/合成指令要求模型输出改造后的提示词
  assert.ok(__APP.IMG2IMG_EDIT_INSTRUCTION.includes('"promptZh"'));
  assert.ok(__APP.IMG2IMG_EDIT_INSTRUCTION.includes("严格只输出 JSON"));

  // 压缩参数：限制最大边长且 JPEG 质量在合理区间
  assert.strictEqual(__APP.IMG2IMG_MAX_UPLOAD_EDGE, 1280);
  assert.ok(__APP.IMG2IMG_JPEG_QUALITY > 0 && __APP.IMG2IMG_JPEG_QUALITY <= 1);

  // 多图上传上限
  assert.strictEqual(__APP.IMG2IMG_MAX_UPLOAD_IMAGES, 9);
});

// ==================== 结构与集成测试 ====================

test("img2img page exposes the three-mode workflow UI", () => {
  const html = readProjectFile("img2img.html");

  // 上传区：点击 + 文件选择 + 拖拽目标 + 粘贴提示 + 多文件支持
  assert.ok(html.includes('id="i2i-dropzone"'));
  assert.ok(html.includes('id="i2i-file-input"'));
  assert.ok(html.includes('accept="image/*"'));
  assert.ok(html.includes("multiple"));
  assert.ok(html.includes("Ctrl</kbd>+<kbd>V"));
  assert.ok(html.includes('id="i2i-multi-preview"'));
  assert.ok(html.includes('id="i2i-dropzone-note"'));

  // 功能模式：三模式卡片
  assert.ok(html.includes('id="i2i-mode-cards"'));

  // 要求面板：修改/合成模式
  assert.ok(html.includes('id="i2i-req-panel"'));
  assert.ok(html.includes('id="i2i-extra-req"'));
  assert.ok(html.includes('id="i2i-req-label"'));

  // 提取结果面板：中英文提示词
  assert.ok(html.includes('id="i2i-extract-result"'));
  assert.ok(html.includes('id="i2i-extract-summary"'));
  assert.ok(html.includes('id="i2i-prompt-zh"'));
  assert.ok(html.includes('id="i2i-prompt-en"'));
  assert.ok(html.includes('id="i2i-copy-zh"'));
  assert.ok(html.includes('id="i2i-copy-en"'));
  assert.ok(html.includes('id="i2i-copy-all"'));

  // 高级设置：视觉模型、生图模型、质量
  assert.ok(html.includes('id="i2i-vision-model"'));
  assert.ok(html.includes('id="i2i-image-model"'));
  assert.ok(html.includes('id="i2i-image-quality"'));
  assert.ok(html.includes('id="i2i-llm-info"'));

  // 操作区：单一主按钮 + 停止/重置
  assert.ok(html.includes('id="i2i-run"'));
  assert.ok(html.includes('id="i2i-stop"'));
  assert.ok(html.includes('id="i2i-reset"'));

  // 结果区
  assert.ok(html.includes('id="i2i-results-grid"'));
  assert.ok(html.includes('id="i2i-result-card-template"'));

  // 依赖脚本
  assert.ok(html.includes('<script src="./app-config.js">'));
  assert.ok(html.includes('<script src="./app-utils.js">'));
  assert.ok(html.includes('<script src="./img2img.js">'));
});

test("img2img script implements three-mode workflow with upload, compression, extraction and generation", () => {
  const script = readProjectFile("img2img.js");

  // 上传三通道：文件选择 / 拖拽 / 粘贴
  assert.ok(script.includes('elements.fileInput.addEventListener("change"'));
  assert.ok(script.includes('"dragenter"'));
  assert.ok(script.includes('"drop"'));
  assert.ok(script.includes('addEventListener("paste"'));

  // 本地压缩：canvas + 白底 + JPEG
  assert.ok(script.includes("function compressImage(img)"));
  assert.ok(script.includes('ctx.fillStyle = "#ffffff"'));
  assert.ok(script.includes('canvas.toDataURL("image/jpeg"'));

  // 视觉分析：多图消息构建与 LLM 调用
  assert.ok(script.includes("function buildMultiVisionMessages("));
  assert.ok(script.includes("__APP.callLlmApi("));
  assert.ok(script.includes("__APP.IMG2IMG_EXTRACT_INSTRUCTION"));
  assert.ok(script.includes("__APP.IMG2IMG_EDIT_INSTRUCTION"));
  assert.ok(script.includes("function getVisionLlmConfig()"));
  assert.ok(script.includes("__APP.getOptimizeModel()"));

  // 多图上传与预览
  assert.ok(script.includes("function addImage(file)"));
  assert.ok(script.includes("function removeImage(index)"));
  assert.ok(script.includes("function renderMultiPreview()"));

  // 修改图片模式：统一走「视觉模型改写 → 生图」链路，不再调用 /v1/images/edits
  assert.ok(!script.includes("editImageDirect"));
  assert.ok(!script.includes("editWithRetry"));
  assert.ok(!script.includes("images/edits"));

  // 生图引擎与重试
  assert.ok(script.includes("function buildChannelEndpoint(baseUrl)"));
  assert.ok(script.includes("function pollImageTask("));
  assert.ok(script.includes("function generateWithRetry("));
  assert.ok(script.includes("RETRYABLE_PATTERN"));

  // 主流程：统一入口 startRun + 停止 + 单张重生成 + 入库 + 下载
  assert.ok(script.includes("async function startRun()"));
  assert.ok(script.includes("state.abortController.abort()"));
  assert.ok(script.includes("async function regenerateResult(index)"));
  assert.ok(script.includes("async function saveResultToGallery("));
  assert.ok(script.includes("async function downloadResult("));
  assert.ok(script.includes("__APP.API_ENDPOINTS.save"));
  assert.ok(script.includes('modeLabel: "图生图"'));

  // 草稿持久化
  assert.ok(script.includes("__APP.STORAGE_KEYS.img2imgDraft"));
  // 多图模式字典标注
  assert.ok(script.includes("图" + String.fromCharCode(65)));
});

test("img2img styles cover multi-preview, extract result and mode cards", () => {
  const css = readProjectFile("img2img.css");

  assert.ok(css.includes(".i2i-dropzone"));
  assert.ok(css.includes(".i2i-dropzone.is-dragover"));
  assert.ok(css.includes(".i2i-mode-card.is-active"));
  assert.ok(css.includes(".i2i-multi-preview"));
  assert.ok(css.includes(".i2i-multi-card"));
  assert.ok(css.includes(".i2i-multi-remove"));
  assert.ok(css.includes(".i2i-extract-result"));
  assert.ok(css.includes(".i2i-extract-summary"));
  assert.ok(css.includes(".i2i-prompt-head"));
  assert.ok(css.includes(".i2i-result-visual"));
  assert.ok(css.includes("@keyframes i2i-spin"));
});

test("img2img entry links are present across all pages", () => {
  const pages = ["index.html", "gallery.html", "prompts.html", "settings.html", "help.html", "xhs.html"];
  pages.forEach((page) => {
    const html = readProjectFile(page);
    assert.ok(html.includes('href="./img2img.html"'), page + " 缺少图生图入口链接");
  });
  // 图生图页面自身提供返回与跨板块导航
  const self = readProjectFile("img2img.html");
  assert.ok(self.includes('href="./index.html"'));
  assert.ok(self.includes('href="./xhs.html"'));
  assert.ok(self.includes('href="./gallery.html"'));
  assert.ok(self.includes('href="./prompts.html"'));
});

test("README documents the img2img board", () => {
  const readme = readProjectFile("README.md");

  assert.ok(readme.includes("图生图工作台"));
  assert.ok(readme.includes("`img2img.html`"));
  assert.ok(readme.includes("img2img.js"));
  assert.ok(readme.includes("视觉模型名"));
});
