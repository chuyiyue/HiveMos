/* 云计算资源四页签（服务器 / 云主机 / 代理 / 边缘计算）。前三页数据走 /api/machines。
   状态、最近心跳是运行态字段（由 Agent 经 MCP 上报），表单里不出现；
   绑定是普通文本字段，随添加/编辑一起保存。
   二期接入：服务器改为极简录入（IP、用户名、密码或密钥二选一、备注），
   保存后用存好的配置真连 SSH 探活回填主机名、系统、内核与架构；卡片只
   展示备注、主机名、系统与主机 IP，用户名只在编辑弹窗里出现，密码经
   「查看 SSH 密码」走 reveal 接口；打开列表时对过期条目后台补测（暂无
   Cron，阈值 10 分钟）。
   云主机走服务商连接向导（华为云 API / MCP 通用）导入设备，凭据加密存、
   设备可改本地别名、可从连接手动同步；Workers 存 Cloudflare 账号 ID 与
   API 令牌（加密保存），可实时查看该账号名下的 Workers。
   分组：三页签共用一个分组池（groups 表 scope=machines），按分组分区
   展示、未分组置后；分组可改名/删除，删组后条目回未分组、不删条目。
   代理页签是 MiSub 瘦客户端：服务商连接的地址与令牌密封保存，界面只显示
   令牌末 4 位。MiSub 列表与机场订阅节点存在 D1（0078），页面只读 D1、
   打开时不出站：快照 /api/misub，全部节点 /api/misub/nodes，单个订阅
   /api/misub/subscriptions/:id/nodes。更新靠每小时 cron（按连接/订阅的
   自动拉取间隔，默认 6 小时）和手动「同步节点」/「拉取节点」（5 分钟冷却）；
   复制链接先走 reveal 写操作日志。 */
(function () {
  var C = window.HiveCommon;
  var hashTab = location.hash;
  if (hashTab === "#workers") hashTab = "#edge";
  var activeTab = hashTab === "#hosts" ? "hosts" : hashTab === "#edge" ? "edge" : hashTab === "#proxy" ? "proxy" : "servers";
  var API_KIND = { server: "server", host: "cloud", worker: "worker" };
  var TITLE_FOR = { server: "服务器", host: "云主机", worker: "Worker" };

  var state = {
    items: [], connections: [], groups: [], loaded: false, loadError: "",
    misubMeta: null, misubMetaLoaded: false,
    misub: null, misubSnapshotLoaded: false, misubSnapshotLoading: false,
    misubError: "",
  };
  // Full credential values stay off the list payloads. Each surface fetches
  // its own row and caches it for the rest of the page session.
  var connCreds = {};
  var workerTokens = {};

  function api(method, url, body) {
    var headers = { accept: "application/json" };
    var options = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (response) {
      return response
        .json()
        .catch(function () { return {}; })
        .then(function (data) { return { status: response.status, data: data || {} }; });
    });
  }

  function val(ctrl, name) {
    var el = ctrl.form.querySelector("[name=\"" + name + "\"]");
    return el ? el.value.trim() : "";
  }

  function byKind(uiKind) {
    var kind = API_KIND[uiKind];
    return state.items.filter(function (item) { return item.kind === kind; });
  }

  function heartbeatText(item) {
    var text = C.formatMinute(item.last_heartbeat_at);
    return text || "还没有心跳";
  }

  // ---- 管理弹窗（点卡片信息区打开） ----

  function openManage(key) {
    if (!key) return;
    var parts = key.split(":");
    if (parts[0] !== "machine") return;
    var kind = parts[1];
    var id = parts.slice(2).join(":");
    var found = null;
    state.items.forEach(function (entry) {
      if (entry.id === id) found = entry;
    });
    if (found) openMachineManage(kind, found);
  }

  var REMOTE_STATE_LABELS = {
    creating: "创建中", starting: "启动中", running: "运行中", stopping: "停止中",
    stopped: "已停止", suspending: "暂停中", suspended: "已暂停", resuming: "恢复中",
    deleting: "删除中", deleted: "已删除", error: "运行异常",
  };
  function remoteStateOf(item) {
    if (item.remote_state) return item.remote_state;
    return item.status === "running" ? "running" : "stopped";
  }
  function remoteStateLabel(item) {
    return REMOTE_STATE_LABELS[remoteStateOf(item)] || (item.status === "running" ? "运行中" : "已停止");
  }
  function powerFor(item) {
    var st = remoteStateOf(item);
    if (st === "stopped" || st === "error") return { label: "唤醒", action: "start" };
    if (st === "suspended") return { label: "唤醒", action: "resume" };
    if (st === "running") return { label: "暂停", action: "suspend" };
    return { label: remoteStateLabel(item), action: "" };
  }
  function displayName(item) {
    return item && item.note ? item.note : item ? item.name : "";
  }
  // Card title rule for devices: the note wins, then the fetched
  // hostname, then the stored name, then the IP.
  function deviceTitle(item) {
    return item.note || item.hostname || item.name || item.ip || "未命名设备";
  }
  function findMachine(id) {
    var found = null;
    state.items.forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  function connName(item) {
    if (!item || !item.connection_id) return "";
    var found = null;
    state.connections.forEach(function (conn) { if (conn.id === item.connection_id) found = conn; });
    return found ? found.name : "";
  }

  function providerLabel(provider) {
    if (provider === "instabox") return "InstaBox";
    if (provider === "huawei") return "华为云";
    if (provider === "mcp") return "MCP 通用";
    return provider || "";
  }

  function openMachineManage(kind, item) {
    if (kind === "worker") { openWorkerPanel(item, "account"); return; }
    var id = C.escapeHtml(item.id);
    function row(label, valueHtml) {
      return "<div><dt>" + label + "</dt><dd>" + valueHtml + "</dd></div>";
    }
    var facts = "";
    if (kind === "server") {
      facts =
        row("备注", C.escapeHtml(item.note || "无")) +
        row("主机名", C.escapeHtml(item.hostname || "未填写")) +
        row("系统", C.escapeHtml(item.os || "未填写")) +
        row(
          "主机 IP",
          item.ip
            ? "<span class=\"copy-text\" data-copy=\"" + C.escapeHtml(item.ip) + "\" data-label=\"" + C.escapeHtml(item.ip) + "\" title=\"点击复制\">" + C.escapeHtml(item.ip) + "</span>"
            : "未填写"
        );
    } else if (kind === "worker") {
      facts =
        row("平台", item.platform === "vercel" ? "Vercel" : "Cloudflare") +
        (item.platform === "vercel"
          ? row("Team ID", C.escapeHtml(item.team_id || "个人账号"))
          : row("Cloudflare 账号", C.escapeHtml(item.cf_account_id || "未填写"))) +
        row("API 令牌", item.api_token_tail ? workerTokenHtml(item, true) : "未填写") +
        row("版本", C.escapeHtml(item.version || "未记录")) +
        row("更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—"));
    } else if (item.connection_id) {
      facts =
        row("来源", C.escapeHtml(connName(item) || "服务商连接")) +
        (item.remote_name ? row("主机名称", C.escapeHtml(item.remote_name)) : "") +
        (item.note ? row("备注", C.escapeHtml(item.note)) : "") +
        row("最近同步", C.escapeHtml(item.last_sync_at ? C.formatMinute(item.last_sync_at) || "—" : "尚未同步"));
    } else {
      facts =
        row("厂商", C.escapeHtml(item.vendor || "未填写")) +
        row("接入备注", C.escapeHtml(item.access_note || "无")) +
        row("地域", C.escapeHtml(item.region || "未填写"));
    }
    // 按钮排序：本机操作 → 来源连接 → 日常管理 → 删除类垫底
    var btns = "";
    if (kind === "server") {
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"probe\" data-kind=\"server\" data-id=\"" + id + "\">同步</button>";
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"reveal\" data-kind=\"server\" data-id=\"" + id + "\">查看 SSH 密码</button>";
    }
    if (kind === "worker") {
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"workers\" data-kind=\"worker\" data-id=\"" + id + "\">" + (item.platform === "vercel" ? "查看项目" : "查看 Workers") + "</button>";
    }
    if (item.connection_id) {
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"snapshots\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">快照</button>";
    }
    btns += "<button type=\"button\" class=\"secondary\" data-mact=\"group\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">设置分组</button>";
    btns += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">编辑</button>";
    btns += "<button type=\"button\" class=\"danger\" data-confirm-delete data-mact=\"delete\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">删除</button>";
    var kindLabel = kind === "server" ? "服务器" : kind === "worker" ? "Worker" : "云主机";
    var ctrl = C.openManageDialog({
      hideHead: true,
      title: kind === "worker" ? item.name : deviceTitle(item),
      bodyHtml:
        C.manageInfoHead({
          iconHtml: kind === "server"
            ? serverIconBtnHtml(item)
            : HMIcons.svg(kind === "worker" ? (item.platform === "vercel" ? "icon-vercel" : "icon-cloudflare") : "icon-monitor", "icon record-icon"),
          title: kind === "worker" ? item.name : deviceTitle(item),
          sub:
            kindLabel +
            (kind === "server" && item.status ? " " + C.statusPill(item.status) : "") +
            (item.region && kind !== "worker" ? " · " + item.region : ""),
        }) +
        "<div class=\"manage-info-card\"><dl class=\"kv\">" +
        facts +
        "</dl></div>" +
        (kind === "server" ? C.record({ id: item.id, title: "服务器信息", facts: probeFactsRows(item) }) : "") +
        "<div class=\"manage-actions\">" +
        btns +
        "</div>",
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function deleteMachine(kind, item, anchor) {
    var dlg = anchor && anchor.closest ? anchor.closest("[data-manage-dialog]") : null;
    var mount = (dlg && dlg.querySelector("[data-manage-confirm]")) || anchor;
    
      api("DELETE", "/api/machines/" + encodeURIComponent(item.id)).then(function (res) {
        if (res.data && res.data.ok) { C.closeCurrentOverlay(); load(); }
      });
    
  }

  var OS_ICONS = [
    ["debian", "Debian"],
    ["ubuntu", "Ubuntu"],
    ["centos", "CentOS"],
    ["fedora", "Fedora"],
    ["arch", "Arch Linux"],
    ["alpine", "Alpine"],
    ["suse", "SUSE"],
    ["redhat", "Red Hat"],
    ["freebsd", "FreeBSD"],
    ["windows", "Windows"],
    ["macos", "macOS"],
    ["linux", "Linux"],
  ];

  function osIconIdForOs(os) {
    var s = String(os || "").toLowerCase();
    if (!s.trim()) return null;
    if (s.indexOf("debian") >= 0) return "debian";
    if (s.indexOf("ubuntu") >= 0) return "ubuntu";
    if (s.indexOf("centos") >= 0) return "centos";
    if (s.indexOf("fedora") >= 0) return "fedora";
    if (s.indexOf("arch") >= 0) return "arch";
    if (s.indexOf("alpine") >= 0) return "alpine";
    if (s.indexOf("suse") >= 0) return "suse";
    if (s.indexOf("red hat") >= 0 || s.indexOf("redhat") >= 0 || s.indexOf("rhel") >= 0) return "redhat";
    if (s.indexOf("freebsd") >= 0) return "freebsd";
    if (s.indexOf("windows") >= 0) return "windows";
    if (s.indexOf("darwin") >= 0 || s.indexOf("mac") >= 0) return "macos";
    return "linux";
  }

  function serverIconId(item) {
    if (item.icon) {
      for (var i = 0; i < OS_ICONS.length; i++) {
        if (OS_ICONS[i][0] === item.icon) return item.icon;
      }
    }
    return osIconIdForOs(item.os);
  }

  function serverIconHtml(item) {
    var id = serverIconId(item);
    return HMIcons.svg(id ? "icon-os-" + id : "icon-monitor", "icon record-icon");
  }

  function serverIconBtnHtml(item) {
    return (
      "<button type=\"button\" class=\"os-icon-btn\" data-micon data-id=\"" +
      C.escapeHtml(item.id) +
      "\" title=\"更换系统图标\" aria-label=\"更换系统图标\">" +
      serverIconHtml(item) +
      "</button>"
    );
  }

  function openOsIconPicker(item, headBtn) {
    var manual = !!item.icon_manual;
    var cells = OS_ICONS.map(function (pair) {
      var active = manual && item.icon === pair[0];
      return (
        "<button type=\"button\" class=\"os-icon-cell" +
        (active ? " is-active" : "") +
        "\" data-os-icon=\"" +
        pair[0] +
        "\">" +
        HMIcons.svg("icon-os-" + pair[0], "icon record-icon") +
        "<span>" +
        pair[1] +
        "</span></button>"
      );
    }).join("");
    var autoId = osIconIdForOs(item.os);
    var body =
      "<p class=\"subtle manage-note\">" +
      (manual ? "当前是手动选的图标，探活不会覆盖" : "当前跟随系统，探活到新系统时自动换") +
      "</p>" +
      "<div class=\"os-icon-grid\">" +
      cells +
      "</div>" +
      "<button type=\"button\" class=\"os-icon-auto" +
      (manual ? "" : " is-active") +
      "\" data-os-icon=\"__auto__\">" +
      HMIcons.svg(autoId ? "icon-os-" + autoId : "icon-monitor", "icon record-icon") +
      "<span>跟随系统（自动）</span></button>";
    var ctrl = C.openManageDialog({ title: "系统图标", size: "sm", bodyHtml: body });
    ctrl.dialog.addEventListener("click", function (event) {
      var cell = event.target.closest("[data-os-icon]");
      if (!cell || cell.disabled) return;
      var pick = cell.getAttribute("data-os-icon");
      cell.disabled = true;
      api("PATCH", "/api/machines/" + encodeURIComponent(item.id), {
        icon: pick === "__auto__" ? null : pick,
      })
        .then(function (res) {
          if (res.data && res.data.ok && res.data.machine) {
            var updated = res.data.machine;
            state.items = state.items.map(function (entry) {
              return entry.id === updated.id ? updated : entry;
            });
            if (headBtn) headBtn.innerHTML = serverIconHtml(updated);
            C.toast("图标已更新");
            ctrl.close();
            render();
          } else {
            cell.disabled = false;
            C.toast((res.data && res.data.error) || "图标保存失败");
          }
        })
        .catch(function () {
          cell.disabled = false;
          C.toast("图标保存失败");
        });
    });
  }

  function card(kind, item, facts, actionsOverride) {
    // 云主机/云条目：地域来自探测（英文国家名，如 United States），副标题
    // 与「所在地」一样走国旗+中文国家名的渲染，不把英文原样摆出来。
    var lede = kind === "worker" ? item.description : kind === "server" ? "" : item.region ? locationText(item) : "";
    var id = C.escapeHtml(item.id);
    var actions = "";
    if (kind === "server") {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"probe\" data-kind=\"server\" data-id=\"" + id + "\">同步</button>";
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"copyconfig\" data-kind=\"server\" data-id=\"" + id + "\">复制配置</button>";
    } else if (kind === "worker") {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"wcopy\" data-kind=\"worker\" data-id=\"" + id + "\">复制配置</button>";
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"worker\" data-id=\"" + id + "\">编辑</button>";
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"wsync\" data-kind=\"worker\" data-id=\"" + id + "\">同步</button>";
    } else if (actionsOverride !== undefined) {
      actions = actionsOverride;
    } else {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">编辑</button>";
    }
    return C.record({
      id: item.id,
      iconHtml: kind === "server"
        ? serverIconHtml(item)
        : HMIcons.svg(kind === "worker" ? (item.platform === "vercel" ? "icon-vercel" : "icon-cloudflare") : "icon-monitor", "icon record-icon"),
      title: kind === "worker" ? item.name : deviceTitle(item),
      pill: kind === "worker" ? (item.platform === "vercel" ? "Vercel" : "Cloudflare") : kind === "host" ? connName(item) || undefined : undefined,
      pillHtml: kind === "server" ? serverBadgeHtml(item) : undefined,
      corner: C.statusPill(item.connection_id ? remoteStateOf(item) : item.status),
      lede: lede || "",
      facts: facts,
      actions: actions,
      manage: "machine:" + kind + ":" + item.id,
    });
  }


  var REGION_PLACES = [
    ["shanghai", "上海", "🇨🇳", "上海"],
    ["singapore", "新加坡", "🇸🇬", "新加坡"],
    ["hong kong", "香港", "🇭🇰", "香港"],
    ["china", "中国", "🇨🇳", "中国"],
    ["beijing", "北京", "🇨🇳", "北京"],
    ["shenzhen", "深圳", "🇨🇳", "深圳"],
    ["guangzhou", "广州", "🇨🇳", "广州"],
    ["tokyo", "东京", "🇯🇵", "东京"],
    ["japan", "日本", "🇯🇵", "日本"],
    ["osaka", "大阪", "🇯🇵", "大阪"],
    ["seoul", "首尔", "🇰🇷", "首尔"],
    ["korea", "韩国", "🇰🇷", "韩国"],
    ["taiwan", "台湾", "🇹🇼", "台湾"],
    ["taipei", "台北", "🇹🇼", "台北"],
    ["united states", "美国", "🇺🇸", "美国"],
    ["oregon", "俄勒冈", "🇺🇸", "俄勒冈"],
    ["virginia", "弗吉尼亚", "🇺🇸", "弗吉尼亚"],
    ["california", "加利福尼亚", "🇺🇸", "加利福尼亚"],
    ["germany", "德国", "🇩🇪", "德国"],
    ["frankfurt", "法兰克福", "🇩🇪", "法兰克福"],
    ["united kingdom", "英国", "🇬🇧", "英国"],
    ["london", "伦敦", "🇬🇧", "伦敦"],
    ["france", "法国", "🇫🇷", "法国"],
    ["paris", "巴黎", "🇫🇷", "巴黎"],
    ["canada", "加拿大", "🇨🇦", "加拿大"],
    ["australia", "澳大利亚", "🇦🇺", "澳大利亚"],
    ["sydney", "悉尼", "🇦🇺", "悉尼"],
    ["india", "印度", "🇮🇳", "印度"],
    ["mumbai", "孟买", "🇮🇳", "孟买"],
    ["netherlands", "荷兰", "🇳🇱", "荷兰"],
  ];

  function locationOf(item) {
    var region = String((item && item.region) || "").trim();
    if (!region) return null;
    var lower = region.toLowerCase();
    for (var i = 0; i < REGION_PLACES.length; i++) {
      var place = REGION_PLACES[i];
      if (lower.indexOf(place[0]) !== -1 || region.indexOf(place[1]) !== -1) {
        return { flag: place[2], label: place[3] };
      }
    }
    return { flag: "🌐", label: region };
  }

  // Plain-text form (callers escape as needed) and card-fact form.
  function locationText(item) {
    var loc = locationOf(item);
    return loc ? loc.flag + " " + loc.label : "—";
  }

  function locationFact(item) {
    var loc = locationOf(item);
    return loc ? loc.flag + " " + C.escapeHtml(loc.label) : "—";
  }

  // Server cards carry a flag + ISO country-code badge next to the name,
  // derived from the probed region (ip-api country names, English).
  var COUNTRY_CODES = [
    ["singapore", "新加坡", "🇸🇬", "SG"], ["hong kong", "香港", "🇭🇰", "HK"],
    ["china", "中国", "🇨🇳", "CN"], ["shanghai", "上海", "🇨🇳", "CN"],
    ["beijing", "北京", "🇨🇳", "CN"], ["shenzhen", "深圳", "🇨🇳", "CN"],
    ["guangzhou", "广州", "🇨🇳", "CN"], ["japan", "日本", "🇯🇵", "JP"],
    ["tokyo", "东京", "🇯🇵", "JP"], ["osaka", "大阪", "🇯🇵", "JP"],
    ["korea", "韩国", "🇰🇷", "KR"], ["seoul", "首尔", "🇰🇷", "KR"],
    ["taiwan", "台湾", "🇹🇼", "TW"], ["taipei", "台北", "🇹🇼", "TW"],
    ["united states", "美国", "🇺🇸", "US"], ["united kingdom", "英国", "🇬🇧", "GB"],
    ["germany", "德国", "🇩🇪", "DE"], ["france", "法国", "🇫🇷", "FR"],
    ["canada", "加拿大", "🇨🇦", "CA"], ["australia", "澳大利亚", "🇦🇺", "AU"],
    ["india", "印度", "🇮🇳", "IN"], ["netherlands", "荷兰", "🇳🇱", "NL"],
    ["russia", "俄罗斯", "🇷🇺", "RU"], ["brazil", "巴西", "🇧🇷", "BR"],
    ["indonesia", "印尼", "🇮🇩", "ID"], ["vietnam", "越南", "🇻🇳", "VN"],
    ["thailand", "泰国", "🇹🇭", "TH"], ["malaysia", "马来西亚", "🇲🇾", "MY"],
    ["philippines", "菲律宾", "🇵🇭", "PH"], ["italy", "意大利", "🇮🇹", "IT"],
    ["spain", "西班牙", "🇪🇸", "ES"], ["poland", "波兰", "🇵🇱", "PL"],
    ["sweden", "瑞典", "🇸🇪", "SE"], ["norway", "挪威", "🇳🇴", "NO"],
    ["finland", "芬兰", "🇫🇮", "FI"], ["denmark", "丹麦", "🇩🇰", "DK"],
    ["austria", "奥地利", "🇦🇹", "AT"], ["switzerland", "瑞士", "🇨🇭", "CH"],
    ["ireland", "爱尔兰", "🇮🇪", "IE"], ["israel", "以色列", "🇮🇱", "IL"],
    ["turkey", "土耳其", "🇹🇷", "TR"], ["ukraine", "乌克兰", "🇺🇦", "UA"],
    ["south africa", "南非", "🇿🇦", "ZA"], ["mexico", "墨西哥", "🇲🇽", "MX"],
    ["argentina", "阿根廷", "🇦🇷", "AR"], ["chile", "智利", "🇨🇱", "CL"],
    ["new zealand", "新西兰", "🇳🇿", "NZ"], ["pakistan", "巴基斯坦", "🇵🇰", "PK"],
    ["bangladesh", "孟加拉", "🇧🇩", "BD"], ["egypt", "埃及", "🇪🇬", "EG"],
    ["saudi arabia", "沙特", "🇸🇦", "SA"], ["united arab emirates", "阿联酋", "🇦🇪", "AE"],
    ["iran", "伊朗", "🇮🇷", "IR"], ["kazakhstan", "哈萨克斯坦", "🇰🇿", "KZ"],
    ["myanmar", "缅甸", "🇲🇲", "MM"], ["cambodia", "柬埔寨", "🇰🇭", "KH"],
    ["laos", "老挝", "🇱🇦", "LA"], ["nepal", "尼泊尔", "🇳🇵", "NP"],
    ["sri lanka", "斯里兰卡", "🇱🇰", "LK"], ["mongolia", "蒙古", "🇲🇳", "MN"]
  ];

  function serverBadgeHtml(item) {
    var region = String((item && item.region) || "").trim();
    if (!region) return undefined;
    var lower = region.toLowerCase();
    for (var i = 0; i < COUNTRY_CODES.length; i++) {
      var row = COUNTRY_CODES[i];
      if (lower.indexOf(row[0]) !== -1 || region.indexOf(row[1]) !== -1) {
        return "<span class=\"flag-big\">" + row[2] + "</span>" + C.escapeHtml(row[1]);
      }
    }
    return undefined;
  }

  function serverBadge(item) {
    var region = String((item && item.region) || "").trim();
    if (!region) return undefined;
    var lower = region.toLowerCase();
    for (var i = 0; i < COUNTRY_CODES.length; i++) {
      var row = COUNTRY_CODES[i];
      if (lower.indexOf(row[0]) !== -1 || region.indexOf(row[1]) !== -1) return row[2] + " " + row[1];
    }
    return undefined;
  }

  function cardFor(uiKind, item) {
    if (uiKind === "worker") {
      var facts = [];
      if (item.platform === "vercel") {
        if (item.team_id) facts.push(["Team ID", C.escapeHtml(item.team_id)]);
        facts.push(["项目总量", workerStatSpan(item, "projects")]);
        facts.push(["域名数量", workerStatSpan(item, "vdomains")]);
        facts.push(["最近部署", workerStatSpan(item, "deploy")]);
      } else {
        facts.push(["Workers 总量", workerStatSpan(item, "workers")]);
        facts.push(["Workers 用量", workerStatSpan(item, "requests")]);
        facts.push(["D1 数据库", workerStatSpan(item, "d1")]);
        facts.push(["域名数量", workerStatSpan(item, "zones")]);
      }
      facts.push(["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")]);
      return card("worker", item, facts);
    }
    if (uiKind === "server") {
      return card("server", item, [
        ["主机名", C.escapeHtml(item.hostname || "尚未探活")],
        ["主机 IP", item.ip ? "<span class=\"copy-text\" data-copy=\"" + C.escapeHtml(item.ip) + "\" data-label=\"" + C.escapeHtml(item.ip) + "\" title=\"点击复制\">" + C.escapeHtml(item.ip) + "</span>" : "未填写"],
        ["规格", C.escapeHtml(item.spec || "—")],
        ["系统", C.escapeHtml(item.os || "尚未探活")],
      ]);
    }
    if (item.connection_id) {
      var connFacts = [
        ["主机名", C.escapeHtml(item.name || "—")],
        ["所在地", locationFact(item)],
        ["规格", C.escapeHtml(item.spec || "未同步")],
        ["系统", C.escapeHtml(item.os || "—")],
      ];
      var pw = powerFor(item);
      var pwClass = pw.action === "start" || pw.action === "resume" ? "secondary accent" : "secondary";
      var pid = C.escapeHtml(item.id);
      var quick =
        (pw.action
          ? "<button type=\"button\" class=\"" + pwClass + "\" data-mpower=\"" + pw.action + "\" data-id=\"" + pid + "\">" + pw.label + "</button>"
          : "<button type=\"button\" class=\"secondary\" disabled>" + pw.label + "</button>") +
        "<button type=\"button\" class=\"secondary\" data-mports data-id=\"" + pid + "\">端口转发</button>" +
        "<button type=\"button\" class=\"secondary\" data-mkeep data-id=\"" + pid + "\">保活</button>" +
        "<button type=\"button\" class=\"secondary\" data-msync data-id=\"" + pid + "\">同步</button>";
      return card(uiKind, item, connFacts, quick);
    }
    var facts = [
      ["主机名", C.escapeHtml(item.name || "—")],
      ["所在地", locationFact(item)],
      ["规格", C.escapeHtml(item.spec || "—")],
      ["系统", C.escapeHtml(item.os || "—")],
    ];
    return card(uiKind, item, facts);
  }

  // 分组头不再放按钮：分组的排序/改名/删除/新建统一走页头「分组管理」
  // 按钮打开的 C.openGroupManager 面板，管 scope=machines 共用分组池。
  // 删除仍走 deleteGroupFlow（内含 askConfirm 二次确认，文案不变），
  // 面板把确认槽元素传给它作锚点。
  function machineGroupCounts() {
    var counts = {};
    state.groups.forEach(function (g) {
      counts[g.id] = g.member_count || 0;
    });
    return counts;
  }

  function openMachineGroupManager(btn) {
    C.openGroupManager({
      anchor: btn,
      groups: state.groups,
      counts: machineGroupCounts(),
      onCreate: function () { openGroupDialog(null); },
      onRename: function (group) { openGroupDialog(group); },
      onDelete: function (group, slot) { deleteGroupFlow(group, slot); },
      onReorder: function (ids) {
        api("POST", "/api/groups/reorder", { scope: "machines", ids: ids })
          .then(function () { load(); })
          .catch(function () { load(); });
      },
      onSettled: function () {
        return { groups: state.groups, counts: machineGroupCounts() };
      },
    });
  }

  function listSection(uiKind, title, unit) {
    if (!state.loaded) return C.section(title, "", C.emptyState("正在加载", ""));
    if (state.loadError) return C.section(title, "", '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>");
    return C.groupedSections({
      groups: state.groups,
      items: byKind(uiKind),
      groupOf: function (item) { return item.group_id || null; },
      renderItem: function (item) { return cardFor(uiKind, item); },
      ungroupedTitle: state.groups.length ? "未分组" : title,
      cardGrid: true,
      emptyTitle: "暂无内容",
      emptyText: "点上方按钮添加",
      emptyGroupText: "添加或编辑条目时选择这个分组即可归入",
    });
  }

  function render() {
    var serverHtml =
      "<div class=\"stack\">" +
      listSection("server", "服务器", "台") +
      "</div>";
    var hostHtml =
      "<div class=\"stack\">" +
      listSection("host", "云主机", "台") +
      C.section("已释放", "", C.emptyState("没有已释放的云主机", "")) +
      "</div>";
    var workerHtml =
      "<div class=\"stack\">" +
      listSection("worker", "边缘计算", "个") +
      "</div>";
    var misubHtml = activeTab === "proxy" ? "<div class=\"stack\">" + renderMisub() + "</div>" : "";
    var head =
      '<div class="page-head"><div class="page-tabs" role="tablist">' +
      '<button class="page-tab" type="button" role="tab" data-tab="servers" aria-selected="' +
      (activeTab === "servers" ? "true" : "false") +
      '">服务器</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="hosts" aria-selected="' +
      (activeTab === "hosts" ? "true" : "false") +
      '">云主机</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="edge" aria-selected="' +
      (activeTab === "edge" ? "true" : "false") +
      '">边缘计算</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="proxy" aria-selected="' +
      (activeTab === "proxy" ? "true" : "false") +
      '">代理</button>' +
      "</div>" +
      '<div class="page-head-actions">' +
      (activeTab === "proxy"
        ? state.misubMetaLoaded
          ? (misubActiveConn()
              ? misubSyncButtonHtml("secondary add-group-button")
              : "") +
            '<button type="button" class="secondary add-group-button" data-misub-connections>服务商设置</button>' +
            '<button type="button" class="add-button misub-add-conn" data-misub-add>添加服务商</button>'
          : ""
        : (activeTab === "hosts" ? '<button type="button" class="secondary add-group-button" data-providers>服务商</button>' : "") +
          '<button type="button" class="secondary add-group-button" data-add-group>分组管理</button>' +
          (activeTab === "servers"
            ? '<button type="button" class="add-button" data-add="server">添加服务器</button>'
            : activeTab === "hosts"
              ? '<button type="button" class="add-button" data-add="host">添加云主机</button>'
              : '<button type="button" class="add-button" data-add="worker">添加 Worker</button>')) +
      "</div></div>";
    C.mount(
      C.layout(
        head +
          "<div data-panel=\"servers\"" + (activeTab === "servers" ? "" : " hidden") + ">" + serverHtml + "</div>" +
          "<div data-panel=\"hosts\"" + (activeTab === "hosts" ? "" : " hidden") + ">" + hostHtml + "</div>" +
          "<div data-panel=\"edge\"" + (activeTab === "edge" ? "" : " hidden") + ">" + workerHtml + "</div>" +
          "<div data-panel=\"proxy\"" + (activeTab === "proxy" ? "" : " hidden") + ">" + misubHtml + "</div>"
      )
    );
  }

  function load() {
    var machinesReq = api("GET", "/api/machines");
    var connsReq = api("GET", "/api/machines/providers").catch(function () { return { data: {} }; });
    var groupsReq = api("GET", "/api/groups?scope=machines").catch(function () { return { data: {} }; });
    // 进入页面只取连接元信息，不出站；快照等代理页签激活后再拉。
    var misubReq = api("GET", "/api/misub?meta=1")
      .then(function (res) { applyMisubMeta(res); })
      .catch(function () {
        state.misubMetaLoaded = true;
        state.misubMeta = null;
        state.misubError = "MiSub 读取失败";
      });
    return Promise.all([machinesReq, connsReq, groupsReq, misubReq])
      .then(function (results) {
        var res = results[0];
        var connRes = results[1];
        var groupsRes = results[2];
        state.loaded = true;
        if (res.data && res.data.ok) {
          state.items = res.data.machines || [];
          state.loadError = "";
        } else {
          state.loadError = (res.data && res.data.error) || "云主机数据读取失败";
        }
        if (connRes.data && connRes.data.ok) state.connections = connRes.data.connections || [];
        if (groupsRes.data && groupsRes.data.ok) state.groups = groupsRes.data.groups || [];
        render();
        refreshConnPanel();
        maybeLoadMisubSnapshot();
        scheduleProbeRefresh();
        fillWorkerStats();
      })
      .catch(function () {
        state.loaded = true;
        state.loadError = "云主机数据读取失败";
        if (!state.misubMetaLoaded) {
          state.misubMetaLoaded = true;
          state.misubMeta = null;
        }
        render();
        maybeLoadMisubSnapshot();
      });
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填。
  // 状态、心跳、版本是运行态字段，不在表单里，编辑时保持不变；
  // 密码或私钥、API 令牌不回填，编辑时留空表示不修改
  function workerPlatformFields(platform, v, editing) {
    v = v || {};
    var tokenField =
      "<label>API 令牌<input name=\"api_token\" type=\"password\" maxlength=\"16384\" autocomplete=\"off\" placeholder=\"" +
      (editing ? "留空表示不修改" : platform === "vercel" ? "有项目读取权限的 Vercel 令牌" : "有 Workers 读取权限的令牌") +
      "\" /></label>";
    if (platform === "vercel") {
      return (
        tokenField +
        "<label>Team ID（选填）<input name=\"team_id\" maxlength=\"64\" autocomplete=\"off\" placeholder=\"团队账号才需要，个人账号留空\" value=\"" +
        C.escapeHtml(v.team_id || "") +
        "\" /></label>"
      );
    }
    return (
      "<label>Cloudflare 账号 ID<input name=\"cf_account_id\" maxlength=\"64\" autocomplete=\"off\" value=\"" +
      C.escapeHtml(v.cf_account_id || "") +
      "\" /></label>" +
      tokenField
    );
  }

  function itemFields(kind, item) {
    var v = item || {};
    var nameField = "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.name || "") + "\" /></label>";
    if (kind === "server") {
      return (
        nameField +
        "<label>备注<input name=\"note\" maxlength=\"200\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.note || "") + "\" /></label>" +
        "<label>主机名<input name=\"hostname\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.hostname || "") + "\" /></label>" +
        "<label>系统<input name=\"os\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 Debian 12\" value=\"" + C.escapeHtml(v.os || "") + "\" /></label>" +
        "<label>主机 IP<input name=\"ip\" maxlength=\"64\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.ip || "") + "\" /></label>" +
        "<label>地域<input name=\"lede\" maxlength=\"30\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.region || "") + "\" /></label>" +
        "<label>配置<input name=\"spec\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 2 核 / 4 GB / 40 GB\" value=\"" + C.escapeHtml(v.spec || "") + "\" /></label>" +
        "<label>SSH 地址<input name=\"ssh_host\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"留空时用主机 IP\" value=\"" + C.escapeHtml(v.ssh_host || "") + "\" /></label>" +
        "<label>SSH 端口<input name=\"ssh_port\" type=\"number\" min=\"1\" max=\"65535\" value=\"" + (v.ssh_port != null ? v.ssh_port : 22) + "\" /></label>" +
        "<label>SSH 用户名<input name=\"ssh_user\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"" + (item ? "留空表示不修改" : "例如 root") + "\" /></label>" +
        "<label>SSH 密码或私钥<textarea name=\"ssh_secret\" data-secret-input rows=\"3\" maxlength=\"16384\" placeholder=\"" + (item ? "留空表示不修改" : "密码或私钥") + "\"></textarea></label>"
      );
    }
    if (kind === "host") {
      return (
        nameField +
        "<label>备注<input name=\"note\" maxlength=\"200\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.note || "") + "\" /></label>" +
        "<label>地域<input name=\"lede\" maxlength=\"30\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.region || "") + "\" /></label>" +
        "<label>规格<input name=\"spec\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 2 核 / 4 GB / 40 GB\" value=\"" + C.escapeHtml(v.spec || "") + "\" /></label>" +
        "<label>厂商<input name=\"vendor\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 Vultr\" value=\"" + C.escapeHtml(v.vendor || "") + "\" /></label>" +
        "<label>接入方式备注<textarea name=\"access_note\" rows=\"2\" maxlength=\"200\" placeholder=\"例如 厂商面板开机，密钥在保险库\">" + C.escapeHtml(v.access_note || "") + "</textarea></label>" +
        "<label>绑定<input name=\"binding\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 值守（留空为未绑定）\" value=\"" + C.escapeHtml(item ? v.binding || "" : "") + "\" /></label>" +
        "<label>分组" + C.groupSelect("group_id", state.groups, v.group_id || "") + "</label>"
      );
    }
    var platform = v.platform === "vercel" ? "vercel" : "cloudflare";
    return (
      nameField +
      "<label>说明<input name=\"lede\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 本控制面\" value=\"" + C.escapeHtml(v.description || "") + "\" /></label>" +
      "<div class=\"auth-type\"><span>平台</span>" +
      "<div class=\"page-tabs auth-tabs\" role=\"tablist\" aria-label=\"平台\">" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wplatform=\"cloudflare\" aria-selected=\"" + (platform === "cloudflare" ? "true" : "false") + "\"" + (item ? " disabled" : "") + ">Workers</button>" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wplatform=\"vercel\" aria-selected=\"" + (platform === "vercel" ? "true" : "false") + "\"" + (item ? " disabled" : "") + ">Vercel</button>" +
      "</div>" +
      "<input type=\"hidden\" name=\"platform\" value=\"" + platform + "\" />" +
      "</div>" +
      "<div data-worker-fields>" + workerPlatformFields(platform, v, !!item) + "</div>" +
      "<label>分组" + C.groupSelect("group_id", state.groups, v.group_id || "") + "</label>"
    );
  }

  function openItemDialog(kind, item) {
    var editing = !!item;
    var dlg = C.openFormDialog({
      title: (editing ? "编辑" : "添加") + TITLE_FOR[kind],
      bodyHtml: itemFields(kind, item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写名称"); return; }
        var payload;
        if (kind === "server") {
          payload = {
            name: name,
            note: val(ctrl, "note"),
            hostname: val(ctrl, "hostname"),
            os: val(ctrl, "os"),
            ip: val(ctrl, "ip"),
            region: val(ctrl, "lede"),
            spec: val(ctrl, "spec") || "未填写配置",
            ssh_host: val(ctrl, "ssh_host"),
            ssh_port: Number(val(ctrl, "ssh_port")) || 22,
          };
          var sshUser = val(ctrl, "ssh_user");
          if (sshUser) payload.ssh_user = sshUser;
          var secret = val(ctrl, "ssh_secret");
          if (secret) payload.ssh_secret = secret;
        } else if (kind === "host") {
          payload = {
            name: name,
            note: val(ctrl, "note"),
            region: val(ctrl, "lede"),
            spec: val(ctrl, "spec") || "未填写规格",
            vendor: val(ctrl, "vendor"),
            access_note: val(ctrl, "access_note"),
            binding: val(ctrl, "binding"),
            group_id: val(ctrl, "group_id") || null,
          };
        } else {
          var platform = val(ctrl, "platform") || "cloudflare";
          payload = {
            name: name,
            description: val(ctrl, "lede"),
            platform: platform,
            group_id: val(ctrl, "group_id") || null,
          };
          if (platform === "vercel") payload.team_id = val(ctrl, "team_id");
          else payload.cf_account_id = val(ctrl, "cf_account_id");
          var token = val(ctrl, "api_token");
          if (token) payload.api_token = token;
        }
        ctrl.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/machines/" + encodeURIComponent(item.id), payload)
          : api("POST", "/api/machines", Object.assign({ kind: API_KIND[kind] }, payload));
        request
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) {
              ctrl.setError((res.data && res.data.error) || "保存失败，请重试");
              return;
            }
            if (kind === "worker" && item && payload.api_token) delete workerTokens[item.id];
            ctrl.close();
            load();
          })
          .catch(function () {
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
    if (kind === "worker" && !editing) {
      dlg.form.addEventListener("click", function (event) {
        var tab = event.target.closest("[data-wplatform]");
        if (!tab || tab.disabled) return;
        var platform = tab.getAttribute("data-wplatform");
        dlg.form.querySelectorAll("[data-wplatform]").forEach(function (b) {
          b.setAttribute("aria-selected", b === tab ? "true" : "false");
        });
        var hidden = dlg.form.querySelector("[name=\"platform\"]");
        if (hidden) hidden.value = platform;
        var box = dlg.form.querySelector("[data-worker-fields]");
        if (box) box.innerHTML = workerPlatformFields(platform, null, false);
      });
    }
  }

  // ---- 服务器：极简表单（IP / 用户名 / 认证二选一 / 备注）+ 真探活 ----

  function probeFactsRows(item) {
    var rows = [
      ["主机名", item.hostname || "尚未探活"],
      ["系统", item.os || "尚未探活"],
      ["内核", item.kernel || "尚未探活"],
      ["架构", item.arch || "尚未探活"],
      ["所属地区", locationText(item)],
      ["最近同步", item.probe_at ? C.formatMinute(item.probe_at) || "—" : "尚未同步"],
    ];
    if (item.host_fingerprint) rows.push(["主机指纹", item.host_fingerprint]);
    if (item.probe_status === "error" && item.probe_error) rows.push(["失败原因", item.probe_error]);
    return rows.map(function (row) { return [row[0], C.escapeHtml(String(row[1]))]; });
  }

  // 列表打开后服务端会经 waitUntil 对过期服务器后台补测；若本页有这类
  // 条目，8 秒后静默重拉一次，让补测结果自己浮现（只排一次，不轮询）。
  var probeRefreshTimer = null;
  function scheduleProbeRefresh() {
    if (probeRefreshTimer) return;
    var now = Date.now();
    var stale = state.items.some(function (item) {
      return item.kind === "server" && item.ssh_tail && (item.probe_at == null || now - item.probe_at > 10 * 60 * 1000);
    });
    if (!stale) return;
    probeRefreshTimer = setTimeout(function () {
      probeRefreshTimer = null;
      load();
    }, 8000);
  }

  function probeServer(item, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "同步中…";
    }
    function restoreBtn() {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "同步";
      }
    }
    api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/probe")
      .then(function (res) {
        var probe = res.data && res.data.probe;
        var ok = !!(res.data && res.data.ok && probe && probe.ok);
        return load().then(function () {
          var fresh = null;
          state.items.forEach(function (entry) { if (entry.id === item.id) fresh = entry; });
          var name = deviceTitle(fresh || item);
          if (ok) C.toast("同步完成：「" + name + "」运行中");
          else C.toast("同步失败：「" + name + "」" + ((probe && probe.error) || (fresh && fresh.probe_error) || (res.data && res.data.error) || "连接失败"));
          restoreBtn();
        });
      })
      .catch(function () {
        load();
        C.toast("同步失败：「" + deviceTitle(item) + "」网络异常");
        restoreBtn();
      });
  }

  // 认证方式二选一：只渲染选中方式的输入框，另一个不出现在 DOM 里。
  function secretFieldHtml(authType, editing) {
    if (authType === "key") {
      return "<label>私钥<textarea name=\"ssh_secret\" data-secret-input rows=\"5\" maxlength=\"16384\" autocomplete=\"off\" placeholder=\"" + (editing ? "留空表示不修改" : "粘贴 OpenSSH 或 PEM 私钥") + "\"></textarea></label>";
    }
    return "<label>密码<input name=\"ssh_secret\" type=\"password\" maxlength=\"200\" autocomplete=\"off\" placeholder=\"" + (editing ? "留空表示不修改" : "SSH 登录密码") + "\" /></label>";
  }

  function serverFields(item) {
    var v = item || {};
    var authType = v.auth_type === "key" ? "key" : "password";
    var html = "";
    if (item) html += C.record({ id: item.id, title: "服务器信息", facts: probeFactsRows(item) });
    html +=
      '<div class="form-cols-2">' +
      "<label>IP<input name=\"ip\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"例如 203.0.113.10\" value=\"" + C.escapeHtml(v.ip || "") + "\" /></label>" +
      "<label>用户名<input name=\"ssh_user\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"" + (item ? "留空表示不修改" : "例如 root") + "\" /></label>" +
      "</div>" +
      "<div class=\"auth-type\"><span>认证方式</span>" +
      "<div class=\"page-tabs auth-tabs\" role=\"tablist\" aria-label=\"认证方式\">" +
      "<button type=\"button\" class=\"page-tab\" data-auth=\"password\" aria-selected=\"" + (authType === "password") + "\">密码</button>" +
      "<button type=\"button\" class=\"page-tab\" data-auth=\"key\" aria-selected=\"" + (authType === "key") + "\">密钥</button>" +
      "</div><input type=\"hidden\" name=\"auth_type\" value=\"" + authType + "\" /></div>" +
      "<div data-secret-slot>" + secretFieldHtml(authType, !!item) + "</div>" +
      "<label>备注<input name=\"note\" maxlength=\"200\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.note || "") + "\" /></label>" +
      "<details><summary>高级</summary>" +
      "<label>SSH 端口<input name=\"ssh_port\" type=\"number\" min=\"1\" max=\"65535\" value=\"" + (v.ssh_port != null ? v.ssh_port : 22) + "\" /></label>" +
      "<label>SSH 地址<input name=\"ssh_host\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"留空时用 IP\" value=\"" + C.escapeHtml(v.ssh_host || "") + "\" /></label>" +
      "<label>分组" + C.groupSelect("group_id", state.groups, v.group_id || "") + "</label>" +
      "</details>";
    return html;
  }

  function openServerDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: (editing ? "编辑" : "添加") + "服务器",
      bodyHtml: serverFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (c) {
        var ip = val(c, "ip");
        var authInput = c.form.querySelector("[name=\"auth_type\"]");
        var authType = authInput && authInput.value === "key" ? "key" : "password";
        var secret = val(c, "ssh_secret");
        var sshUser = val(c, "ssh_user");
        if (!editing) {
          if (!ip) { c.setError("请填写 IP"); return; }
          if (!sshUser) { c.setError("请填写用户名"); return; }
          if (!secret) { c.setError(authType === "key" ? "请粘贴私钥" : "请填写密码"); return; }
        }
        var payload = { auth_type: authType, note: val(c, "note"), ssh_port: Number(val(c, "ssh_port")) || 22 };
        payload.group_id = val(c, "group_id") || null;
        if (ip) payload.ip = ip;
        payload.ssh_host = val(c, "ssh_host") || ip;
        if (sshUser) payload.ssh_user = sshUser;
        if (secret) payload.ssh_secret = secret;
        c.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/machines/" + encodeURIComponent(item.id), payload)
          : api("POST", "/api/machines", Object.assign({ kind: "server" }, payload));
        request
          .then(function (res) {
            c.setBusy(false);
            if (!res.data || !res.data.ok) {
              c.setError((res.data && res.data.error) || "保存失败，请重试");
              return;
            }
            c.close();
            if (!editing && res.data.machine && res.data.machine.id) {
              var created = res.data.machine;
              load().then(function () { probeServer(created, null); });
            } else {
              load();
            }
          })
          .catch(function () {
            c.setBusy(false);
            c.setError("网络异常，请重试");
          });
      },
    });
    var slot = ctrl.form.querySelector("[data-secret-slot]");
    ctrl.form.addEventListener("click", function (event) {
      var t = event.target && event.target.closest ? event.target.closest("[data-auth]") : null;
      if (!t || !slot) return;
      var next = t.getAttribute("data-auth") === "key" ? "key" : "password";
      var hidden = ctrl.form.querySelector("[name=\"auth_type\"]");
      if (hidden) hidden.value = next;
      ctrl.form.querySelectorAll("[data-auth]").forEach(function (b) {
        b.setAttribute("aria-selected", b === t ? "true" : "false");
      });
      slot.innerHTML = secretFieldHtml(next, editing);
    });
  }

  // ---- 分组（全板块共用一个池，scope=machines） ----

  function openGroupDialog(group) {
    var editing = !!group;
    C.openFormDialog({
      title: editing ? "分组改名" : "添加分组",
      bodyHtml: "<label>分组名<input name=\"name\" maxlength=\"64\" autocomplete=\"off\" value=\"" + (editing ? C.escapeHtml(group.name) : "") + "\" /></label>",
      submitLabel: editing ? "保存" : "添加分组",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写分组名"); return; }
        ctrl.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/groups/" + encodeURIComponent(group.id), { name: name })
          : api("POST", "/api/groups", { scope: "machines", name: name });
        request
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) { ctrl.setError((res.data && res.data.error) || "保存失败，请重试"); return; }
            ctrl.close();
            load();
          })
          .catch(function () { ctrl.setBusy(false); ctrl.setError("网络异常，请重试"); });
      },
    });
  }

  function deleteGroupFlow(group, anchor) {
    C.askConfirm({
      anchor: anchor,
      title: "删除分组",
      text: "确认删除分组「" + group.name + "」吗？组内条目会回到未分组，不会被删除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/groups/" + encodeURIComponent(group.id)).then(function (res) {
        if (res.data && res.data.ok) load();
      });
    });
  }

  function openGroupMoveDialog(item) {
    C.openFormDialog({
      title: "设置分组",
      bodyHtml: "<label>分组" + C.groupSelect("group_id", state.groups, item.group_id || "") + "</label>",
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        ctrl.setBusy(true);
        api("PATCH", "/api/machines/" + encodeURIComponent(item.id), { group_id: val(ctrl, "group_id") || null })
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) { ctrl.setError((res.data && res.data.error) || "保存失败，请重试"); return; }
            ctrl.close();
            C.closeCurrentOverlay();
            load();
          })
          .catch(function () { ctrl.setBusy(false); ctrl.setError("网络异常，请重试"); });
      },
    });
  }

  // ---- 云主机：服务商连接（第二阶段） ----

  function connectionAction(conn, act, btn) {
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = act === "sync" ? "正在同步…" : "正在测试…";
    api("POST", "/api/machines/providers/" + encodeURIComponent(conn.id) + "/" + act)
      .then(function (res) {
        var failed = !res.data || !res.data.ok;
        if (connPanelState) {
          var text = failed
            ? (res.data && res.data.error) || (act === "sync" ? "同步失败" : "测试失败")
            : act === "sync"
              ? "已同步，更新 " + (res.data.updated || 0) + " 台"
              : "测试成功";
          if (act === "test") connPanelState.testNotice = { text: text, error: failed };
          else connPanelState.notice = { text: text, error: failed };
          connPanelState.devicesStale = !failed;
        }
        return load();
      })
      .catch(function () {
        setConnStatus("网络异常，请重试", true);
      })
      .then(function () {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = original;
        }
      });
  }

  function deleteConnection(conn, anchor) {
    var mount = connPanelCtrl && connPanelCtrl.dialog.open && connPanelCtrl.confirmSlot ? connPanelCtrl.confirmSlot : anchor;
    C.askConfirm({
      anchor: mount,
      title: "删除服务商连接",
      text: "确认删除连接「" + conn.name + "」吗？已接入的设备会保留为普通云主机条目，不会被删除",
      confirmLabel: "删除连接",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/machines/providers/" + encodeURIComponent(conn.id)).then(function (res) {
        if (!res.data || !res.data.ok) {
          setConnStatus((res.data && res.data.error) || "删除失败", true);
          return;
        }
        if (connPanelState) {
          if (connPanelState.selectedId === conn.id) {
            connPanelState.selectedId = "";
            connPanelState.devices = null;
            connPanelState.devicesError = "";
            connPanelState.devicesLoading = false;
            connPanelState.testNotice = null;
          }
          connPanelState.devicesStale = false;
          connPanelState.notice = { text: "连接已删除，已接入的设备仍留在云主机列表", error: false };
        }
        load();
      }).catch(function () {
        setConnStatus("网络异常，请重试", true);
      });
    });
  }

  function openCloudAliasDialog(item) {
    var body =
      '<form id="machine-note-form" class="form-grid" novalidate>' +
      "<label>主机备注<input name=\"note\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"填了之后，卡片标题显示备注\" value=\"" +
      C.escapeHtml(item.note || "") +
      '\" /></label>' +
      '<label>分组<select name="group_id">' +
      groupOptions(item.group_id || "") +
      "</select></label>" +
      '<p class="subtle">主机名称：' +
      C.escapeHtml(item.remote_name || item.name) +
      "（由服务商自动同步，不能手动改）</p></form>";
    var ctrl = C.openFormDialog({
      title: "编辑备注",
      bodyHtml: body,
      submitLabel: "保存",
      onSubmit: function () {
        var form = ctrl.form.querySelector("#machine-note-form");
        var data = new FormData(form);
        return api("PATCH", "/api/machines/" + encodeURIComponent(item.id), {
          note: String(data.get("note") || "").trim(),
          group_id: String(data.get("group_id") || ""),
        }).then(function (res) {
          if (res.data && res.data.ok) {
            C.toast("已保存");
            load();
            return true;
          }
          throw new Error((res.data && res.data.error) || "保存失败");
        });
      },
    });
  }

  function wizardConfigFields(provider) {
    return (
      "<label>API 密钥<input data-wiz-field=\"apiKey\" type=\"password\" maxlength=\"500\" autocomplete=\"off\" placeholder=\"InstaBox 的 API Key\" /></label>" +
      "<details><summary>高级</summary><label>接口地址<input data-wiz-field=\"endpoint\" maxlength=\"300\" autocomplete=\"off\" placeholder=\"留空用官方地址 api.instabox.sh\" /></label></details>"
    );
  }

  // ---- 接入设备快捷功能：电源 / 端口转发 / 保活 ----

  function syncMachine(btn) {
    var id = btn.getAttribute("data-id");
    btn.disabled = true;
    var oldText = btn.textContent;
    btn.textContent = "同步中…";
    api("POST", "/api/machines/" + encodeURIComponent(id) + "/sync", {})
      .then(function (res) {
        if (res.data && res.data.ok) C.toast(res.data.missing ? "服务商那边已找不到这台主机" : "状态已同步");
        else C.toast((res.data && res.data.error) || "同步失败");
      })
      .catch(function () { C.toast("同步失败"); })
      .then(function () { load(); });
  }

  function powerMachine(btn) {
    var id = btn.getAttribute("data-id");
    var action = btn.getAttribute("data-mpower");
    var labels = { start: "唤醒", resume: "唤醒", suspend: "暂停", stop: "停止" };
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = "处理中…";
    api("POST", "/api/machines/" + encodeURIComponent(id) + "/power", { action: action })
      .then(function (res) {
        if (res.data && res.data.ok) {
          C.toast("已发送" + (labels[action] || "操作") + "指令，状态刷新中");
          return load();
        }
        C.toast((res.data && res.data.error) || "操作失败", "error");
      })
      .catch(function () { C.toast("操作失败", "error"); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = original;
      });
  }

  function openPortsDialog(id) {
    var ctrl = C.openManageDialog({
      title: "端口转发",
      size: "md",
      bodyHtml: '<div data-ports-body>' + C.emptyState("正在读取", "") + "</div>",
    });
    var bodyEl = ctrl.bodyEl.querySelector("[data-ports-body]");
    function renderPorts(data) {
      var ports = data.ports || [];
      var rows = ports.length
        ? ports
            .map(function (p) {
              return (
                '<div class="port-row"><div class="port-main"><span class="port-name">' +
                C.escapeHtml(p.name || "未命名") +
                ' <span class="subtle">端口 ' +
                p.port +
                "</span></span>" +
                (p.url
                  ? '<a class="port-url" href="' + C.escapeHtml(p.url) + '" target="_blank" rel="noopener">' + C.escapeHtml(p.url) + "</a>"
                  : "") +
                '</div><button type="button" class="ghost" data-port-del="' +
                p.port +
                '">取消公开</button></div>'
              );
            })
            .join("")
        : C.emptyState("还没有公开的端口", "");
      bodyEl.innerHTML =
        (data.enabled === false ? '<p class="callout danger">这台机器的公网端口功能未开启</p>' : "") +
        rows +
        '<form class="port-add" data-port-form><label>端口<input name="port" type="number" min="1024" max="65535" placeholder="1024 – 65535" /></label>' +
        '<label>名称<input name="name" maxlength="100" placeholder="例如 Web 服务" /></label>' +
        '<button type="submit">公开端口</button></form>' +
        '<p class="subtle">5901 和 6768 是平台保留端口；每台机器最多公开 16 个</p>';
    }
    function refresh() {
      return api("GET", "/api/machines/" + encodeURIComponent(id) + "/ports").then(function (res) {
        if (res.data && res.data.ok) renderPorts(res.data);
        else bodyEl.innerHTML = C.emptyState("读取失败", (res.data && res.data.error) || "请稍后再试");
      });
    }
    ctrl.dialog.addEventListener("submit", function (event) {
      var form = event.target.closest("[data-port-form]");
      if (!form) return;
      event.preventDefault();
      var data = new FormData(form);
      api("POST", "/api/machines/" + encodeURIComponent(id) + "/ports", {
        port: Number(data.get("port")),
        name: String(data.get("name") || ""),
      }).then(function (res) {
        if (res.data && res.data.ok) {
          C.toast("端口已公开");
          refresh();
        } else C.toast((res.data && res.data.error) || "公开失败", "error");
      });
    });
    ctrl.dialog.addEventListener("click", function (event) {
      var del = event.target.closest("[data-port-del]");
      if (!del) return;
      var port = del.getAttribute("data-port-del");
      C.askConfirm(del, {
        title: "取消公开端口 " + port + "？",
        confirmLabel: "取消公开",
        danger: true,
        onConfirm: function () {
          return api("DELETE", "/api/machines/" + encodeURIComponent(id) + "/ports/" + port).then(function (res) {
            if (res.data && res.data.ok) {
              C.toast("已取消公开");
              refresh();
            } else C.toast((res.data && res.data.error) || "取消失败", "error");
          });
        },
      });
    });
    refresh();
  }

  function openKeepaliveDialog(id) {
    api("GET", "/api/machines/" + encodeURIComponent(id) + "/keepalive").then(function (res) {
      var policy = (res.data && res.data.keepalive) || { mode: "off", timezone: "Asia/Shanghai", windows: [] };
      var mode = policy.mode || "off";
      var windows = (policy.windows || []).map(function (w) { return { start: w.start, end: w.end }; });
      function windowsHtml() {
        return windows
          .map(function (w, i) {
            return (
              '<div class="keep-window"><input type="time" value="' +
              C.escapeHtml(w.start) +
              '" data-kw-start="' +
              i +
              '" /><span>至</span><input type="time" value="' +
              C.escapeHtml(w.end) +
              '" data-kw-end="' +
              i +
              '" /><button type="button" class="ghost" data-kw-del="' +
              i +
              '">删除</button></div>'
            );
          })
          .join("");
      }
      var ctrl = C.openFormDialog({
        title: "保活设置",
        bodyHtml:
          "<label>保活模式</label>" +
          '<div class="page-tabs" role="tablist">' +
          [
            ["off", "关闭"],
            ["always", "全天"],
            ["windows", "时段"],
          ]
            .map(function (opt) {
              return '<button type="button" class="page-tab" data-kmode="' + opt[0] + '" aria-selected="' + (mode === opt[0] ? "true" : "false") + '">' + opt[1] + "</button>";
            })
            .join("") +
          "</div>" +
          '<div data-kwindows' +
          (mode === "windows" ? "" : " hidden") +
          ">" +
          '<div data-kw-list>' +
          windowsHtml() +
          "</div>" +
          '<button type="button" class="secondary" data-kw-add>添加时段</button>' +
          '<label>时区<input name="timezone" autocomplete="off" value="' +
          C.escapeHtml(policy.timezone || "Asia/Shanghai") +
          '" /></label>' +
          "</div>" +
          (policy.last_result
            ? '<p class="subtle">上次检查：' + C.escapeHtml(policy.last_result) + (policy.last_checked_at ? " · " + C.escapeHtml(C.formatMinute(policy.last_checked_at) || "") : "") + "</p>"
            : "") +
          '<p class="subtle">保活时段内机器被停机或暂停时会自动拉起</p>',
        submitLabel: "保存",
        onSubmit: function (form) {
          syncWindowInputs();
          var tz = String(new FormData(form).get("timezone") || "Asia/Shanghai");
          return api("PUT", "/api/machines/" + encodeURIComponent(id) + "/keepalive", {
            mode: mode,
            timezone: tz,
            windows: mode === "windows" ? windows : [],
          }).then(function (res) {
            if (res.data && res.data.ok) {
              C.toast("保活设置已保存");
              return true;
            }
            throw new Error((res.data && res.data.error) || "保存失败");
          });
        },
      });
      function syncWindowInputs() {
        ctrl.dialog.querySelectorAll("[data-kw-start]").forEach(function (input) {
          var entry = windows[Number(input.getAttribute("data-kw-start"))];
          if (entry) entry.start = input.value;
        });
        ctrl.dialog.querySelectorAll("[data-kw-end]").forEach(function (input) {
          var entry = windows[Number(input.getAttribute("data-kw-end"))];
          if (entry) entry.end = input.value;
        });
      }
      ctrl.dialog.addEventListener("click", function (event) {
        var tab = event.target.closest("[data-kmode]");
        if (tab) {
          mode = tab.getAttribute("data-kmode");
          ctrl.dialog.querySelectorAll("[data-kmode]").forEach(function (b) {
            b.setAttribute("aria-selected", b === tab ? "true" : "false");
          });
          var kw = ctrl.dialog.querySelector("[data-kwindows]");
          if (kw) kw.hidden = mode !== "windows";
          return;
        }
        if (event.target.closest("[data-kw-add]")) {
          if (windows.length >= 5) {
            C.toast("最多 5 个时段", "error");
            return;
          }
          syncWindowInputs();
          windows.push({ start: "09:00", end: "18:00" });
          ctrl.dialog.querySelector("[data-kw-list]").innerHTML = windowsHtml();
          return;
        }
        var del = event.target.closest("[data-kw-del]");
        if (del) {
          syncWindowInputs();
          windows.splice(Number(del.getAttribute("data-kw-del")), 1);
          ctrl.dialog.querySelector("[data-kw-list]").innerHTML = windowsHtml();
        }
      });
    });
  }

  // ---- 接入设备快照：列表 / 创建 / 删除 / 从快照新建机器 ----

  function snapTime(iso) {
    var t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    var d = new Date(t);
    function pad(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function openSnapshotsDialog(item) {
    var id = item.id;
    var ctrl = C.openManageDialog({
      title: "快照",
      size: "md",
      bodyHtml: "<div data-snap-body>" + C.emptyState("正在读取", "") + "</div>",
    });
    var bodyEl = ctrl.bodyEl.querySelector("[data-snap-body]");
    function sourceName(snap) {
      if (snap.own) return "";
      var found = null;
      state.items.forEach(function (entry) { if (entry.remote_id && entry.remote_id === snap.sourceMachineId) found = entry; });
      return found ? deviceTitle(found) : "其他机器";
    }
    function renderSnaps(snaps) {
      var rows = snaps.length
        ? snaps
            .map(function (snap) {
              var meta = [];
              var when = snapTime(snap.createdAt);
              if (when) meta.push(when);
              if (snap.sizeBytes > 0) meta.push(fmtSize(snap.sizeBytes));
              var src = sourceName(snap);
              if (src) meta.push("来自「" + src + "」");
              var status = snap.status === "pending" ? "保存中" : snap.status === "ready" ? "就绪" : snap.status || "";
              var sid = C.escapeHtml(snap.id);
              return (
                "<div class=\"port-row\"><div class=\"port-main\"><span class=\"port-name\">" +
                C.escapeHtml(snap.name) +
                (status ? " <span class=\"subtle\">" + C.escapeHtml(status) + "</span>" : "") +
                "</span>" +
                (meta.length ? "<span class=\"subtle\">" + C.escapeHtml(meta.join(" · ")) + "</span>" : "") +
                "</div>" +
                "<button type=\"button\" class=\"ghost\" data-snap-spawn=\"" + sid + "\"" + (snap.status && snap.status !== "ready" ? " disabled" : "") + ">新建机器</button>" +
                "<button type=\"button\" class=\"ghost\" data-confirm-delete data-snap-del=\"" + sid + "\">删除</button></div>"
              );
            })
            .join("")
        : C.emptyState("还没有快照", "给这台机器创建第一个快照");
      bodyEl.innerHTML =
        "<form class=\"port-add\" data-snap-form><label>快照名称<input name=\"name\" maxlength=\"100\" placeholder=\"例如 上线前备份\" /></label>" +
        "<button type=\"submit\">创建快照</button></form>" +
        "<p class=\"subtle\">快照保存这台机器的磁盘（根盘与 /data），不保存正在运行的进程；运行中创建的快照会先显示保存中</p>" +
        rows;
    }
    function refresh() {
      return api("GET", "/api/machines/" + encodeURIComponent(id) + "/snapshots").then(function (res) {
        if (res.data && res.data.ok) renderSnaps(res.data.snapshots || []);
        else bodyEl.innerHTML = C.emptyState("读取失败", (res.data && res.data.error) || "请稍后再试");
      });
    }
    ctrl.dialog.addEventListener("submit", function (event) {
      var form = event.target.closest("[data-snap-form]");
      if (!form) return;
      event.preventDefault();
      var data = new FormData(form);
      var name = String(data.get("name") || "").trim();
      if (!name) {
        C.toast("请填写快照名称", "error");
        return;
      }
      api("POST", "/api/machines/" + encodeURIComponent(id) + "/snapshots", { name: name }).then(function (res) {
        if (res.data && res.data.ok) {
          C.toast(res.data.snapshot && res.data.snapshot.status === "pending" ? "快照创建中，保存完成后会变为就绪" : "快照已创建");
          refresh();
        } else C.toast((res.data && res.data.error) || "创建失败", "error");
      });
    });
    ctrl.dialog.addEventListener("click", function (event) {
      var del = event.target.closest("[data-snap-del]");
      if (del) {
        var snapId = del.getAttribute("data-snap-del");
        api("DELETE", "/api/machines/" + encodeURIComponent(id) + "/snapshots/" + encodeURIComponent(snapId)).then(function (res) {
          if (res.data && res.data.ok) {
            C.toast("快照已删除");
            refresh();
          } else C.toast((res.data && res.data.error) || "删除失败", "error");
        });
        return;
      }
      var spawn = event.target.closest("[data-snap-spawn]");
      if (spawn && !spawn.disabled) {
        var spawnId = spawn.getAttribute("data-snap-spawn");
        C.askConfirm({
          anchor: ctrl.confirmSlot,
          title: "用快照新建机器",
          text: "用这个快照新建一台机器吗？会占用一个机器名额，新机器会出现在云主机列表里",
          confirmLabel: "新建机器",
        }).then(function (yes) {
          if (!yes) return;
          spawn.disabled = true;
          api("POST", "/api/machines/" + encodeURIComponent(id) + "/snapshots/" + encodeURIComponent(spawnId) + "/spawn", {})
            .then(function (res) {
              if (res.data && res.data.ok) {
                C.toast("已新建机器「" + (res.data.name || "") + "」，列表已同步");
                ctrl.close();
                load();
              } else {
                spawn.disabled = false;
                C.toast((res.data && res.data.error) || "新建失败", "error");
              }
            })
            .catch(function () {
              spawn.disabled = false;
              C.toast("新建失败", "error");
            });
        });
      }
    });
    refresh();
  }

  // 服务商管理：点卡片选中连接，在同一面板里改名、换凭据、接入设备
  var connPanelCtrl = null;
  var connPanelState = null;

  function freshConnPanelState() {
    return {
      selectedId: "",
      devices: null,
      devicesError: "",
      devicesLoading: false,
      devicesStale: false,
      importing: false,
      importGroupId: "",
      notice: null,
      testNotice: null,
    };
  }

  function setConnTestStatus(text, isError) {
    if (connPanelState) connPanelState.testNotice = text ? { text: text, error: !!isError } : null;
    var el = connPanelCtrl && connPanelCtrl.bodyEl.querySelector("[data-conn-test-status]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function connTestStatusHtml() {
    var notice = connPanelState && connPanelState.testNotice;
    return (
      '<p class="manage-status' + (notice && notice.error ? " is-error" : "") +
      '" data-conn-test-status role="status">' +
      (notice ? C.escapeHtml(notice.text) : "") +
      "</p>"
    );
  }

  function findConn(id) {
    var found = null;
    state.connections.forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  function copyValueHtml(value) {
    var shown = C.escapeHtml(value);
    return "<span class=\"copy-text\" data-copy=\"" + shown + "\" data-label=\"" + shown + "\" title=\"点击复制\">" + shown + "</span>";
  }

  function connCredInner(conn, kick) {
    var entry = connCreds[conn.id];
    if (entry && entry.status === "ok") return entry.value ? copyValueHtml(entry.value) : "已保存";
    if (entry && entry.status === "error") {
      var tail = conn.config_tail ? "末四位 " + C.escapeHtml(conn.config_tail) : "已保存";
      return "<span class=\"copy-text\" data-conn-cred-retry=\"" + C.escapeHtml(conn.id) + "\" title=\"读取失败，点击重试\">" + tail + "</span>";
    }
    if (kick) ensureConnCred(conn.id);
    return "读取中";
  }

  function connCredHtml(conn) {
    return "<span data-conn-cred=\"" + C.escapeHtml(conn.id) + "\">" + connCredInner(conn, true) + "</span>";
  }

  function paintConnCred(id) {
    var conn = findConn(id);
    if (!conn) return;
    var html = connCredInner(conn, false);
    document.querySelectorAll("[data-conn-cred]").forEach(function (node) {
      if (node.getAttribute("data-conn-cred") === id) node.innerHTML = html;
    });
  }

  function ensureConnCred(id) {
    var entry = connCreds[id];
    if (entry && (entry.status === "loading" || entry.status === "ok")) return;
    var ticket = {};
    connCreds[id] = { status: "loading", value: "", ticket: ticket };
    api("GET", "/api/machines/providers/" + encodeURIComponent(id) + "/credential")
      .then(function (res) {
        if (!connCreds[id] || connCreds[id].ticket !== ticket) return;
        if (res.data && res.data.ok && typeof res.data.credential === "string") {
          connCreds[id] = { status: "ok", value: res.data.credential };
        } else {
          connCreds[id] = { status: "error", value: "" };
        }
        paintConnCred(id);
      })
      .catch(function () {
        if (!connCreds[id] || connCreds[id].ticket !== ticket) return;
        connCreds[id] = { status: "error", value: "" };
        paintConnCred(id);
      });
  }

  function retryConnCred(id) {
    if (!id) return;
    delete connCreds[id];
    ensureConnCred(id);
    paintConnCred(id);
  }

  function findMachine(id) {
    var found = null;
    state.items.forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  function workerTokenInner(item, kick) {
    var entry = workerTokens[item.id];
    if (entry && entry.status === "ok") return entry.value ? copyValueHtml(entry.value) : "未填写";
    if (entry && entry.status === "error") {
      var tail = item.api_token_tail ? "末四位 " + C.escapeHtml(item.api_token_tail) : "未填写";
      return "<span class=\"copy-text\" data-worker-token-retry=\"" + C.escapeHtml(item.id) + "\" title=\"读取失败，点击重试\">" + tail + "</span>";
    }
    if (entry && entry.status === "loading") return "读取中";
    if (kick) {
      ensureWorkerToken(item.id);
      return "读取中";
    }
    return item.api_token_tail ? "末四位 " + C.escapeHtml(item.api_token_tail) : "未填写";
  }

  function workerTokenHtml(item, kick) {
    if (!item.api_token_tail && !(workerTokens[item.id] && workerTokens[item.id].status === "ok" && workerTokens[item.id].value)) {
      return "未填写";
    }
    if (!kick && !workerTokens[item.id]) return "末四位 " + C.escapeHtml(item.api_token_tail);
    return "<span data-worker-token=\"" + C.escapeHtml(item.id) + "\">" + workerTokenInner(item, !!kick) + "</span>";
  }

  function paintWorkerToken(id) {
    var item = findMachine(id);
    if (!item) return;
    var html = workerTokenInner(item, false);
    document.querySelectorAll("[data-worker-token]").forEach(function (node) {
      if (node.getAttribute("data-worker-token") === id) node.innerHTML = html;
    });
  }

  function ensureWorkerToken(id) {
    var entry = workerTokens[id];
    if (entry && (entry.status === "loading" || entry.status === "ok")) return;
    var ticket = {};
    workerTokens[id] = { status: "loading", value: "", ticket: ticket };
    api("POST", "/api/machines/" + encodeURIComponent(id) + "/reveal")
      .then(function (res) {
        if (!workerTokens[id] || workerTokens[id].ticket !== ticket) return;
        if (res.data && res.data.ok && res.data.reveal && typeof res.data.reveal.secret === "string") {
          workerTokens[id] = { status: "ok", value: res.data.reveal.secret };
        } else {
          workerTokens[id] = { status: "error", value: "" };
        }
        paintWorkerToken(id);
      })
      .catch(function () {
        if (!workerTokens[id] || workerTokens[id].ticket !== ticket) return;
        workerTokens[id] = { status: "error", value: "" };
        paintWorkerToken(id);
      });
  }

  function retryWorkerToken(id) {
    if (!id) return;
    delete workerTokens[id];
    ensureWorkerToken(id);
    paintWorkerToken(id);
  }

  function setConnStatus(text, isError) {
    var el = connPanelCtrl && connPanelCtrl.bodyEl.querySelector("[data-conn-status]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function rememberImportGroup() {
    if (!connPanelCtrl || !connPanelState) return;
    var el = connPanelCtrl.bodyEl.querySelector('[name="import_group_id"]');
    if (el) connPanelState.importGroupId = el.value;
  }

  function testSummary(conn) {
    if (!conn.last_test_at) return "尚未测试";
    var when = C.formatMinute(conn.last_test_at) || "";
    var result = conn.last_test_ok ? "成功" : "失败";
    return when ? result + " · " + when : result;
  }

  function deviceStateText(device) {
    if (device.state && REMOTE_STATE_LABELS[device.state]) return REMOTE_STATE_LABELS[device.state];
    return device.status === "running" ? "运行中" : "已停止";
  }

  function credentialFields(provider) {
    if (provider === "huawei") {
      return (
        "<label>Access Key<input data-wiz-field=\"accessKey\" data-secret-input maxlength=\"200\" autocomplete=\"off\" /></label>" +
        "<label>Secret Key<input data-wiz-field=\"secretKey\" type=\"password\" maxlength=\"500\" autocomplete=\"off\" /></label>" +
        "<label>区域<input data-wiz-field=\"region\" maxlength=\"60\" autocomplete=\"off\" /></label>" +
        "<label>Project ID<input data-wiz-field=\"projectId\" maxlength=\"200\" autocomplete=\"off\" /></label>" +
        "<label>接口地址（选填）<input data-wiz-field=\"endpoint\" maxlength=\"300\" autocomplete=\"off\" /></label>"
      );
    }
    if (provider === "mcp") {
      return (
        "<label>MCP 端点<input data-wiz-field=\"endpoint\" maxlength=\"500\" autocomplete=\"off\" /></label>" +
        "<label>令牌（选填）<input data-wiz-field=\"token\" type=\"password\" maxlength=\"2000\" autocomplete=\"off\" /></label>" +
        "<label>设备列表工具名<input data-wiz-field=\"toolName\" maxlength=\"200\" autocomplete=\"off\" /></label>"
      );
    }
    return wizardConfigFields(provider);
  }

  function connProviderIconId(conn) {
    var provider = (conn && conn.provider) || "";
    var label = (conn && (conn.provider_label || providerLabel(provider))) || "";
    var symbol = HMIcons.match(provider) || HMIcons.match(label);
    if (symbol) return symbol;
    if (provider === "mcp") return "icon-gateway";
    return "icon-layout";
  }

  function connDeviceCount(conn) {
    if (typeof conn.device_count === "number") return conn.device_count;
    return state.items.filter(function (it) { return it.connection_id === conn.id; }).length;
  }

  function connCardsHtml() {
    if (!state.connections.length) {
      return (
        '<div class="conn-empty">' +
        C.emptyState("还没有服务商连接", "") +
        '<button type="button" class="add-button" data-conn-add>添加云主机</button>' +
        "</div>"
      );
    }
    var cards = state.connections
      .map(function (conn) {
        var selected = connPanelState && connPanelState.selectedId === conn.id;
        var tail = conn.config_tail ? "末四位 " + conn.config_tail : "已保存";
        return C.record({
          id: conn.id,
          className: "conn-card" + (selected ? " is-selected" : ""),
          iconHtml: HMIcons.svg(connProviderIconId(conn), "icon record-icon"),
          title: conn.name,
          pill: conn.provider_label || providerLabel(conn.provider),
          corner: selected ? C.badge("已选", "accent") : '<span class="conn-pick-hint">查看</span>',
          facts: [
            ["已接入设备", connDeviceCount(conn) + " 台"],
            ["凭据", C.escapeHtml(tail)],
          ],
          manage: "provider:" + conn.id,
        });
      })
      .join("");
    return C.cardList(cards);
  }

  function connInfoHtml(conn) {
    var rows = [
      ["服务商", C.escapeHtml(conn.provider_label || providerLabel(conn.provider))],
      ["最近测试", C.escapeHtml(testSummary(conn))],
      ["创建时间", C.escapeHtml(C.formatMinute(conn.created_at) || "—")],
    ];
    if (conn.last_test_at && !conn.last_test_ok && conn.last_error) rows.push(["失败原因", C.escapeHtml(conn.last_error)]);
    return (
      '<dl class="kv">' +
      rows
        .map(function (pair) {
          return "<div><dt>" + C.escapeHtml(pair[0]) + "</dt><dd>" + pair[1] + "</dd></div>";
        })
        .join("") +
      "</dl>"
    );
  }

  function deviceStatusKind(device) {
    var st = device.state || (device.status === "running" ? "running" : "stopped");
    if (st === "running") return "ok";
    if (st === "error") return "danger";
    if (st === "stopped" || st === "deleted") return "idle";
    return "warn";
  }

  function connDevicesHtml() {
    if (!connPanelState) return "";
    var devices = connPanelState.devices || [];
    var known = !!connPanelState.devices;
    var pending = devices.filter(function (device) { return !device.imported; }).length;
    var head =
      '<div class="conn-section-head"><h3 class="conn-section-title">接入设备</h3>' +
      (known ? '<span class="conn-count">' + devices.length + " 台</span>" : "") +
      "</div>";
    if (connPanelState.devicesLoading && !known) return head + C.emptyState("正在读取设备", "");
    if (connPanelState.devicesError && !devices.length) {
      return (
        head +
        '<p class="callout danger" role="alert">' +
        C.escapeHtml(connPanelState.devicesError) +
        "</p>" +
        '<div class="manage-actions"><button type="button" class="secondary" data-conn-retry>重试</button></div>'
      );
    }
    if (!devices.length) return head + C.emptyState("服务商那边没有设备", "");
    var rows = devices
      .map(function (device) {
        var id = C.escapeHtml(device.remoteId);
        var name = C.escapeHtml(device.name || device.remoteId);
        var meta = C.escapeHtml([deviceStateText(device), device.spec].filter(Boolean).join(" · "));
        var dot = '<span class="ui-status-dot" data-status="' + deviceStatusKind(device) + '" aria-hidden="true"></span>';
        var main =
          dot +
          '<span class="wiz-device-main"><span class="wiz-device-name">' +
          name +
          "</span>" +
          (meta ? '<span class="wiz-device-meta">' + meta + "</span>" : "") +
          "</span>";
        if (device.imported) {
          return '<div class="conn-device is-imported"><div class="wiz-device">' + main + C.badge("已接入", "accent") + "</div></div>";
        }
        return (
          '<div class="conn-device"><label class="wiz-device"><input type="checkbox" data-conn-device="' +
          id +
          '" />' +
          main +
          C.badge("未接入") +
          '</label><button type="button" class="secondary" data-conn-import-one="' +
          id +
          '">接入</button></div>'
        );
      })
      .join("");
    var bar = pending
      ? '<div class="conn-import-bar"><label>接入到分组' +
        C.groupSelect("import_group_id", state.groups, connPanelState.importGroupId || "") +
        '</label><button type="button" class="secondary" data-conn-import disabled>接入选中</button></div>'
      : "";
    return (
      head +
      (connPanelState.devicesLoading ? '<p class="subtle">正在刷新设备列表</p>' : "") +
      '<div class="conn-devices">' +
      rows +
      "</div>" +
      bar
    );
  }

  function connDetailHtml(conn) {
    var cid = C.escapeHtml(conn.id);
    return (
      '<div class="conn-detail">' +
      C.manageInfoHead({
        iconHtml: HMIcons.svg(connProviderIconId(conn), "icon"),
        title: conn.name,
        sub: conn.provider_label || providerLabel(conn.provider),
      }) +
      '<section class="conn-section">' +
      '<h3 class="conn-section-title">连接信息</h3>' +
      connInfoHtml(conn) +
      '<form data-conn-rename novalidate>' +
      '<label>连接名称<input name="name" maxlength="60" autocomplete="off" value="' +
      C.escapeHtml(conn.name) +
      '" /></label>' +
      '<div class="manage-actions"><button type="submit">保存名称</button></div>' +
      "</form>" +
      "</section>" +
      '<section class="conn-section">' +
      '<h3 class="conn-section-title">凭据</h3>' +
      '<div class="conn-cred-line"><span class="conn-field-label">当前凭据</span>' +
      connCredHtml(conn) +
      "</div>" +
      connTestStatusHtml() +
      '<form data-conn-cred novalidate>' +
      credentialFields(conn.provider) +
      '<p class="subtle">保存前会先测试，通过后才替换现有凭据</p>' +
      '<div class="manage-actions">' +
      '<button type="button" class="secondary" data-conn="test" data-id="' +
      cid +
      '">测试连接</button>' +
      '<button type="submit">保存凭据</button>' +
      "</div>" +
      "</form>" +
      "</section>" +
      '<section class="conn-section" data-conn-devices>' +
      connDevicesHtml() +
      "</section>" +
      '<div class="manage-actions conn-danger-row">' +
      '<button type="button" class="secondary" data-conn="sync" data-id="' +
      cid +
      '">同步</button>' +
      '<button type="button" class="danger" data-conn="delete" data-id="' +
      cid +
      '">删除连接</button>' +
      "</div></div>"
    );
  }

  function noticeHtml() {
    var notice = connPanelState && connPanelState.notice;
    if (connPanelState) connPanelState.notice = null;
    if (!notice) return '<p class="manage-status" data-conn-status role="status"></p>';
    return '<p class="manage-status' + (notice.error ? " is-error" : "") + '" data-conn-status role="status">' + C.escapeHtml(notice.text) + "</p>";
  }

  function connPanelHtml() {
    var selected = connPanelState && connPanelState.selectedId ? findConn(connPanelState.selectedId) : null;
    if (connPanelState && connPanelState.selectedId && !selected) connPanelState.selectedId = "";
    return (
      noticeHtml() +
      '<div class="conn-admin' +
      (selected ? " has-detail" : "") +
      '"><div class="conn-list">' +
      connCardsHtml() +
      "</div>" +
      (selected ? connDetailHtml(selected) : "") +
      "</div>"
    );
  }

  function syncImportButton() {
    if (!connPanelCtrl) return;
    var btn = connPanelCtrl.bodyEl.querySelector("[data-conn-import]");
    if (!btn) return;
    var n = connPanelCtrl.bodyEl.querySelectorAll("[data-conn-device]:checked").length;
    btn.disabled = !n || !!(connPanelState && connPanelState.importing);
    btn.textContent = n ? "接入选中（" + n + "）" : "接入选中";
  }

  function paintConnDevices() {
    if (!connPanelCtrl) return;
    rememberImportGroup();
    var slot = connPanelCtrl.bodyEl.querySelector("[data-conn-devices]");
    if (!slot) return;
    slot.innerHTML = connDevicesHtml();
    syncImportButton();
  }

  function paintConnPanel() {
    if (!connPanelCtrl || !connPanelState) return;
    rememberImportGroup();
    var slot = connPanelCtrl.bodyEl.querySelector("[data-conn-panel]");
    if (!slot) return;
    slot.innerHTML = connPanelHtml();
    syncImportButton();
  }

  function fetchConnDevices(id) {
    if (!connPanelState) return;
    connPanelState.devicesLoading = true;
    connPanelState.devicesError = "";
    paintConnDevices();
    api("GET", "/api/machines/providers/" + encodeURIComponent(id) + "/devices")
      .then(function (res) {
        if (!connPanelState || connPanelState.selectedId !== id) return;
        connPanelState.devicesLoading = false;
        if (!res.data || !res.data.ok) {
          connPanelState.devices = null;
          connPanelState.devicesError = (res.data && res.data.error) || "设备列表读取失败";
        } else {
          connPanelState.devices = res.data.devices || [];
          connPanelState.devicesError = "";
        }
        paintConnDevices();
      })
      .catch(function () {
        if (!connPanelState || connPanelState.selectedId !== id) return;
        connPanelState.devicesLoading = false;
        connPanelState.devices = null;
        connPanelState.devicesError = "网络异常，请重试";
        paintConnDevices();
      });
  }

  function selectConnection(id) {
    if (!connPanelState || !findConn(id)) return;
    if (connPanelState.selectedId === id) {
      fetchConnDevices(id);
      return;
    }
    connPanelState.selectedId = id;
    connPanelState.devices = null;
    connPanelState.devicesError = "";
    connPanelState.devicesLoading = true;
    connPanelState.notice = null;
    connPanelState.testNotice = null;
    paintConnPanel();
    fetchConnDevices(id);
  }

  function afterConnWrite(text, isError) {
    if (connPanelState) {
      connPanelState.notice = text ? { text: text, error: !!isError } : null;
      connPanelState.devicesStale = true;
    }
    return load();
  }

  function importDevices(ids, btn) {
    if (!connPanelState || !connPanelState.selectedId) return;
    var clean = (ids || []).filter(Boolean);
    if (!clean.length) {
      setConnStatus("请先勾选要接入的设备", true);
      return;
    }
    if (connPanelState.importing) return;
    connPanelState.importing = true;
    if (btn) btn.disabled = true;
    rememberImportGroup();
    var groupId = connPanelState.importGroupId || null;
    api("POST", "/api/machines/providers/" + encodeURIComponent(connPanelState.selectedId) + "/import", {
      deviceIds: clean,
      groupId: groupId,
    })
      .then(function (res) {
        if (connPanelState) connPanelState.importing = false;
        if (!res.data || !res.data.ok) {
          if (btn && btn.isConnected) btn.disabled = false;
          setConnStatus((res.data && res.data.error) || "接入失败", true);
          syncImportButton();
          return;
        }
        var n = res.data.imported || 0;
        var skipped = res.data.skipped || 0;
        var text = n ? "已接入 " + n + " 台" : "所选设备都已接入";
        if (n && skipped) text += "，跳过 " + skipped + " 台已接入的";
        afterConnWrite(text, false);
      })
      .catch(function () {
        if (connPanelState) connPanelState.importing = false;
        if (btn && btn.isConnected) btn.disabled = false;
        setConnStatus("网络异常，请重试", true);
        syncImportButton();
      });
  }

  function submitConnRename(form) {
    if (!connPanelState || !connPanelState.selectedId) return;
    var input = form.querySelector('[name="name"]');
    var name = input ? input.value.trim() : "";
    if (!name) {
      setConnStatus("请填写连接名称", true);
      return;
    }
    if (Array.from(name).length > 60) {
      setConnStatus("名称最多 60 个字", true);
      return;
    }
    var btn = form.querySelector('[type="submit"]');
    if (btn) btn.disabled = true;
    api("PATCH", "/api/machines/providers/" + encodeURIComponent(connPanelState.selectedId), { name: name })
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (btn) btn.disabled = false;
          setConnStatus((res.data && res.data.error) || "保存失败，请重试", true);
          return;
        }
        afterConnWrite("名称已保存", false);
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        setConnStatus("网络异常，请重试", true);
      });
  }

  function readConnConfig(form) {
    var config = {};
    form.querySelectorAll("[data-wiz-field]").forEach(function (el) {
      config[el.getAttribute("data-wiz-field")] = el.value.trim();
    });
    return config;
  }

  function submitConnCredentials(form) {
    if (!connPanelState || !connPanelState.selectedId) return;
    var btn = form.querySelector('[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "正在验证…";
    }
    setConnTestStatus("正在验证…", false);
    api("POST", "/api/machines/providers/" + encodeURIComponent(connPanelState.selectedId) + "/credentials", { config: readConnConfig(form) })
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = "保存凭据";
          }
          setConnTestStatus((res.data && res.data.error) || "凭据未更新", true);
          return;
        }
        if (connPanelState && connPanelState.selectedId) delete connCreds[connPanelState.selectedId];
        setConnTestStatus("测试通过，凭据已更新", false);
        afterConnWrite("", false);
      })
      .catch(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "保存凭据";
        }
        setConnTestStatus("网络异常，请重试", true);
      });
  }

  function handleConnSubmit(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute("data-conn-rename")) {
      event.preventDefault();
      submitConnRename(form);
      return;
    }
    if (form.hasAttribute("data-conn-cred")) {
      event.preventDefault();
      submitConnCredentials(form);
    }
  }

  function handleConnChange(event) {
    var target = event.target;
    if (target instanceof Element && target.matches("[data-conn-device]")) syncImportButton();
  }

  function openProvidersPanel() {
    connPanelState = freshConnPanelState();
    if (state.connections.length) {
      connPanelState.selectedId = state.connections[0].id;
      connPanelState.devicesLoading = true;
    }
    connPanelCtrl = C.openManageDialog({
      title: "服务商管理",
      size: "lg",
      bodyHtml: '<div data-conn-panel></div>',
    });
    paintConnPanel();
    if (connPanelState.selectedId) fetchConnDevices(connPanelState.selectedId);
    connPanelCtrl.dialog.addEventListener("click", handleClick);
    connPanelCtrl.dialog.addEventListener("submit", handleConnSubmit);
    connPanelCtrl.dialog.addEventListener("change", handleConnChange);
  }

  function refreshConnPanel() {
    if (!connPanelCtrl || !connPanelCtrl.dialog.open || !connPanelState) return;
    if (connPanelState.selectedId && !findConn(connPanelState.selectedId)) {
      connPanelState.selectedId = "";
      connPanelState.devices = null;
      connPanelState.devicesError = "";
      connPanelState.devicesLoading = false;
      connPanelState.devicesStale = false;
      connPanelState.testNotice = null;
    }
    var refetch = !!(connPanelState.selectedId && connPanelState.devicesStale);
    if (refetch) {
      connPanelState.devicesStale = false;
      connPanelState.devicesLoading = true;
    }
    paintConnPanel();
    if (refetch) fetchConnDevices(connPanelState.selectedId);
  }

  function openCloudWizard() {
    var wiz = { provider: "instabox", tested: false, devices: [] };
    var ctrl = C.openFormDialog({
      title: "添加云主机",
      wide: true,
      actionsLeftHtml: "<button type=\"button\" class=\"secondary\" data-wiz-test>测试连接</button>",
      bodyHtml:
        "<div class=\"auth-type\"><span>服务商</span>" +
        "<div class=\"page-tabs auth-tabs\" role=\"tablist\" aria-label=\"服务商\">" +
        "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wiz-provider=\"instabox\" aria-selected=\"true\">InstaBox</button>" +
        "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wiz-provider=\"future\" aria-selected=\"false\" disabled>更多厂商（即将支持）</button>" +
        "</div></div>" +
        "<div data-wiz-config>" + wizardConfigFields("huawei") + "</div>" +
        "<label>连接名称（可留空）<input name=\"conn_name\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"留空按服务商自动命名\" /></label>" +
        "<label>导入到分组" + C.groupSelect("group_id", state.groups, "") + "</label>" +
        "<p class=\"subtle\" data-wiz-status>尚未测试</p>" +
        "<div class=\"wiz-devices\" data-wiz-devices></div>",
      submitLabel: "保存",
      onSubmit: function (c) {
        if (!wiz.tested) { c.setError("请先点「测试连接」，拉到设备列表后才能保存"); return; }
        var ids = [];
        c.form.querySelectorAll("[data-wiz-device]:checked").forEach(function (box) { ids.push(box.getAttribute("data-wiz-device")); });
        if (!ids.length) { c.setError("请至少勾选一台要接入的设备"); return; }
        c.setBusy(true);
        api("POST", "/api/machines/providers", {
          provider: wiz.provider,
          name: val(c, "conn_name"),
          config: wiz.config || {},
          device_ids: ids,
          group_id: val(c, "group_id") || null,
        })
          .then(function (res) {
            c.setBusy(false);
            if (!res.data || !res.data.ok) { c.setError((res.data && res.data.error) || "保存失败，请重试"); return; }
            c.close();
            load();
          })
          .catch(function () { c.setBusy(false); c.setError("网络异常，请重试"); });
      },
    });
    var form = ctrl.form;
    var configBox = form.querySelector("[data-wiz-config]");
    var statusEl = form.querySelector("[data-wiz-status]");
    var devicesBox = form.querySelector("[data-wiz-devices]");
    function invalidate(message) {
      wiz.tested = false;
      wiz.devices = [];
      devicesBox.innerHTML = "";
      statusEl.textContent = message || "尚未测试";
    }
    function readConfig() {
      var config = {};
      form.querySelectorAll("[data-wiz-field]").forEach(function (el) {
        config[el.getAttribute("data-wiz-field")] = el.value.trim();
      });
      return config;
    }
    form.addEventListener("click", function (event) {
      var tab = event.target.closest("[data-wiz-provider]");
      if (!tab || tab.disabled) return;
      form.querySelectorAll("[data-wiz-provider]").forEach(function (b) {
        b.setAttribute("aria-selected", b === tab ? "true" : "false");
      });
      wiz.provider = tab.getAttribute("data-wiz-provider");
      configBox.innerHTML = wizardConfigFields(wiz.provider);
      invalidate("尚未测试");
    });
    form.addEventListener("input", function (event) {
      var t = event.target;
      if (t && t.hasAttribute("data-wiz-field") && wiz.tested) invalidate("配置已变更，请重新测试");
    });
    form.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-wiz-test]");
      if (!btn) return;
      var config = readConfig();
      btn.disabled = true;
      statusEl.textContent = "正在测试…";
      devicesBox.innerHTML = "";
      api("POST", "/api/machines/providers/test", { provider: wiz.provider, config: config })
        .then(function (res) {
          btn.disabled = false;
          if (!res.data || !res.data.ok) {
            wiz.tested = false;
            statusEl.textContent = "测试失败：" + ((res.data && res.data.error) || "请稍后重试");
            return;
          }
          wiz.tested = true;
          wiz.config = config;
          wiz.devices = res.data.devices || [];
          statusEl.textContent = "测试成功，共 " + wiz.devices.length + " 台设备可接入";
          devicesBox.innerHTML = wiz.devices.map(function (device) {
            var meta = [device.status === "running" ? "运行中" : "已停止", device.os, device.spec, device.ip].filter(Boolean).join(" · ");
            return "<label class=\"wiz-device\"><input type=\"checkbox\" data-wiz-device=\"" + C.escapeHtml(device.remoteId) + "\" /><span class=\"wiz-device-main\"><span class=\"wiz-device-name\">" + C.escapeHtml(device.name || device.remoteId) + "</span>" + (meta ? "<span class=\"wiz-device-meta\">" + C.escapeHtml(meta) + "</span>" : "") + "</span></label>";
          }).join("");
        })
        .catch(function () {
          btn.disabled = false;
          wiz.tested = false;
          statusEl.textContent = "测试失败：网络异常，请重试";
        });
    });
  }

  // 查看 SSH 密码：走 reveal 接口拿明文（服务端记审计），与保险库同口径
  // 复制配置：经审计的 reveal 接口取回用户名与密码/密钥，拼成逐项
  // 写全称的纯文本整份复制；取不到机密就整份不复制。
  function copyServerConfig(item, btn) {
    btn.disabled = true;
    api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/reveal")
      .then(function (result) {
        if (!result.data || !result.data.ok || !result.data.reveal || !result.data.reveal.secret) {
          C.toast("还没有保存密码或密钥，未复制");
          return;
        }
        var reveal = result.data.reveal;
        var lines = [];
        lines.push(item.note ? "服务器备注名：" + item.note : "服务器名称：" + deviceTitle(item));
        lines.push("服务器 IP 地址：" + (item.ip || item.ssh_host || "未填写"));
        lines.push("连接端口：" + (item.ssh_port || 22));
        lines.push("登录用户名：" + (reveal.ssh_user || "未填写"));
        if (item.auth_type === "key") lines.push("登录密钥：\n" + reveal.secret);
        else lines.push("登录密码：" + reveal.secret);
        return C.copyText(lines.join("\n")).then(function () { C.toast("连接配置已复制"); });
      })
      .catch(function () { C.toast("复制失败，请稍后重试"); })
      .then(function () { btn.disabled = false; });
  }

  function openRevealDialog(item) {
    var ctrl = C.openFormDialog({
      title: "查看 SSH 密码",
      bodyHtml: C.emptyState("正在读取", ""),
      submitLabel: "关闭",
      onSubmit: function (c) { c.close(); },
    });
    api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/reveal")
      .then(function (result) {
        if (!result.data || !result.data.ok) {
          ctrl.setBody(C.emptyState("读取失败", (result.data && result.data.error) || "请稍后重试"));
          return;
        }
        var value = result.data.reveal.secret;
        var secretHtml = value
          ? C.copyLine(value, "复制密码")
          : "<p class=\"subtle\">还没有保存 SSH 密码或私钥</p>";
        var facts = [
          ["主机", C.escapeHtml((item.ssh_host || item.ip || "未填写") + (item.ssh_port ? ":" + item.ssh_port : ""))],
          ["用户名", C.escapeHtml(result.data.reveal.ssh_user || "未填写")],
          ["密码末四位", C.escapeHtml(item.ssh_tail || "无")],
          ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")],
        ];
        ctrl.setBody(secretHtml + C.record({ id: item.id, title: item.name, facts: facts }));
      })
      .catch(function () {
        ctrl.setBody(C.emptyState("读取失败", "网络异常，请重试"));
      });
  }

  // 查看 Workers：服务端用存好的令牌实时拉取，失败把 Cloudflare 的错误原样展示
  // ---- Workers 账号面板：账号信息 + 资产页签（域名 / Workers / D1 / R2 / KV） ----
  var workerStatsCache = {};
  function fmtSize(bytes) {
    var b = Number(bytes) || 0;
    if (b >= 1024 * 1024) return (b / 1048576).toFixed(1).replace(/\.0$/, "") + " MB";
    return (b > 0 ? Math.max(1, Math.round(b / 1024)) : 0) + " KB";
  }
  // Relative time for deployment rows and the card's 最近部署 fact.
  function relTime(value) {
    var time = typeof value === "number" ? value : value ? new Date(value).getTime() : NaN;
    if (!Number.isFinite(time) || time <= 0) return "";
    var diff = Date.now() - time;
    if (diff < 0) return C.formatMinute(time) || "";
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 30 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + " 天前";
    return C.formatMinute(time) || "";
  }
  // Vercel deployment states, shown as the API returns them; the tone only
  // colours the status dot.
  var VERCEL_STATE_TONE = {
    READY: "ok", BUILDING: "warn", QUEUED: "warn", INITIALIZING: "warn",
    ERROR: "bad", CANCELED: "idle",
  };
  function vercelStateTone(state) {
    return VERCEL_STATE_TONE[String(state || "").toUpperCase()] || "idle";
  }
  function vercelStateHtml(state) {
    var text = String(state || "").trim().toUpperCase();
    if (!text) return "—";
    return "<span class=\"status-indicator\" data-status=\"" + vercelStateTone(text) + "\">" + C.escapeHtml(text) + "</span>";
  }
  function urlHost(url) {
    return String(url || "").replace(/^https?:\/\//i, "");
  }
  function copyUrlHtml(url) {
    var full = String(url || "").trim();
    if (!full) return "—";
    var shown = urlHost(full);
    return "<span class=\"copy-text\" data-copy=\"" + C.escapeHtml(full) + "\" data-label=\"" + C.escapeHtml(shown) + "\" title=\"点击复制\">" + C.escapeHtml(shown) + "</span>";
  }
  function vercelAccountText(stats, key) {
    if (!stats || !stats.account) return "—";
    var value = stats.account[key];
    return typeof value === "string" && value.trim() ? value : "—";
  }
  function workerStatSpan(item, metric) {
    return "<span data-wstat=\"" + C.escapeHtml(item.id) + ":" + metric + "\">…</span>";
  }
  function workerStatText(stats, metric) {
    if (!stats) return "—";
    if (metric === "workers") return stats.workers_total == null ? "—" : stats.workers_total + " 个";
    if (metric === "requests") return stats.requests_24h == null ? "—" : "近 24 小时 " + stats.requests_24h + " 次";
    if (metric === "d1") return stats.d1_count == null ? "—" : stats.d1_count + " 个 · " + fmtSize(stats.d1_bytes);
    if (metric === "zones") return stats.zones_total == null ? "—" : stats.zones_total + " 个";
    if (metric === "projects") return stats.projects_total == null ? "—" : stats.projects_total + " 个";
    if (metric === "vdomains") return stats.domains_total == null ? "—" : stats.domains_total + " 个";
    if (metric === "deploy") {
      var deploy = stats.latest_deploy;
      if (!deploy) return "—";
      var pieces = [];
      var state = String(deploy.state || "").trim().toUpperCase();
      var when = relTime(deploy.created_at);
      if (state) pieces.push(state);
      if (when) pieces.push(when);
      return pieces.length ? pieces.join(" · ") : "—";
    }
    if (metric === "vuser") return vercelAccountText(stats, "username");
    if (metric === "vemail") return vercelAccountText(stats, "email");
    if (metric === "vname") return vercelAccountText(stats, "name");
    if (metric === "vteam") return vercelAccountText(stats, "team_name");
    if (metric === "vplan") return vercelAccountText(stats, "team_plan");
    return "—";
  }
  function paintWorkerStats(id) {
    var cached = workerStatsCache[id];
    if (cached === undefined || cached === "loading") return;
    document.querySelectorAll("[data-wstat]").forEach(function (el) {
      var parts = (el.getAttribute("data-wstat") || "").split(":");
      if (parts[0] === id) el.textContent = workerStatText(cached, parts[1]);
    });
  }
  function ensureWorkerStats(item) {
    if (workerStatsCache[item.id] !== undefined) { paintWorkerStats(item.id); return Promise.resolve(); }
    workerStatsCache[item.id] = "loading";
    return api("GET", "/api/machines/" + encodeURIComponent(item.id) + "/edge-stats")
      .then(function (res) {
        workerStatsCache[item.id] = res.data && res.data.ok ? res.data.stats : null;
        paintWorkerStats(item.id);
      })
      .catch(function () { workerStatsCache[item.id] = null; paintWorkerStats(item.id); });
  }
  function fillWorkerStats() {
    if (activeTab !== "edge") return;
    state.items.forEach(function (item) {
      if (item.kind === "worker") ensureWorkerStats(item);
    });
  }
  function assetRecord(kind, entry) {
    if (kind === "zones") return C.record({ id: entry.name, title: entry.name, facts: [["状态", C.escapeHtml(entry.status || "—")], ["套餐", C.escapeHtml(entry.plan || "—")]] });
    if (kind === "d1") return C.record({ id: entry.uuid || entry.name, title: entry.name, facts: [["大小", fmtSize(entry.file_size)], ["创建时间", C.escapeHtml(entry.created_at ? String(entry.created_at).slice(0, 10) : "—")]] });
    if (kind === "r2") return C.record({ id: entry.name, title: entry.name, facts: [["创建时间", C.escapeHtml(entry.created_at ? String(entry.created_at).slice(0, 10) : "—")], ["区域", C.escapeHtml(entry.location || "—")]] });
    if (kind === "vdomains") return C.record({ id: entry.name, title: entry.name, facts: [["创建时间", C.escapeHtml(entry.created_at ? String(entry.created_at).slice(0, 10) : "—")]] });
    if (kind === "deployments") {
      var facts = [
        ["地址", copyUrlHtml(entry.url)],
        ["时间", C.escapeHtml(relTime(entry.created_at) || "—")],
      ];
      if (entry.branch) facts.push(["分支", C.escapeHtml(entry.branch)]);
      if (entry.commit_message) facts.push(["提交", C.escapeHtml(entry.commit_message)]);
      return C.record({
        id: String(entry.name || "") + String(entry.url || entry.created_at || ""),
        title: entry.name || entry.url || "未命名部署",
        statusHtml: vercelStateHtml(entry.state),
        facts: facts,
        actions: entry.url ? "<button type=\"button\" class=\"secondary\" data-wopen=\"" + C.escapeHtml(entry.url) + "\">打开</button>" : "",
      });
    }
    return C.record({ id: entry.id, title: entry.title || entry.id, facts: [["ID", "<span class=\"copy-text\" data-copy=\"" + C.escapeHtml(entry.id) + "\" data-label=\"" + C.escapeHtml(entry.id) + "\" title=\"点击复制\">" + C.escapeHtml(entry.id) + "</span>"]] });
  }
  function copyWorkerConfig(item, btn) {
    btn.disabled = true;
    api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/reveal")
      .then(function (result) {
        if (!result.data || !result.data.ok || !result.data.reveal || !result.data.reveal.secret) {
          C.toast("还没有保存 API 令牌，未复制");
          return;
        }
        var lines = [];
        lines.push("名称：" + item.name);
        if ((item.platform || "cloudflare") === "vercel") {
          lines.push("平台：Vercel");
          lines.push("Team ID：" + (item.team_id || "个人账号"));
        } else {
          lines.push("平台：Cloudflare");
          lines.push("Cloudflare 账号：" + (item.cf_account_id || "未填写"));
        }
        lines.push("API 令牌：" + result.data.reveal.secret);
        return C.copyText(lines.join("\n")).then(function () { C.toast("配置已复制"); });
      })
      .catch(function () { C.toast("复制失败，请稍后重试"); })
      .then(function () { btn.disabled = false; });
  }

  function syncWorkerEntry(item, btn) {
    btn.disabled = true;
    btn.textContent = "同步中…";
    delete workerStatsCache[item.id];
    ensureWorkerStats(item).then(function () {
      btn.disabled = false;
      btn.textContent = "同步";
      C.toast("「" + item.name + "」已同步最新用量");
    });
  }

  function openWorkerPanel(item, startTab) {
    var isVercel = (item.platform || "cloudflare") === "vercel";
    var tabs = isVercel
      ? [["account", "账号信息"], ["vdomains", "域名"], ["workers", "项目"], ["deployments", "部署"]]
      : [["account", "账号信息"], ["zones", "域名"], ["workers", "Workers"], ["d1", "D1"], ["r2", "R2"], ["kv", "KV"]];
    var bar = tabs.map(function (t) {
      return "<button type=\"button\" class=\"wp-tab\" data-wtab=\"" + t[0] + "\" aria-selected=\"" + (t[0] === startTab ? "true" : "false") + "\">" + t[1] + "</button>";
    }).join("");
    var ctrl = C.openFormDialog({
      title: item.name,
      size: "lg",
      bodyHtml: "<div class=\"wp-tabs\" role=\"tablist\">" + bar + "</div><div class=\"wp-pane\"></div>",
      submitLabel: "关闭",
      onSubmit: function (c) { c.close(); },
    });
    ctrl.dialog.addEventListener("click", handleClick);
    var pane = ctrl.dialog.querySelector(".wp-pane");
    function accountPane() {
      var id = C.escapeHtml(item.id);
      var facts =
        "<div><dt>平台</dt><dd>" + (isVercel ? "Vercel" : "Cloudflare") + "</dd></div>" +
        (isVercel
          ? "<div><dt>Team ID</dt><dd>" + C.escapeHtml(item.team_id || "个人账号") + "</dd></div>"
          : "<div><dt>Cloudflare 账号</dt><dd>" + C.escapeHtml(item.cf_account_id || "未填写") + "</dd></div>") +
        "<div><dt>API 令牌</dt><dd>" + (item.api_token_tail ? workerTokenHtml(item, true) : "未填写") + "</dd></div>" +
        "<div><dt>更新时间</dt><dd>" + C.escapeHtml(C.formatMinute(item.updated_at) || "—") + "</dd></div>";
      var statRows = isVercel
        ? "<div><dt>项目总量</dt><dd>" + workerStatSpan(item, "projects") + "</dd></div>" +
          "<div><dt>域名数量</dt><dd>" + workerStatSpan(item, "vdomains") + "</dd></div>" +
          "<div><dt>最近部署</dt><dd>" + workerStatSpan(item, "deploy") + "</dd></div>" +
          "<div><dt>用户名</dt><dd>" + workerStatSpan(item, "vuser") + "</dd></div>" +
          "<div><dt>邮箱</dt><dd>" + workerStatSpan(item, "vemail") + "</dd></div>" +
          "<div><dt>姓名</dt><dd>" + workerStatSpan(item, "vname") + "</dd></div>" +
          (item.team_id
            ? "<div><dt>团队名称</dt><dd>" + workerStatSpan(item, "vteam") + "</dd></div>" +
              "<div><dt>团队套餐</dt><dd>" + workerStatSpan(item, "vplan") + "</dd></div>"
            : "")
        : "<div><dt>Workers 总量</dt><dd>" + workerStatSpan(item, "workers") + "</dd></div>" +
          "<div><dt>Workers 用量</dt><dd>" + workerStatSpan(item, "requests") + "</dd></div>" +
          "<div><dt>D1 数据库</dt><dd>" + workerStatSpan(item, "d1") + "</dd></div>" +
          "<div><dt>域名数量</dt><dd>" + workerStatSpan(item, "zones") + "</dd></div>";
      var stats = "<div class=\"manage-info-card\"><dl class=\"kv\">" + statRows + "</dl></div>";
      pane.innerHTML =
        "<div class=\"manage-info-card\"><dl class=\"kv\">" + facts + "</dl></div>" + stats +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-mact=\"group\" data-kind=\"worker\" data-id=\"" + id + "\">设置分组</button>" +
        "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"worker\" data-id=\"" + id + "\">编辑</button>" +
        "<button type=\"button\" class=\"danger\" data-confirm-delete data-mact=\"delete\" data-kind=\"worker\" data-id=\"" + id + "\">删除</button>" +
        "</div>";
      ensureWorkerStats(item);
    }
    function assetsPane(kind) {
      pane.innerHTML = C.emptyState("正在读取", "");
      api("GET", "/api/machines/" + encodeURIComponent(item.id) + "/edge-assets?kind=" + kind)
        .then(function (res) {
          if (!res.data || !res.data.ok) { pane.innerHTML = C.emptyState("读取失败", (res.data && res.data.error) || "请稍后重试"); return; }
          var items = res.data.items || [];
          if (!items.length) { pane.innerHTML = C.emptyState("暂无数据", "拉取于 " + (C.formatMinute(res.data.fetched_at) || "刚刚")); return; }
          var rows = items.map(function (entry) { return assetRecord(kind, entry); }).join("");
          pane.innerHTML = "<p class=\"subtle\">拉取于 " + C.escapeHtml(C.formatMinute(res.data.fetched_at) || "刚刚") + "，共 " + items.length + " 个</p>" + C.list(rows);
        })
        .catch(function () { pane.innerHTML = C.emptyState("读取失败", "网络异常，请重试"); });
    }
    function show(key) {
      ctrl.dialog.querySelectorAll("[data-wtab]").forEach(function (b) {
        b.setAttribute("aria-selected", b.getAttribute("data-wtab") === key ? "true" : "false");
      });
      if (key === "account") { accountPane(); return; }
      if (key === "workers") { mountWorkersList(pane, item); return; }
      assetsPane(key);
    }
    ctrl.dialog.addEventListener("click", function (event) {
      var tab = event.target instanceof Element ? event.target.closest("[data-wtab]") : null;
      if (tab) show(tab.getAttribute("data-wtab"));
    });
    show(startTab || "account");
  }

  function mountWorkersList(container, item) {
    if (!item.api_token_tail) {
      container.innerHTML = C.emptyState("还没有保存 API 令牌", item.platform === "vercel" ? "先在编辑里补上 API 令牌，再来查看名下项目" : "先在编辑里补上 Cloudflare 账号 ID 与 API 令牌，再来查看名下 Workers");
      return;
    }
    var listState = { subdomain: "", accountId: item.cf_account_id || "", platform: item.platform || "cloudflare" };
    function workerActions(w) {
      if (listState.platform === "vercel") return "";
      var btns = "";
      if (listState.subdomain) {
        btns += "<button type=\"button\" class=\"secondary\" data-wact=\"visit\" data-url=\"" + C.escapeHtml("https://" + w.name + "." + listState.subdomain + ".workers.dev") + "\">访问</button>";
      }
      if (listState.accountId) {
        btns += "<button type=\"button\" class=\"secondary\" data-wact=\"console\" data-url=\"" + C.escapeHtml("https://dash.cloudflare.com/" + listState.accountId + "/workers/services/view/" + w.name + "/production") + "\">控制台</button>";
      }
      btns += "<button type=\"button\" class=\"danger\" data-confirm-delete data-wact=\"delete\" data-name=\"" + C.escapeHtml(w.name) + "\">删除</button>";
      return btns;
    }
    function loadWorkers() {
      api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/edges")
        .then(function (result) {
          if (!result.data || !result.data.ok) {
            container.innerHTML = (C.emptyState("读取失败", (result.data && result.data.error) || "请稍后重试"));
            return;
          }
          if (result.data.platform) listState.platform = result.data.platform;
          if (result.data.account_id) listState.accountId = result.data.account_id;
          if (result.data.subdomain) listState.subdomain = result.data.subdomain;
          var workers = result.data.workers || [];
          if (!workers.length) {
            container.innerHTML = (C.emptyState(item.platform === "vercel" ? "这个账号下还没有项目" : "这个账号下还没有 Workers", "拉取于 " + (C.formatMinute(result.data.fetched_at) || "刚刚")));
            return;
          }
          var rows = workers.map(function (w) {
            var modified = w.modified_on ? String(w.modified_on).slice(0, 10) + " " + String(w.modified_on).slice(11, 16) : "未记录";
            var wfacts = [];
            if (w.meta) wfacts.push(["框架", C.escapeHtml(w.meta)]);
            if (w.deploy_at) wfacts.push(["最近部署", C.escapeHtml(relTime(w.deploy_at) || "—")]);
            else wfacts.push(["更新时间", C.escapeHtml(modified)]);
            if (w.domain) wfacts.push(["域名", copyUrlHtml(w.domain)]);
            return C.record({ id: w.name, title: w.name, facts: wfacts, actions: workerActions(w) });
          }).join("");
          container.innerHTML = (
            "<p class=\"subtle\">拉取于 " + C.escapeHtml(C.formatMinute(result.data.fetched_at) || "刚刚") + "，共 " + workers.length + " 个</p>" + C.list(rows)
          );
        })
        .catch(function () {
          container.innerHTML = (C.emptyState("读取失败", "网络异常，请重试"));
        });
    }
    container.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var btn = target.closest("[data-wact]");
      if (!btn) return;
      var act = btn.getAttribute("data-wact");
      if (act === "visit" || act === "console") {
        window.open(btn.getAttribute("data-url"), "_blank", "noopener");
        return;
      }
      if (act === "delete") {
        var wname = btn.getAttribute("data-name");
        btn.disabled = true;
        api("DELETE", "/api/machines/" + encodeURIComponent(item.id) + "/edges/" + encodeURIComponent(wname))
          .then(function (res) {
            if (res.data && res.data.ok) {
              C.toast("已删除 Worker「" + wname + "」");
              loadWorkers();
            } else {
              btn.disabled = false;
              C.toast((res.data && res.data.error) || "删除失败");
            }
          })
          .catch(function () {
            btn.disabled = false;
            C.toast("删除失败");
          });
      }
    });
    container.innerHTML = C.emptyState("正在读取", "");
    loadWorkers();
  }

  // ---- MiSub 瘦客户端：连接、概览与列表 ----

  var MISUB_SEGMENTS = [
    ["all", "全部节点"],
    ["manual_nodes", "手工节点"],
    ["subscriptions", "机场订阅"],
    ["profiles", "订阅组"],
  ];
  var misubSegment = "all";
  // 节点视图的筛选：关键词 + 协议 + 地区 + 来源（来源只在全部节点里出现）。
  var misubFilter = { q: "", protocol: "", region: "", source: "" };
  // 全部节点 = 手工节点 + 各机场订阅拉回来的节点，进「全部节点」时才拉。
  var misubAll = { data: null, loading: false, error: "", connId: "" };
  var MISUB_PAGE = 200;
  var misubShowLimit = MISUB_PAGE;

  var MISUB_REGIONS = {
    HK: "香港", MO: "澳门", TW: "台湾", JP: "日本", SG: "新加坡", KR: "韩国", US: "美国", GB: "英国",
    DE: "德国", FR: "法国", NL: "荷兰", CA: "加拿大", AU: "澳大利亚", RU: "俄罗斯", ID: "印尼", IN: "印度",
    TR: "土耳其", MY: "马来西亚", TH: "泰国", VN: "越南", PH: "菲律宾", AE: "阿联酋", AR: "阿根廷",
    BR: "巴西", MX: "墨西哥", IT: "意大利", ES: "西班牙", CH: "瑞士", SE: "瑞典", IE: "爱尔兰",
    PL: "波兰", IL: "以色列", ZA: "南非", CN: "中国",
  };

  function misubFlag(code) {
    if (!/^[A-Z]{2}$/.test(code || "")) return "";
    return String.fromCodePoint(0x1f1e6 + code.charCodeAt(0) - 65, 0x1f1e6 + code.charCodeAt(1) - 65);
  }

  function misubRegionName(code) {
    if (!code) return "未识别";
    return MISUB_REGIONS[code] || code;
  }

  function twoDigit(number) {
    return String(number).padStart(2, "0");
  }

  function fmtLocalTime(value) {
    if (value == null || value === "") return "—";
    var time = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(time)) {
      var parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return "—";
      time = parsed.getTime();
    } else if (time < 1e12) {
      time = time * 1000;
    }
    var date = new Date(time);
    if (Number.isNaN(date.getTime())) return "—";
    return date.getFullYear() + "-" + twoDigit(date.getMonth() + 1) + "-" + twoDigit(date.getDate()) + " " + twoDigit(date.getHours()) + ":" + twoDigit(date.getMinutes());
  }

  function fmtDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.getFullYear() + "-" + twoDigit(date.getMonth() + 1) + "-" + twoDigit(date.getDate());
  }

  // 全站文件体积口径只有 KB/MB/GB，不出现 B。
  function fmtBytes(value) {
    var bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
    return "0 KB";
  }

  function misubCount(value) {
    var count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function misubConnections() {
    return state.misubMeta && Array.isArray(state.misubMeta.connections) ? state.misubMeta.connections : [];
  }

  function misubActiveId() {
    return (state.misubMeta && state.misubMeta.active_id) || "";
  }

  function findMisubConn(id) {
    var found = null;
    misubConnections().forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  function misubActiveConn() {
    return findMisubConn(misubActiveId());
  }

  function misubConfig() {
    return (state.misubMeta && state.misubMeta.config) || {};
  }

  function misubVaultState() {
    return (state.misubMeta && state.misubMeta.vault_key_state) || "";
  }

  function misubTimeLabel(value) {
    if (value == null || value === "") return "—";
    return fmtLocalTime(value) || "—";
  }

  function misubTestSummary(conn) {
    if (!conn || !conn.last_test_at) return "尚未测试";
    var result = conn.last_test_ok ? "成功" : "失败";
    var when = misubTimeLabel(conn.last_test_at);
    return when && when !== "—" ? result + " · " + when : result;
  }

  // ---- 同步状态与冷却 ----
  var misubCooldownTimer = 0;

  function misubSyncInfo() {
    return (state.misub && state.misub.sync) || (state.misubMeta && state.misubMeta.sync) || null;
  }

  function misubCooling(ts) {
    return !!ts && Number(ts) > Date.now();
  }

  function misubMinutesUntil(ts) {
    return Math.max(1, Math.ceil((Number(ts) - Date.now()) / 60000));
  }

  function misubAgo(ts) {
    if (!ts) return "从未";
    var diff = Date.now() - Number(ts);
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
    return fmtLocalTime(ts);
  }

  function misubIntervalLabel(hours) {
    var h = Number(hours);
    return h > 0 ? "每 " + h + " 小时" : "已关闭";
  }

  function misubNextAutoLabel(ts, hours) {
    if (!(Number(hours) > 0)) return "不自动拉取";
    if (!ts || Number(ts) <= Date.now()) return "下一个整点";
    return fmtLocalTime(ts);
  }

  // 冷却结束时重画一次，让按钮自己恢复可点。
  function scheduleMisubCooldownRepaint(ts) {
    if (!misubCooling(ts)) return;
    var wait = Math.min(Number(ts) - Date.now() + 500, 6 * 60 * 1000);
    if (misubCooldownTimer) clearTimeout(misubCooldownTimer);
    misubCooldownTimer = setTimeout(function () {
      misubCooldownTimer = 0;
      if (activeTab === "proxy") render();
    }, wait);
  }

  function misubSyncButtonHtml(cls) {
    var sync = misubSyncInfo();
    var next = sync && sync.next_manual_at;
    if (misubCooling(next)) {
      scheduleMisubCooldownRepaint(next);
      return (
        '<button type="button" class="' + cls + '" data-misub-sync disabled title="手动同步有 5 分钟冷却，' +
        C.escapeHtml(fmtLocalTime(next)) + ' 后可再同步">' + misubMinutesUntil(next) + " 分钟后可同步</button>"
      );
    }
    return '<button type="button" class="' + cls + '" data-misub-sync title="从 MiSub 拉列表，并拉取最久没更新的机场订阅">同步节点</button>';
  }

  function misubSyncBarHtml() {
    var sync = misubSyncInfo();
    if (!sync) return "";
    var parts = [];
    if (sync.synced_at) parts.push("上次同步 " + misubAgo(sync.synced_at) + "（" + fmtLocalTime(sync.synced_at) + "）");
    parts.push("自动拉取 " + misubIntervalLabel(sync.auto_interval_hours));
    if (Number(sync.auto_interval_hours) > 0) parts.push("下次自动 " + misubNextAutoLabel(sync.next_auto_at, sync.auto_interval_hours));
    if (misubCooling(sync.next_manual_at)) parts.push(fmtLocalTime(sync.next_manual_at) + " 后可再手动同步");
    var html = '<p class="subtle misub-sync-bar">' + C.escapeHtml(parts.join(" · ")) + "</p>";
    if (sync.last_attempt_at && !sync.last_ok && sync.last_error) {
      html +=
        '<p class="callout warn" role="status">最近一次同步 MiSub 列表失败（' + C.escapeHtml(fmtLocalTime(sync.last_attempt_at)) + "）：" +
        C.escapeHtml(sync.last_error) + (sync.synced_at ? "。下面仍是上次成功同步的数据" : "") + "</p>";
    }
    return html;
  }

  function misubNeverSyncedHtml() {
    var sync = misubSyncInfo() || {};
    return (
      misubSyncBarHtml() +
      '<div class="misub-never">' +
      C.emptyState(
        "还没有同步过",
        "节点数据保存在 D1，打开页面不会访问 MiSub。点「同步节点」拉取一次，之后按" +
          misubIntervalLabel(sync.auto_interval_hours) + "自动更新"
      ) +
      '<div class="manage-actions">' + misubSyncButtonHtml("add-button misub-sync-primary") + "</div>" +
      "</div>"
    );
  }

  function misubSyncNow(button) {
    if (!button || button.disabled) return;
    button.disabled = true;
    button.textContent = "同步中…";
    api("POST", "/api/misub/sync")
      .then(function (res) {
        var data = res.data || {};
        if (!data.ok) {
          C.toast(data.error || "同步失败，请稍后重试", "danger");
        } else {
          var parts = [];
          if (!data.snapshot_ok) parts.push("MiSub 列表失败：" + (data.snapshot_error || "未知错误"));
          var tried = (data.fetched || 0) + ((data.failed && data.failed.length) || 0);
          parts.push("拉取了 " + tried + " 个机场订阅");
          if (data.failed && data.failed.length) parts.push(data.failed.length + " 个失败（保留上次的节点）");
          if (data.remaining) parts.push(data.remaining + " 个留到下次");
          C.toast("同步完成：" + parts.join("，"), data.snapshot_ok && !(data.failed && data.failed.length) ? undefined : "danger");
        }
        resetMisubAll();
        return loadMisubSnapshot(false, true).then(function () {
          if (misubSegment === "all" && activeTab === "proxy") loadMisubAllNodes();
        });
      })
      .catch(function () {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = "同步节点";
        }
        C.toast("同步失败，请稍后重试", "danger");
      });
  }

  function misubFetchSub(id, button, after) {
    if (!id || !button || button.disabled) return;
    button.disabled = true;
    button.textContent = "拉取中…";
    api("POST", "/api/misub/subscriptions/" + encodeURIComponent(id) + "/fetch")
      .then(function (res) {
        var data = res.data || {};
        if (!data.ok) C.toast(data.error || "拉取失败", "danger");
        else if (!data.fetch_ok) C.toast("拉取失败：" + (data.error || "未知错误") + "，保留上次的节点", "danger");
        else C.toast("已拉取 " + misubCount(data.node_count) + " 个节点");
        resetMisubAll();
        if (after) after();
        return loadMisubSnapshot(false, true);
      })
      .catch(function () {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = "拉取节点";
        }
        C.toast("拉取失败，请稍后重试", "danger");
      });
  }

  function misubFetchButtonHtml(sub, extraAttr) {
    if (misubCooling(sub.next_manual_at)) {
      scheduleMisubCooldownRepaint(sub.next_manual_at);
      return (
        '<button type="button" class="secondary" disabled title="' + C.escapeHtml(fmtLocalTime(sub.next_manual_at)) +
        ' 后可再拉取">' + misubMinutesUntil(sub.next_manual_at) + " 分钟后可拉取</button>"
      );
    }
    if (sub.enabled === false) return "";
    return '<button type="button" class="secondary" ' + extraAttr + ">拉取节点</button>";
  }

  // 只记录连接元信息，不出站；当前连接变化时清掉旧快照，避免串数据。
  function applyMisubMeta(res) {
    state.misubMetaLoaded = true;
    if (!res || !res.data || !res.data.ok) {
      state.misubMeta = null;
      state.misubSnapshotLoading = false;
      state.misubError = (res && res.data && res.data.error) || "MiSub 读取失败";
      return;
    }
    var data = res.data;
    var hadMetaError = !state.misubMeta;
    var previousActive = misubActiveId();
    state.misubMeta = data;
    if (hadMetaError) state.misubError = "";
    if (!data.active_id || (previousActive && previousActive !== data.active_id)) {
      resetMisubAll();
      state.misub = null;
      state.misubSnapshotLoaded = false;
      state.misubSnapshotLoading = false;
      state.misubError = "";
    }
  }

  function reloadMisubMeta() {
    return api("GET", "/api/misub?meta=1")
      .then(function (res) {
        applyMisubMeta(res);
        render();
        if (misubPanelCtrl && misubPanelCtrl.dialog.open) paintMisubPanel();
        maybeLoadMisubSnapshot();
      })
      .catch(function () {});
  }

  function maybeLoadMisubSnapshot() {
    if (activeTab !== "proxy") return;
    if (!state.misubMetaLoaded || !misubActiveConn()) return;
    if (state.misubSnapshotLoaded || state.misubSnapshotLoading) return;
    loadMisubSnapshot(false, false);
  }

  function loadMisubSnapshot(fresh, force) {
    if (!misubActiveConn()) return Promise.resolve();
    if (state.misubSnapshotLoading) return Promise.resolve();
    if (state.misubSnapshotLoaded && !fresh && !force) return Promise.resolve();
    var requestActive = misubActiveId();
    state.misubSnapshotLoading = true;
    if (!state.misub) state.misubError = "";
    render();
    return api("GET", "/api/misub")
      .then(function (res) {
        // 请求期间切换了当前连接：丢弃旧连接的结果，交给新一轮加载。
        if (misubActiveId() !== requestActive) return;
        state.misubSnapshotLoading = false;
        if (res && res.data && res.data.ok) {
          state.misub = res.data;
          state.misubSnapshotLoaded = true;
          state.misubError = "";
          if (state.misubMeta && res.data.sync) state.misubMeta.sync = res.data.sync;
          if (misubPanelCtrl && misubPanelCtrl.dialog.open) paintMisubPanel();
          if (state.misubMeta) {
            if (Array.isArray(res.data.connections)) state.misubMeta.connections = res.data.connections;
            if (typeof res.data.active_id === "string") state.misubMeta.active_id = res.data.active_id;
          }
        } else {
          state.misubError = (res && res.data && res.data.error) || "MiSub 读取失败";
        }
        render();
      })
      .catch(function () {
        if (misubActiveId() !== requestActive) return;
        state.misubSnapshotLoading = false;
        state.misubError = "MiSub 读取失败";
        render();
      });
  }

  function misubOverview() {
    var overview = state.misub.overview || {};
    var expireHint = "";
    var expire = Number(overview.nearest_expire);
    if (Number.isFinite(expire) && expire > 0) {
      var days = Math.max(0, Math.ceil((expire * 1000 - Date.now()) / 86400000));
      expireHint = "最近到期 " + fmtDate(expire * 1000) + "（剩 " + days + " 天）";
    }
    return (
      '<div class="stat-grid">' +
      C.stat("全部节点", String(misubCount(overview.total_nodes)), "按 MiSub 记录的订阅节点数合计") +
      C.stat("手工节点", String(misubCount(overview.manual_nodes)), "") +
      C.stat("机场订阅", String(misubCount(overview.subscriptions)), "订阅组 " + misubCount(overview.profiles) + " 个") +
      C.stat("流量", fmtBytes(overview.traffic_used) + " / " + fmtBytes(overview.traffic_total), expireHint) +
      "</div>"
    );
  }

  function misubSegmented() {
    return (
      '<div class="segmented misub-segmented" role="group" aria-label="MiSub 列表">' +
      MISUB_SEGMENTS.map(function (option) {
        return (
          '<button type="button" class="segment" data-misub-seg="' + option[0] + '" aria-pressed="' +
          (misubSegment === option[0] ? "true" : "false") + '">' + option[1] + "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function misubEmpty() {
    var text =
      misubSegment === "subscriptions"
        ? "MiSub 里还没有机场订阅"
        : misubSegment === "manual_nodes"
          ? "MiSub 里还没有手工节点"
          : "MiSub 里还没有订阅组";
    return '<p class="subtle">' + text + "</p>";
  }

  function misubCards(items, renderCard) {
    if (!items || !items.length) return misubEmpty();
    return C.cardList(items.map(renderCard).join(""));
  }

  function misubDisabledBadge(item) {
    return item.enabled === false ? C.badge("已停用", "warn") : "";
  }

  function misubProfileCard(item) {
    var facts = [
      ["节点", misubCount(item.total_nodes) + " 个"],
      ["组成", misubCount(item.subscription_count) + " 个订阅源 · " + misubCount(item.manual_count) + " 个手动节点"],
    ];
    if (item.description) facts.push(["说明", item.description]);
    var canRefresh = !!misubConfig().refresh_enabled;
    return C.record({
      id: item.id,
      title: item.name || "未命名订阅组",
      statusHtml: misubDisabledBadge(item),
      facts: facts,
      actions: canRefresh
        ? '<button type="button" class="secondary" data-msrefresh data-id="' +
          C.escapeHtml(item.id) +
          '">触发刷新</button>'
        : "",
    });
  }

  function misubMeter(used, total) {
    var pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
    return (
      '<div class="misub-meter" aria-hidden="true"><div class="misub-meter-fill" style="width:' +
      pct.toFixed(1) +
      '%"></div></div>'
    );
  }

  function misubRemainDays(expire) {
    return Math.max(0, Math.ceil((expire * 1000 - Date.now()) / 86400000));
  }

  function misubSubscriptionCard(item) {
    var used = (Number(item.upload) || 0) + (Number(item.download) || 0);
    var total = Number(item.total) || 0;
    var facts = [["MiSub 节点数", misubCount(item.node_count) + " 个"]];
    facts.push(["已存节点", item.last_fetch_success_at ? misubCount(item.fetched_node_count) + " 个" : "—"]);
    facts.push(["节点拉取", C.escapeHtml(!item.last_fetch_at ? "尚未拉取" : (item.last_fetch_ok ? "成功" : "失败") + " · " + misubAgo(item.last_fetch_at))]);
    if (item.enabled !== false) {
      facts.push(["自动拉取", C.escapeHtml(misubIntervalLabel(item.effective_interval_hours) + (item.interval_hours == null ? "（跟随连接）" : "（单独设置）"))]);
      if (Number(item.effective_interval_hours) > 0) facts.push(["下次自动", C.escapeHtml(misubNextAutoLabel(item.next_auto_at, item.effective_interval_hours))]);
    }
    if (item.url_masked) facts.push(["订阅地址", '<code class="misub-mono">' + C.escapeHtml(item.url_masked) + "</code>"]);
    if (item.group) facts.push(["分组", C.escapeHtml(item.group)]);
    facts.push(["流量", fmtBytes(used) + " / " + fmtBytes(total)]);
    var expire = Number(item.expire);
    var expired = false;
    if (item.expire != null && item.expire !== "" && Number.isFinite(expire) && expire > 0) {
      expired = expire * 1000 <= Date.now();
      facts.push(["到期", expired
        ? fmtDate(expire * 1000) + "（已过期）"
        : fmtDate(expire * 1000) + "（剩 " + misubRemainDays(expire) + " 天）"]);
    }
    if (item.last_update != null && item.last_update !== "") {
      facts.push(["最后刷新", fmtLocalTime(item.last_update)]);
    }
    var extra =
      misubMeter(used, total) +
      (item.last_error
        ? '<p class="callout danger" role="alert">MiSub 记录的错误：' + C.escapeHtml(item.last_error) + "</p>"
        : "") +
      (item.last_fetch_at && !item.last_fetch_ok
        ? '<p class="callout warn" role="status">节点拉取失败（' + C.escapeHtml(fmtLocalTime(item.last_fetch_at)) + "）：" +
          C.escapeHtml(item.last_fetch_error || "未知错误") +
          (item.last_fetch_success_at ? "。仍保留 " + C.escapeHtml(fmtLocalTime(item.last_fetch_success_at)) + " 拉到的节点" : "") + "</p>"
        : "");
    var sid = C.escapeHtml(item.id);
    return C.record({
      id: item.id,
      title: item.name || "未命名订阅",
      className: "misub-sub-card",
      statusHtml: misubDisabledBadge(item) + (expired ? C.badge("已过期", "warn") : ""),
      extra: extra,
      facts: facts,
      actions:
        '<button type="button" class="secondary" data-mssub-nodes="' + sid + '">查看节点</button>' +
        misubFetchButtonHtml(item, 'data-mssub-fetch="' + sid + '"') +
        (misubConfig().refresh_enabled
          ? '<button type="button" class="secondary" data-mssub-refresh="' + sid + '">触发刷新</button>'
          : ""),
    });
  }

  // 手工节点在前端转成与全部节点同一形状，列表只画一套。
  function misubManualAsNode(item) {
    return {
      key: item.id,
      source_type: "manual",
      source_id: item.id,
      source_name: "手工节点",
      name: item.name,
      protocol: item.protocol,
      server_masked: item.server_masked,
      has_server: item.has_server !== false,
      region: item.region || "",
      can_copy: true,
      enabled: item.enabled !== false,
      group: item.group || "",
      remarks: item.remarks || "",
    };
  }

  function misubManualNodes() {
    return ((state.misub && state.misub.manual_nodes) || []).map(misubManualAsNode);
  }

  function misubViewNodes() {
    if (misubSegment === "manual_nodes") return misubManualNodes();
    if (misubAll.data && misubAll.connId === misubActiveId()) return misubAll.data.nodes || [];
    return misubManualNodes();
  }

  function misubNodeMatches(node, filter, withSource) {
    if (filter.protocol && (node.protocol || "") !== filter.protocol) return false;
    if (filter.region && (node.region || "_") !== filter.region) return false;
    if (withSource && filter.source) {
      if (filter.source === "manual" && node.source_type !== "manual") return false;
      if (filter.source !== "manual" && (node.source_type !== "subscription" || node.source_id !== filter.source)) return false;
    }
    var q = (filter.q || "").trim().toLowerCase();
    if (!q) return true;
    var hay = [node.name, node.protocol, node.server_masked, node.source_name, node.group, node.remarks, misubRegionName(node.region)]
      .join(" ")
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  }

  function misubCountBy(nodes, keyOf) {
    var map = {};
    var order = [];
    nodes.forEach(function (node) {
      var key = keyOf(node);
      if (!(key in map)) {
        map[key] = 0;
        order.push(key);
      }
      map[key]++;
    });
    order.sort(function (a, b) { return map[b] - map[a]; });
    return order.map(function (key) { return [key, map[key]]; });
  }

  function misubChipRow(label, field, options, current, total) {
    if (options.length < 2 && !current) return "";
    return (
      '<div class="misub-chip-row"><span class="misub-chip-label">' + C.escapeHtml(label) + "</span>" +
      '<div class="segmented misub-chips" role="group" aria-label="' + C.escapeHtml(label) + '">' +
      '<button type="button" class="segment" data-misub-filter="' + field + '" data-value="" aria-pressed="' +
      (current ? "false" : "true") + '">全部 ' + total + "</button>" +
      options
        .map(function (opt) {
          return (
            '<button type="button" class="segment" data-misub-filter="' + field + '" data-value="' + C.escapeHtml(opt[0]) +
            '" aria-pressed="' + (current === opt[0] ? "true" : "false") + '">' + opt[1] + "</button>"
          );
        })
        .join("") +
      "</div></div>"
    );
  }

  function misubChipsHtml(nodes, filter, withSource) {
    var protocols = misubCountBy(nodes, function (n) { return n.protocol || ""; })
      .filter(function (e) { return e[0]; })
      .map(function (e) { return [e[0], C.escapeHtml(e[0]) + " " + e[1]]; });
    var regions = misubCountBy(nodes, function (n) { return n.region || "_"; }).map(function (e) {
      var code = e[0] === "_" ? "" : e[0];
      var flag = misubFlag(code);
      return [e[0], (flag ? flag + " " : "") + C.escapeHtml(misubRegionName(code)) + " " + e[1]];
    });
    var html = misubChipRow("协议", "protocol", protocols, filter.protocol, nodes.length) +
      misubChipRow("地区", "region", regions, filter.region, nodes.length);
    if (withSource) {
      var sources = misubCountBy(nodes, function (n) { return n.source_type === "manual" ? "manual" : n.source_id; }).map(function (e) {
        var sample = null;
        for (var i = 0; i < nodes.length && !sample; i++) {
          var n = nodes[i];
          if ((n.source_type === "manual" ? "manual" : n.source_id) === e[0]) sample = n;
        }
        return [e[0], C.escapeHtml((sample && sample.source_name) || "未命名订阅") + " " + e[1]];
      });
      html += misubChipRow("来源", "source", sources, filter.source, nodes.length);
    }
    return html;
  }

  function misubNodeRow(node, inDialog) {
    var flag = misubFlag(node.region);
    var server = node.has_server === false ? "—" : node.server_masked || "—";
    var attrs =
      ' data-src-type="' + C.escapeHtml(node.source_type) + '" data-src-id="' + C.escapeHtml(node.source_id) +
      '" data-key="' + C.escapeHtml(String(node.key)) + '" data-name="' + C.escapeHtml(node.name || "") + '"';
    var sub = [];
    if (!inDialog) sub.push(C.escapeHtml(node.source_name || ""));
    if (node.group) sub.push(C.escapeHtml(node.group));
    if (node.remarks) sub.push(C.escapeHtml(node.remarks));
    return (
      '<li class="misub-node-row' + (node.enabled === false ? " is-disabled" : "") + '">' +
      '<span class="misub-node-region" title="' + C.escapeHtml(misubRegionName(node.region)) + '">' +
      (flag ? '<span class="misub-flag" aria-hidden="true">' + flag + "</span>" : "") +
      '<span class="misub-region-name">' + C.escapeHtml(misubRegionName(node.region)) + "</span></span>" +
      '<span class="misub-node-main"><span class="misub-node-name">' + C.escapeHtml(node.name || "未命名节点") + "</span>" +
      (sub.length ? '<span class="misub-node-sub">' + sub.join(" · ") + "</span>" : "") +
      "</span>" +
      '<span class="misub-node-proto">' + (node.protocol ? C.badge(node.protocol) : "") +
      (node.enabled === false ? C.badge("已停用", "warn") : "") + "</span>" +
      '<code class="misub-node-server">' + C.escapeHtml(server) + "</code>" +
      '<span class="misub-node-actions">' +
      (node.can_copy
        ? '<button type="button" class="secondary" data-msnode-copy' + attrs + ">复制链接</button>" +
          '<button type="button" class="ghost" data-msnode-show' + attrs + ">显示</button>"
        : '<span class="subtle" title="Clash 配置格式的订阅没有原始链接">无原始链接</span>') +
      "</span></li>"
    );
  }

  function misubRowsHtml(nodes, filter, withSource, limit, inDialog) {
    var matched = nodes.filter(function (n) { return misubNodeMatches(n, filter, withSource); });
    if (!nodes.length) return "";
    if (!matched.length) return '<p class="subtle">没有符合筛选条件的节点</p>';
    var shown = matched.slice(0, limit);
    return (
      '<p class="subtle misub-count">共 ' + matched.length + " 个节点" +
      (matched.length !== nodes.length ? "（筛选自 " + nodes.length + " 个）" : "") + "</p>" +
      '<ul class="misub-node-list">' + shown.map(function (n) { return misubNodeRow(n, inDialog); }).join("") + "</ul>" +
      (matched.length > shown.length
        ? '<div class="manage-actions"><button type="button" class="secondary" data-misub-more>再显示 ' +
          Math.min(MISUB_PAGE, matched.length - shown.length) + " 个（还剩 " + (matched.length - shown.length) + " 个）</button></div>"
        : "")
    );
  }

  function misubSearchHtml(placeholder, attr) {
    return (
      '<div class="misub-toolbar">' +
      '<input type="search" class="misub-search" ' + attr + ' placeholder="' + C.escapeHtml(placeholder) +
      '" autocomplete="off" value="' + C.escapeHtml(misubFilter.q) + '" />' +
      (misubSegment === "all" ? misubSyncButtonHtml("secondary") : "") +
      "</div>"
    );
  }

  function misubAllStatusHtml() {
    if (misubAll.loading && !misubAll.data) return C.emptyState("正在读取", "");
    if (misubAll.error) return '<p class="callout danger" role="alert">' + C.escapeHtml(misubAll.error) + "</p>";
    var data = misubAll.data;
    if (!data) return "";
    var subs = (data.sources || []).filter(function (src) { return src.type === "subscription"; });
    var off = subs.filter(function (src) { return src.enabled === false; });
    var live = subs.filter(function (src) { return src.enabled !== false; });
    var never = live.filter(function (src) { return !src.last_fetch_at; });
    var failed = live.filter(function (src) { return src.last_fetch_at && !src.last_fetch_ok; });
    var okCount = live.length - never.length - failed.length;
    var text = okCount + " 个机场订阅已拉到节点" +
      (failed.length ? "，" + failed.length + " 个最近一次拉取失败" : "") +
      (never.length ? "，" + never.length + " 个还没拉取" : "") +
      (off.length ? "，" + off.length + " 个已停用不拉取" : "");
    return (
      '<p class="subtle">' + C.escapeHtml(text) + "</p>" +
      (failed.length
        ? '<div class="callout warn misub-source-errors" role="status"><ul>' +
          failed
            .map(function (src) {
              return "<li>" + C.escapeHtml((src.name || "未命名订阅") + "：" + (src.last_fetch_error || "拉取失败") +
                (src.last_fetch_success_at ? "（保留 " + fmtLocalTime(src.last_fetch_success_at) + " 的 " + src.count + " 个节点）" : "")) + "</li>";
            })
            .join("") +
          "</ul></div>"
        : "")
    );
  }

  function misubNodesViewHtml() {
    var withSource = misubSegment === "all";
    var nodes = misubViewNodes();
    var status = withSource ? misubAllStatusHtml() : "";
    var loadingAll = withSource && misubAll.loading && !misubAll.data;
    if (!nodes.length && !loadingAll) {
      return misubSearchHtml("搜索节点名、服务器、备注", "data-misub-search") + status +
        '<p class="subtle">' + (withSource ? "还没有节点：MiSub 里没有手工节点，机场订阅也还没拉到节点" : "MiSub 里还没有手工节点") + "</p>";
    }
    return (
      misubSearchHtml("搜索节点名、服务器、备注", "data-misub-search") +
      status +
      (loadingAll ? "" : '<div data-misub-chips>' + misubChipsHtml(nodes, misubFilter, withSource) + "</div>" +
        '<div data-misub-rows>' + misubRowsHtml(nodes, misubFilter, withSource, misubShowLimit, false) + "</div>")
    );
  }

  function misubSubscriptionsViewHtml() {
    var data = state.misub || {};
    var subs = data.subscriptions || [];
    if (!subs.length) return misubEmpty();
    var q = (misubFilter.q || "").trim().toLowerCase();
    var matched = q
      ? subs.filter(function (s) { return ((s.name || "") + " " + (s.group || "") + " " + (s.tags || []).join(" ")).toLowerCase().indexOf(q) >= 0; })
      : subs;
    return (
      misubSearchHtml("搜索订阅名称或分组", "data-misub-search") +
      '<div data-misub-rows>' +
      (matched.length ? C.cardList(matched.map(misubSubscriptionCard).join("")) : '<p class="subtle">没有符合条件的机场订阅</p>') +
      "</div>"
    );
  }

  function misubList() {
    var data = state.misub || {};
    if (misubSegment === "subscriptions") return misubSubscriptionsViewHtml();
    if (misubSegment === "manual_nodes" || misubSegment === "all") return misubNodesViewHtml();
    return misubCards(data.profiles, misubProfileCard);
  }

  // 只重画筛选块和列表，保留搜索框焦点。
  function updateMisubRows() {
    var rows = document.querySelector("[data-misub-rows]");
    if (!rows) return updateMisubList();
    if (misubSegment === "subscriptions") {
      var holder = document.createElement("div");
      holder.innerHTML = misubSubscriptionsViewHtml();
      var fresh = holder.querySelector("[data-misub-rows]");
      if (fresh) rows.innerHTML = fresh.innerHTML;
      return;
    }
    var withSource = misubSegment === "all";
    var nodes = misubViewNodes();
    var chips = document.querySelector("[data-misub-chips]");
    if (chips) chips.innerHTML = misubChipsHtml(nodes, misubFilter, withSource);
    rows.innerHTML = misubRowsHtml(nodes, misubFilter, withSource, misubShowLimit, false);
  }

  function loadMisubAllNodes() {
    var connId = misubActiveId();
    if (!connId || misubAll.loading) return;
    if (misubAll.data && misubAll.connId === connId) return;
    misubAll.loading = true;
    misubAll.error = "";
    updateMisubList();
    api("GET", "/api/misub/nodes")
      .then(function (res) {
        if (misubActiveId() !== connId) return;
        misubAll.loading = false;
        if (res.data && res.data.ok) {
          misubAll.data = res.data;
          misubAll.connId = connId;
          misubAll.error = "";
        } else {
          misubAll.error = (res.data && res.data.error) || "全部节点读取失败";
        }
        if (activeTab === "proxy") updateMisubList();
      })
      .catch(function () {
        if (misubActiveId() !== connId) return;
        misubAll.loading = false;
        misubAll.error = "全部节点读取失败";
        if (activeTab === "proxy") updateMisubList();
      });
  }

  function resetMisubAll() {
    misubAll = { data: null, loading: false, error: "", connId: "" };
  }

  // 明文只走 reveal（服务端先写审计再回明文）。
  function misubRevealRequest(btn) {
    var type = btn.getAttribute("data-src-type");
    var srcId = btn.getAttribute("data-src-id") || "";
    var key = btn.getAttribute("data-key") || "";
    var name = btn.getAttribute("data-name") || "";
    if (type === "manual") return api("POST", "/api/misub/manual-nodes/" + encodeURIComponent(srcId) + "/reveal");
    return api("POST", "/api/misub/subscriptions/" + encodeURIComponent(srcId) + "/nodes/" + encodeURIComponent(key) + "/reveal", { name: name });
  }

  function showMisubNodePlain(title, server, url) {
    var ctrl = C.openManageDialog({ title: title || "节点", size: "sm", bodyHtml: "" });
    ctrl.setBody(
      '<dl class="kv"><div><dt>服务器</dt><dd>' + copyValueHtml(server || "—") + "</dd></div></dl>" +
        '<div><p class="subtle">完整链接</p>' + (url ? C.copyLine(url, "复制链接") : '<p class="subtle">—</p>') + "</div>" +
        '<p class="subtle">这次查看已记入操作日志，关闭后不再保留明文</p>'
    );
  }

  function misubNodeShow(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    misubRevealRequest(btn)
      .then(function (res) {
        if (btn.isConnected) btn.disabled = false;
        if (!res.data || !res.data.ok) {
          C.toast((res.data && res.data.error) || "读取失败，请稍后重试", "danger");
          return;
        }
        showMisubNodePlain(btn.getAttribute("data-name") || "节点", res.data.server, res.data.url);
      })
      .catch(function () {
        if (btn.isConnected) btn.disabled = false;
        C.toast("读取失败，请稍后重试", "danger");
      });
  }

  function misubNodeCopy(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = "读取中…";
    misubRevealRequest(btn)
      .then(function (res) {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = label;
        }
        if (!res.data || !res.data.ok || !res.data.url) {
          C.toast((res.data && res.data.error) || "读取失败，请稍后重试", "danger");
          return;
        }
        var url = res.data.url;
        var server = res.data.server;
        return C.copyText(url).then(
          function () { C.toast("链接已复制，已记入操作日志"); },
          // 浏览器拒绝异步写剪贴板（例如 Safari）时改为弹出明文，让用户手动点复制。
          function () { showMisubNodePlain(btn.getAttribute("data-name") || "节点", server, url); }
        );
      })
      .catch(function () {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.textContent = label;
        }
        C.toast("读取失败，请稍后重试", "danger");
      });
  }

  // 机场订阅详情：读 D1 里最近一次成功拉到的节点（脱敏），可搜索、复制、手动再拉一次。
  function openMisubSubNodes(sub) {
    var filter = { q: "", protocol: "", region: "", source: "" };
    var limit = MISUB_PAGE;
    var result = null;
    var ctrl = C.openManageDialog({
      title: (sub.name || "机场订阅") + " · 节点",
      size: "lg",
      bodyHtml: C.emptyState("正在读取", ""),
    });
    function rowsHtml() {
      return result ? misubRowsHtml(result.nodes || [], filter, false, limit, true) : "";
    }
    function infoHtml() {
      var st = result.state || {};
      var rows = [["订阅地址", '<code class="misub-mono">' + C.escapeHtml(sub.url_masked || "—") + "</code>"]];
      rows.push(["最近拉取", C.escapeHtml(st.last_fetch_at ? (st.last_fetch_ok ? "成功" : "失败") + " · " + fmtLocalTime(st.last_fetch_at) : "尚未拉取")]);
      if (st.last_fetch_at && !st.last_fetch_ok) rows.push(["失败原因", C.escapeHtml(st.last_fetch_error || "未知错误")]);
      if (st.last_fetch_success_at) {
        rows.push(["节点", String((result.nodes || []).length) + " 个（" + C.escapeHtml(fmtLocalTime(st.last_fetch_success_at)) + " 拉到）" + (st.fetch_truncated ? "，只保存了前一部分" : "")]);
        rows.push(["内容格式", st.fetch_format === "clash" ? "Clash 配置（无原始链接，不能复制）" : st.fetch_format === "base64" ? "base64 链接列表" : "明文链接列表"]);
      }
      rows.push(["自动拉取", C.escapeHtml(misubIntervalLabel(st.effective_interval_hours) + (st.interval_hours == null ? "（跟随连接）" : "（单独设置）") +
        (Number(st.effective_interval_hours) > 0 ? " · 下次 " + misubNextAutoLabel(st.next_auto_at, st.effective_interval_hours) : ""))]);
      var info = st.live_user_info;
      if (info) {
        rows.push(["实时流量", fmtBytes((info.upload || 0) + (info.download || 0)) + " / " + fmtBytes(info.total || 0)]);
        if (info.expire) rows.push(["到期", fmtDate(info.expire * 1000)]);
      }
      return '<dl class="kv">' + rows.map(function (r) { return "<div><dt>" + r[0] + "</dt><dd>" + r[1] + "</dd></div>"; }).join("") + "</dl>";
    }
    function fetchBtn() {
      var st = (result && result.state) || {};
      return misubFetchButtonHtml({ enabled: sub.enabled, next_manual_at: st.next_manual_at }, "data-mssub-reload");
    }
    function paint() {
      if (!result) return;
      var nodes = result.nodes || [];
      var st = result.state || {};
      ctrl.setBody(
        infoHtml() +
          '<div class="misub-toolbar"><input type="search" class="misub-search" data-mssub-search placeholder="搜索节点名或服务器" autocomplete="off" value="' +
          C.escapeHtml(filter.q) + '" />' + fetchBtn() + "</div>" +
          '<div data-mssub-chips>' + misubChipsHtml(nodes, filter, false) + "</div>" +
          '<div data-mssub-rows>' +
          (nodes.length
            ? rowsHtml()
            : '<p class="subtle">' + (st.last_fetch_success_at ? "这个订阅里没有读到节点" : "还没有拉取过这个订阅的节点：等自动拉取，或点「拉取节点」") + "</p>") +
          "</div>"
      );
    }
    function repaintRows() {
      var rows = ctrl.bodyEl.querySelector("[data-mssub-rows]");
      var chips = ctrl.bodyEl.querySelector("[data-mssub-chips]");
      if (chips) chips.innerHTML = misubChipsHtml(result.nodes || [], filter, false);
      if (rows) rows.innerHTML = rowsHtml();
    }
    function load() {
      api("GET", "/api/misub/subscriptions/" + encodeURIComponent(sub.id) + "/nodes")
        .then(function (res) {
          if (!ctrl.dialog.open) return;
          if (!res.data || !res.data.ok) {
            ctrl.setBody('<p class="callout danger" role="alert">' + C.escapeHtml((res.data && res.data.error) || "读取失败") + "</p>");
            return;
          }
          result = res.data;
          paint();
        })
        .catch(function () {
          if (ctrl.dialog.open) ctrl.setBody('<p class="callout danger" role="alert">读取失败，请稍后重试</p>');
        });
    }
    ctrl.dialog.addEventListener("input", function (event) {
      var t = event.target;
      if (!(t instanceof Element) || !t.hasAttribute("data-mssub-search")) return;
      filter.q = t.value;
      limit = MISUB_PAGE;
      repaintRows();
    });
    ctrl.dialog.addEventListener("click", function (event) {
      var t = event.target;
      if (!(t instanceof Element)) return;
      var chip = t.closest("[data-misub-filter]");
      if (chip) {
        filter[chip.getAttribute("data-misub-filter")] = chip.getAttribute("data-value") || "";
        limit = MISUB_PAGE;
        repaintRows();
        return;
      }
      if (t.closest("[data-misub-more]")) {
        limit += MISUB_PAGE;
        repaintRows();
        return;
      }
      var reload = t.closest("[data-mssub-reload]");
      if (reload && !reload.disabled) {
        misubFetchSub(sub.id, reload, function () { if (ctrl.dialog.open) load(); });
        return;
      }
      var copyBtn = t.closest("[data-msnode-copy]");
      if (copyBtn) return void misubNodeCopy(copyBtn);
      var showBtn = t.closest("[data-msnode-show]");
      if (showBtn) return void misubNodeShow(showBtn);
    });
    load();
  }

  function refreshMisubSubscription(id, button) {
    if (!id || !button || button.disabled) return;
    button.disabled = true;
    button.textContent = "刷新中…";
    api("POST", "/api/misub/subscriptions/" + encodeURIComponent(id) + "/refresh")
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (button.isConnected) {
            button.disabled = false;
            button.textContent = "触发刷新";
          }
          C.toast((res.data && res.data.error) || "触发刷新失败", "danger");
          return;
        }
        if (res.data.last_error) C.toast("MiSub 刷新失败：" + res.data.last_error, "danger");
        else C.toast("MiSub 已刷新，共 " + misubCount(res.data.node_count) + " 个节点");
        resetMisubAll();
        return loadMisubSnapshot(false, true);
      })
      .catch(function () {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = "触发刷新";
        }
        C.toast("触发刷新失败", "danger");
      });
  }

  function updateMisubList() {
    var list = document.querySelector("[data-misub-list]");
    var searchFocused = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute("data-misub-search");
    if (list) list.innerHTML = misubList();
    if (searchFocused) {
      var input = document.querySelector("[data-misub-search]");
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
    var buttons = document.querySelectorAll("[data-misub-seg]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute("data-misub-seg") === misubSegment ? "true" : "false");
    }
  }

  function misubAddFieldsHtml() {
    return (
      '<label>连接名称（选填）<input name="name" maxlength="60" autocomplete="off" placeholder="留空按地址自动命名" /></label>' +
      '<label>MiSub 地址<input name="base_url" maxlength="2048" autocomplete="off" placeholder="https://你的 MiSub 域名" /></label>' +
      '<label>令牌<input name="token" type="password" maxlength="16384" autocomplete="new-password" data-misub-token="1" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" readonly placeholder="在 MiSub 系统设置里创建的令牌" /></label>'
    );
  }

  function misubTokenHelpHtml() {
    return (
      '<p class="subtle">在 MiSub 后台「系统设置 → External Management API」里开启接口并生成 Bearer Token。' +
      "令牌会密封保存，界面只显示末 4 位；保存前会先测一次连接</p>"
    );
  }

  function misubUaFieldHtml(value) {
    return (
      '<label>拉取机场订阅的 User-Agent（选填）<input name="node_ua" maxlength="200" autocomplete="off" value="' +
      C.escapeHtml(value || "") +
      '" placeholder="留空用 v2rayN/7.23；订阅源在 MiSub 里自带 UA 时优先用它的" /></label>'
    );
  }

  function misubConnectCard() {
    var vaultOn = misubVaultState() === "on";
    var warning = vaultOn ? "" : '<p class="callout danger" role="alert">保险库未配置，暂时不能保存 MiSub 令牌</p>';
    return C.section(
      "添加代理服务商",
      "目前支持 MiSub",
      warning +
        '<form data-misub-add-form>' +
        '<div class="stack">' +
        misubAddFieldsHtml() +
        misubTokenHelpHtml() +
        '<p class="callout danger" data-misub-error role="alert" hidden></p>' +
        '<div class="add-bar">' +
        '<button type="button" class="secondary" data-misub-test>测试连接</button>' +
        '<button type="submit" class="add-button misub-save-conn"' + (vaultOn ? "" : " disabled") + '>保存并连接</button>' +
        "</div>" +
        "</div>" +
        "</form>"
    );
  }

  function misubErrorState(conn, baseUrl, hint) {
    return C.section(
      "MiSub",
      hint,
      '<p class="callout danger" role="alert">' + C.escapeHtml(state.misubError || "MiSub 读取失败") + "</p>" +
        '<p class="subtle">' + C.escapeHtml((conn.name || "未命名连接") + " · " + baseUrl) + "</p>" +
        '<div class="manage-actions">' +
        '<button type="button" class="secondary" data-misub-retry>重试</button>' +
        '<button type="button" class="secondary" data-misub-connections>服务商设置</button>' +
        "</div>"
    );
  }

  function renderMisub() {
    if (!state.misubMetaLoaded) return C.section("MiSub", "", C.emptyState("正在加载", ""));
    if (!state.misubMeta) {
      return C.section(
        "MiSub",
        "",
        '<p class="callout danger" role="alert">' + C.escapeHtml(state.misubError || "MiSub 读取失败") + "</p>" +
          '<div class="manage-actions"><button type="button" class="secondary" data-misub-retry>重试</button></div>'
      );
    }
    var conn = misubActiveConn();
    if (!conn) return misubConnectCard();
    var config = misubConfig();
    var baseUrl = conn.base_url || config.base_url || "";
    var hint = "当前连接 · " + (conn.name || "未命名连接") + " · " + baseUrl;
    if (!state.misub) {
      if (state.misubSnapshotLoading) return C.section("MiSub", hint, C.emptyState("正在加载", "正在读取 MiSub 数据"));
      if (state.misubError) return misubErrorState(conn, baseUrl, hint);
      return C.section("MiSub", hint, C.emptyState("正在加载", ""));
    }
    if (state.misub.sync && state.misub.sync.never_synced) return C.section("MiSub", hint, misubNeverSyncedHtml());
    if (misubSegment === "all" && !misubAll.loading && !(misubAll.data && misubAll.connId === misubActiveId()) && !misubAll.error) {
      setTimeout(function () { loadMisubAllNodes(); }, 0);
    }
    var body =
      misubSyncBarHtml() +
      misubOverview() +
      '<div class="stack">' +
      misubSegmented() +
      '<div data-misub-list>' + misubList() + "</div>" +
      "</div>";
    if (state.misubError) {
      body =
        '<p class="callout danger" role="alert">' + C.escapeHtml(state.misubError) + "</p>" +
        '<div class="misub-dim">' + body + "</div>";
    }
    return C.section("MiSub", hint, body);
  }

  function misubField(form, name) {
    var input = form.querySelector('[name="' + name + '"]');
    return input ? input.value.trim() : "";
  }

  function setMisubFormError(form, message) {
    var box = form.querySelector("[data-misub-error]");
    if (!box) return;
    box.textContent = message || "";
    box.hidden = !message;
  }

  // MiSub 令牌框默认 readonly：浏览器不会往 readonly 的密码框里自动填充
  // 登录密码；用户第一次聚焦或点按时才解锁为可编辑。
  document.addEventListener("focusin", function (event) {
    var t = event.target;
    if (t && t.matches && t.matches("input[data-misub-token]")) t.removeAttribute("readonly");
  });
  document.addEventListener("pointerdown", function (event) {
    var t = event.target;
    if (t && t.matches && t.matches("input[data-misub-token]")) t.removeAttribute("readonly");
  });

  function testMisubConnection(form, button) {
    var baseUrl = misubField(form, "base_url");
    var token = misubField(form, "token");
    if (!baseUrl) return setMisubFormError(form, "请填写 MiSub 地址");
    if (!token) return setMisubFormError(form, "请填写令牌");
    setMisubFormError(form, "");
    button.disabled = true;
    api("POST", "/api/misub/test", { base_url: baseUrl, token: token })
      .then(function (res) {
        button.disabled = false;
        if (res.data && res.data.ok) {
          C.toast("连接成功");
          return;
        }
        C.toast((res.data && res.data.error) || "连接失败", "danger");
      })
      .catch(function () {
        button.disabled = false;
        C.toast("连接失败", "danger");
      });
  }

  function saveMisubAddForm(form) {
    var baseUrl = misubField(form, "base_url");
    var token = misubField(form, "token");
    if (!baseUrl) return setMisubFormError(form, "请填写 MiSub 地址");
    if (!token) return setMisubFormError(form, "请填写令牌");
    var submit = form.querySelector('button[type="submit"]');
    if (submit && submit.disabled) return;
    setMisubFormError(form, "");
    if (submit) submit.disabled = true;
    api("POST", "/api/misub/connections", {
      name: misubField(form, "name"),
      base_url: baseUrl,
      token: token,
      refresh_enabled: false,
      active: true,
    })
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (submit) submit.disabled = false;
          setMisubFormError(form, (res.data && res.data.error) || "保存失败，请重试");
          return;
        }
        C.toast("已保存并连接");
        state.misub = null;
        state.misubSnapshotLoaded = false;
        state.misubError = "";
        return reloadMisubMeta().then(function () {
          if (activeTab === "proxy") return loadMisubSnapshot(false, true);
        });
      })
      .catch(function () {
        if (submit) submit.disabled = false;
        setMisubFormError(form, "保存失败，请重试");
      });
  }

  function refreshMisubProfile(id, button) {
    if (!id || !button || button.disabled) return;
    button.disabled = true;
    api("POST", "/api/misub/profiles/" + encodeURIComponent(id) + "/refresh")
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (button.isConnected) button.disabled = false;
          C.toast((res.data && res.data.error) || "触发刷新失败", "danger");
          return;
        }
        C.toast("已触发 MiSub 刷新该订阅组");
        return loadMisubSnapshot(false, true);
      })
      .catch(function () {
        if (button.isConnected) button.disabled = false;
        C.toast("触发刷新失败", "danger");
      });
  }

  // ---- 代理服务商设置（MiSub）：仿云主机服务商面板，左列表右详情 ----
  var misubPanelCtrl = null;
  var misubPanelState = null;

  function freshMisubPanelState() {
    return { selectedId: "", notice: null };
  }

  function setMisubPanelNotice(text, isError) {
    if (misubPanelState) misubPanelState.notice = text ? { text: text, error: !!isError } : null;
    var el = misubPanelCtrl && misubPanelCtrl.bodyEl.querySelector("[data-misub-panel-status]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function misubPanelNoticeHtml() {
    var notice = misubPanelState && misubPanelState.notice;
    if (misubPanelState) misubPanelState.notice = null;
    return (
      '<p class="manage-status' + (notice && notice.error ? " is-error" : "") +
      '" data-misub-panel-status role="status">' +
      (notice ? C.escapeHtml(notice.text) : "") +
      "</p>"
    );
  }

  function misubPanelCardsHtml() {
    var conns = misubConnections();
    if (!conns.length) {
      return (
        '<div class="conn-empty">' +
        C.emptyState("还没有代理服务商", "目前支持 MiSub，添加后这里会列出连接") +
        '<button type="button" class="add-button" data-misub-panel-add>添加服务商</button>' +
        "</div>"
      );
    }
    return C.cardList(
      conns
        .map(function (conn) {
          var selected = misubPanelState && misubPanelState.selectedId === conn.id;
          var isActive = conn.id === misubActiveId();
          var tail = conn.token_tail ? "末 4 位 " + C.escapeHtml(conn.token_tail) : "已保存";
          return C.record({
            id: conn.id,
            className: "conn-card" + (selected ? " is-selected" : ""),
            iconHtml: HMIcons.svg("icon-plug", "icon record-icon"),
            title: conn.name || "未命名连接",
            pill: "MiSub",
            corner: isActive
              ? C.badge("当前", "accent")
              : selected
                ? C.badge("已选", "accent")
                : '<span class="conn-pick-hint">查看</span>',
            facts: [
              ["地址", C.escapeHtml(conn.base_url || "—")],
              ["令牌", tail],
              ["最近测试", C.escapeHtml(misubTestSummary(conn))],
            ],
            manage: "misubconn:" + conn.id,
          });
        })
        .join("")
    );
  }

  function misubInfoHtml(conn) {
    var rows = [
      ["服务商", "MiSub"],
      ["地址", copyValueHtml(conn.base_url || "—")],
      ["令牌", conn.token_tail ? "末 4 位 " + C.escapeHtml(conn.token_tail) : "已保存"],
      ["最近测试", C.escapeHtml(misubTestSummary(conn))],
      ["订阅 UA", C.escapeHtml(conn.node_ua || "默认 v2rayN/7.23")],
      ["自动拉取", C.escapeHtml(misubIntervalLabel(conn.auto_interval_hours))],
      ["触发刷新", conn.refresh_enabled ? "已允许" : "未允许"],
      ["创建时间", C.escapeHtml(misubTimeLabel(conn.created_at))],
    ];
    if (conn.last_test_at && !conn.last_test_ok && conn.last_error) {
      rows.push(["失败原因", C.escapeHtml(conn.last_error)]);
    }
    return (
      '<dl class="kv">' +
      rows
        .map(function (pair) {
          return "<div><dt>" + C.escapeHtml(pair[0]) + "</dt><dd>" + pair[1] + "</dd></div>";
        })
        .join("") +
      "</dl>"
    );
  }

  function misubDetailHtml(conn) {
    var cid = C.escapeHtml(conn.id);
    var isActive = conn.id === misubActiveId();
    var tail = conn.token_tail || "—";
    return (
      '<div class="conn-detail">' +
      C.manageInfoHead({
        iconHtml: HMIcons.svg("icon-plug", "icon"),
        title: conn.name || "未命名连接",
        sub: conn.base_url || "",
      }) +
      '<section class="conn-section">' +
      '<h3 class="conn-section-title">连接信息</h3>' +
      misubInfoHtml(conn) +
      '<div class="manage-actions">' +
      (isActive
        ? C.badge("当前连接", "accent")
        : '<button type="button" class="secondary" data-misub-activate="' + cid + '">设为当前连接</button>') +
      "</div>" +
      "</section>" +
      '<section class="conn-section">' +
      '<h3 class="conn-section-title">改名</h3>' +
      '<form data-misub-rename novalidate>' +
      '<label>连接名称<input name="name" maxlength="60" autocomplete="off" value="' +
      C.escapeHtml(conn.name) +
      '" /></label>' +
      '<div class="manage-actions"><button type="submit">保存名称</button></div>' +
      "</form>" +
      "</section>" +
      '<section class="conn-section">' +
      '<h3 class="conn-section-title">接入设置</h3>' +
      '<form data-misub-cred novalidate>' +
      '<label>MiSub 地址<input name="base_url" maxlength="2048" autocomplete="off" value="' +
      C.escapeHtml(conn.base_url || "") +
      '" /></label>' +
      '<label>令牌<input name="token" type="password" maxlength="16384" autocomplete="new-password" data-misub-token="1" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" readonly placeholder="留空不修改（当前末 4 位 ' +
      C.escapeHtml(tail) +
      '）" /></label>' +
      '<label class="misub-check"><input type="checkbox" name="refresh_enabled"' +
      (conn.refresh_enabled ? " checked" : "") +
      " />允许触发刷新（机场订阅与订阅组，会让 MiSub 去拉上游）</label>" +
      misubUaFieldHtml(conn.node_ua) +
      '<p class="subtle">地址或令牌有改动时，保存前会先测试，通过后才替换</p>' +
      '<div class="manage-actions">' +
      '<button type="button" class="secondary" data-misub-test-saved="' + cid + '">测试连接</button>' +
      '<button type="submit">保存凭据</button>' +
      "</div>" +
      "</form>" +
      "</section>" +
      misubFreqSectionHtml(conn) +
      '<div class="manage-actions conn-danger-row">' +
      '<button type="button" class="danger" data-misub-delete="' + cid + '">删除连接</button>' +
      "</div>" +
      "</div>"
    );
  }

  var MISUB_INTERVAL_CHOICES = [1, 3, 6, 12, 24, 48, 72, 168];

  function misubIntervalSelectHtml(subId, current) {
    var opts = [["", "跟随连接"], ["0", "不自动拉取"]].concat(
      MISUB_INTERVAL_CHOICES.map(function (h) { return [String(h), "每 " + h + " 小时"]; })
    );
    var cur = current == null ? "" : String(current);
    if (cur && opts.every(function (o) { return o[0] !== cur; })) opts.push([cur, "每 " + cur + " 小时"]);
    return (
      '<select data-misub-sub-interval="' + C.escapeHtml(subId) + '" aria-label="自动拉取间隔">' +
      opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === cur ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("") +
      "</select>"
    );
  }

  // 拉取频率：连接默认间隔 + 每个机场订阅的覆盖值（只对当前连接列出订阅，数据来自 D1）。
  function misubFreqSectionHtml(conn) {
    var isActive = conn.id === misubActiveId();
    var hours = conn.auto_interval_hours == null ? 6 : conn.auto_interval_hours;
    var subs = isActive && state.misub ? state.misub.subscriptions || [] : [];
    var list = "";
    if (isActive && subs.length) {
      list =
        '<ul class="misub-freq-list">' +
        subs.map(function (sub) {
          return (
            '<li class="misub-freq-row"><span class="misub-freq-name">' + C.escapeHtml(sub.name || "未命名订阅") +
            (sub.enabled === false ? " " + C.badge("已停用", "warn") : "") +
            '<span class="subtle">' + C.escapeHtml(sub.last_fetch_at ? "上次拉取 " + misubAgo(sub.last_fetch_at) + (sub.last_fetch_ok ? "" : "（失败）") : "尚未拉取") +
            "</span></span>" + misubIntervalSelectHtml(sub.id, sub.interval_hours) + "</li>"
          );
        }).join("") +
        "</ul>";
    } else if (isActive) {
      list = '<p class="subtle">同步一次后，这里会列出机场订阅，可以单独设置间隔</p>';
    } else {
      list = '<p class="subtle">设为当前连接后可以单独设置每个机场订阅的间隔</p>';
    }
    return (
      '<section class="conn-section">' +
      '<h3 class="conn-section-title">拉取频率</h3>' +
      '<form data-misub-freq novalidate>' +
      '<label>自动拉取间隔（小时）<input name="auto_interval_hours" type="number" inputmode="numeric" min="0" max="168" step="1" value="' +
      C.escapeHtml(String(hours)) + '" /></label>' +
      '<p class="subtle">每小时的定时任务检查一次，到期才访问 MiSub 和机场；填 0 关闭自动拉取。手动同步有 5 分钟冷却。每次定时任务最多拉 16 个，订阅多时分几个小时轮完</p>' +
      '<div class="manage-actions"><button type="submit">保存间隔</button></div>' +
      "</form>" +
      '<h4 class="misub-freq-title">单个机场订阅</h4>' +
      list +
      "</section>"
    );
  }

  function submitMisubFreq(form) {
    if (!misubPanelState || !misubPanelState.selectedId) return;
    var raw = misubField(form, "auto_interval_hours");
    var hours = Number(raw);
    if (raw === "" || !Number.isInteger(hours) || hours < 0 || hours > 168) {
      setMisubPanelNotice("间隔要填 0 到 168 之间的整数", true);
      return;
    }
    var button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    api("PATCH", "/api/misub/connections/" + encodeURIComponent(misubPanelState.selectedId), { auto_interval_hours: hours })
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (button && button.isConnected) button.disabled = false;
          setMisubPanelNotice((res.data && res.data.error) || "保存失败，请重试", true);
          return;
        }
        return reloadMisubMeta().then(function () {
          setMisubPanelNotice(hours > 0 ? "自动拉取改为每 " + hours + " 小时" : "已关闭自动拉取", false);
          if (activeTab === "proxy") return loadMisubSnapshot(false, true);
        });
      })
      .catch(function () {
        if (button && button.isConnected) button.disabled = false;
        setMisubPanelNotice("网络异常，请重试", true);
      });
  }

  function saveMisubSubInterval(select) {
    var subId = select.getAttribute("data-misub-sub-interval");
    var value = select.value;
    select.disabled = true;
    api("PATCH", "/api/misub/subscriptions/" + encodeURIComponent(subId) + "/interval", { interval_hours: value === "" ? null : Number(value) })
      .then(function (res) {
        if (select.isConnected) select.disabled = false;
        if (!res.data || !res.data.ok) {
          setMisubPanelNotice((res.data && res.data.error) || "保存失败，请重试", true);
          return;
        }
        setMisubPanelNotice("已保存", false);
        loadMisubSnapshot(false, true);
      })
      .catch(function () {
        if (select.isConnected) select.disabled = false;
        setMisubPanelNotice("网络异常，请重试", true);
      });
  }

  function misubPanelHtml() {
    var conns = misubConnections();
    var selected = null;
    if (misubPanelState) {
      if (misubPanelState.selectedId) {
        selected = findMisubConn(misubPanelState.selectedId);
        if (!selected) misubPanelState.selectedId = "";
      }
      if (!selected && conns.length) {
        selected = conns[0];
        misubPanelState.selectedId = selected.id;
      }
    }
    return (
      misubPanelNoticeHtml() +
      '<div class="conn-admin' + (selected ? " has-detail" : "") + '">' +
      '<div class="conn-list">' + misubPanelCardsHtml() + "</div>" +
      (selected ? misubDetailHtml(selected) : "") +
      "</div>"
    );
  }

  function paintMisubPanel() {
    if (!misubPanelCtrl) return;
    var slot = misubPanelCtrl.bodyEl.querySelector("[data-misub-panel]");
    if (!slot) return;
    slot.innerHTML = misubPanelHtml();
  }

  function openMisubPanel() {
    misubPanelState = freshMisubPanelState();
    misubPanelState.selectedId = misubActiveId() || "";
    if (!misubPanelState.selectedId && misubConnections().length) misubPanelState.selectedId = misubConnections()[0].id;
    misubPanelCtrl = C.openManageDialog({
      title: "服务商设置",
      size: "lg",
      bodyHtml: '<div data-misub-panel></div>',
    });
    paintMisubPanel();
    misubPanelCtrl.dialog.addEventListener("click", handleMisubPanelClick);
    misubPanelCtrl.dialog.addEventListener("submit", handleMisubPanelSubmit);
    misubPanelCtrl.dialog.addEventListener("change", function (event) {
      var t = event.target;
      if (t instanceof HTMLSelectElement && t.hasAttribute("data-misub-sub-interval")) saveMisubSubInterval(t);
    });
  }

  function selectMisubConnection(id) {
    if (!misubPanelState || !findMisubConn(id)) return;
    if (misubPanelState.selectedId === id) return;
    misubPanelState.selectedId = id;
    misubPanelState.notice = null;
    paintMisubPanel();
  }

  function activateMisubConnection(id, button) {
    if (!id || (button && button.disabled)) return;
    if (button) button.disabled = true;
    api("POST", "/api/misub/connections/" + encodeURIComponent(id) + "/activate")
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (button && button.isConnected) button.disabled = false;
          setMisubPanelNotice((res.data && res.data.error) || "设为当前失败", true);
          return;
        }
        state.misub = null;
        state.misubSnapshotLoaded = false;
        state.misubError = "";
        return reloadMisubMeta().then(function () {
          setMisubPanelNotice("已设为当前连接", false);
          if (activeTab === "proxy") return loadMisubSnapshot(false, true);
        });
      })
      .catch(function () {
        if (button && button.isConnected) button.disabled = false;
        setMisubPanelNotice("网络异常，请重试", true);
      });
  }

  function testMisubSaved(id, button) {
    var conn = findMisubConn(id);
    if (!conn) return;
    var form = misubPanelCtrl && misubPanelCtrl.bodyEl.querySelector("form[data-misub-cred]");
    if (form) {
      var baseUrl = misubField(form, "base_url");
      var token = misubField(form, "token");
      if ((baseUrl && baseUrl !== (conn.base_url || "")) || token) {
        setMisubPanelNotice("凭据有修改，请先保存再测试", true);
        return;
      }
    }
    if (button) {
      button.disabled = true;
      button.textContent = "测试中…";
    }
    api("POST", "/api/misub/connections/" + encodeURIComponent(id) + "/test")
      .then(function (res) {
        var data = res.data || {};
        var failed = !data.ok || (data.connection && data.connection.last_test_ok === false);
        var text = failed
          ? (data.error || (data.connection && data.connection.last_error) || "连接失败")
          : "测试成功";
        return reloadMisubMeta().then(function () {
          setMisubPanelNotice(text, failed);
        });
      })
      .catch(function () {
        if (button && button.isConnected) {
          button.disabled = false;
          button.textContent = "测试连接";
        }
        setMisubPanelNotice("网络异常，请重试", true);
      });
  }

  function deleteMisubConnection(conn, anchor) {
    var mount = misubPanelCtrl && misubPanelCtrl.dialog.open && misubPanelCtrl.confirmSlot ? misubPanelCtrl.confirmSlot : anchor;
    C.askConfirm({
      anchor: mount,
      title: "删除连接",
      text: "确认删除服务商连接「" + (conn.name || "未命名连接") + "」吗？地址与令牌会被删除，MiSub 里的数据不受影响",
      confirmLabel: "删除连接",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/misub/connections/" + encodeURIComponent(conn.id))
        .then(function (res) {
          if (!res.data || !res.data.ok) {
            setMisubPanelNotice((res.data && res.data.error) || "删除失败，请重试", true);
            return;
          }
          if (misubPanelState) misubPanelState.selectedId = "";
          return reloadMisubMeta().then(function () {
            setMisubPanelNotice("连接已删除", false);
            if (activeTab === "proxy" && misubActiveConn()) return loadMisubSnapshot(false, true);
          });
        })
        .catch(function () {
          setMisubPanelNotice("网络异常，请重试", true);
        });
    });
  }

  function submitMisubRename(form) {
    if (!misubPanelState || !misubPanelState.selectedId) return;
    var name = misubField(form, "name");
    if (!name) {
      setMisubPanelNotice("请填写连接名称", true);
      return;
    }
    if (Array.from(name).length > 60) {
      setMisubPanelNotice("名称最多 60 个字", true);
      return;
    }
    var button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    api("PATCH", "/api/misub/connections/" + encodeURIComponent(misubPanelState.selectedId), { name: name })
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (button && button.isConnected) button.disabled = false;
          setMisubPanelNotice((res.data && res.data.error) || "保存失败，请重试", true);
          return;
        }
        return reloadMisubMeta().then(function () {
          setMisubPanelNotice("名称已保存", false);
        });
      })
      .catch(function () {
        if (button && button.isConnected) button.disabled = false;
        setMisubPanelNotice("网络异常，请重试", true);
      });
  }

  function submitMisubCredentials(form) {
    if (!misubPanelState || !misubPanelState.selectedId) return;
    var conn = findMisubConn(misubPanelState.selectedId);
    if (!conn) return;
    var baseUrl = misubField(form, "base_url");
    if (!baseUrl) {
      setMisubPanelNotice("请填写 MiSub 地址", true);
      return;
    }
    var token = misubField(form, "token");
    var refreshInput = form.querySelector('[name="refresh_enabled"]');
    var body = {
      base_url: baseUrl,
      refresh_enabled: !!(refreshInput && refreshInput.checked),
      node_ua: misubField(form, "node_ua"),
    };
    if (token) body.token = token;
    var wasActive = conn.id === misubActiveId();
    var button = form.querySelector('[type="submit"]');
    if (button) {
      button.disabled = true;
      button.textContent = "正在验证…";
    }
    api("PATCH", "/api/misub/connections/" + encodeURIComponent(conn.id), body)
      .then(function (res) {
        if (!res.data || !res.data.ok) {
          if (button && button.isConnected) {
            button.disabled = false;
            button.textContent = "保存凭据";
          }
          setMisubPanelNotice((res.data && res.data.error) || "保存失败，请重试", true);
          return;
        }
        return reloadMisubMeta().then(function () {
          setMisubPanelNotice("凭据已保存", false);
          if (wasActive) resetMisubAll();
          if (wasActive && activeTab === "proxy") {
            state.misub = null;
            state.misubSnapshotLoaded = false;
            state.misubError = "";
            return loadMisubSnapshot(false, true);
          }
        });
      })
      .catch(function () {
        if (button && button.isConnected) {
          button.disabled = false;
          button.textContent = "保存凭据";
        }
        setMisubPanelNotice("网络异常，请重试", true);
      });
  }

  function handleMisubPanelSubmit(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute("data-misub-rename")) {
      event.preventDefault();
      submitMisubRename(form);
      return;
    }
    if (form.hasAttribute("data-misub-cred")) {
      event.preventDefault();
      submitMisubCredentials(form);
      return;
    }
    if (form.hasAttribute("data-misub-freq")) {
      event.preventDefault();
      submitMisubFreq(form);
    }
  }

  function handleMisubPanelClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var zone = target.closest("[data-manage]");
    if (zone && !target.closest("button, a, input, select, textarea")) {
      var key = zone.getAttribute("data-manage") || "";
      if (key.indexOf("misubconn:") === 0) {
        selectMisubConnection(key.slice("misubconn:".length));
        return;
      }
    }
    var add = target.closest("[data-misub-panel-add]");
    if (add) {
      openMisubAddDialog();
      return;
    }
    var activate = target.closest("[data-misub-activate]");
    if (activate && !activate.disabled) {
      activateMisubConnection(activate.getAttribute("data-misub-activate"), activate);
      return;
    }
    var testBtn = target.closest("[data-misub-test-saved]");
    if (testBtn && !testBtn.disabled) {
      testMisubSaved(testBtn.getAttribute("data-misub-test-saved"), testBtn);
      return;
    }
    var del = target.closest("[data-misub-delete]");
    if (del && !del.disabled) {
      var conn = findMisubConn(del.getAttribute("data-misub-delete"));
      if (conn) deleteMisubConnection(conn, del);
    }
  }

  function openMisubAddDialog() {
    var vaultOn = misubVaultState() === "on";
    var warning = vaultOn ? "" : '<p class="callout danger" role="alert">保险库未配置，暂时不能保存 MiSub 令牌</p>';
    var ctrl = C.openFormDialog({
      title: "添加代理服务商 · MiSub",
      bodyHtml:
        warning +
        '<label>连接名称（选填）<input name="name" maxlength="60" autocomplete="off" placeholder="留空按地址自动命名" /></label>' +
        '<label>MiSub 地址<input name="base_url" maxlength="2048" autocomplete="off" placeholder="https://你的 MiSub 域名" /></label>' +
        '<label>令牌<input name="token" type="password" maxlength="16384" autocomplete="new-password" data-misub-token="1" data-1p-ignore="true" data-lpignore="true" data-bwignore="true" readonly placeholder="在 MiSub 系统设置里创建的令牌" /></label>' +
        misubUaFieldHtml("") +
        '<label>自动拉取间隔（小时）<input name="auto_interval_hours" type="number" inputmode="numeric" min="0" max="168" step="1" value="6" /></label>' +
        misubTokenHelpHtml() +
        '<label class="misub-check"><input type="checkbox" name="set_active" checked />保存后设为当前连接</label>',
      actionsLeftHtml:
        '<button type="button" class="secondary" data-misub-add-test' + (vaultOn ? "" : " disabled") + '>测试连接</button>',
      submitLabel: "保存",
      onSubmit: function (c) {
        if (!vaultOn) {
          c.setError("保险库未配置，暂时不能保存 MiSub 令牌");
          return;
        }
        var baseUrl = misubField(c.form, "base_url");
        var token = misubField(c.form, "token");
        if (!baseUrl) {
          c.setError("请填写 MiSub 地址");
          return;
        }
        if (!token) {
          c.setError("请填写令牌");
          return;
        }
        var activeInput = c.form.querySelector('[name="set_active"]');
        var makeActive = activeInput ? activeInput.checked : true;
        c.setBusy(true);
        api("POST", "/api/misub/connections", {
          name: misubField(c.form, "name"),
          base_url: baseUrl,
          token: token,
          refresh_enabled: false,
          active: makeActive,
          node_ua: misubField(c.form, "node_ua"),
          auto_interval_hours: misubField(c.form, "auto_interval_hours") === "" ? 6 : Number(misubField(c.form, "auto_interval_hours")),
        })
          .then(function (res) {
            c.setBusy(false);
            if (!res.data || !res.data.ok) {
              c.setError((res.data && res.data.error) || "保存失败，请重试");
              return;
            }
            var created = res.data.connection;
            c.close();
            if (makeActive) {
              state.misub = null;
              state.misubSnapshotLoaded = false;
              state.misubError = "";
            }
            return reloadMisubMeta().then(function () {
              if (misubPanelCtrl && misubPanelCtrl.dialog.open && misubPanelState) {
                if (created && findMisubConn(created.id)) misubPanelState.selectedId = created.id;
                paintMisubPanel();
              }
              if (makeActive && activeTab === "proxy") return loadMisubSnapshot(false, true);
            });
          })
          .catch(function () {
            c.setBusy(false);
            c.setError("网络异常，请重试");
          });
      },
    });
    ctrl.dialog.addEventListener("click", function (event) {
      var target = event.target instanceof Element ? event.target.closest("[data-misub-add-test]") : null;
      if (!target || target.disabled) return;
      testMisubConnection(ctrl.form, target);
    });
  }

  var page = document.getElementById("page");
  page.addEventListener("click", handleClick);
  page.addEventListener("submit", handleSubmit);
  page.addEventListener("input", function (event) {
    var t = event.target;
    if (!(t instanceof Element) || !t.hasAttribute("data-misub-search")) return;
    misubFilter.q = t.value;
    misubShowLimit = MISUB_PAGE;
    updateMisubRows();
  });

  function handleSubmit(event) {
    var form = event.target;
    if (!(form instanceof Element) || !form.hasAttribute("data-misub-add-form")) return;
    event.preventDefault();
    saveMisubAddForm(form);
  }

  function handleClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var tab = target.closest(".page-tab");
    if (tab) {
      activeTab = tab.getAttribute("data-tab");
      history.replaceState(null, "", "#" + activeTab);
      render();
      maybeLoadMisubSnapshot();
      return;
    }
    var misubConnBtn = target.closest("[data-misub-connections]");
    if (misubConnBtn) {
      openMisubPanel();
      return;
    }
    var misubAddBtn = target.closest("[data-misub-add]");
    if (misubAddBtn) {
      openMisubAddDialog();
      return;
    }
    var misubRetry = target.closest("[data-misub-retry]");
    if (misubRetry) {
      if (!state.misubMeta) reloadMisubMeta();
      else loadMisubSnapshot(false, true);
      return;
    }
    var provBtn = target.closest("[data-providers]");
    if (provBtn) return void openProvidersPanel();
    var addGroupBtn = target.closest("[data-add-group]");
    if (addGroupBtn) { openMachineGroupManager(addGroupBtn); return; }
    var add = target.closest("[data-add]");
    if (add) {
      var addKind = add.getAttribute("data-add");
      if (addKind === "server") openServerDialog(null);
      else if (addKind === "host") openCloudWizard();
      else openItemDialog(addKind, null);
      return;
    }
    if (target.closest("[data-copy]")) return;
    var misubTest = target.closest("[data-misub-test]");
    if (misubTest && !misubTest.disabled) {
      var misubForm = misubTest.closest("form");
      if (misubForm) testMisubConnection(misubForm, misubTest);
      return;
    }
    var misubSyncBtn = target.closest("[data-misub-sync]");
    if (misubSyncBtn) {
      misubSyncNow(misubSyncBtn);
      return;
    }
    var misubRefresh = target.closest("[data-msrefresh]");
    if (misubRefresh) {
      refreshMisubProfile(misubRefresh.getAttribute("data-id"), misubRefresh);
      return;
    }
    var misubSeg = target.closest("[data-misub-seg]");
    if (misubSeg) {
      var nextSeg = misubSeg.getAttribute("data-misub-seg") || "all";
      if (nextSeg !== misubSegment) {
        misubSegment = nextSeg;
        misubFilter = { q: "", protocol: "", region: "", source: "" };
        misubShowLimit = MISUB_PAGE;
      }
      updateMisubList();
      if (misubSegment === "all") loadMisubAllNodes();
      return;
    }
    var misubFilterBtn = target.closest("[data-misub-filter]");
    if (misubFilterBtn) {
      misubFilter[misubFilterBtn.getAttribute("data-misub-filter")] = misubFilterBtn.getAttribute("data-value") || "";
      misubShowLimit = MISUB_PAGE;
      updateMisubRows();
      return;
    }
    if (target.closest("[data-misub-more]")) {
      misubShowLimit += MISUB_PAGE;
      updateMisubRows();
      return;
    }
    var msCopy = target.closest("[data-msnode-copy]");
    if (msCopy) return void misubNodeCopy(msCopy);
    var msShow = target.closest("[data-msnode-show]");
    if (msShow) return void misubNodeShow(msShow);
    var msSubNodes = target.closest("[data-mssub-nodes]");
    if (msSubNodes) {
      var subId = msSubNodes.getAttribute("data-mssub-nodes");
      var subItem = null;
      ((state.misub && state.misub.subscriptions) || []).forEach(function (entry) {
        if (entry.id === subId) subItem = entry;
      });
      if (subItem) openMisubSubNodes(subItem);
      return;
    }
    var msSubFetch = target.closest("[data-mssub-fetch]");
    if (msSubFetch) {
      misubFetchSub(msSubFetch.getAttribute("data-mssub-fetch"), msSubFetch);
      return;
    }
    var msSubRefresh = target.closest("[data-mssub-refresh]");
    if (msSubRefresh) {
      refreshMisubSubscription(msSubRefresh.getAttribute("data-mssub-refresh"), msSubRefresh);
      return;
    }
    var connAdd = target.closest("[data-conn-add]");
    if (connAdd) {
      if (connPanelCtrl) connPanelCtrl.close();
      openCloudWizard();
      return;
    }
    var connRetry = target.closest("[data-conn-retry]");
    if (connRetry) {
      if (connPanelState && connPanelState.selectedId) fetchConnDevices(connPanelState.selectedId);
      return;
    }
    var credRetry = target.closest("[data-conn-cred-retry]");
    if (credRetry) {
      retryConnCred(credRetry.getAttribute("data-conn-cred-retry"));
      return;
    }
    var tokenRetry = target.closest("[data-worker-token-retry]");
    if (tokenRetry) {
      retryWorkerToken(tokenRetry.getAttribute("data-worker-token-retry"));
      return;
    }
    var miconBtn = target.closest("[data-micon]");
    if (miconBtn) {
      var miconItem = null;
      state.items.forEach(function (entry) {
        if (entry.id === miconBtn.getAttribute("data-id")) miconItem = entry;
      });
      if (miconItem) openOsIconPicker(miconItem, miconBtn);
      return;
    }
    var importOne = target.closest("[data-conn-import-one]");
    if (importOne) {
      importDevices([importOne.getAttribute("data-conn-import-one")], importOne);
      return;
    }
    var importBatch = target.closest("[data-conn-import]");
    if (importBatch && !importBatch.disabled) {
      var picked = [];
      if (connPanelCtrl) {
        connPanelCtrl.bodyEl.querySelectorAll("[data-conn-device]:checked").forEach(function (box) {
          picked.push(box.getAttribute("data-conn-device"));
        });
      }
      importDevices(picked, importBatch);
      return;
    }
    var zone = target.closest("[data-manage]");
    if (zone && !target.closest("button, a, input, select, textarea")) {
      var manageKey = zone.getAttribute("data-manage") || "";
      if (manageKey.indexOf("provider:") === 0) {
        selectConnection(manageKey.slice("provider:".length));
        return;
      }
      openManage(manageKey);
      return;
    }
    var pwBtn = target.closest("[data-mpower]");
    if (pwBtn && !pwBtn.disabled) return void powerMachine(pwBtn);
    var portsBtn = target.closest("[data-mports]");
    if (portsBtn) return void openPortsDialog(portsBtn.getAttribute("data-id"));
    var keepBtn = target.closest("[data-mkeep]");
    if (keepBtn) return void openKeepaliveDialog(keepBtn.getAttribute("data-id"));
    var syncBtn = event.target.closest("[data-msync]");
    if (syncBtn && !syncBtn.disabled) return void syncMachine(syncBtn);
    var connBtn = target.closest("[data-conn]");
    if (connBtn) {
      var connId = connBtn.getAttribute("data-id");
      var connAct = connBtn.getAttribute("data-conn");
      var conn = null;
      state.connections.forEach(function (entry) { if (entry.id === connId) conn = entry; });
      if (conn) {
        if (connAct === "delete") deleteConnection(conn, connBtn);
        else connectionAction(conn, connAct, connBtn);
      }
      return;
    }
    var wopenBtn = target.closest("[data-wopen]");
    if (wopenBtn) {
      window.open(wopenBtn.getAttribute("data-wopen"), "_blank", "noopener");
      return;
    }
    var mact = target.closest("[data-mact]");
    if (mact) {
      var mkind = mact.getAttribute("data-kind");
      var mid = mact.getAttribute("data-id");
      var found = null;
      state.items.forEach(function (entry) { if (entry.id === mid) found = entry; });
      if (found) {
        var act = mact.getAttribute("data-mact");
        if (act === "probe") probeServer(found, mact);
        else if (act === "reveal") openRevealDialog(found);
        else if (act === "copyconfig") copyServerConfig(found, mact);
        else if (act === "workers") openWorkerPanel(found, "workers");
        else if (act === "snapshots") openSnapshotsDialog(found);
        else if (act === "wcopy") copyWorkerConfig(found, mact);
        else if (act === "wsync") syncWorkerEntry(found, mact);
        else if (act === "group") openGroupMoveDialog(found);
        else if (act === "edit") {
          if (mkind === "server") openServerDialog(found);
          else if (mkind === "host" && found.connection_id) openCloudAliasDialog(found);
          else openItemDialog(mkind, found);
        }
        else if (act === "delete") deleteMachine(mkind, found, mact);
      }
    }
  }
  render();
  load();
})();
