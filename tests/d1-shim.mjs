// 以 Node 內建 node:sqlite 模擬 Cloudflare D1 的 prepare/bind/first/all/run/batch，讓測試執行真正的 SQL。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params.map(p => (p === undefined ? null : p))); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  async run() { return this._run(); }
  _run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare: sql => new Stmt(db, sql),
    // D1 的 batch 是交易：任一敘述失敗即全部回滾。
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map(s => s._run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  };
}
