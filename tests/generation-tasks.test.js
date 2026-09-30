/**
 * 后台生图任务管理器单元测试
 * 覆盖 server.js 中与外部请求无关的纯函数：
 * endpoint 构建、供应商状态归一化、图片提取、瞬时错误分类、任务快照脱敏
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  buildGenerationEndpoint,
  buildProviderTaskEndpoint,
  normalizeProviderTaskStatus,
  isProviderTaskCompleted,
  isProviderTaskFailed,
  extractSyncImageUrlsSrv,
  extractGptImageUrlsSrv,
  isTransientSubmitFailure,
  sanitizeTask,
  createGenerationTask,
  cancelGenerationTasks,
  listGenerationTasks
} = require("../server.js");

test("buildGenerationEndpoint 兼容多种 Base URL 形态", () => {
  assert.strictEqual(
    buildGenerationEndpoint("https://api.example.com"),
    "https://api.example.com/v1/images/generations"
  );
  assert.strictEqual(
    buildGenerationEndpoint("https://api.example.com/v1"),
    "https://api.example.com/v1/images/generations"
  );
  assert.strictEqual(
    buildGenerationEndpoint("https://api.example.com/v1/images/generations"),
    "https://api.example.com/v1/images/generations"
  );
  assert.strictEqual(buildGenerationEndpoint(""), "");
});

test("buildProviderTaskEndpoint 与前端规则一致", () => {
  assert.strictEqual(
    buildProviderTaskEndpoint("https://api.example.com/v1/images/generations", "abc123"),
    "https://api.example.com/v1/tasks/abc123"
  );
  assert.strictEqual(
    buildProviderTaskEndpoint("https://api.example.com/v1", "abc123"),
    "https://api.example.com/v1/tasks/abc123"
  );
  assert.strictEqual(
    buildProviderTaskEndpoint("https://api.example.com", "abc123"),
    "https://api.example.com/v1/tasks/abc123"
  );
});

test("供应商任务状态归一化覆盖中转站常见写法", () => {
  assert.ok(isProviderTaskCompleted("completed"));
  assert.ok(isProviderTaskCompleted("Succeeded"));
  assert.ok(isProviderTaskCompleted("success"));
  assert.ok(isProviderTaskCompleted("DONE"));
  assert.ok(isProviderTaskFailed("failed"));
  assert.ok(isProviderTaskFailed("Error"));
  assert.ok(isProviderTaskFailed("cancelled"));
  assert.ok(isProviderTaskFailed("Canceled"));
  assert.ok(!isProviderTaskCompleted("processing"));
  assert.ok(!isProviderTaskFailed("processing"));
  assert.strictEqual(normalizeProviderTaskStatus("In_Progress"), "inprogress");
});

test("extractSyncImageUrlsSrv 支持 url 与 b64_json", () => {
  const images = extractSyncImageUrlsSrv({
    data: [
      { url: "https://cdn.example.com/a.png" },
      { b64_json: "AAAA" },
      { b64_json: "   " }
    ]
  });
  assert.deepStrictEqual(images, [
    "https://cdn.example.com/a.png",
    "data:image/png;base64,AAAA"
  ]);
});

test("extractGptImageUrlsSrv 支持 result.images 与 data 兜底", () => {
  const fromResult = extractGptImageUrlsSrv({
    status: "completed",
    result: { images: [{ url: "https://cdn.example.com/1.png" }, "data:image/png;base64,BBBB"] }
  });
  assert.deepStrictEqual(fromResult, [
    "https://cdn.example.com/1.png",
    "data:image/png;base64,BBBB"
  ]);

  const fromData = extractGptImageUrlsSrv({
    status: "completed",
    data: [{ url: "https://cdn.example.com/2.png" }]
  });
  assert.deepStrictEqual(fromData, ["https://cdn.example.com/2.png"]);
});

test("isTransientSubmitFailure 仅对网络错误/429/5xx 放行自动重试", () => {
  assert.ok(isTransientSubmitFailure(0, "fetch failed"));
  assert.ok(isTransientSubmitFailure(0, "ECONNREFUSED 连接被拒绝"));
  assert.ok(isTransientSubmitFailure(429, "rate limit"));
  assert.ok(isTransientSubmitFailure(503, "service unavailable"));
  assert.ok(!isTransientSubmitFailure(401, "Unauthorized"));
  assert.ok(!isTransientSubmitFailure(400, "invalid prompt"));
  assert.ok(!isTransientSubmitFailure(404, "model not found"));
  assert.ok(!isTransientSubmitFailure(422, "size unsupported"));
});

test("sanitizeTask 剥离通道配置（含 API Key），保留展示字段", () => {
  const created = createGenerationTask({
    id: "snap-1",
    prompt: "一只猫",
    finalPrompt: "一只猫，电影感",
    channel: {
      type: "openai_images",
      name: "测试通道",
      baseUrl: "https://api.example.com",
      apiKey: "sk-secret-key",
      model: "gpt-image-1",
      mode: "auto"
    },
    aspectRatio: "1:1",
    imageQuality: "2K"
  });
  assert.ok(created.ok, "任务应创建成功");

  // 立即取消：避免任务真实发起网络请求（创建即入队执行，这是预期行为）
  const cancelled = cancelGenerationTasks(["snap-1"]);
  assert.deepStrictEqual(cancelled, ["snap-1"]);

  const snapshot = created.task;
  assert.strictEqual(snapshot.id, "snap-1");
  assert.ok(["queued", "running", "cancelled"].includes(snapshot.status), "创建瞬间的状态应合法");
  assert.strictEqual(snapshot.channelLabel, "测试通道 · gpt-image-1");
  assert.ok(!("channel" in snapshot), "快照不应包含 channel 字段");
  assert.ok(!JSON.stringify(snapshot).includes("sk-secret-key"), "快照不得泄露 API Key");

  // listGenerationTasks 同样必须脱敏
  const listed = JSON.stringify(listGenerationTasks());
  assert.ok(!listed.includes("sk-secret-key"), "任务列表不得泄露 API Key");
});

test("createGenerationTask 校验通道配置完整性", () => {
  const missing = createGenerationTask({ prompt: "x", channel: { type: "openai_images" } });
  assert.ok(!missing.ok);
  assert.ok(missing.error.includes("通道配置不完整"));

  const badType = createGenerationTask({
    prompt: "x",
    channel: { type: "unknown", baseUrl: "https://a.com", apiKey: "k", model: "m" }
  });
  assert.ok(!badType.ok);
});
