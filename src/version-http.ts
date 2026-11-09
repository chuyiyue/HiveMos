import type { Env } from "./env";
import { json } from "./http";

export function handleVersionRequest(request: Request, env: Env, path: string): Response | null {
  if (path !== "/api/version") return null;
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  const build = env.BUILD_ID?.trim() || "dev";
  return json({ build });
}
