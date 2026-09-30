(function () {
  window.__APP = window.__APP || {};

  // localStorage 键定义（通用命名空间，不暴露项目原始名称）
  __APP.STORAGE_KEYS = {
    gptApiKey: "image-studio:gpt-image-api-key",
    agnesApiKey: "image-studio:agnes-image-api-key",
    model: "image-studio:image-model",
    draft: "image-studio:image-draft",
    batchDraft: "image-studio:image-batch-draft",
    history: "image-studio:image-history-v1",
    legacyGallery: "image-studio:image-gallery-v1",
    aspectRatio: "image-studio:image-aspect-ratio",
    imageQuality: "image-studio:image-quality",
    styleTemplate: "image-studio:image-style-template",
    imageCount: "image-studio:image-count",
    mode: "image-studio:image-mode",
    taskMode: "image-studio:image-task-mode",
    previewPanelCollapsed: "image-studio:preview-panel-collapsed",
    chatPanelHeight: "image-studio:chat-panel-height",
    sidebarWidth: "image-studio:sidebar-width",
    account: "image-studio:account",
    agnesModel: "image-studio:agnes-model",
    agnesBaseUrl: "image-studio:agnes-base-url",
    gptImageModel: "image-studio:gpt-image-model",
    customImageApiKey: "image-studio:custom-image-api-key",
    customImageBaseUrl: "image-studio:custom-image-base-url",
    customImageModel: "image-studio:custom-image-model",
    imageChannels: "image-studio:image-channels-v1",
    llmProviders: "image-studio:llm-providers",
    optimizeProvider: "image-studio:optimize-provider",
    optimizeModel: "image-studio:optimize-model",
    promptLibrary: "image-studio:prompt-library-v1",
    xhsDraft: "image-studio:xhs-draft",
    xhsCheckpoint: "image-studio:xhs-checkpoint",
    xhsStyles: "image-studio:xhs-styles",
    articleStyles: "image-studio:article-styles",
    img2imgDraft: "image-studio:img2img-draft",
    img2imgVisionModel: "image-studio:img2img-vision-model"
  };

  // 旧的 localStorage 键前缀（仅用于一次性向后兼容迁移，不再用于新代码中）
  __APP.LEGACY_STORAGE_PREFIX = "jiaoge-ai-toolbox:";

  /**
   * 向后兼容读取 localStorage
   * 优先读取新键（image-studio:xxx），若不存在则尝试旧键（jiaoge-ai-toolbox:xxx）
   * 用于平滑迁移，不破坏已有用户配置
   * @param {string} newKey - 新的 localStorage 键
   * @returns {string|null} 取到的值，或 null
   */
  __APP.getStoredCompat = function (newKey) {
    if (!newKey) return null;
    var v = window.localStorage.getItem(newKey);
    if (v !== null && v !== undefined && v !== "") return v;
    // 尝试旧键（把 image-studio: 前缀替换为 jiaoge-ai-toolbox:）
    if (newKey.indexOf("image-studio:") === 0) {
      var legacyKey = __APP.LEGACY_STORAGE_PREFIX + newKey.substring("image-studio:".length);
      v = window.localStorage.getItem(legacyKey);
      if (v !== null && v !== undefined && v !== "") {
        // 读到旧键时，自动写入新键并清理旧键
        try {
          window.localStorage.setItem(newKey, v);
          window.localStorage.removeItem(legacyKey);
        } catch (e) { /* ignore quota errors */ }
        return v;
      }
    }
    return null;
  };

  /**
   * 启动期一次性迁移：把所有 jiaoge-ai-toolbox:xxx 旧键中的值复制到 image-studio:xxx 新键
   * 仅在新键不存在时迁移，避免覆盖用户最新配置
   * 调用方：脚本加载时立即执行一次
   */
  __APP.migrateLegacyStorage = function () {
    if (!window || !window.localStorage) return;
    try {
      var legacyPrefix = __APP.LEGACY_STORAGE_PREFIX;
      var newPrefix = "image-studio:";
      var newKeys = __APP.STORAGE_KEYS;
      Object.keys(newKeys).forEach(function (k) {
        var newKey = newKeys[k];
        if (!newKey || newKey.indexOf(newPrefix) !== 0) return;
        // 跳过：新键已经有值
        if (window.localStorage.getItem(newKey) !== null) return;
        // 读旧键
        var suffix = newKey.substring(newPrefix.length);
        var legacyKey = legacyPrefix + suffix;
        var legacyVal = window.localStorage.getItem(legacyKey);
        if (legacyVal !== null) {
          try {
            window.localStorage.setItem(newKey, legacyVal);
            window.localStorage.removeItem(legacyKey);
          } catch (e) { /* ignore */ }
        }
      });
    } catch (e) {
      // 迁移失败不影响主功能
    }
  };

  /**
   * 生图通道类型定义
   * openai_images: OpenAI /v1/images/generations 兼容接口
   * agnes: Agnes /v1/images/generations 接口（带 extra_body）
   */
  __APP.CHANNEL_TYPES = [
    { value: "openai_images", label: "OpenAI Images 兼容", desc: "标准 /v1/images/generations 接口，适用于大多数第三方中转站" },
    { value: "agnes", label: "Agnes Images", desc: "Agnes AI /v1/images/generations 接口" }
  ];

  /**
   * 生图接口模式
   * auto: 自动检测（推荐）— 响应含 task_id 则走异步轮询，否则直接取图
   * sync: 同步 — API 直接返回图片数据
   * async: 异步 — API 返回 task_id，需要轮询获取结果
   */
  __APP.CHANNEL_MODES = [
    { value: "auto", label: "自动检测（推荐）", desc: "根据 API 响应自动判断同步或异步" },
    { value: "sync", label: "同步出图", desc: "API 直接返回图片数据（b64_json 或 url）" },
    { value: "async", label: "异步出图", desc: "API 返回 task_id，需轮询 /v1/tasks/{id} 获取结果" }
  ];

  __APP.API_ENDPOINTS = {
    save: "/api/image-studio/save"
  };

  __APP.APIMART_GENERATION_URL = "https://api.apimart.ai/v1/images/generations";
  __APP.AGNES_GENERATION_URL_DEFAULT = "https://apihub.agnes-ai.com/v1/images/generations";
  __APP.GPT_IMAGE_TASK_INITIAL_DELAY = 10000;
  __APP.GPT_IMAGE_TASK_POLL_INTERVAL = 4000;
  __APP.GPT_IMAGE_TASK_TIMEOUT = 10 * 60 * 1000;
  __APP.BATCH_DELAY_MIN_MS = 1000;
  __APP.GPT_IMAGE_MODEL = "gpt-image-2";
  __APP.AGNES_IMAGE_MODEL_DEFAULT = "agnes-image-2.1-flash";
  __APP.CUSTOM_IMAGE_MODEL_DEFAULT = "gpt-image-2";

  /**
   * 获取默认生图通道列表（首次使用时种子数据）
   * 包含 OpenAI Images 兼容通道模板
   * @returns {Array} 通道数组
   */
  __APP.getDefaultImageChannels = function () {
    return [
      {
        id: "ch-builtin-openai",
        name: "OpenAI Images 中转",
        type: "openai_images",
        mode: "auto",
        baseUrl: "https://api.apimart.ai",
        apiKey: "",
        model: "gpt-image-2",
        // 内置预置的多个生图模型（可在设置页增删）
        models: ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.6"],
        enabled: false,
        builtin: true
      },
      {
        id: "ch-builtin-wawapii",
        name: "wawapii 生图",
        type: "openai_images",
        mode: "auto",
        baseUrl: "https://wawapii.com",
        apiKey: "",
        model: "gpt-image-2",
        models: ["gpt-image-2", "gpt-image-2.5", "gpt-image-2.6"],
        enabled: false,
        builtin: true
      }
    ];
  };

  /**
   * 从旧的 localStorage 键迁移到新的通道列表
   * 仅在 imageChannels 不存在时执行一次
   * @returns {Array} 迁移后的通道数组
   */
  __APP.migrateImageChannels = function () {
    // 使用向后兼容读取：优先新键，缺失时回退旧键
    var existing = __APP.getStoredCompat(__APP.STORAGE_KEYS.imageChannels);
    if (existing) {
      try {
        var parsed = JSON.parse(existing);
        if (Array.isArray(parsed)) {
          // 补齐后续版本新增的内置通道模板（如 wawapii.com），默认禁用，不覆盖已有配置
          var defaults = __APP.getDefaultImageChannels();
          var changed = false;
          defaults.forEach(function (defaultCh) {
            if (defaultCh.builtin && !parsed.some(function (ch) { return ch.id === defaultCh.id; })) {
              parsed.push(defaultCh);
              changed = true;
            }
          });
          // 给旧版内置通道补充默认多模型列表（仅限未自定义过模型、未配置过 models 的通道）
          defaults.forEach(function (defaultCh) {
            parsed.forEach(function (ch) {
              if (ch.id === defaultCh.id && ch.builtin && !Array.isArray(ch.models) && (!ch.model || ch.model === defaultCh.model)) {
                ch.models = defaultCh.models.slice();
                changed = true;
              }
            });
          });
          if (changed) {
            window.localStorage.setItem(__APP.STORAGE_KEYS.imageChannels, JSON.stringify(parsed));
          }
          return parsed;
        }
      } catch (e) {
        // JSON 损坏，继续迁移
      }
    }

    var channels = __APP.getDefaultImageChannels();

    // 迁移 GPT-Image 中转通道（向后兼容旧键）
    var gptKey = __APP.getStoredCompat(__APP.STORAGE_KEYS.gptApiKey);
    var gptModel = __APP.getStoredCompat(__APP.STORAGE_KEYS.gptImageModel);
    if (gptKey) {
      channels[0].apiKey = gptKey || "";
      channels[0].baseUrl = __APP.APIMART_GENERATION_URL.replace(/\/images\/generations$/, "");
      channels[0].model = gptModel || __APP.GPT_IMAGE_MODEL;
      channels[0].enabled = true;
    }

    // 迁移自定义生图通道（向后兼容旧键）
    var customKey = __APP.getStoredCompat(__APP.STORAGE_KEYS.customImageApiKey);
    var customBaseUrl = __APP.getStoredCompat(__APP.STORAGE_KEYS.customImageBaseUrl);
    var customModel = __APP.getStoredCompat(__APP.STORAGE_KEYS.customImageModel);
    if (customKey || customBaseUrl) {
      channels.push({
        id: "ch-migrated-custom",
        name: "自定义生图",
        type: "openai_images",
        mode: "auto",
        baseUrl: (customBaseUrl || "").replace(/\/images\/generations$/, "").replace(/\/v1$/, ""),
        apiKey: customKey || "",
        model: customModel || __APP.CUSTOM_IMAGE_MODEL_DEFAULT,
        enabled: true,
        builtin: false
      });
    }

    // 迁移 Agnes 通道（向后兼容旧键）
    var agnesKey = __APP.getStoredCompat(__APP.STORAGE_KEYS.agnesApiKey);
    var agnesBaseUrl = __APP.getStoredCompat(__APP.STORAGE_KEYS.agnesBaseUrl);
    var agnesModel = __APP.getStoredCompat(__APP.STORAGE_KEYS.agnesModel);
    if (agnesKey || agnesBaseUrl) {
      channels.push({
        id: "ch-migrated-agnes",
        name: "Agnes Image",
        type: "agnes",
        mode: "sync",
        baseUrl: (agnesBaseUrl || __APP.AGNES_GENERATION_URL_DEFAULT).replace(/\/images\/generations$/, "").replace(/\/v1$/, ""),
        apiKey: agnesKey || "",
        model: agnesModel || __APP.AGNES_IMAGE_MODEL_DEFAULT,
        enabled: true,
        builtin: false
      });
    }

    window.localStorage.setItem(__APP.STORAGE_KEYS.imageChannels, JSON.stringify(channels));
    return channels;
  };

  /**
   * 读取一键优化所选模型商 ID（默认 DeepSeek）
   * @returns {string} provider id
   */
  __APP.getOptimizeProvider = function () {
    return window.localStorage.getItem(__APP.STORAGE_KEYS.optimizeProvider) || "deepseek";
  };

  /**
   * 读取一键优化所用模型（默认 deepseek-chat）
   * @returns {string} 模型 value
   */
  __APP.getOptimizeModel = function () {
    return window.localStorage.getItem(__APP.STORAGE_KEYS.optimizeModel) || "deepseek-chat";
  };

  /**
   * 获取默认的 LLM 提供商列表（三个独立平台，各自配置自己的 URL / API / 模型）
   * @returns {Array} 提供商数组
   */
  __APP.getDefaultLlmProviders = function () {
    return [
      {
        id: "deepseek",
        name: "DeepSeek",
        apiKey: "",
        baseUrl: "https://api.deepseek.com/v1",
        format: "openai",
        models: [""]
      },
      {
        id: "MiniMax",
        name: "MiniMax",
        apiKey: "",
        baseUrl: "https://api.minimax.chat/v1",
        format: "openai",
        models: [""]
      },
      {
        id: "custom",
        name: "其他服务",
        apiKey: "",
        baseUrl: "",
        format: "openai",
        models: [""]
      }
    ];
  };

  /**
   * 常见模型平台预设，用于设置页快速添加
   * 为小白用户准备了看得懂的模型名称（modelLabels），保存时仍使用原始模型名
   * @returns {Array} 平台预设数组
   */
  __APP.LLM_PROVIDER_PRESETS = [
    {
      id: "deepseek",
      name: "DeepSeek",
      format: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyHint: 'API Key 获取：<a href="https://platform.deepseek.com/" target="_blank" rel="noopener">platform.deepseek.com</a>'
    },
    {
      id: "MiniMax",
      name: "MiniMax",
      format: "openai",
      baseUrl: "https://api.minimax.chat/v1",
      apiKeyHint: 'API Key 获取：<a href="https://www.minimaxi.com/" target="_blank" rel="noopener">minimaxi.com</a>'
    },
    {
      id: "custom",
      name: "自定义 / 其他 OpenAI 兼容服务",
      format: "openai",
      baseUrl: "",
      apiKeyHint: "填写你的服务商提供的 API Key"
    }
  ];

  __APP.DEFAULT_MODEL = "gpt-image-2";
  __APP.MAX_HISTORY = 16;
  __APP.MAX_LEGACY_GALLERY = 40;
  __APP.ASPECT_RATIOS = [
    { value: "1:1", label: "1:1 方形" },
    { value: "3:4", label: "3:4 竖版海报" },
    { value: "4:3", label: "4:3 横版画幅" },
    { value: "9:16", label: "9:16 竖屏封面" },
    { value: "16:9", label: "16:9 宽屏横幅" },
    { value: "21:9", label: "21:9 超宽横幅" }
  ];
  __APP.IMAGE_QUALITIES = [
    { value: "1K", label: "1K 标准" },
    { value: "2K", label: "2K 高清" },
    { value: "4K", label: "4K 超清" }
  ];
  __APP.STYLE_TEMPLATES = [
    { id: "none", label: "不套模板", instruction: "" },
    { id: "photo", label: "写实摄影", instruction: "风格要求：高质感写实摄影，电影感布光，真实材质，清晰主体，细节完整，专业摄影棚或电影剧照质感。" },
    { id: "poster", label: "海报视觉", instruction: "风格要求：品牌海报视觉，构图克制，有主视觉焦点，留白清晰，适合标题排版，高级商业宣传风格。" },
    { id: "illustration", label: "数字插画", instruction: "风格要求：高完成度数字插画，层次丰富，色彩统一，画面叙事感强，细节精致。" },
    { id: "watercolor", label: "水彩手绘", instruction: "风格要求：水彩手绘质感，纸张纹理明显，颜色柔和，笔触自然，保留手工感。" },
    { id: "3d", label: "3D 物料", instruction: "风格要求：3D 渲染，磨砂材质，柔和边缘光，产品级展示，统一材质语言，干净背景。" },
    { id: "ink", label: "东方美学", instruction: "风格要求：东方审美与现代设计融合，克制用色，留白，纹理细腻，具有海报级气质。" }
  ];
  // ==================================================================
  // 随机生图提示词：模板组合系统
  // 参考 OpenAI《GPT 图像生成模型提示指南》的结构化提示建议：
  // 主体 → 动作 → 环境 → 媒介风格 → 景别/视角/构图 → 光影氛围 → 色彩情绪
  // 每次随机按公式组合：[主体场景卡] + [媒介风格] + [镜头构图] + [光线氛围] + [质量收尾]
  // 质量保障（组合虽多但张张合理）：
  //   1. 场景卡只写「谁 + 在做什么 + 在哪里」，不写死时间与光线（时间感统一交给光线层）
  //   2. 光线氛围从场景卡策展过的候选（atmos）中抽取，不会出现"霓虹夜色配清晨早餐铺"式冲突
  //   3. 媒介风格是唯一样式轴，只选一种，杜绝多风格打架
  //   4. 构图层全部是物理性镜头描述，与任何主体兼容
  // ==================================================================

  // 媒介风格（唯一样式轴）：phrase 为风格定语句，tail 为与该风格匹配的质量收尾词
  __APP.RANDOM_STYLES = [
    { id: "photo_cinema", label: "电影感摄影", phrase: "画面呈现为电影感写实摄影", tail: "电影级调色，高细节，画面有故事感。" },
    { id: "photo_35mm", label: "35mm 胶片", phrase: "画面呈现为 35mm 胶片摄影", tail: "细腻胶片颗粒，真实材质，杂志级质感。" },
    { id: "photo_doc", label: "自然纪实", phrase: "画面呈现为国家地理风格纪实摄影", tail: "真实自然，超高细节，画面有纵深感。" },
    { id: "photo_commercial", label: "商业摄影", phrase: "画面呈现为高级商业摄影", tail: "真实材质纹理，干净背景，广告级精致。" },
    { id: "photo_bw", label: "黑白纪实", phrase: "画面呈现为黑白银盐质感摄影", tail: "灰阶层次丰富，经典人文纪实气质。" },
    { id: "art_gongbi", label: "工笔国画", phrase: "画面呈现为工笔重彩国画", tail: "线条细腻，设色典雅，绢本质感。" },
    { id: "art_shuimo", label: "水墨写意", phrase: "画面呈现为中国水墨写意画风", tail: "墨分五色，大量留白，宣纸质感。" },
    { id: "art_watercolor", label: "水彩插画", phrase: "画面呈现为温柔的水彩插画", tail: "纸张纹理明显，色彩通透柔和，手绘完成度高。" },
    { id: "art_oil", label: "厚涂油画", phrase: "画面呈现为经典厚涂油画", tail: "笔触可见，色彩浑厚，美术馆藏品质感。" },
    { id: "illu_flat", label: "扁平插画", phrase: "画面呈现为现代扁平矢量插画", tail: "造型简练，配色克制和谐，构图干净。" },
    { id: "art_anime", label: "手绘动画", phrase: "画面呈现为吉卜力风格手绘动画场景", tail: "温暖治愈，细节丰富，赛璐璐上色质感。" },
    { id: "render_3d", label: "3D 渲染", phrase: "画面呈现为精致 3D 渲染", tail: "柔和边缘光，细腻材质，产品级打光。" },
    { id: "render_clay", label: "黏土定格", phrase: "画面呈现为黏土定格动画微缩场景", tail: "手工质感，微缩模型细节，柔光摄影。" },
    { id: "art_cyber", label: "赛博概念", phrase: "画面呈现为赛博朋克概念艺术", tail: "霓虹色彩，电影概念设计级细节，史诗氛围。" },
    // ===== 2026 社交平台爆款风格（盲盒潮玩 / 等距微缩 / 像素 / 羊毛毡 / 纸艺 / 复古海报）=====
    { id: "toy_blindbox", label: "盲盒潮玩", phrase: "画面呈现为泡泡玛特风格的潮玩盲盒手办，大头小身约 3:1 头身比，哑光乙烯基质感，大而有神的圆眼睛", tail: "釉面光滑，漆色均匀，收藏级玩具摄影质感，画面中不出现任何文字。" },
    { id: "render_isometric", label: "等距微缩", phrase: "画面呈现为等距视角（isometric）的精致微缩场景模型", tail: "微缩模型细节丰富，干净的柔光布光，微缩世界般的精致感。" },
    { id: "render_pixel", label: "像素艺术", phrase: "画面呈现为精细的 16-bit 像素艺术风格", tail: "像素颗粒干净利落，复古游戏配色，场景层次分明。" },
    { id: "art_felt", label: "羊毛毡", phrase: "画面呈现为手工羊毛毡材质的可爱场景", tail: "绒毛纤维质感清晰可见，手工缝线细节，温暖柔软的布艺氛围。" },
    { id: "art_paper", label: "纸艺剪纸", phrase: "画面呈现为多层剪纸纸艺立体场景", tail: "纸层边缘清晰，层叠出景深，纸质纹理细腻，光影干净。" },
    { id: "poster_retro", label: "复古海报", phrase: "画面呈现为 1950 年代复古旅行海报风格", tail: "扁平色块与丝网印刷质感，怀旧配色，版式大气，画面中不出现文字。" },
    // ===== 知识图谱与电商爆款风格 =====
    { id: "render_infographic", label: "知识图谱", phrase: "画面呈现为清晰美观的知识图谱信息图，用节点、连线与层级框组织内容，搭配简洁的图形图标与示意元素", tail: "信息层级分明，配色克制统一，图形语义准确，图中若出现文字则使用简短中文词语，宁少勿多。" },
    { id: "photo_product", label: "产品棚拍", phrase: "画面呈现为电商爆款的静物棚拍大片，主体置于干净的渐变色背景前", tail: "影棚级布光，材质细节锐利，倒影与投影讲究，商品图质感。" }
  ];

  // 镜头与构图（物理性描述，与任何主体、风格都兼容）
  __APP.RANDOM_COMPOSITIONS = [
    "浅景深特写镜头，主体清晰背景柔和虚化",
    "广角全景，画面有清晰的近中远层次",
    "低角度仰拍，主体挺拔有气势",
    "高角度俯拍，画面呈现图案般的秩序感",
    "中心对称构图，主体居中画面稳定",
    "贴近主体的平视视角，画面亲切自然",
    "微距特写，细节纤毫毕现",
    "极简留白构图，主体一侧留出大面积负空间",
    "框架式构图，用前景元素自然包围主体"
  ];

  // 光线氛围库：id → 光线与色调描述（时间感统一收在这一层）
  __APP.RANDOM_LIGHTINGS = {
    golden_hour: "黄金时刻的暖色逆光，轮廓镶着金边",
    soft_morning: "清晨柔和漫射光，影调干净通透",
    overcast: "阴天灰调漫射光，色彩克制高级",
    candlelight: "温暖灯火，明暗过渡柔和",
    neon_night: "夜晚霓虹灯光，红蓝灯牌交映",
    moonlight: "清冷月光，蓝银色调静谧",
    chiaroscuro: "戏剧性明暗对比，伦勃朗式用光",
    dappled: "林间斑驳光斑，光影跳跃",
    studio_soft: "摄影棚柔光，光影干净均匀",
    snow_light: "雪后清冽天光，空气通透",
    rain_reflection: "雨后湿润反光，地面如镜",
    blue_hour: "蓝调时刻，天光与暖灯交融",
    underwater: "阳光光柱穿透水面，洒下摇曳光带",
    aurora: "极光在夜空中流动，绿紫色光幕低垂",
    ember_fire: "篝火与炉火余烬的暖橙光，火星微微飘起",
    fireworks: "夜空中烟花绽放，彩色光点洒落"
  };

  // 主体场景卡：只描述「谁 + 在做什么 + 在哪里」；atmos 为该场景策展过的光线候选 id 列表
  __APP.RANDOM_SUBJECTS = [
    // ===== 人物肖像（6）=====
    { title: "雨夜街角旅人", subject: "一位穿深色风衣的年轻人撑着伞走过湿漉漉的街角，身后霓虹灯牌次第亮起", atmos: ["neon_night", "rain_reflection", "blue_hour"] },
    { title: "老陶艺匠人", subject: "一位花白胡须的老陶艺匠人坐在拉坯机前塑形一只陶碗，双手沾满泥浆，身后是摆满陶坯的木架", atmos: ["soft_morning", "candlelight", "chiaroscuro"] },
    { title: "花市少女", subject: "一位挎着竹篮的少女在花市里挑选鲜花，篮中已装满向日葵与桔梗，摊位上花团锦簇", atmos: ["soft_morning", "dappled"] },
    { title: "街头歌手", subject: "一位街头歌手抱着旧木吉他闭眼演唱，脚边摊开着手写琴谱和几枚硬币", atmos: ["golden_hour", "neon_night", "blue_hour"] },
    { title: "院中对弈", subject: "两位老者在庭院石桌前对弈围棋，一枚棋子正悬在半空，手边茶炉飘着青烟", atmos: ["dappled", "soft_morning"] },
    { title: "排练室的舞者", subject: "一位现代舞者在空旷的排练室里跃起，裙摆扬出弧线，落地窗映出她的身影", atmos: ["studio_soft", "blue_hour"] },
    // ===== 动物（6）=====
    { title: "雪原哈士奇", subject: "三只哈士奇在雪原上奔跑，嘴里吐出白色哈气，背景是朦胧的白桦林", atmos: ["snow_light", "soft_morning"] },
    { title: "金合欢树下狮群", subject: "一群狮子在金合欢树下休憩，雄狮鬃毛蓬松，远处有象群缓缓移动", atmos: ["golden_hour"] },
    { title: "海龟与珊瑚", subject: "一只绿海龟在清澈浅海中悠然游动，身旁是色彩缤纷的珊瑚礁与鱼群", atmos: ["underwater"] },
    { title: "书店窗台的猫", subject: "一只橘猫蜷在旧书店窗台的线装书上打盹，窗外落着细雨", atmos: ["soft_morning", "candlelight", "rain_reflection"] },
    { title: "萤火虫与鹿", subject: "一只雄鹿站在夜色森林的空地上，鹿角间萦绕着萤火虫的光点", atmos: ["moonlight"] },
    { title: "冰缘企鹅", subject: "一列帝企鹅幼崽在冰缘排成歪歪扭扭的队伍摇摇晃晃前行，身后是成年的冰川", atmos: ["snow_light"] },
    // ===== 风景自然（6）=====
    { title: "云海石柱", subject: "巨大的砂岩石柱群从翻涌的云海中拔地而起，石柱顶端覆着绿植", atmos: ["golden_hour", "soft_morning"] },
    { title: "雪山湖畔木屋", subject: "山脚湖畔的一间木屋亮着暖黄的窗灯，湖面倒映着雪山轮廓", atmos: ["blue_hour", "moonlight", "snow_light"] },
    { title: "灌水梯田", subject: "层层梯田顺着山势铺展，灌水期如镜面般映着天色，田埂线条蜿蜒", atmos: ["golden_hour", "soft_morning", "overcast"] },
    { title: "苔藓溪谷", subject: "幽绿峡谷里一条溪流滑过覆满青苔的岩石，小型瀑布层层跌落", atmos: ["dappled", "overcast"] },
    { title: "沙脊驼队", subject: "一望无际的沙漠沙丘勾勒出锋利的明暗曲线，一支驼队正走在沙脊上", atmos: ["golden_hour", "moonlight"] },
    { title: "黑色熔岩海岸", subject: "黑色火山岩海岸边海浪拍碎成白色泡沫，远处海蚀柱矗立", atmos: ["overcast", "blue_hour"] },
    // ===== 城市街景（4）=====
    { title: "巷口早餐铺", subject: "老城巷口的早餐铺蒸汽升腾，师傅正把面团拉长下锅，门口摆着矮桌竹凳", atmos: ["soft_morning", "blue_hour", "candlelight"] },
    { title: "雨后书店橱窗", subject: "雨后老街的旧书店橱窗透出暖光，玻璃上挂着水珠，映出来往的伞影", atmos: ["rain_reflection", "blue_hour", "candlelight"] },
    { title: "环形天桥", subject: "城市环形天桥上行人匆匆，桥下车流拉出光的轨迹，两侧是玻璃幕墙高楼", atmos: ["blue_hour", "neon_night", "rain_reflection"] },
    { title: "深夜便利店", subject: "深夜街角的便利店亮着冷白的光，玻璃门内一个身影正低头看关东煮的锅", atmos: ["neon_night", "blue_hour"] },
    // ===== 科幻幻想（5）=====
    { title: "深空探测器", subject: "一台孤独的探测器缓缓降落在一颗带巨大星环的橙色星球上，冰晶云层在低空漂浮", atmos: ["moonlight", "golden_hour"] },
    { title: "未来城市航道", subject: "巨型城市的摩天楼群之间飞行器穿梭留下光轨，全息广告在楼体上流动", atmos: ["neon_night", "blue_hour"] },
    { title: "雨中机甲", subject: "一台高大的旧机甲单膝跪在雨中的机库外，技师搭着梯子检修它的肩甲", atmos: ["rain_reflection", "moonlight", "neon_night"] },
    { title: "悬浮群岛", subject: "几座悬浮的岛屿飘在云海上，岛与岛之间由藤蔓与石桥相连，瀑布从岛缘坠落云端", atmos: ["golden_hour", "soft_morning"] },
    { title: "东方赛博茶室", subject: "传统木构茶室与全息屏交错，茶烟升起时穿过一道光束，窗外是高楼夜景", atmos: ["neon_night", "candlelight", "blue_hour"] },
    // ===== 静物物件（4）=====
    { title: "打字机与咖啡", subject: "一台黑色老式打字机摆在橡木桌上，旁边是冒着热气的咖啡杯和揉皱的稿纸", atmos: ["soft_morning", "candlelight", "dappled"] },
    { title: "香水台面", subject: "一瓶磨砂玻璃香水瓶立在浅灰石材台面上，瓶身凝着细小水珠", atmos: ["studio_soft"] },
    { title: "窗边青瓷茶具", subject: "一套青瓷茶具摆在窗边木案上，茶汤澄澈，窗外竹影婆娑", atmos: ["soft_morning", "dappled", "golden_hour"] },
    { title: "旧皮箱", subject: "一只贴满旅行标签的旧皮箱半开着，里面露出相机、地图和一叠信件", atmos: ["soft_morning", "golden_hour", "candlelight"] },
    // ===== 美食（4）=====
    { title: "热汤小面", subject: "一碗热气腾腾的红汤小面端上木桌，红油上浮着葱花，旁边摆着竹筷和陶罐", atmos: ["soft_morning", "candlelight"] },
    { title: "出炉可颂", subject: "刚出炉的可颂在铁架上冒着热气，酥皮层次分明，背景是面包房的原木货架", atmos: ["soft_morning", "golden_hour", "candlelight"] },
    { title: "深夜寿司", subject: "居酒屋吧台上寿司摆放在木托盘里，师傅的手正捏起一团醋饭", atmos: ["candlelight", "neon_night"] },
    { title: "夏日冰饮", subject: "一杯插着薄荷叶的冰柠檬茶挂满水珠，旁边散落着切开的柠檬角", atmos: ["studio_soft", "soft_morning", "dappled"] },
    // ===== 建筑空间（5）=====
    { title: "极简光影墙", subject: "一面纯净的清水混凝土墙上落着几何形的光斑，远处是一扇窄门", atmos: ["studio_soft", "dappled", "golden_hour"] },
    { title: "江南天井", subject: "江南老宅的天井里雨丝斜织，青石板泛着水光，屋檐滴水成线", atmos: ["rain_reflection", "overcast"] },
    { title: "穹顶图书馆", subject: "老图书馆的穹顶大厅里，一排排拱窗把光洒在深色长桌上，绿罩台灯次第亮起", atmos: ["dappled", "candlelight", "golden_hour"] },
    { title: "礁石灯塔", subject: "礁石高地上的白色灯塔与守塔人小屋，浪花在崖下碎成白雾", atmos: ["blue_hour", "moonlight", "overcast"] },
    { title: "废弃车站", subject: "废弃的老火车站站台铁轨爬满藤蔓，候车长椅漆皮剥落，光线从破损的穹顶落下", atmos: ["dappled", "golden_hour", "overcast"] },
    // ===== 以下为 2026 社交平台爆款主题扩容（潮玩拟人 / 微缩空间 / 国风神话 / 萌宠 / 旅行 / 节庆夜色）=====
    // ===== 潮玩与拟人萌宠（8）=====
    { title: "宇航兔盲盒", subject: "一只穿白色宇航服的垂耳兔宇航员，头戴透明泡泡头盔，胸前别着星星徽章，站在迷你月球基地上", atmos: ["studio_soft", "moonlight"] },
    { title: "柑橘小女巫", subject: "一个头戴糖果条纹尖帽的小女巫玩偶，抱着一支巨大的漩涡棒棒糖，站在蘑菇展示底座上", atmos: ["studio_soft", "candlelight"] },
    { title: "柯基上班通勤", subject: "一只穿西装打领带的柯基正单爪举着公文包小跑赶地铁，领带被风吹起", atmos: ["soft_morning", "golden_hour"] },
    { title: "柴犬拉面店主", subject: "一只系着藏青色围裙的柴犬站在拉面摊灶台后，爪子正捞起一缕面条，蒸汽扑面", atmos: ["candlelight", "ember_fire", "neon_night"] },
    { title: "猫咪法官", subject: "一只表情严肃的虎斑猫披着法官袍坐在高背椅上，爪边放着小木槌，图书馆般的背景", atmos: ["chiaroscuro", "dappled"] },
    { title: "熊猫茶艺师", subject: "一只圆滚滚的熊猫穿着中式褂子，正专注地用长嘴铜壶冲茶，水柱在空中划出弧线", atmos: ["soft_morning", "dappled"] },
    { title: "刺猬邮差", subject: "一只背着邮差包的刺猬站在蘑菇邮箱旁，信封上沾着露水和花瓣", atmos: ["soft_morning", "dappled"] },
    { title: "机械小狐狸", subject: "一只黄铜机械小狐狸坐在工作台上，关节处露出精密齿轮，眼睛是温润的琥珀色灯珠", atmos: ["candlelight", "studio_soft"] },
    // ===== 等距微缩空间（7）=====
    { title: "微型画室", subject: "一间塞满画架、颜料管和半成品油画的小画室，窗台上蹲着一只打盹的猫模特", atmos: ["soft_morning", "dappled"] },
    { title: "微型唱片店", subject: "一间摆满黑胶唱片的迷你唱片店，试听台上的唱机正旋转，墙上贴满乐队海报", atmos: ["neon_night", "candlelight"] },
    { title: "微型花房", subject: "一座玻璃顶的迷你花房，层层木架上摆满蕨类和多肉，浇水壶还滴着水珠", atmos: ["soft_morning", "dappled"] },
    { title: "微型程序员工位", subject: "一张双屏代码滚动的紧凑工位，键盘旁堆着能量饮料罐，桌角的盆栽刚刚发芽", atmos: ["neon_night", "blue_hour"] },
    { title: "微型饺子馆", subject: "一间只有四个座位的老饺子馆后厨，面板上排着刚包好的元宝饺子，锅里的水正沸", atmos: ["ember_fire", "soft_morning"] },
    { title: "微型天台花园", subject: "城市天台改造成的迷你花园，串灯下摆着藤椅和小茶桌，远处是朦胧的楼群", atmos: ["blue_hour", "golden_hour", "fireworks"] },
    { title: "微型钟表铺", subject: "一间老钟表铺的工作台，放大镜下齿轮零件分门别类，墙上挂钟指针停在不同时刻", atmos: ["candlelight", "chiaroscuro"] },
    // ===== 国风神话（8）=====
    { title: "敦煌飞天", subject: "一位敦煌壁画中的飞天从洞窟穹顶飘然而下，披帛与彩带在空中舒卷，手持琵琶", atmos: ["golden_hour", "candlelight"] },
    { title: "锦鲤跃龙门", subject: "一尾红金锦鲤跃出惊涛，鳞片溅起水光，身后是青黑色的龙门石坊", atmos: ["blue_hour", "moonlight"] },
    { title: "月宫桂树", subject: "广寒宫的桂树下，白兔正捣药，玉杵起落间桂叶飘落，远处宫阙半掩云雾", atmos: ["moonlight"] },
    { title: "雪夜舞狮", subject: "一对红金醒狮在雪夜的古镇石桥上腾跃，狮头昂扬，锣鼓队跟在身后", atmos: ["fireworks", "ember_fire", "snow_light"] },
    { title: "皮影戏台", subject: "老戏台的白色幕布上皮影翻飞，幕布后一盏油灯把影子投得巨大，台下坐着乘凉的老人", atmos: ["candlelight", "ember_fire"] },
    { title: "山间云雾古寺", subject: "一座木质古寺半隐在翻涌的云海之上，飞檐挂着铜铃，石阶从云中蜿蜒而上", atmos: ["soft_morning", "golden_hour"] },
    { title: "江南采莲", subject: "采莲少女撑一叶扁舟穿行在荷叶间，船头堆着莲蓬，蜻蜓落在竹篙上", atmos: ["soft_morning", "dappled", "golden_hour"] },
    { title: "灯笼铺子", subject: "老灯笼铺的屋檐下挂满未点的红灯笼，匠人正给最后一盏描金，巷子深处飘着小雨", atmos: ["candlelight", "rain_reflection", "blue_hour"] },
    // ===== 奇幻想象（7）=====
    { title: "天空鲸群", subject: "几头巨大的鲸鱼游弋在晚霞的天空中，腹部的星图隐约发光，云朵像海浪一样翻卷", atmos: ["golden_hour", "moonlight"] },
    { title: "蘑菇萤光森林", subject: "巨人般巨大的发光蘑菇林下，一队提灯的小蘑菇精灵列队回家，孢子像雪一样飘", atmos: ["moonlight", "aurora"] },
    { title: "水晶洞穴", subject: "巨大的紫水晶簇从洞穴四壁生长出来，中央一汪平静的水晶潭倒映着晶光", atmos: ["aurora", "moonlight"] },
    { title: "空中帆船", subject: "一艘扬起风帆的飞艇帆船穿行在积雨云之间，船舷挂着黄铜提灯，缆绳上落着海鸥", atmos: ["golden_hour", "blue_hour"] },
    { title: "巨人的花园", subject: "废弃的花园里，藤蔓缠绕着巨人遗落的石靴，靴子里开满了蓝紫色的鸢尾", atmos: ["dappled", "overcast"] },
    { title: "极光下的冰湖", subject: "一面结冰的湖水下封存着气泡串，天上的极光在冰面上映出流动的光幕", atmos: ["aurora", "moonlight", "snow_light"] },
    { title: "纸鹤化龙", subject: "一千只纸鹤从书页间飞起，在空中汇成一条蜿蜒的龙形，纸翼被夕光照得半透明", atmos: ["golden_hour", "studio_soft"] },
    // ===== 旅行与远方（8）=====
    { title: "草原热气球", subject: "几只条纹热气球悬浮在起伏的草原上空，影子投在金黄的草浪上，羊群散落如珠", atmos: ["golden_hour", "soft_morning"] },
    { title: "海边公路房车", subject: "一辆复古老爷车拖着房车停在海边公路的观景弯道，车尾朝着无边的海平线", atmos: ["golden_hour", "blue_hour"] },
    { title: "渔村灯塔黄昏", subject: "渔村码头上渔船归港，桅杆林立，穿胶靴的渔妇正把银亮的鱼获卸上岸", atmos: ["golden_hour", "blue_hour"] },
    { title: "雪山缆车", subject: "红色的缆车车厢悬在雪线之上的铁索上，脚下是松林与冰瀑，远处山脊绵延", atmos: ["snow_light", "soft_morning"] },
    { title: "沙漠星空露营", subject: "沙漠中央一顶发光的帐篷旁燃着篝火，银河横贯头顶的夜空，沙丘边缘轮廓温柔", atmos: ["ember_fire", "moonlight"] },
    { title: "古镇石桥", subject: "江南古镇的半月石桥上，卖白兰花的老奶奶与撑油纸伞的姑娘擦肩，桥下乌篷船正过", atmos: ["rain_reflection", "soft_morning", "overcast"] },
    { title: "稻田小火车", subject: "一辆彩色的小火车穿过灌水的稻田，车顶落着白鹭，铁轨两侧稻穗低垂", atmos: ["golden_hour", "soft_morning"] },
    { title: "悬崖秋千", subject: "山谷悬崖边的秋千正荡向空中，坐着的女孩张开双手，脚下是云雾缭绕的深谷", atmos: ["golden_hour", "soft_morning"] },
    // ===== 夜色与节庆（7）=====
    { title: "夜市烟火", subject: "热闹的夜市摊位前，铁板上的鱿鱼滋滋作响，摊主颠着炒锅，火苗窜起半米高", atmos: ["neon_night", "ember_fire"] },
    { title: "江边天灯", subject: "数百盏天灯正从江边的沙滩上缓缓升起，人们在灯面上写下心愿，江水映着暖光", atmos: ["candlelight", "fireworks", "blue_hour"] },
    { title: "烟花下的屋顶", subject: "两个孩子坐在老屋顶的瓦片上仰头看烟花，手中的仙女棒还剩最后一点火花", atmos: ["fireworks", "blue_hour"] },
    { title: "末班地铁", subject: "末班地铁车厢里灯光温白，靠门的女孩抱着吉他在打盹，车窗外的隧道灯飞成光线", atmos: ["neon_night", "blue_hour"] },
    { title: "天台远眺", subject: "一个身影坐在高楼天台的边缘，脚下的城市灯火像铺开的电路板，晚风掀起衣角", atmos: ["blue_hour", "neon_night"] },
    { title: "庙会糖画摊", subject: "庙会一角的糖画摊前，老师傅手腕一转，糖丝在石板上凝成一只凤凰，孩子们踮脚围观", atmos: ["ember_fire", "candlelight", "fireworks"] },
    { title: "雪夜温泉", subject: "山林间的一池温泉冒着白汽，池边石灯笼覆着薄雪，一只猴子泡在池中惬意闭眼", atmos: ["moonlight", "snow_light", "ember_fire"] },
    // ===== 潮流静物与美食（6）=====
    { title: "球鞋陈列", subject: "一只配色大胆的复古球鞋悬浮展示在亚克力盒中，鞋底纹路清晰，附着的鞋带飞出弧线", atmos: ["studio_soft", "neon_night"] },
    { title: "机械键盘特写", subject: "一把键帽配色复古的机械键盘摊在木桌上，键帽间落着一颗多肉和一枚硬币", atmos: ["soft_morning", "studio_soft"] },
    { title: "黑胶唱机", subject: "一台木质黑胶唱机的唱针正落在旋转的唱片上，唱片的纹理在灯下泛着虹彩", atmos: ["candlelight", "chiaroscuro"] },
    { title: "冬日火锅", subject: "铜锅炭火上汤底翻滚，夹起的一片肥牛还挂着汤，窗外隐约有雪", atmos: ["ember_fire", "candlelight"] },
    { title: "章鱼小丸子", subject: "铁板上滚圆的小丸子刚刷上酱汁，木船形的纸托里撒着柴鱼片，鱼片在热气中起舞", atmos: ["neon_night", "soft_morning"] },
    { title: "马卡龙塔", subject: "一座马卡龙塔摆在大理石甜品台上，糖果色的外壳在柔光下泛着细腻的光泽", atmos: ["studio_soft", "soft_morning"] },
    // ===== 爆款扩容二期：人物职业 / 电商产品 / 建筑美学 / 世界地标 / 知识图谱 =====
    // ===== 人物·职业与心流瞬间（10）=====
    { title: "修表匠", subject: "一位戴着单眼放大镜的老修表匠伏在工作台前，镊子尖夹着一枚比米粒还小的齿轮，台灯把他的影子钉在墙上", atmos: ["chiaroscuro", "candlelight"] },
    { title: "调香师", subject: "一位白衬衫调香师在暗色木质工作台前试香，指尖捏着试香纸凑近鼻尖，身后是一整墙贴满标签的琥珀色小瓶", atmos: ["candlelight", "studio_soft"] },
    { title: "小提琴手", subject: "一位小提琴手在空荡的老剧院观众席正中央练习，乐谱架上摊开的手写谱子，尘封的天鹅绒座椅环绕四周", atmos: ["chiaroscuro", "golden_hour"] },
    { title: "宇航员的窗边", subject: "一位宇航员静静漂浮在空间站舷窗边，蔚蓝的地球在窗外缓缓转动，舱内仪表灯映在他头盔的面罩上", atmos: ["moonlight", "blue_hour"] },
    { title: "消防员休整", subject: "两位满身烟尘的消防员坐在消防车尾啃西瓜，头盔回扣在膝盖上，消防站的卷帘门半开着透进夕光", atmos: ["golden_hour", "soft_morning"] },
    { title: "芭蕾清晨课", subject: "一位芭蕾舞者扶着老练功房的把杆压腿，晨光穿过高窗落在磨旧的地板上，她的影子与镜中身影重叠", atmos: ["soft_morning", "dappled"] },
    { title: "剑道晨练", subject: "一位剑道练习者在木地板道场中挥刀定格，护具整齐摆在场边，汗珠随动作甩出一道弧线", atmos: ["soft_morning", "studio_soft"] },
    { title: "早点铺主厨", subject: "一位系白围裙的主厨在早点铺后厨揉面，面粉粉尘在逆光里飞舞，蒸笼塔在他身后冒着白汽", atmos: ["soft_morning", "ember_fire"] },
    { title: "深夜电台主播", subject: "一位电台主播隔着隔音玻璃对着话筒轻声说话，调音台的推子泛着微光，桌上咖啡已经凉了", atmos: ["neon_night", "candlelight"] },
    { title: "鞋匠的黄昏", subject: "一位老鞋匠在巷口摊位前给皮鞋上线，蜡线在他手中绷紧，身后的工具墙挂满用了几十年的锥子和楦头", atmos: ["golden_hour", "candlelight"] },
    // ===== 电商产品·爆款商品图（8）=====
    { title: "精华瓶水波", subject: "一支磨砂玻璃精华瓶立在浅蓝渐变背景的水波纹理上，瓶身凝着水珠，一片荷叶作陪衬", atmos: ["studio_soft"] },
    { title: "降噪耳机悬浮", subject: "一副米白色头戴降噪耳机悬浮在奶油色背景中，耳罩皮质细腻，下面投出一圈柔和的环形阴影", atmos: ["studio_soft"] },
    { title: "腕表机械心", subject: "一块镂空机械腕表斜立在黑色石材上，表盘后的齿轮游丝纤毫毕现，冷光扫过蓝钢指针", atmos: ["studio_soft", "chiaroscuro"] },
    { title: "香薰蜡烛晨光", subject: "一罐大豆香薰蜡烛摆在亚麻桌布上，木芯冒出一缕细烟，旁边散着干薰衣草和火柴", atmos: ["soft_morning", "dappled"] },
    { title: "咖啡豆烘焙", subject: "一只麻布袋里的咖啡豆倾泻在原木台面上，一颗颗油亮饱满，牛皮纸包装立在后面", atmos: ["soft_morning", "golden_hour"] },
    { title: "运动水壶俯拍", subject: "一只哑光渐变色运动水壶平放在浅灰背景上，壶身挂着冷凝水珠，瓶盖旋开一半露出硅胶密封圈", atmos: ["studio_soft"] },
    { title: "口红膏体特写", subject: "一支金管口红的膏体旋出特写，切面棱角锋利，膏体上有一道新划过的丝绒试色", atmos: ["studio_soft", "chiaroscuro"] },
    { title: "帆布鞋与花瓣", subject: "一双低帮帆布鞋摆在水磨石地面上，鞋带松散，几片干花瓣散落在鞋边，背景是一面粉色墙", atmos: ["soft_morning", "studio_soft"] },
    // ===== 建筑美学（7）=====
    { title: "螺旋阶梯", subject: "一座奶白色螺旋阶梯从穹顶垂落盘旋而上，从底部仰拍，阶梯边缘的弧线一圈圈收向天窗", atmos: ["studio_soft", "dappled"] },
    { title: "清水混凝土美术馆", subject: "一座清水混凝土美术馆的中庭，一面巨幅落地窗把海平线框成一幅画，一个人静静站在画前", atmos: ["soft_morning", "overcast"] },
    { title: "冰雪酒店", subject: "一座用冰砖砌成的酒店大厅，冰雕吊灯垂落，蓝色冰墙里冻着细小的气泡，壁炉的火光给冰面染上暖色", atmos: ["aurora", "ember_fire", "snow_light"] },
    { title: "集装箱书店", subject: "两只橙色集装箱错落叠成的街角书店，落地玻璃里透出暖光，屋顶平台摆着两把折叠椅", atmos: ["blue_hour", "golden_hour"] },
    { title: "梯田民宿", subject: "一家夯土民宿嵌在梯田半山，无边界泳池的水面与远处云海齐平，一盏竹编灯笼刚点亮", atmos: ["blue_hour", "golden_hour", "soft_morning"] },
    { title: "清真寺拱顶", subject: "清真寺祈祷大厅的拱顶布满蓝金几何纹样，光从彩色玻璃窗斜落进来，在地毯上拼出花纹", atmos: ["dappled", "candlelight", "golden_hour"] },
    { title: "包豪斯白别墅", subject: "一栋包豪斯风格的白色平顶别墅立在松林边，横向长窗映着天光，门前一辆复古自行车靠在栏杆上", atmos: ["soft_morning", "overcast", "golden_hour"] },
    // ===== 世界地标（8）=====
    { title: "富士山与樱花", subject: "富士山对称的雪顶下，一排樱花沿着河道盛开，一叶扁舟正划过落满花瓣的水面", atmos: ["soft_morning", "golden_hour"] },
    { title: "长城秋色", subject: "秋天的长城沿着山脊伸向远方，敌楼立在层林尽染的山峦间，一段石阶上落满黄叶", atmos: ["golden_hour", "overcast"] },
    { title: "金字塔驼影", subject: "金字塔在沙暴初歇的黄昏显出清晰的轮廓，一支驼队的长影投在沙丘上缓缓前行", atmos: ["golden_hour", "moonlight"] },
    { title: "罗马斗兽场", subject: "罗马斗兽场的拱门残壁在晨光中显出温暖的赭石色，一只鸽子从断拱上振翅飞起", atmos: ["golden_hour", "soft_morning"] },
    { title: "圣托里尼蓝顶", subject: "圣托里尼的白色房子沿火山崖层层叠落，蓝顶教堂在正午阳光下蓝得纯粹，远处爱琴海深浅分明", atmos: ["soft_morning", "studio_soft"] },
    { title: "冰岛黑教堂", subject: "一座纯黑木教堂孤零零立在雪原上，背后是平顶山脉，极光刚好在教堂尖顶上方亮起", atmos: ["aurora", "snow_light", "overcast"] },
    { title: "京都竹林小径", subject: "京都岚山竹林小径两侧的竹子高耸如绿色穹顶，光斑落在碎石路面上，一位穿和服的身影远远走来", atmos: ["dappled", "soft_morning"] },
    { title: "威尼斯水巷", subject: "威尼斯水巷里贡多拉正驶过窄窄的水道，斑驳的墙面映进水里，一扇百叶窗后晾着白衬衫", atmos: ["golden_hour", "rain_reflection"] },
    // ===== 知识图谱·可视觉化科普（6）=====
    { title: "水循环黑板报", subject: "一块墨绿色黑板上用彩色粉笔画着水循环示意图，太阳、云朵、雨滴与地下河流连成一个环，板角画着一只打伞的小猫", atmos: ["soft_morning", "studio_soft"] },
    { title: "光合作用立体书", subject: "一本摊开的科普立体书，纸艺的植物叶片间立着阳光箭头与气泡组成的能量流程，翻起的纸页上有小标签", atmos: ["soft_morning", "dappled"] },
    { title: "蜜蜂授粉图谱", subject: "一张手绘风博物学图版，中央是蜜蜂采蜜的解剖示意，四周放射状排开花朵结构与授粉路径的编号小图", atmos: ["soft_morning", "dappled"] },
    { title: "太阳系沙盘", subject: "一张教室中央摆着太阳系黄铜沙盘模型，行星按轨道嵌在同心圆黄铜轨上，太阳位置亮着一盏小灯", atmos: ["candlelight", "chiaroscuro"] },
    { title: "月相变化挂图", subject: "一面深蓝色墙面上挂着月相变化木框挂图，八个月亮从新月排到满月，下方一位孩子正指着今晚的月相", atmos: ["moonlight", "blue_hour"] },
    { title: "食物链木刻画卷", subject: "一幅展开的木刻版画长卷，从浮游藻类到鲸鱼的食物链层层递进，箭头把每个环节连成闭环，边角画着小小的浮游生物", atmos: ["studio_soft", "soft_morning"] }
  ];

  // 组合总数（用于提示规模）：Σ(场景光线候选数) × 风格数 × 构图数
  __APP.RANDOM_PROMPT_COMBINATION_COUNT = __APP.RANDOM_SUBJECTS.reduce(function (sum, item) {
    return sum + item.atmos.length;
  }, 0) * __APP.RANDOM_STYLES.length * __APP.RANDOM_COMPOSITIONS.length;

  __APP.MODE_META = {
    text: { label: "文生图" }
  };

  /**
   * 提示词库默认分类，用于新增提示词时的下拉候选
   * 用户也可以自由输入新的分类
   */
  __APP.PROMPT_LIBRARY_DEFAULT_CATEGORIES = [
    "未分类",
    "写实摄影",
    "海报视觉",
    "数字插画",
    "水彩手绘",
    "3D 物料",
    "东方美学",
    "产品摄影",
    "人物肖像",
    "概念场景",
    "收藏"
  ];

  __APP.OPTIMIZE_PROMPT_INSTRUCTION = [
    "你是一名专业 AI 生图提示词工程师。请将用户输入的提示词优化为一段结构完整、细节丰富的生图提示词。",
    "优化时严格按照以下公式组织内容：主体 + 动作 + 场景 + 风格 + 细节。",
    "主体：明确画面中的核心对象，包括身份、数量、外貌特征、服饰等。",
    "动作：描述主体的姿态、表情、行为或互动方式。",
    "场景：交代环境、地点、时间、天气、氛围等背景信息。",
    "风格：指定艺术风格、画风参考、镜头质感、色彩基调等。",
    "细节：补充光线方向、景深虚化、材质纹理、构图裁切、画质等增强真实感的描述。",
    "要求：",
    "1. 只输出优化后的提示词本身，不要写任何解释、分析或标注。",
    "2. 不要输出任何思考过程、推理过程或内部想法，直接给出最终提示词。",
    "3. 保留用户原始意图，在此基础上丰富和补全，不要改变核心内容。",
    "4. 输出中文，自然流畅，可以直接用于生图。"
  ].join("\n");

  // ==================== 小红书图文笔记板块 ====================

  // 小红书笔记统一使用 3:4 竖版（小红书标准展示比例）
  __APP.XHS_ASPECT_RATIO = "3:4";

  // 首次使用时的种子风格（会写入自定义风格库，可编辑/删除，不属于内置固定风格）
  __APP.XHS_SEED_STYLE = {
    name: "儿童版知识图解",
    prompt: "儿童版知识图解风格：扁平矢量插画，明亮柔和的马卡龙配色，圆润卡通造型，粗描边，浅色干净背景，画面中央有大号圆体中文标题，信息分区清晰，配简单图示、图标与箭头标注，像儿童百科知识卡片，活泼友好，教育感强，画面精致高细节。"
  };

  /**
   * 小红书板块示例主题（点击快速填入）
   */
  __APP.XHS_SAMPLE_TOPICS = [
    "中国四大发明，包括造纸术、指南针、火药、印刷术",
    "太阳系八大行星，包括水星、金星、地球、火星、木星、土星、天王星、海王星",
    "彩虹是怎么形成的"
  ];

  /**
   * 小红书大纲生成指令（第一次 LLM 调用）
   * 要求模型输出严格的 JSON 大纲：笔记标题 + 封面内容 + 每个子主题页
   */
  __APP.XHS_OUTLINE_INSTRUCTION = [
    "你是一名小红书图文笔记策划师。请根据用户输入的主题，策划一份图文笔记大纲（1 张封面 + 若干分镜内容页）。",
    "若用户消息中给出了「风格要求」，封面与每一页的视觉规划必须严格遵循该风格来拆解内容。",
    "严格只输出 JSON，不要输出任何解释、前后缀或代码块标记，格式如下：",
    '{"title":"笔记主标题","cover":{"heading":"封面大标题","subheading":"封面副标题","highlights":["子主题1","子主题2"]},"pages":[{"name":"子主题名称","points":["讲解要点1","讲解要点2","讲解要点3"]}]}',
    "要求：",
    "1. title 是整篇笔记的标题，cover.heading 是封面上的大字标题，控制在 12 字以内",
    "2. cover.highlights 依次列出所有子主题名称，与 pages 顺序一致",
    "3. pages 数量必须严格遵守用户消息中的「张数要求」（总张数 = 封面 1 张 + pages 数量）；若用户未指定张数，一般 2-8 个子主题",
    "4. 每页 points 为 2-4 条简短讲解要点，每条不超过 20 字，语言简洁易懂",
    "5. 内容要科学准确、条理清晰，紧扣用户输入的主题，不要随意增删子主题",
    "6. 输出必须是严格合法的 JSON：所有键名和字符串值（包括数组里的每一项）都必须用英文双引号包裹，例如 \"highlights\":[\"造纸术\",\"指南针\"]，绝不允许输出 [彩虹是什么, 阳光] 这类未加引号的内容"
  ].join("\n");

  /**
   * 小红书配图提示词生成指令（第二次 LLM 调用）
   * 输入大纲 JSON，输出每张图的生图提示词数组
   */
  __APP.XHS_PROMPT_INSTRUCTION = [
    "你是一名 AI 生图提示词工程师，正在为小红书图文笔记配图编写生图提示词。",
    "输入是一份笔记大纲 JSON，请为封面和每个子主题页各编写一条中文生图提示词。",
    "严格只输出 JSON 数组，不要输出任何解释或代码块标记，格式如下：",
    '[{"index":0,"type":"cover","text":"封面提示词"},{"index":1,"type":"page","name":"子主题名称","text":"内容页提示词"}]',
    "提示词编写要求：",
    "1. 第一条必须是封面：提示词中必须包含醒目的大号标题文字「{封面大标题}」，并要求画面完整列出所有子主题名称",
    "2. 每个内容页的提示词必须包含：大号标题文字「{子主题名称}」、与该子主题匹配的图示元素、以及讲解要点的可视化呈现",
    "3. 提示词中出现的文字内容必须用中文，且与大纲完全一致，不要写错别字",
    "4. 每条提示词要具体描述画面构图、主体元素与讲解信息的呈现方式；不要直接写画风描述（画风由系统按所选风格统一拼接）",
    "5. 只输出 JSON 数组本身，数组的 index 从 0 开始，0 为封面，之后依次对应 pages"
  ].join("\n");

  // ==================== 图生图工作台板块 ====================

  // 上传图片送视觉模型分析前的压缩参数：限制最大边长并转 JPEG，
  // 避免手机原图（几 MB）直接 base64 导致请求体过大、token 浪费或接口超时
  __APP.IMG2IMG_MAX_UPLOAD_EDGE = 1280;
  __APP.IMG2IMG_JPEG_QUALITY = 0.85;
  // 多图合成模式最多可上传的图片数
  __APP.IMG2IMG_MAX_UPLOAD_IMAGES = 9;
  // 单次生图请求（含异步任务轮询）的客户端硬超时
  __APP.IMG2IMG_GENERATE_TIMEOUT_MS = 12 * 60 * 1000;

  /**
   * 图生图功能模式
   */
  __APP.IMG2IMG_MODES = [
    {
      value: "extract",
      label: "提取提示词",
      desc: "上传一张图，一键得到中文 + 英文绘图提示词",
      maxImages: 1,
      runLabel: "一键提取提示词",
      needGeneration: false
    },
    {
      value: "edit",
      label: "修改图片",
      desc: "上传一张图，说出修改要求，AI 直接改图（如把猫换成小狗）",
      maxImages: 1,
      runLabel: "开始修改",
      needGeneration: true
    },
    {
      value: "compose",
      label: "多图合成",
      desc: "上传最多 9 张图，描述组合方式（如把图 A 放进图 B）",
      maxImages: 9,
      runLabel: "开始合成",
      needGeneration: true
    }
  ];

  /** 图生图「提取提示词」模式指令 */
  __APP.IMG2IMG_EXTRACT_INSTRUCTION = [
    "你是一名资深 AI 生图提示词工程师，擅长把图片转写为高质量生图提示词。",
    "用户会提供一张图片，请仔细观察后输出一个 JSON 对象，严格只输出 JSON，不要输出任何解释、前后缀或代码块标记，格式如下：",
    '{"summary":"一句话画面概述","promptZh":"中文提示词","promptEn":"English prompt"}',
    "要求：",
    "1. promptZh 用中文书写，融合主体、场景、构图、风格、配色、光影等要素，200 字以内，具体可执行，不出现「图中」「该图」等指代词",
    "2. promptEn 是 promptZh 的地道英文版本，遵循 Stable Diffusion / Midjourney 提示词习惯，用逗号分隔关键词短语",
    "3. 图中出现文字时必须在两个版本的提示词中原样保留（中文用「」包裹，英文用双引号包裹），不要写错别字，也不要编造原图不存在的文字",
    "4. 输出必须是严格合法的 JSON：所有键名和字符串值都用英文双引号包裹"
  ].join("\n");

  /** 图生图「修改图片 / 多图合成」模式指令：按用户要求输出改造后的中文提示词 */
  __APP.IMG2IMG_EDIT_INSTRUCTION = [
    "你是一名资深 AI 生图提示词工程师，擅长根据用户要求修改或合成图片。",
    "用户会提供一张或多张图片（多张时会在图片说明前缀标注「图A」「图B」等），同时给出修改/合成要求。",
    "请综合图片内容与用户要求，输出一个 JSON 对象，严格只输出 JSON，不要输出任何解释、前后缀或代码块标记，格式如下：",
    '{"summary":"修改方案说明","promptZh":"改造后的中文提示词"}',
    "要求：",
    "1. promptZh 用中文书写，完整描述改造后的目标画面，包含主体、场景、构图、风格、配色、光影等要素，200 字以内，具体可执行",
    "2. 必须严格遵守用户的修改/合成要求，不要遗漏关键点；未要求改动的元素要尽量保留原貌",
    "3. 图中出现文字时必须原样保留（中文用「」包裹），不要写错别字，也不要编造原图不存在的文字",
    "4. 输出必须是严格合法的 JSON：所有键名和字符串值都用英文双引号包裹"
  ].join("\n");

  __APP.normalizeImageQuality = function (value) {
    return __APP.IMAGE_QUALITIES.some(function (item) { return item.value === value; }) ? value : "2K";
  };

  __APP.getGptImageSize = function (aspectRatio, imageQuality, sizeFormat) {
    if (sizeFormat === "ratio") {
      return aspectRatio;
    }

    var sizesByQuality = {
      "1K": {
        "1:1": "1024x1024",
        "3:4": "768x1024",
        "4:3": "1024x768",
        "9:16": "576x1024",
        "16:9": "1024x576",
        "21:9": "1344x576"
      },
      "2K": {
        "1:1": "2048x2048",
        "3:4": "1536x2048",
        "4:3": "2048x1536",
        "9:16": "1152x2048",
        "16:9": "2048x1152",
        "21:9": "2688x1152"
      },
      "4K": {
        "1:1": "4096x4096",
        "3:4": "3072x4096",
        "4:3": "4096x3072",
        "9:16": "2304x4096",
        "16:9": "4096x2304",
        "21:9": "5376x2304"
      }
    };
    var quality = __APP.normalizeImageQuality(imageQuality);
    return (sizesByQuality[quality] && sizesByQuality[quality][aspectRatio]) || sizesByQuality[quality]["1:1"];
  };

  // 启动期执行一次旧键迁移，确保已有用户的本地配置无缝过渡到新键
  try { __APP.migrateLegacyStorage(); } catch (e) { /* ignore */ }
})();
