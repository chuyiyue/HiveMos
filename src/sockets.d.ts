// Minimal ambient types for the Workers sockets API (the repo type-checks
// without generated worker types, so declare just what ssh-probe uses).
declare module "cloudflare:sockets" {
  export interface SocketAddress {
    hostname: string;
    port: number;
  }
  export interface SocketInfo {
    remoteAddress?: string;
    localAddress?: string;
  }
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    readonly opened: Promise<SocketInfo>;
    close(): Promise<void>;
  }
  export function connect(address: SocketAddress | string, options?: Record<string, unknown>): Socket;
}
