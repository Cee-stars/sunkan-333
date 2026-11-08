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

/** 1 回に読ませる長さの上限。無料枠は文字数で減るので、長文は受けない */
const TTS_MAX_CHARS = 400;

/** 前に通った型番。**次からはこれを最初に試す。**
 *  通らない型番を毎回ひとつずつ試すと、そのぶん待たされる（押してから鳴るまでが遅い）。
 *  Worker が入れ替わると忘れるが、そのときはまた探し直すだけで害は無い。 */
let lastGoodTts = null;

/**
 * Workers AI の返事から音の中身を取り出す。
 * 型番によって Response だったり、base64 を持った object だったりする。
 * **ここで形の違いを吸収する**（型番を足すたびに呼ぶ側を直さなくて済むように）。
 */
async function toAudio(got) {
  if (!got) return null;
  if (typeof got.arrayBuffer === 'function') {
    const type = (got.headers && got.headers.get('content-type')) || '';
    if (/json/i.test(type)) {
      let json = null;
      try { json = await got.json(); } catch (e) { return null; }
      return fromBase64(json && (json.audio || (json.result && json.result.audio)));
    }
    const bytes = await got.arrayBuffer();
    if (!bytes || bytes.byteLength < 256) return null;
    return { bytes, type: type || 'audio/mpeg' };
  }
  if (typeof ReadableStream !== 'undefined' && got instanceof ReadableStream) {
    const bytes = await new Response(got).arrayBuffer();
    if (!bytes || bytes.byteLength < 256) return null;
    return { bytes, type: 'audio/mpeg' };
  }
  return fromBase64(got.audio || (got.result && got.result.audio));
}

function fromBase64(b64) {
  if (!b64) return null;
  const bin = atob(String(b64));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  if (arr.byteLength < 256) return null;
  return { bytes: arr, type: 'audio/mpeg' };
}

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

    /* --- 読み上げの音を作る（Workers AI） ---
     * 端末の読み上げより自然な声にするためのもの。**作って返すだけ**で、
     * 置き場は音を預からない（しまうのは端末のほう。同じ文を 2 度作らせない）。
     * 合言葉は上で見ているので、URL を知っただけの人には使えない。
     */
    if (body.op === 'tts') {
      if (!env.AI) {
        return reply({ ok: false,
          error: 'AI がつながっていません（バインディングの変数名を AI にしてください）' }, 500, origin);
      }
      const text = String(body.text || '').trim().slice(0, TTS_MAX_CHARS);
      if (!text) return reply({ ok: false, error: '読む文がありません' }, 400, origin);

      // 型番も引数も、Cloudflare の側で増えたり名前が変わったりする。
      // **通るものが見つかるまで順に試す**（1 つ消えただけで音が出なくなるのを防ぐ）。
      const TRY = [
        ['@cf/deepgram/aura-2-en', { text, encoding: 'mp3' }],
        ['@cf/deepgram/aura-2-en', { text }],
        ['@cf/deepgram/aura-1', { text, encoding: 'mp3' }],
        ['@cf/deepgram/aura-1', { text }],
        ['@cf/myshell-ai/melotts', { prompt: text, lang: 'en' }]
      ];
      // 前に通ったものを先頭へ回す
      const order = lastGoodTts
        ? TRY.slice().sort((a, b) => (b[0] === lastGoodTts ? 1 : 0) - (a[0] === lastGoodTts ? 1 : 0))
        : TRY;

      let why = '';
      for (const [model, input] of order) {
        let out = null;
        try {
          out = await toAudio(await env.AI.run(model, input, { returnRawResponse: true }));
        } catch (e) {
          why = model + ' … ' + String((e && e.message) || e);
          continue;
        }
        if (!out) { why = model + ' … 音が返りませんでした'; continue; }
        lastGoodTts = model;
        return new Response(out.bytes, {
          status: 200,
          headers: Object.assign({
            'Content-Type': out.type,
            'Cache-Control': 'no-store',
            'X-Tts-Model': model
          }, cors(origin))
        });
      }
      return reply({ ok: false, error: '音を作れませんでした（' + why + '）' }, 502, origin);
    }

    return reply({ ok: false, error: '知らない命令です' }, 400, origin);
  }
};
