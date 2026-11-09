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

export interface Env {
  ASSETS: {
    fetch(input: Request | string): Promise<Response>;
  };
  DB: D1Database;
  AI?: AiBinding;
  ADMIN_USERNAME?: string;
  BUILD_ID?: string;
  ADMIN_PASSWORD?: string;
  // Optional Worker var/secret. Blank falls back to the built-in model.
  AI_MODEL?: string;
  // Optional. Seals TOTP secrets. Blank stores them with a plain: prefix.
  CONTENT_KEY?: string;
}

export interface WaitCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}
