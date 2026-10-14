/* Instant English — 同期の置き場（Cloudflare Worker）
 *
 * 役目はひとつだけ。**合言葉ごとに JSON を 1 つ預かって返す**。
 * 中身は一切解釈しない（マージは端末側の sync.js がやる）。
 *
 * 置き方（npm もビルドも要らない）:
 *   1. Cloudflare の管理画面 → Workers & Pages → 作った Worker → 「コードの編集」
 *   2. このファイルの中身をまるごと貼り付けて保存＋デプロイ
 *   3. 設定 → バインディング → D1 データベースを追加し、変数名を **DB** にする
 *
 * 表は最初の 1 回で勝手に作られる（CREATE TABLE IF NOT EXISTS）。
 *
 * なぜ KV ではなく D1 か:
 *   KV は書いたものが世界中に行き渡るまで少し遅れることがある。
 *   Mac で同期した直後に iPhone で開くと古いものが返り、
 *   「同期したのに反映されない」に見える。D1 は書いた直後から正しく読める。
 *
 * なぜ合言葉を URL ではなく本文で送るか:
 *   URL は記録に残りやすい。合言葉はこの仕組みの唯一の鍵なので、本文で送る。
 */

/** アプリを置いている場所。ここ以外のサイトからは使わせない */
const ALLOWED = [
  'https://cee-stars.github.io',
  'http://127.0.0.1:8599',   // 手元で確かめるとき
  'http://localhost:8599'
];

/** 1 人ぶんの上限。これを超えるなら、そもそも同期ではなく書き出しを使うべき */
const MAX_BYTES = 1024 * 1024;

/** 合言葉の形。短いと総当たりで覗かれる */
const CODE_OK = /^[a-z0-9-]{16,64}$/;

function cors(origin) {
  const allow = ALLOWED.indexOf(origin) >= 0 ? origin : ALLOWED[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors(origin))
  });
}

async function ready(db) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)'
  );
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (request.method !== 'POST') {
      // 人が URL を直接開いたとき用。何なのかが分かるようにしておく
      return new Response('Instant English の同期の置き場です。アプリから使ってください。', {
        status: 405,
        headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, cors(origin))
      });
    }
    if (!env.DB) {
      return reply({ ok: false, error: 'D1 がつながっていません（変数名を DB にしてください）' }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return reply({ ok: false, error: '読めない中身でした' }, 400, origin);
    }

    const code = String((body && body.room) || '');
    if (!CODE_OK.test(code)) {
      return reply({ ok: false, error: '合言葉の形が違います' }, 400, origin);
    }

    await ready(env.DB);

    /* --- 読む --- */
    if (body.op === 'get') {
      const row = await env.DB
        .prepare('SELECT data, updated FROM rooms WHERE code = ?')
        .bind(code)
        .first();
      if (!row) return reply({ ok: true, found: false, updated: 0 }, 200, origin);
      return reply({ ok: true, found: true, updated: row.updated, data: JSON.parse(row.data) }, 200, origin);
    }

    /* --- 書く --- */
    if (body.op === 'put') {
      const text = JSON.stringify(body.data === undefined ? null : body.data);
      if (text.length > MAX_BYTES) {
        return reply({ ok: false, error: '大きすぎます（1MB まで）' }, 413, origin);
      }

      // 取ったときから変わっていないかを見る。**これが無いと、2 台が
      // ほぼ同時に書いたとき、あとから書いたほうが相手のぶんを消す。**
      const seen = Number(body.seen) || 0;
      const now = Date.now();
      const cur = await env.DB
        .prepare('SELECT updated FROM rooms WHERE code = ?')
        .bind(code)
        .first();

      if (cur && Number(cur.updated) !== seen) {
        // 先を越されている。端末側で取り直して合わせ直してもらう
        return reply({ ok: false, stale: true, updated: Number(cur.updated) }, 409, origin);
      }

      await env.DB
        .prepare('INSERT INTO rooms (code, data, updated) VALUES (?, ?, ?)'
               + ' ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated = excluded.updated')
        .bind(code, text, now)
        .run();

      return reply({ ok: true, updated: now }, 200, origin);
    }

    return reply({ ok: false, error: '知らない命令です' }, 400, origin);
  }
};
