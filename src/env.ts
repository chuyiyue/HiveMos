// Bindings the Worker reads. Kept local so the source type-checks without a
// generated worker-configuration.d.ts or an npm types package.

export interface D1PreparedStatement {
  bind(...values: Array<string | number | null>): D1PreparedStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface Env {
  ASSETS: {
    fetch(input: Request | string): Promise<Response>;
  };
  DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
}
