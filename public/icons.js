/* global window */
// HiveMos shared icon registry. One place describes every brand icon the app
// can render, so pages never build their own <svg><use> strings or keep their
// own name -> symbol maps.
//
// The symbols themselves live in /icons.svg as <symbol id="brand-<slug>">.
// Paths come from Simple Icons (CC0-1.0), flattened to a single currentColor
// glyph on the same 24x24 grid as the rest of the sprite.
//
// To add a brand icon:
//   1. append <symbol id="brand-<slug>" viewBox="0 0 24 24"><path .../></symbol>
//      to public/icons.svg;
//   2. add one { id, name, aliases } entry to BRANDS below.
// match(), svg(), list() and has() all read from that list — nothing else to wire.
(function (global) {
  "use strict";

  // Brand symbols that predate this registry (machines renders workers with
  // them). They keep their original icon-* ids so stored values never break.
  var LEGACY_BRANDS = [
    { id: "icon-cloudflare", name: "Cloudflare", aliases: ["cloudflare", "cf", "cloudflare workers"] },
    { id: "icon-vercel", name: "Vercel", aliases: ["vercel"] }
  ];

  var BRANDS = [
    {"id":"brand-github","name":"GitHub","aliases":["gh"]},
    {"id":"brand-gitlab","name":"GitLab","aliases":["gl"]},
    {"id":"brand-bitbucket","name":"Bitbucket","aliases":[]},
    {"id":"brand-gitea","name":"Gitea","aliases":[]},
    {"id":"brand-google","name":"Google","aliases":["gmail","gmailcom","googlemail","google cloud","googlecloud","gcloud","gcp","google workspace","googleapps","谷歌","谷歌云","谷歌邮箱"]},
    {"id":"brand-googledrive","name":"Google Drive","aliases":[]},
    {"id":"brand-microsoft","name":"Microsoft","aliases":["ms","outlook","outlookcom","hotmail","hotmailcom","office365","o365","microsoft office","微软","微软邮箱"]},
    {"id":"brand-microsoftazure","name":"Microsoft Azure","aliases":[]},
    {"id":"brand-microsoftteams","name":"Microsoft Teams","aliases":[]},
    {"id":"brand-microsoftbing","name":"Bing","aliases":["bing","必应"]},
    {"id":"brand-apple","name":"Apple","aliases":["苹果"]},
    {"id":"brand-icloud","name":"iCloud","aliases":["icloud","apple icloud"]},
    {"id":"brand-amazonaws","name":"Amazon Web Services","aliases":["aws","amazon","amazon web services","亚马逊","亚马逊云","亚马逊云科技"]},
    {"id":"brand-digitalocean","name":"DigitalOcean","aliases":[]},
    {"id":"brand-netlify","name":"Netlify","aliases":[]},
    {"id":"brand-heroku","name":"Heroku","aliases":[]},
    {"id":"brand-docker","name":"Docker","aliases":[]},
    {"id":"brand-kubernetes","name":"Kubernetes","aliases":[]},
    {"id":"brand-npm","name":"npm","aliases":[]},
    {"id":"brand-nginx","name":"NGINX","aliases":[]},
    {"id":"brand-openai","name":"OpenAI","aliases":["chatgpt","gpt","open ai"]},
    {"id":"brand-anthropic","name":"Anthropic","aliases":["claude"]},
    {"id":"brand-discord","name":"Discord","aliases":["dc"]},
    {"id":"brand-telegram","name":"Telegram","aliases":["tg","电报"]},
    {"id":"brand-slack","name":"Slack","aliases":[]},
    {"id":"brand-spotify","name":"Spotify","aliases":[]},
    {"id":"brand-x","name":"X (Twitter)","aliases":["twitter","推特"]},
    {"id":"brand-facebook","name":"Facebook","aliases":[]},
    {"id":"brand-instagram","name":"Instagram","aliases":[]},
    {"id":"brand-youtube","name":"YouTube","aliases":[]},
    {"id":"brand-linkedin","name":"LinkedIn","aliases":[]},
    {"id":"brand-reddit","name":"Reddit","aliases":[]},
    {"id":"brand-tiktok","name":"TikTok","aliases":[]},
    {"id":"brand-whatsapp","name":"WhatsApp","aliases":[]},
    {"id":"brand-zoom","name":"Zoom","aliases":[]},
    {"id":"brand-dropbox","name":"Dropbox","aliases":[]},
    {"id":"brand-figma","name":"Figma","aliases":[]},
    {"id":"brand-notion","name":"Notion","aliases":[]},
    {"id":"brand-trello","name":"Trello","aliases":[]},
    {"id":"brand-asana","name":"Asana","aliases":[]},
    {"id":"brand-airtable","name":"Airtable","aliases":[]},
    {"id":"brand-jira","name":"Jira","aliases":[]},
    {"id":"brand-confluence","name":"Confluence","aliases":[]},
    {"id":"brand-steam","name":"Steam","aliases":["steam"]},
    {"id":"brand-playstation","name":"PlayStation","aliases":[]},
    {"id":"brand-xbox","name":"Xbox","aliases":[]},
    {"id":"brand-nintendo","name":"Nintendo","aliases":[]},
    {"id":"brand-epicgames","name":"Epic Games","aliases":[]},
    {"id":"brand-twitch","name":"Twitch","aliases":[]},
    {"id":"brand-patreon","name":"Patreon","aliases":[]},
    {"id":"brand-stripe","name":"Stripe","aliases":[]},
    {"id":"brand-paypal","name":"PayPal","aliases":["贝宝"]},
    {"id":"brand-shopify","name":"Shopify","aliases":[]},
    {"id":"brand-wise","name":"Wise","aliases":[]},
    {"id":"brand-revolut","name":"Revolut","aliases":[]},
    {"id":"brand-venmo","name":"Venmo","aliases":[]},
    {"id":"brand-binance","name":"Binance","aliases":[]},
    {"id":"brand-coinbase","name":"Coinbase","aliases":[]},
    {"id":"brand-ethereum","name":"Ethereum","aliases":[]},
    {"id":"brand-bitcoin","name":"Bitcoin","aliases":[]},
    {"id":"brand-1password","name":"1Password","aliases":["1p","onepassword"]},
    {"id":"brand-bitwarden","name":"Bitwarden","aliases":["bw"]},
    {"id":"brand-lastpass","name":"LastPass","aliases":[]},
    {"id":"brand-tailscale","name":"Tailscale","aliases":[]},
    {"id":"brand-protonmail","name":"Proton Mail","aliases":[]},
    {"id":"brand-proton","name":"Proton","aliases":[]},
    {"id":"brand-duckduckgo","name":"DuckDuckGo","aliases":[]},
    {"id":"brand-stackoverflow","name":"Stack Overflow","aliases":["so","stack overflow"]},
    {"id":"brand-medium","name":"Medium","aliases":[]},
    {"id":"brand-substack","name":"Substack","aliases":[]},
    {"id":"brand-sinaweibo","name":"Weibo","aliases":["weibo","微博"]},
    {"id":"brand-tencentqq","name":"QQ","aliases":["qq","腾讯qq"]},
    {"id":"brand-alipay","name":"Alipay","aliases":["支付宝"]},
    {"id":"brand-wechat","name":"WeChat","aliases":["weixin","微信"]},
    {"id":"brand-bilibili","name":"Bilibili","aliases":["b站","哔哩哔哩"]},
    {"id":"brand-zhihu","name":"Zhihu","aliases":["知乎"]},
    {"id":"brand-baidu","name":"Baidu","aliases":["百度"]},
    {"id":"brand-xiaomi","name":"Xiaomi","aliases":["小米"]},
    {"id":"brand-huawei","name":"Huawei","aliases":["华为"]},
    {"id":"brand-samsung","name":"Samsung","aliases":[]},
    {"id":"brand-sony","name":"Sony","aliases":[]},
    {"id":"brand-line","name":"LINE","aliases":[]}
  ];

  // Non-brand sprite symbols the machines view renders through this registry.
  // They are UI/OS glyphs, not services, so they are not part of list().
  var OS_IDS = ["debian", "ubuntu", "centos", "fedora", "arch", "alpine", "suse", "redhat", "freebsd", "windows", "macos", "linux"];
  var EXTRA_SYMBOLS = ["icon-monitor"].concat(OS_IDS.map(function (id) { return "icon-os-" + id; }));

  var ALL_BRANDS = LEGACY_BRANDS.concat(BRANDS);

  // Name lookup: normalized service name -> symbol id.
  var ALIASES = Object.create(null);
  var KNOWN = Object.create(null);

  function normalize(name) {
    return String(name == null ? "" : name)
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function register(brand) {
    KNOWN[brand.id] = true;
    var idKey = normalize(String(brand.id).replace(/^brand-/, "").replace(/^icon-/, ""));
    if (idKey && !ALIASES[idKey]) ALIASES[idKey] = brand.id;
    var nameKey = normalize(brand.name);
    if (nameKey && !ALIASES[nameKey]) ALIASES[nameKey] = brand.id;
    (brand.aliases || []).forEach(function (alias) {
      var key = normalize(alias);
      if (key && !ALIASES[key]) ALIASES[key] = brand.id;
    });
  }

  ALL_BRANDS.forEach(register);
  EXTRA_SYMBOLS.forEach(function (id) { KNOWN[id] = true; });

  function escapeAttr(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Resolve a free-form service name ("Google Cloud", "gcp", "Gmail") to a
  // sprite symbol id, or null when the registry does not know it.
  function match(name) {
    var key = normalize(name);
    return key ? ALIASES[key] || null : null;
  }

  // Build the standard sprite reference markup, matching common.js's iconSvg.
  function svg(symbolId, className) {
    if (!symbolId) return "";
    return (
      '<svg class="' + escapeAttr(className == null || className === "" ? "icon" : className) +
      '" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#' +
      escapeAttr(symbolId) + '"/></svg>'
    );
  }

  // Every brand icon, for building a selection grid.
  function list() {
    return ALL_BRANDS.map(function (brand) {
      return { id: brand.id, name: brand.name };
    });
  }

  // Whether this registry knows the sprite symbol id.
  function has(symbolId) {
    return !!symbolId && KNOWN[symbolId] === true;
  }

  var api = { match: match, svg: svg, list: list, has: has, normalize: normalize };
  global.HMIcons = api;
})(typeof window !== "undefined" ? window : this);
