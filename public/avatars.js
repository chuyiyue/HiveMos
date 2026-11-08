// Agent 头像图标库：30 个按项目图标语言重绘的线性图标（24×24、描边、
// currentColor、无背景），符号本体在 /icons.svg 里以 avatar-<id> 存放。
// AVATAR_ICON_IDS（src/registry.ts）是这份清单的服务端镜像，两处必须同步增改。
(function () {
  var CATEGORIES = [
    { key: "tech", label: "科技" },
    { key: "animal", label: "动物" },
    { key: "symbol", label: "符号" },
  ];
  var ICONS = [
    { id: "robot", cat: "tech", name: "机器人", keys: "jiqiren robot bot ai 智能 助手" },
    { id: "terminal", cat: "tech", name: "终端", keys: "zhongduan terminal console 命令行 shell" },
    { id: "code", cat: "tech", name: "代码", keys: "daima code 编程 开发 程序" },
    { id: "chip", cat: "tech", name: "芯片", keys: "xinpian chip cpu 处理器 电路" },
    { id: "brain", cat: "tech", name: "大脑", keys: "danao brain 思考 智慧 神经" },
    { id: "network", cat: "tech", name: "节点网络", keys: "jiedian wangluo network 节点 连接 分布式" },
    { id: "rocket", cat: "tech", name: "火箭", keys: "huojian rocket 发射 启动 速度" },
    { id: "satellite", cat: "tech", name: "卫星", keys: "weixing satellite 信号 通信 轨道" },
    { id: "spark", cat: "tech", name: "星火", keys: "xinghuo spark 灵感 魔法 闪光" },
    { id: "message", cat: "tech", name: "对话气泡", keys: "duihua qipao message chat 聊天 消息" },
    { id: "cat", cat: "animal", name: "猫", keys: "mao cat 猫咪 喵" },
    { id: "owl", cat: "animal", name: "猫头鹰", keys: "maotouying owl 夜 睿智" },
    { id: "fox", cat: "animal", name: "狐狸", keys: "huli fox 狡黠" },
    { id: "octopus", cat: "animal", name: "章鱼", keys: "zhangyu octopus 多手 触手" },
    { id: "whale", cat: "animal", name: "鲸", keys: "jing whale 鲸鱼 海洋" },
    { id: "bird", cat: "animal", name: "小鸟", keys: "xiaoniao bird 鸟 飞翔" },
    { id: "fish", cat: "animal", name: "鱼", keys: "yu fish 鱼儿 游泳" },
    { id: "panda", cat: "animal", name: "熊猫", keys: "xiongmao panda 国宝" },
    { id: "turtle", cat: "animal", name: "海龟", keys: "haigui turtle 乌龟 稳重 长寿" },
    { id: "butterfly", cat: "animal", name: "蝴蝶", keys: "hudie butterfly 变化 轻盈" },
    { id: "ghost", cat: "symbol", name: "幽灵", keys: "youling ghost 幽灵 鬼 可爱" },
    { id: "alien", cat: "symbol", name: "外星人", keys: "waixingren alien et 外星 宇宙" },
    { id: "eye", cat: "symbol", name: "眼睛", keys: "yanjing eye 观察 洞察 视觉" },
    { id: "bulb", cat: "symbol", name: "灯泡", keys: "dengpao bulb 想法 点子 照明" },
    { id: "cube", cat: "symbol", name: "魔方", keys: "mofang cube 立方 结构 模块" },
    { id: "wrench", cat: "symbol", name: "扳手", keys: "banshou wrench 工具 维修 运维" },
    { id: "crown", cat: "symbol", name: "皇冠", keys: "huangguan crown 王者 权威" },
    { id: "shield", cat: "symbol", name: "盾牌", keys: "dunpai shield 安全 防护 守卫" },
    { id: "bolt", cat: "symbol", name: "闪电", keys: "shandian bolt 雷电 快速 能量" },
    { id: "planet", cat: "symbol", name: "星球", keys: "xingqiu planet 行星 土星 宇宙" },
  ];
  var byId = {};
  ICONS.forEach(function (icon) {
    byId[icon.id] = icon;
  });
  window.HiveAvatars = {
    categories: CATEGORIES,
    icons: ICONS,
    byId: function (id) {
      return byId[id] || null;
    },
    symbol: function (id) {
      return "avatar-" + id;
    },
    search: function (keyword) {
      var needle = String(keyword || "").trim().toLowerCase();
      if (!needle) return ICONS.slice();
      return ICONS.filter(function (icon) {
        return (icon.name + " " + icon.id + " " + icon.keys).toLowerCase().indexOf(needle) !== -1;
      });
    },
  };
})();
