// Paint the primary nav and the sidebar chrome before the first frame.
// Loaded synchronously at the end of the <aside>, right after registry.js,
// mirroring SMSinBox's sidebar-boot: nav rendering, the account entry mark,
// the collapse button wrap, and the persisted collapsed state are all
// settled before the parser moves past the sidebar, so a refresh never
// reflows the brand row or animates the sidebar width. The collapsed state
// is also set by an inline script in <head> before the stylesheet, so the
// very first style computation already uses the final width.
// shell.js keeps the dynamic features (Agent rail, drawer, theme, account)
// and skips this chrome when the boot flag below is set. Keep the storage
// key, the state attribute, and the rendered markup aligned with
// public/shell.js.
(function () {
  var SIDEBAR_KEY = "hivemos-sidebar";

  window.__HIVEMOS_SIDEBAR_BOOT__ = true;

  function canonicalPath(pathname) {
    var path = pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (path === "/index.html" || path === "/index") return "/";
    if (path.endsWith(".html")) path = path.slice(0, -5);
    return path || "/";
  }

  function iconRef(id) {
    return "/icons.svg#" + id;
  }

  function svgIcon(id) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    var ref = iconRef(id);
    use.setAttribute("href", ref);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "href", ref);
    svg.append(use);
    return svg;
  }

  function renderNav() {
    var nav = document.querySelector(".sidebar-nav");
    if (!nav) return;
    var active = canonicalPath(location.pathname);
    var items = window.HIVEMOS_MODULES || [];
    nav.replaceChildren();
    items.forEach(function (item) {
      if (item.nav === false) return;
      var icon = /^icon-[a-z0-9-]+$/.test(item.icon || "") ? item.icon : "icon-layout";
      var link = document.createElement("a");
      link.href = item.href;
      link.setAttribute("data-nav-key", item.key || "");
      link.title = item.title;
      if (canonicalPath(item.href) === active) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
      var label = document.createElement("span");
      label.className = "nav-label";
      label.textContent = item.title;
      link.append(svgIcon(icon), label);
      nav.append(link);
    });
  }

  function markAccount() {
    var button = document.querySelector(".account-btn");
    if (!button) return;
    var on = canonicalPath(location.pathname) === "/settings";
    button.classList.toggle("active", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  function readCollapsed() {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch (error) {
      return false;
    }
  }

  function applySidebarState(collapsed, persist) {
    document.documentElement.setAttribute("data-sidebar", collapsed ? "collapsed" : "expanded");
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
      } catch (error) {
        // 无存储时只在这次浏览里收起
      }
    }
    var button = document.querySelector(".sidebar-collapse");
    if (!button) return;
    var label = collapsed ? "展开侧栏" : "收起侧栏";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  function injectCollapseButton() {
    var brand = document.querySelector(".sidebar > .brand");
    if (!brand || document.querySelector(".sidebar-collapse")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-collapse ghost icon-btn";
    button.append(svgIcon("icon-chevron-left"));
    button.addEventListener("click", function () {
      var collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
      applySidebarState(!collapsed, true);
    });
    var row = document.createElement("div");
    row.className = "sidebar-brand-row";
    brand.parentNode.insertBefore(row, brand);
    row.append(brand, button);
  }

  renderNav();
  markAccount();
  injectCollapseButton();
  applySidebarState(readCollapsed(), false);
})();
