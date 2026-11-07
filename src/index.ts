// 最小 Worker：/api/health 返回 JSON，其余请求交给 public/ 静态资源。

interface Env {
  ASSETS: {
    fetch(input: Request | string): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/health") {
      return Response.json({ ok: true, service: "hivemos" });
    }
    return env.ASSETS.fetch(request);
  },
};
