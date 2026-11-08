// Minimal ambient types for the Workers sockets API (the repo type-checks
// without generated worker types, so declare just what ssh-probe uses).
declare module "cloudflare:sockets" {
  export interface SocketAddress {
    hostname: string;
    port: number;
  }
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
  }
  export function connect(address: SocketAddress | string, options?: Record<string, unknown>): Socket;
}
