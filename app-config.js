(function () {
  window.__APP = window.__APP || {};

  __APP.STORAGE_KEYS = {
    gptApiKey: "jiaoge-ai-toolbox:gpt-image-api-key",
    agnesApiKey: "jiaoge-ai-toolbox:agnes-image-api-key",
    model: "jiaoge-ai-toolbox:image-model",
    draft: "jiaoge-ai-toolbox:image-draft",
    batchDraft: "jiaoge-ai-toolbox:image-batch-draft",
    history: "jiaoge-ai-toolbox:image-history-v1",
    legacyGallery: "jiaoge-ai-toolbox:image-gallery-v1",
    aspectRatio: "jiaoge-ai-toolbox:image-aspect-ratio",
    imageQuality: "jiaoge-ai-toolbox:image-quality",
    styleTemplate: "jiaoge-ai-toolbox:image-style-template",
    imageCount: "jiaoge-ai-toolbox:image-count",
    mode: "jiaoge-ai-toolbox:image-mode",
    taskMode: "jiaoge-ai-toolbox:image-task-mode",
    previewPanelCollapsed: "jiaoge-ai-toolbox:preview-panel-collapsed",
    chatPanelHeight: "jiaoge-ai-toolbox:chat-panel-height",
    sidebarWidth: "jiaoge-ai-toolbox:sidebar-width",
    account: "jiaoge-ai-toolbox:account",
    agnesModel: "jiaoge-ai-toolbox:agnes-model",
    agnesBaseUrl: "jiaoge-ai-toolbox:agnes-base-url",
    gptImageModel: "jiaoge-ai-toolbox:gpt-image-model",
    customImageApiKey: "jiaoge-ai-toolbox:custom-image-api-key",
    customImageBaseUrl: "jiaoge-ai-toolbox:custom-image-base-url",
    customImageModel: "jiaoge-ai-toolbox:custom-image-model",
    imageChannels: "jiaoge-ai-toolbox:image-channels-v1",
    llmProviders: "jiaoge-ai-toolbox:llm-providers",
    optimizeProvider: "jiaoge-ai-toolbox:optimize-provider",
    optimizeModel: "jiaoge-ai-toolbox:optimize-model",
    promptLibrary: "jiaoge-ai-toolbox:prompt-library-v1"
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
    var existing = window.localStorage.getItem(__APP.STORAGE_KEYS.imageChannels);
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

    // 迁移 GPT-Image 中转通道
    var gptKey = window.localStorage.getItem(__APP.STORAGE_KEYS.gptApiKey);
    var gptModel = window.localStorage.getItem(__APP.STORAGE_KEYS.gptImageModel);
    if (gptKey) {
      channels[0].apiKey = gptKey || "";
      channels[0].baseUrl = __APP.APIMART_GENERATION_URL.replace(/\/images\/generations$/, "");
      channels[0].model = gptModel || __APP.GPT_IMAGE_MODEL;
      channels[0].enabled = true;
    }

    // 迁移自定义生图通道
    var customKey = window.localStorage.getItem(__APP.STORAGE_KEYS.customImageApiKey);
    var customBaseUrl = window.localStorage.getItem(__APP.STORAGE_KEYS.customImageBaseUrl);
    var customModel = window.localStorage.getItem(__APP.STORAGE_KEYS.customImageModel);
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

    // 迁移 Agnes 通道
    var agnesKey = window.localStorage.getItem(__APP.STORAGE_KEYS.agnesApiKey);
    var agnesBaseUrl = window.localStorage.getItem(__APP.STORAGE_KEYS.agnesBaseUrl);
    var agnesModel = window.localStorage.getItem(__APP.STORAGE_KEYS.agnesModel);
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
  // 随机生图提示词库，共 30 条，覆盖人物、动物、风景、电影海报、科技、生活物件六大类
  __APP.RANDOM_IMAGE_PROMPTS = [
    // ===== 人物肖像（6 条）=====
    {
      title: "电影感雨夜街角",
      prompt: "电影感写实摄影，一位穿深色风衣的年轻人在雨夜霓虹街角停下脚步，湿润柏油路反射红蓝灯牌，浅景深，35mm 镜头，柔和背光，画面有悬疑故事感，高细节，高级调色。"
    },
    {
      title: "古风仕女图",
      prompt: "工笔重彩国画风格，一位身着唐代襦裙的仕女立于庭院芭蕉叶下，手持团扇半遮面，发髻插金步摇，神情含蓄温柔，背景是盛开的牡丹和太湖石，色彩典雅，线条细腻，国风人物肖像。"
    },
    {
      title: "街头滑板少年",
      prompt: "街头纪实摄影，一位戴棒球帽和耳机的少年在黄昏城市广场腾空做滑板动作，运动鞋和滑板清晰可见，背景是涂鸦墙和逆光剪影人群，35mm 胶片质感，动感十足，青春氛围。"
    },
    {
      title: "老匠人陶艺",
      prompt: "纪实人像摄影，一位花白胡须的老陶艺匠人坐在拉坯机前，双手沾满泥浆正在塑形一只陶碗，专注的神情被侧窗自然光照亮，背景是摆满陶坯的木质架子，温暖色调，工匠精神，浅景深。"
    },
    {
      title: "海岛悬崖无边泳池",
      prompt: "热带悬崖酒店的无边泳池延伸至海平面，远处是渐变色的海和落日，池边一位穿白色连衣裙的女性侧身望向远方，35mm 电影镜头，柔和逆光，高端度假杂志封面质感。"
    },
    {
      title: "老北京胡同早餐铺",
      prompt: "清晨老北京胡同口的早餐铺，蒸汽从豆浆锅和油条锅里升起，老师傅在现炸油条，门楣上挂着褪色手写招牌，红色暖光从店内透出，写实纪实摄影，胶片色调，年代感十足。"
    },
    // ===== 动物（6 条）=====
    {
      title: "猫咪侦探办公室",
      prompt: "拟人化猫咪侦探坐在复古办公室桌前查看线索，百叶窗投下光影，桌上有放大镜、旧照片和打字机，黑色电影风格，幽默但精致，插画完成度高。"
    },
    {
      title: "雪地哈士奇",
      prompt: "野生动物摄影，三只哈士奇在白雪覆盖的森林空地上奔跑，嘴里吐出白色哈气，蓝眼睛炯炯有神，雪花在逆光中飞舞，高速快门定格动作，背景是朦胧的白桦林，冬日活力画面，高细节。"
    },
    {
      title: "非洲草原狮群日落",
      prompt: "国家地理风格野生动物摄影，非洲塞伦盖蒂草原上，一群狮子在金色的夕阳下休息，雄狮鬃毛被逆光照亮，远处是合欢树剪影和象群，广角构图，暖色调，史诗自然纪录片质感。"
    },
    {
      title: "水下海龟漫游",
      prompt: "水下摄影，一只巨大的绿海龟在清澈的蔚蓝海水中优雅游动，阳光光柱穿透水面照射在龟壳上，周围是彩色珊瑚礁和热带鱼群，广角水下镜头，蓝色调，自然纪录片质感，高细节。"
    },
    {
      title: "森林精灵光球",
      prompt: "奇幻插画风格，深夜森林里一只鹿从树丛中探出头，鹿角上缠绕着发光藤蔓和萤火虫光球，月光从树冠缝隙洒落，地面是发光的苔藓，魔法治愈氛围，数字绘画，细节精致。"
    },
    {
      title: "树懒微笑特写",
      prompt: "超近距离动物特写摄影，一只树懒挂在热带雨林的树枝上，脸部正对镜头露出招牌式的微笑表情，毛发蓬松沾着露珠，背景是虚化的绿色雨林，柔和自然光，可爱治愈，高细节。"
    },
    // ===== 风景（6 条）=====
    {
      title: "雪山湖畔小屋",
      prompt: "雪山湖畔的一间温暖木屋，黄昏蓝调时刻，屋内灯光透出，湖面倒映山峰和星空，宁静旅行摄影风格，广角构图，空气清澈，画面治愈。"
    },
    {
      title: "冬日温泉雪景",
      prompt: "日本温泉旅馆的露天浴池，周围被厚厚积雪覆盖，木质屋顶飘着淡淡蒸汽，远处是层叠雪山和松林，池边摆着木桶和毛巾，傍晚蓝调时刻，写实摄影，宁静治愈画面。"
    },
    {
      title: "张家界石柱云海",
      prompt: "中国张家界国家森林公园，巨大的砂岩石柱群从云海中拔地而起，石柱顶部覆盖绿植，云雾在石柱间流动翻涌，清晨金色阳光从侧方照射，广角风光摄影，水墨意境，气势磅礴。"
    },
    {
      title: "冰岛极光",
      prompt: "冰岛杰古沙龙冰湖夜景，天空中绿色和紫色极光如丝带般舞动，倒映在漂浮着蓝色冰山碎块的黑色沙滩水面上，远处是冰川轮廓，长曝光摄影，超广角，宁静壮丽，高细节。"
    },
    {
      title: "托斯卡纳田园",
      prompt: "意大利托斯卡纳夏日黄昏，起伏的绿色山丘上排列着笔直的柏树，远处有一座石头农舍和教堂尖顶，金色麦田在微风中摇曳，暖色调，风光摄影，电影感构图，田园诗意。"
    },
    {
      title: "水彩春日花园",
      prompt: "温柔水彩插画，春日花园里一张白色小圆桌，上面有打开的书、茶杯和几朵鲜花，微风吹动窗帘，色彩柔和，纸张纹理明显，宁静午后氛围。"
    },
    // ===== 电影海报（5 条）=====
    {
      title: "都市雨夜出租车",
      prompt: "电影感写实摄影，一辆复古黄色出租车停在雨夜街边，车内仪表盘发出暖黄色光，雨刷器刚划过挡风玻璃留下水痕，远处霓虹灯牌模糊倒映，写实胶片质感，复古 80 年代电影海报氛围。"
    },
    {
      title: "复古太空旅行海报",
      prompt: "复古科幻旅行海报，主题是前往土星环度假，巨大的行星和飞船占据主视觉，20 世纪中期复古印刷质感，醒目的构图，有限色彩，高级平面设计。"
    },
    {
      title: "末日废土公路海报",
      prompt: "末日废土风格电影海报，一条荒废的高速公路延伸至地平线，路边是倾覆的校车和生锈汽车残骸，天空是橙红色尘暴和破败的信号塔，一位穿防风斗篷的旅人背影走向远方，宽幅电影海报构图，废土美学。"
    },
    {
      title: "武侠江湖电影海报",
      prompt: "中国武侠电影海报，一位戴斗笠穿青衫的剑客立于竹林之巅，长剑出鞘剑尖滴血，风吹竹叶纷飞，背景是水墨远山和古寺飞檐，留白构图，墨色主调点缀朱红，国风电影质感，史诗武侠氛围。"
    },
    {
      title: "悬疑惊悚片海报",
      prompt: "悬疑惊悚电影海报，一条昏暗的长廊尽头有一扇半开的门，门缝透出诡异的红光，地面有拖拽的水痕，墙上的画框歪斜，一位黑衣人背影站在走廊中央，冷色调高对比，电影级打光，紧张压迫感。"
    },
    // ===== 科技 / 科幻（4 条）=====
    {
      title: "赛博未来茶室",
      prompt: "未来主义赛博茶室，传统木质茶桌与透明全息屏融合，窗外是高层城市夜景，青绿色与暖金色灯光交错，东方美学，精致室内设计，超清细节，安静而高级。"
    },
    {
      title: "深空探测器降落",
      prompt: "一台孤独的探测器正在粉红色星空下缓缓降落至土卫六表面，远处是土星环和冰晶云层，金属反光强烈，电影星际穿越概念海报质感，imax 宽幅构图，史诗感。"
    },
    {
      title: "未来城市俯瞰",
      prompt: "未来巨型城市夜景俯瞰，密集的摩天楼群被全息广告和飞行航道光线分割，空中穿梭着小型飞行器留下光轨，地面是多层立体高架，赛博朋克美学，青蓝与粉紫霓虹色，超广角航拍，电影概念艺术。"
    },
    {
      title: "智能机器人伴侣",
      prompt: "产品级摄影，一台白色圆润造型的家用陪伴机器人坐在客厅沙发上，屏幕脸上显示着微笑表情，旁边是绿植和落地窗阳光，极简北欧风室内，柔和自然光，科技温暖感，高级质感。"
    },
    // ===== 生活 / 物件 / 艺术（3 条）=====
    {
      title: "极简产品摄影",
      prompt: "一瓶高级香水的极简商业摄影，磨砂玻璃瓶身放在浅灰石材台面上，侧后方柔光，水滴和淡淡雾气，干净背景，奢侈品广告质感，真实材质，高端精致。"
    },
    {
      title: "老式打字机特写",
      prompt: "复古物件特写摄影，一台 1950 年代黑色打字机摆在橡木桌面上，旁边是一杯冒着热气的咖啡和揉皱的稿纸，午后阳光从左侧百叶窗洒入，浅景深，胶片颗粒感，怀旧温暖色调。"
    },
    {
      title: "极简建筑光影",
      prompt: "极简主义建筑摄影，一面纯白混凝土墙上投射着规则的几何光影，地面是浅灰色水磨石，远处一扇黑色窄门，纯净构图，色彩克制，安藤忠雄风格，建筑杂志封面质感。"
    }
  ];

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
})();
