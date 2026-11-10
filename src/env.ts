// Bindings the Worker reads. Kept local so the source type-checks without a
// generated worker-configuration.d.ts or an npm types package.

export interface D1PreparedStatement {
  bind(...values: Array<string | number | null>): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results?: T[] } | T[]>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

// Vectorize 绑定的最小接口。本地 dev 没有索引时绑定缺省，所有调用方都必须
// 在缺失时直接降级为纯词法检索。
export interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorizeIndex {
  query(
    vector: number[],
    options?: { topK?: number; returnMetadata?: "none" | "indexed" | "all" },
  ): Promise<{ matches?: VectorizeMatch[] }>;
  upsert(
    vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>,
  ): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface Env {
  ASSETS: {
    fetch(input: Request | string): Promise<Response>;
  };
  DB: D1Database;
  AI?: AiBinding;
  // 记忆向量索引（hivemos-memories）。本地 dev 不绑定，搜索与回填自动降级。
  MEMORY_VECTORS?: VectorizeIndex;
  ADMIN_USERNAME?: string;
  BUILD_ID?: string;
  ADMIN_PASSWORD?: string;
  // Optional Worker var/secret. Blank falls back to the built-in model.
  AI_MODEL?: string;
  // Optional. Seals TOTP secrets. Blank stores them with a plain: prefix.
  CONTENT_KEY?: string;
  // Optional GitHub OAuth secrets. Missing either one hides every GitHub
  // entry point; the system keeps working with password login only.
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export interface WaitCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}
