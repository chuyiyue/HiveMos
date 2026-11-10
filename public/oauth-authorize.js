// 应用授权页脚本（oauth-http.ts 服务端渲染的页面数据挂在
// window.__OAUTH_PAGE__ 上）。
//
// 只有一条路：管理员在授权页填应用名、勾一整张权限矩阵（普通域 +
// 高级域，全部可勾、无上限不灰化），勾选的就是应用最终的权限。批准
// 后把应用名与权限快照随授权码签发，客户端兑换时才建应用。
// 拒绝则按 OAuth 规范回跳客户端并带 error=access_denied。
(() => {
  const page = window.__OAUTH_PAGE__ || {};
  const appNameInput = document.getElementById("appName");
  const matrixEl = document.getElementById("permMatrix");
  const msgEl = document.getElementById("msg");
  const allowBtn = document.getElementById("allowBtn");
  const denyBtn = document.getElementById("denyBtn");

  const DOMAIN_LABELS = {
    mcp: "MCP",
    skills: "技能",
    api: "API 注册表",
    memory: "记忆",
    soul: "Soul",
    tasks: "任务",
    calendar: "日历",
    vault: "保险库",
    machines: "云计算资源",
  };
  const ADV_LABELS = {
    agents_other: "操作其他 Agent",
    soul_other: "操作其他 Soul",
    totp: "操作2FA",
  };
  const domains = (page.domains || []).map((entry) => entry.key).filter(Boolean);
  const advancedKeys = (page.advanced || []).map((entry) => entry.key).filter(Boolean);

  function emptyPerms() {
    const perms = {};
    for (const key of domains) perms[key] = { read: false, write: false };
    perms.advanced = {};
    for (const key of advancedKeys) perms.advanced[key] = { read: false, write: false };
    return perms;
  }
  const grants = emptyPerms();

  function esc(text) {
    return String(text == null ? "" : text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  // 渲染一整张矩阵：普通域在前、高级域在后，全是同一种勾选框，没有
  // 只读灰化和上限钳制——管理员勾什么，应用就是什么权限。
  function matrixHtml() {
    let html = "";
    html += "<div class=\"oauth-matrix\">";
    html += "<span class=\"mhead mname\">功能</span><span class=\"mhead\">读取</span><span class=\"mhead\">写入</span>";
    for (const key of domains) {
      html +=
        "<span>" + esc(DOMAIN_LABELS[key] || key) + "</span>" +
        "<label><input type=\"checkbox\" data-m=\"conn\" data-key=\"" + esc(key) + "\" data-op=\"read\"></label>" +
        "<label><input type=\"checkbox\" data-m=\"conn\" data-key=\"" + esc(key) + "\" data-op=\"write\"></label>";
    }
    html += "</div>";
    if (advancedKeys.length) {
      html += "<div style=\"font-weight:700;margin:14px 0 6px\">高级权限</div>";
      html += "<div class=\"oauth-matrix\">";
      html += "<span class=\"mhead mname\">功能</span><span class=\"mhead\">读取</span><span class=\"mhead\">写入</span>";
      for (const key of advancedKeys) {
        html +=
          "<span>" + esc(ADV_LABELS[key] || key) + "</span>" +
          "<label><input type=\"checkbox\" data-m=\"conn-adv\" data-key=\"" + esc(key) + "\" data-op=\"read\"></label>" +
          "<label><input type=\"checkbox\" data-m=\"conn-adv\" data-key=\"" + esc(key) + "\" data-op=\"write\"></label>";
      }
      html += "</div>";
    }
    return html;
  }
  if (matrixEl) matrixEl.innerHTML = matrixHtml();
  if (appNameInput) appNameInput.value = page.appName || "";

  function syncMatrix() {
    for (const box of document.querySelectorAll("#permMatrix input[type=checkbox]")) {
      const branch = box.getAttribute("data-m") === "conn-adv" ? grants.advanced : grants;
      box.checked = !!(branch[box.getAttribute("data-key")] || {})[box.getAttribute("data-op")];
    }
  }
  syncMatrix();

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || target.tagName !== "INPUT") return;
    const mode = target.getAttribute("data-m");
    if (mode === "conn" || mode === "conn-adv") {
      const branch = mode === "conn-adv" ? grants.advanced : grants;
      const key = target.getAttribute("data-key");
      const op = target.getAttribute("data-op");
      if (branch[key]) branch[key][op] = !!target.checked;
      return;
    }
  });

  function setMsg(text) {
    if (msgEl) msgEl.textContent = text || "";
  }

  function redirectBack(params) {
    const target = new URL(page.params.redirect_uri);
    for (const [key, value] of Object.entries(params)) {
      if (value) target.searchParams.set(key, value);
    }
    window.location.href = target.toString();
  }

  denyBtn.addEventListener("click", () => {
    redirectBack({ error: "access_denied", error_description: "管理员拒绝了这次授权", state: page.params.state });
  });

  allowBtn.addEventListener("click", async () => {
    allowBtn.disabled = true;
    setMsg("正在提交…");
    try {
      const response = await fetch("/oauth/authorize", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: page.params.client_id,
          redirect_uri: page.params.redirect_uri,
          state: page.params.state,
          code_challenge: page.params.code_challenge,
          code_challenge_method: page.params.code_challenge_method,
          app_name: appNameInput ? appNameInput.value.trim() : "",
          grants,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || !payload.ok || !payload.redirect) {
        setMsg((payload && payload.error) || "提交失败，请重试");
        allowBtn.disabled = false;
        return;
      }
      window.location.href = payload.redirect;
    } catch {
      setMsg("网络错误，请重试");
      allowBtn.disabled = false;
    }
  });
})();
