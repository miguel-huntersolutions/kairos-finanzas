// src/lib (lógica compartida con el repo raíz) importa pg. En Vercel la raíz del proyecto es
// web/ y los tipos de pg no se resuelven desde ../src. Esta declaración mínima lo deja compilar
// (pg se ejecuta desde web/node_modules; en el repo raíz sigue usando sus tipos reales).
declare module 'pg' {
  export interface PoolClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    release(): void;
  }
  export class Pool {
    constructor(opciones?: Record<string, unknown>);
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }
}
