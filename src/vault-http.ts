// Panel REST for the vault board. Routes sit behind the admin session gate
// (the caller in index.ts has already authenticated); mutations additionally
// pass the cross-site check here, same as memory-http. List responses only
// ever carry the tail of a secret, or smtp_secret_set for a mailbox SMTP
// password. Plaintext leaves through POST /api/vault/reveal, which writes
// an access-log row. The TOTP tab (阶段 1/3/4) follows the same rules: its
// list carries public fields only, live codes come from /codes, and revealing
// a secret goes through reveal (kind=totp) with the same audit row.

import { isCrossSite, json, readJsonLimited, rejectsSensitiveWrite } from "./http";
import { verifyPassword } from "./auth";
import {
  accountPasswordLimited,
  clearAccountPasswordFailures,
  findUserRecordById,
  loginRetryAfterSeconds,
  recordAccountPasswordFailure,
} from "./accounts";
import { prepare } from "./registry";
import { requireAdminUser } from "./session";
import type { Env, WaitCtx } from "./env";
import {
  VaultError,
  createEmail,
  createEntry,
  createGateway,
  createGroup,
  deleteEmail,
  deleteEntry,
  deleteGateway,
  deleteGroup,
  emailPublic,
  entryPublic,
  gatewayPublic,
  groupPublic,
  listAccessLog,
  listEmails,
  listEntries,
  listGateways,
  listGroups,
  newId,
  updateGroup,
  revealSecret,
  updateEmail,
  updateEntry,
  updateGateway,
  vaultKey,
} from "./vault";
import {
  assertVaultKey,
  confirmTotpImport,
  createTotpEntry,
  exportTotpEntries,
  type TotpExportFormat,
  deleteTotpEntry,
  listTotpCodes,
  listTotpEntries,
  previewTotpImport,
  TOTP_MAX_IMPORT_BYTES,
  totpPublic,
  updateTotpEntry,
} from "./vault-totp";
import { logOp, panelActor } from "./oplog";

const MAX_BODY_BYTES = 64 * 1024;

export async function handleVaultRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  try {
    if (path === "/api/vault/entries") return await entries(request, env);
    const entryOne = /^\/api\/vault\/entries\/([A-Za-z0-9_-]+)$/.exec(path);
    if (entryOne && entryOne[1]) return await entryOneHandler(request, env, entryOne[1]);
    if (path === "/api/vault/gateways") return await gateways(request, env);
    const gatewayOne = /^\/api\/vault\/gateways\/([A-Za-z0-9_-]+)$/.exec(path);
    if (gatewayOne && gatewayOne[1]) return await gatewayOneHandler(request, env, gatewayOne[1]);
    if (path === "/api/vault/emails") return await emails(request, env);
    const emailOne = /^\/api\/vault\/emails\/([A-Za-z0-9_-]+)$/.exec(path);
    if (emailOne && emailOne[1]) return await emailOneHandler(request, env, emailOne[1]);
    if (path === "/api/vault/groups") return await groups(request, env);
    const groupOne = /^\/api\/vault\/groups\/([A-Za-z0-9_-]+)$/.exec(path);
    if (groupOne && groupOne[1]) return await groupOneHandler(request, env, groupOne[1]);
    if (path === "/api/vault/reveal") return await reveal(request, env);
    if (path === "/api/vault/access-log") return await accessLog(request, env);
    // 验证码条目。codes 与 future import/export 路由必须排在 :id 正则前面。
    if (path === "/api/vault/totp") return await totpEntries(request, env);
    if (path === "/api/vault/totp/codes") return await totpCodes(request, env);
    // 导入两段式：preview 只解析不改库，confirm 回传预览里的 entries 才落库。
    // 必须排在 :id 正则前面，否则 /import/preview 会被当成条目编号。
    if (path === "/api/vault/totp/import/preview") return await totpImportPreview(request, env);
    if (path === "/api/vault/totp/import/confirm") return await totpImportConfirm(request, env);
    // 导出要重验当前密码，单独一段，不归 :id 正则。
    if (path === "/api/vault/totp/export") return await totpExport(request, env);
    const totpOne = /^\/api\/vault\/totp\/([A-Za-z0-9_-]+)$/.exec(path);
    if (totpOne && totpOne[1]) return await totpOneHandler(request, env, totpOne[1]);
    return null;
  } catch (error) {
    // VaultError may carry machine-readable detail (duplicate id/issuer on a
    // 409, key-state code on a 503); merge it into the error body.
    if (error instanceof VaultError) {
      return json({ ok: false, error: error.message, ...(error.detail ?? {}) }, error.status);
    }
    throw error;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return json({ ok: false, error: "请求体格式不正确" }, 400);
  }
  return parsed.value as Record<string, unknown>;
}

// 导入接口的请求体上限放宽到 512 KB（与解析层一致），其余接口仍是 64 KB。
async function readBodyLimited(request: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonLimited(request, maxBytes);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return json({ ok: false, error: "请求体格式不正确" }, 400);
  }
  return parsed.value as Record<string, unknown>;
}

async function entries(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return json({ ok: true, entries: (await listEntries(env.DB)).map(entryPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createEntry(env.DB, env, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了保险库条目「${created.name}」`,
    });
    return json({ ok: true, entry: entryPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function entryOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateEntry(env.DB, env, id, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "修改",
      targetId: id,
      targetName: updated.name,
      text: `修改了保险库条目「${updated.name}」`,
    });
    return json({ ok: true, entry: entryPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteEntry(env.DB, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "删除",
      targetId: id,
      targetName: deleted.name,
      text: `删除了保险库条目「${deleted.name}」`,
    });
    return json({ ok: true, entry: entryPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function gateways(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return json({ ok: true, gateways: (await listGateways(env.DB)).map(gatewayPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createGateway(env.DB, env, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了模型网关「${created.name}」`,
    });
    return json({ ok: true, gateway: gatewayPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function gatewayOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateGateway(env.DB, env, id, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "修改",
      targetId: id,
      targetName: updated.name,
      text: `修改了模型网关「${updated.name}」`,
    });
    return json({ ok: true, gateway: gatewayPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteGateway(env.DB, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "删除",
      targetId: id,
      targetName: deleted.name,
      text: `删除了模型网关「${deleted.name}」`,
    });
    return json({ ok: true, gateway: gatewayPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function emails(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return json({ ok: true, emails: (await listEmails(env.DB)).map(emailPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createEmail(env.DB, env, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "添加",
      targetId: created.id,
      targetName: created.address,
      text: `添加了发信邮箱「${created.address}」`,
    });
    return json({ ok: true, email: emailPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function emailOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateEmail(env.DB, env, id, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "修改",
      targetId: id,
      targetName: updated.address,
      text: `修改了发信邮箱「${updated.address}」`,
    });
    return json({ ok: true, email: emailPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteEmail(env.DB, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "删除",
      targetId: id,
      targetName: deleted.address,
      text: `删除了发信邮箱「${deleted.address}」`,
    });
    return json({ ok: true, email: emailPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function groups(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return json({ ok: true, groups: (await listGroups(env.DB)).map(groupPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createGroup(env.DB, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了保险库分组「${created.name}」`,
    });
    return json({ ok: true, group: groupPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function groupOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateGroup(env.DB, id, body);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "修改",
      targetId: id,
      targetName: updated.name,
      text: `把保险库分组改名为「${updated.name}」`,
    });
    return json({ ok: true, group: groupPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteGroup(env.DB, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "删除",
      targetId: id,
      targetName: deleted.name,
      text: `删除了保险库分组「${deleted.name}」`,
    });
    return json({ ok: true, group: groupPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function reveal(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const result = await revealSecret(env.DB, env, body, Date.now());
  return json({ ok: true, reveal: result });
}

async function accessLog(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  const rows = await listAccessLog(env.DB, 100);
  return json({
    ok: true,
    access_log: rows.map((row) => ({
      id: row.id,
      target_kind: row.target_kind,
      target_id: row.target_id,
      target_name: row.target_name,
      action: row.action,
      // NULL = 面板操作；MCP 取码（阶段 6）才填 Agent 名。
      actor: row.actor ?? null,
      created_at: row.created_at,
    })),
  });
}

// ---- 验证码（TOTP） ---------------------------------------------------------

function totpLabel(row: { issuer: string; account: string }): string {
  return row.account ? `${row.issuer}（${row.account}）` : row.issuer;
}

async function totpEntries(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    // vaultKeySet 是整页提示用的：未配置 VAULT_KEY 时能列出条目却取不到码。
    const key = vaultKey(env);
    return json({
      ok: true,
      entries: (await listTotpEntries(env.DB)).map(totpPublic),
      vaultKeySet: key.state === "on",
    });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createTotpEntry(env.DB, env, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "添加",
      targetId: created.id,
      targetName: totpLabel(created),
      text: `添加了验证码「${totpLabel(created)}」`,
    });
    return json({ ok: true, entry: totpPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function totpCodes(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  const now = Date.now();
  const entries = await listTotpCodes(env.DB, env, now);
  // json() 已经带 cache-control: no-store：验证码不能被任何缓存留住。
  return json({ ok: true, serverNow: now, entries });
}

// 导入预览：文件内容整段放在 content 里（512 KB 上限与解析层一致），加密
// 导出再带 password。返回 items（逐条口径）+ entries（含密钥，确认时原样
// 回传）。这是唯一会把明文密钥发回浏览器的接口，前提是管理员会话 + 同源；
// json() 自带 no-store。
async function totpImportPreview(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBodyLimited(request, TOTP_MAX_IMPORT_BYTES);
  if (body instanceof Response) return body;
  const content = typeof body["content"] === "string" ? body["content"] : "";
  const password = typeof body["password"] === "string" ? body["password"] : undefined;
  const preview = await previewTotpImport(env.DB, content, password);
  return json({ ok: true, ...preview });
}

async function totpImportConfirm(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBodyLimited(request, TOTP_MAX_IMPORT_BYTES);
  if (body instanceof Response) return body;
  const result = await confirmTotpImport(env.DB, env, body["entries"], Date.now());
  if (result.imported > 0) {
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "导入",
      targetName: "验证码",
      text: `导入了 ${result.imported} 条验证码，跳过 ${result.skipped} 条`,
    });
  }
  return json({ ok: true, imported: result.imported, skipped: result.skipped });
}

async function totpOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateTotpEntry(env.DB, env, id, body, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "修改",
      targetId: id,
      targetName: totpLabel(updated),
      text: `修改了验证码「${totpLabel(updated)}」`,
    });
    return json({ ok: true, entry: totpPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteTotpEntry(env.DB, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "保险库",
      action: "删除",
      targetId: id,
      targetName: totpLabel(deleted),
      text: `删除了验证码「${totpLabel(deleted)}」`,
    });
    return json({ ok: true, entry: totpPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

// ---- 验证码导出 -------------------------------------------------------------

// 导出是敏感动作：面板要求重输当前密码，和登录/改进程共用同一套
// login:account 失败预算（被盗会话不能在这里无限试口令）。

type PasswordCheck = "ok" | "bad" | "limited" | "missing";

async function checkCurrentPassword(env: Env, userId: string, password: string): Promise<PasswordCheck> {
  const now = Date.now();
  if (await accountPasswordLimited(env.DB, userId, now)) return "limited";
  const record = await findUserRecordById(env.DB, userId);
  if (!record) return "missing";
  if (!(await verifyPassword(password, record.password_hash))) {
    await recordAccountPasswordFailure(env.DB, userId, now);
    return "bad";
  }
  await clearAccountPasswordFailures(env.DB, userId, now);
  return "ok";
}

function passwordCheckResponse(status: Exclude<PasswordCheck, "ok">): Response {
  if (status === "limited") {
    return json({ ok: false, error: "尝试过多，请稍后再试" }, 429, {
      "retry-after": String(loginRetryAfterSeconds(Date.now())),
    });
  }
  if (status === "missing") return json({ ok: false, error: "未登录" }, 401);
  return json({ ok: false, error: "当前密码不正确" }, 401);
}

async function totpExport(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readBody(request);
  if (body instanceof Response) return body;

  const currentPassword =
    typeof body["currentPassword"] === "string"
      ? body["currentPassword"]
      : typeof body["current_password"] === "string"
        ? body["current_password"]
        : "";
  if (!currentPassword) return json({ ok: false, error: "请填写当前密码" }, 400);
  if (currentPassword.length > 256) {
    return json({ ok: false, error: "当前密码需要 1 到 256 个字符" }, 400);
  }
  const check = await checkCurrentPassword(env, user.id, currentPassword);
  if (check !== "ok") return passwordCheckResponse(check);

  const scopeValue = body["scope"];
  if (scopeValue !== undefined && scopeValue !== "all" && scopeValue !== "group") {
    return json({ ok: false, error: "导出范围只能是 all 或 group" }, 400);
  }
  const scope: "all" | "group" = scopeValue === "group" ? "group" : "all";
  const groupId = typeof body["group_id"] === "string" && body["group_id"] ? body["group_id"] : null;

  const formatValue = body["format"] === undefined ? "hivemos" : body["format"];
  if (formatValue !== "hivemos" && formatValue !== "aegis" && formatValue !== "otpauth") {
    return json({ ok: false, error: "导出格式只支持 hivemos、aegis、otpauth" }, 400);
  }
  const format = formatValue as TotpExportFormat;
  const encrypt = body["encrypt"] === true || body["encrypt"] === 1 || body["encrypt"] === "true";
  const password = typeof body["password"] === "string" ? body["password"] : null;
  if (encrypt && format !== "hivemos") {
    return json({ ok: false, error: "只有 HiveMos 格式支持口令加密" }, 400);
  }
  if (encrypt && (!password || password.length < 8)) {
    return json({ ok: false, error: "加密口令至少 8 个字符" }, 400);
  }

  const now = Date.now();
  // 先确认 VAULT_KEY 可用再写审计，避免必然失败的导出也留一条“导出”记录。
  assertVaultKey(env);
  await prepare(
    env.DB,
    "INSERT INTO vault_access_log (id, target_kind, target_id, action, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [newId("va"), "totp", scope === "group" ? groupId : "all", "export", null, now],
  ).run();
  const result = await exportTotpEntries(
    env.DB,
    env,
    { scope, groupId, format, encrypt, password },
    now,
  );
  await logOp(env.DB, {
    actor: await panelActor(request, env),
    module: "保险库",
    action: "导出",
    targetName: scope === "group" ? "验证码（分组）" : "验证码（全部）",
    text: `导出了 ${result.count} 条验证码（${format}${encrypt ? "，口令加密" : ""}）`,
  });
  return json({ ok: true, filename: result.filename, content: result.content });
}
