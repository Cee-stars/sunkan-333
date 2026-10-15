/* 確かめ用の置き場。**cloudflare/worker.mjs をそのまま動かす**。
 *
 * Cloudflare につながなくても、同期の往復（取って・合わせて・返す・
 * 先を越されたときのやり直し）をこの中で確かめられるようにするためのもの。
 * D1 の代わりに、その場かぎりの SQLite を渡す。
 *
 *   node tests/fake-worker.mjs 8600
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const db = new DatabaseSync(':memory:');

/** D1 の口のうち、worker.mjs が使うものだけ真似る */
const DB = {
  exec(sql) { db.exec(sql); return Promise.resolve(); },
  prepare(sql) {
    return {
      bind(...args) {
        return {
          first() {
            const row = db.prepare(sql).get(...args);
            return Promise.resolve(row === undefined ? null : row);
          },
          run() { db.prepare(sql).run(...args); return Promise.resolve({ success: true }); }
        };
      }
    };
  }
};

const port = Number(process.argv[2] || 8600);

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request('http://127.0.0.1:' + port + req.url, {
    method: req.method,
    headers: req.headers,
    body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : body
  });
  const out = await worker.fetch(request, { DB });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log('fake worker on ' + port));
