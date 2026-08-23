# 実装のとりきめ（CONTRACT）

`index.html` が DOM の唯一の正。CSS と JS はこのファイルの取り決めに従う。

## ファイル分担

| ファイル | 担当 | 内容 |
| --- | --- | --- |
| `index.html` | 共通 | DOM 構造・ID・クラス名の定義（変更しない） |
| `assets/style.css` | A | 全スタイル（iPhone / MacBook 対応、ライト/ダーク） |
| `assets/data.js` | B | 例文データ `window.SUNKAN_DECKS` |
| `assets/app.js` | C | 瞬間英作文の動作すべて（描画・隠す/表示・検索・取り込み・保存） |
| `assets/paraphrase.js` | D | パラフレ帳の動作すべて＋モード切り替え |
| `assets/inbox.js` | E | 受信箱（同じドメインの別アプリから届いたカードの取り込み） |
| `assets/sync.js` | F | 端末どうしの同期（GitHub のシークレット Gist 経由） |

`app.js` と `paraphrase.js` と `inbox.js` は状態も保存先も共有しない。触れ合うのは
`<html data-mode>` と下の `window.SUNKAN_DRILL` だけで、`app.js` は `data-mode="para"` の間
キー操作を受け取らない（表が画面に無いため）。`inbox.js` は自分の帯（`#inbox-bar`）と
`sunkan:inbox` しか触らず、文を足すのは `SUNKAN_DRILL.addSentences` 越しに限る。
`sync.js` は保存データを直に読み書きするが、**書いたあとは必ず `reload()` を呼んで画面を追いつかせる**
（自分では DOM を作らない）。

### `window.SUNKAN_DRILL`（app.js が開けている口。ここ以外から中身を触らせない）

| 関数 | 内容 |
| --- | --- |
| `addSentences(deckName, items)` | 名前でセットを探し（無ければ作って開き）、`{ja,en,note}` を足す。戻り値は `{added, skipped, deckId, deckName}`。足し方は「＋追加」と同じ（`sunkan:added` 行き）なので元データは無傷 |
| `splitTable(text)` | 貼り付けテキストを行×列に割る（TSV / CSV 自動判定）。戻り値は `{rows, delimiter}` |
| `copyText(text, done)` | クリップボードへ。非同期なので結果は `done(ok)` で返す |
| `reload()` | localStorage を読み直して表を作り直す。同期が中身を入れ替えたあとに呼ぶ。開いていたセットは、まだ在ればそのまま |

### `window.SUNKAN_PARA`（paraphrase.js が開けている口）

| 関数 | 内容 |
| --- | --- |
| `reload()` | localStorage を読み直してパラフレ帳を作り直す。見ていたジャンルが消えていたら「すべて」へ戻す |

### `window.SUNKAN_SYNC`（sync.js が開けている口）

消したものが同期で戻ってこないよう、**削除は必ずここへ知らせる**。sync.js が読み込まれて
いなければ何もしないので、呼ぶ側は毎回 `typeof` で確かめてから呼ぶ。

| 関数 | 内容 |
| --- | --- |
| `recordDelete(key)` | 消したことを覚える |
| `clearDelete(key)` | 同じものを足し直したことを覚える（記録は消さず、足し直した時刻を入れる） |
| `addedKey(deckId, ja, en)` | 足した 1 文の鍵。作り方を 1 か所にそろえるためここで配る |

鍵の形は `deck:<deckId>` / `card:<cardId>` / `genre:<genreId>` /
`added:<deckId>\n<ja>\n<en>` の 4 つ。

## データ形式（`assets/data.js`）

```js
window.SUNKAN_DECKS = [
  {
    id: 'basic-1',              // 一意な文字列（英数字とハイフン）
    name: '基本の形 100',        // <select> に出る名前
    description: 'be動詞・一般動詞の肯定/否定/疑問',
    items: [
      { ja: '私は学生です。', en: 'I am a student.', note: '' },
      // note は任意。空文字でよい。
    ]
  },
];
```

- `items` の順番がそのまま初期表示順。
- `id` は localStorage のキーに使うので変更しない。

## 状態を表すクラス / 属性（JS が付け外し、CSS が見た目を担当）

### `<html>` 要素
| 属性 | 値 | 意味 |
| --- | --- | --- |
| `data-mask` | `blur` / `block` / `hidden` | 隠し方 |
| `data-font` | `0`〜`4` | 文字サイズ（2 が標準） |
| `data-direction` | `ja-en` / `en-ja` | `en-ja` のときは日本語側を隠す |
| `data-mode` | `drill` / `para` | 開いているモード（瞬間英作文 / パラフレ帳） |
| `data-para-mask` | `on` / `off` | パラフレ帳で言い換えを伏せているか |

`data-mode` は `<head>` の小さなインラインスクリプトが描画前に付ける。
あとから付けると、開いた瞬間にもう片方の画面が一瞬見えてしまう。
`data-font` はどちらのモードにも効く（パラフレの文字も同じ変数で伸び縮みする）。

### `<li class="row">`
| クラス / 属性 | 意味 |
| --- | --- |
| `is-revealed` | この行の答えが表示されている |
| `is-current` | キーボード操作の現在行（デスクトップのフォーカス表示） |
| `is-starred` | ★が付いている |
| `hidden` 属性 | 検索・絞り込みで非表示 |
| `.row-main[aria-expanded]` | `true` / `false` で表示状態を持つ |

### メモ（`note`）
`items[].note` があるとき、JS が `.cell--ja` の中に `<small class="note">` を足す。
**答えのヒントそのものなので、`.row.is-revealed` のときだけ表示する**（伏せている間に見えると意味がない）。
同じ理由で、行に `title` 属性は付けない（ホバーでツールチップが出て答えが割れるため）。

### その他
- `#btn-toggle-all[aria-pressed="true"]` … 現在「全部隠れている」状態。ラベルは `#btn-toggle-all-label` の文字列を JS が書き換える（`英語を表示` / `英語を隠す`）。
- `#empty-state` … 該当 0 件のとき `hidden` を外す。
- `#status-bar` … 「全 120 文 / 表示中 38 文」のような文言を JS が入れる。空文字のこともある。
- `#inbox-bar` … 別アプリから届いたカードがあるときだけ `hidden` を外す。中の `#inbox-actions` は
  取り込み結果を出している間だけ畳む（下の「受信箱」を参照）。

## 隠す仕組み

答え側のセルは `.cell--en` の中に `<span class="en-text">`（本文）と `<span class="en-mask">`（覆い）が入っている。

- CSS 側: `data-mask` の値と `.row.is-revealed` の有無で `.en-text` / `.en-mask` の見え方を切り替える。
  - **隠れているとき、文字列を選択・コピーできてもよいが、目で読めてはいけない。**
  - `blur`: `.en-text { filter: blur(...) }`
  - `block`: `.en-mask` を不透明な帯として本文の上に重ねる
  - `hidden`: `.en-text { visibility: hidden }`（**高さは保つ**。行が伸び縮みしないこと）
- `data-direction="en-ja"` のときは日本語側 `.cell--ja` が同じ扱いになる。CSS は両方に効くよう書く。

## レイアウト要件

- 3 カラム: `#` / 日本語 / 英語。iPhone の縦画面でも 2 列（日本語・英語）は横並びを保つ。`#` は狭幅では非表示にしてよい。
- iPhone: `env(safe-area-inset-*)` 対応、ヘッダーは sticky、行の高さは指で押しやすく（最低 44px）、`100dvh` 系で iOS のアドレスバー問題を避ける。横スクロールを出さない。
- MacBook: 中央寄せ、最大幅 1100px 程度。ホバー、フォーカスリング、キーボード操作の現在行 `is-current` がはっきり分かること。
- `.hint--desktop` は狭幅で非表示、`.hint--mobile` は広幅で非表示。
- ライト/ダークは `prefers-color-scheme` で自動。CSS 変数を `:root` に定義する。
- 印刷用に軽く `@media print` を入れてもよい（任意）。

## パラフレ帳

`[data-mode-view="drill"]` / `[data-mode-view="para"]` の付いた要素は、`<html data-mode>` と
食い違うほうを CSS が丸ごと畳む（JS は属性を替えるだけでよい）。

### データ形式（localStorage の中だけにある。収録データは持たない）

```js
// sunkan:para:genres
[ { id: 'g…', name: '会議で使う言い換え' } ]

// sunkan:para:cards
[
  {
    id: 'p…',
    genreId: 'g…',                      // '' はジャンルなし
    headEn: 'It is important to keep trying.',   // 見出し（1 文だけ）
    headJa: 'やり続けることが大切だ。',            // 見出しの意味（空でよい）
    lines: [                            // 言い換え。最大 4 つ
      { en: 'Persistence matters.', ja: '粘り強さが物を言う。' }
    ]
  }
]
```

### 表示の決まり

- 見出しは**枠の中**に、英文を大きく・その下に日本語訳を小さく置く（`.para-head-en` / `.para-head-ja`）。
- 言い換えは**枠の外**に 4 行まで。見出しより少し小さい英文と、その下に意味（`.para-line-en` / `.para-line-ja`）。
- ジャンルはいちばん上。入力欄もチップも太字で、他より目立たせる。
- `.para-card.is-revealed` … `data-para-mask="on"` のとき、この札だけ言い換えが見えている。
- `.para-card.is-starred` … ★が付いている（見出しの縦線を `--star` に替える）。

### 表の列（📋 の読み込み・書き出し）

`ジャンル / 見出しの英文 / 見出しの意味 / 言い換え1の英文 / 言い換え1の意味 / …（4 組）` の 11 列。
2 列目（見出しの英文）だけ必須。読み込みは `SUNKAN_DRILL.splitTable` に任せ、見出し行は自動で外す。

### 瞬間英作文へ送る

パラフレ 1 枚は `{ja: 意味, en: 英文}` の並びになる（言い換えに意味が無ければ見出しの意味を使う）。
送り先は `パラフレ帳（ジャンル名）` というセットで、ジャンルごとに分ける。元のパラフレは消さない。

## 受信箱（別アプリから届いたカード）

My Dictionary（別リポジトリの単一 HTML）は、同じ GitHub Pages のドメインにパス違いで置かれる。
`https://<user>.github.io/dictionary-22/` と `https://<user>.github.io/sunkan-333/` はオリジンが
同じなので、localStorage がそのまま共有される。そこを 1 本の受け渡し場所として使う。

**送り手は `sunkan:inbox` に足すだけ。取り込みと後始末は `inbox.js` だけが行う。**
送り手側のデータ形式（`mydict.v1` など）には、こちらからは一切触らない。

```js
// sunkan:inbox — 取り込み待ちのカード。空になったらキーごと消える
[
  {
    id: 'mydict:e3k9x2a1:1750000000000',  // 送り手が付ける一意な文字列（任意）
    en: 'The bus was ten minutes late.',   // 必須
    ja: 'バスが10分遅れた。',                // 必須
    pattern: 'N was 〜 minutes late.',      // 型。取り込むと note になる（任意）
    source: 'My Dictionary',               // 送り元。そのままセット名になる（任意）
    sentAt: 1750000000000                  // 送った時刻（任意。表示には使わない）
  }
]
```

- **`ja` と `en` の両方がそろっていないものは出題できないので捨てる。** 単語だけの項目が
  そのまま流れてこないよう、送り手側で両方を埋めさせること。
- `id` が無いときは `source` + `en` + `ja` を鍵に使う。同じ内容を二度送っても
  `addSentences` が同じ文を弾くので、重複して並ぶことはない。
- 中身は他アプリが書くので一切信用しない。配列でない・壊れている・長すぎる（400 字超）は落とす。
- 溜まりっぱなしを防ぐため 500 件で頭を打つ（古いほうから捨てる）。
- 取り込むと `source` の名前のセット（無ければ作る）に入り、受信箱からは消える。

### URL で届くぶん（`#inbox=…`）

iOS はホーム画面に追加したアプリとブラウザで保存領域が分ける。片方から書いた localStorage を
もう片方は読めないので、`sunkan:inbox` だけを頼りにすると「送ったのに何も出てこない」ことになる。
そこで **URL に載せて渡す道**も持つ。`#inbox=<base64url の JSON 配列>` が付いていたら、
`inbox.js` が起動時（と `hashchange` / `pageshow`）に中身を受信箱へ移し、**URL からは消す**
（`history.replaceState`。消さないと再読み込みで二重に入る）。載っている 1 件の形は上と同じ。

読めない・壊れた URL は黙って捨てる。同じ URL を二度開いても、`addSentences` が同じ文を
弾くので重複して並ばない。

`#inbox-bar` は届いているときだけ `hidden` が外れ、モードに関係なく出る（`data-mode-view` は
付けない）。パラフレ帳を開いたまま「取り込む」を押したときは、`#tab-drill` をクリックして
表のほうへ移る。「あとで」はその時点の中身を覚えて畳むだけで、受信箱には手を付けない
（新しいカードが届けばまた出る）。

## 端末どうしで渡す（登録なし）

サーバーが無い以上、**アカウントの類なしに裏から勝手に揃える方法は無い**。代わりに
「片方で作ったものを、もう片方で開く」形を用意する。中身は下の同期と同じ突き合わせに
通すので、開いた側のぶんも消えない。

- **リンク**: `#data=<z|p>.<base64url>` を作って開く。`z.` は `CompressionStream('deflate-raw')`
  で縮めたもの、`p.` は生（この API が無い端末向け）。`inbox.js` の `#inbox=` とは別の鍵なので
  ぶつからない。読んだら `history.replaceState` で URL から消す（消さないと再読み込みで二重に入る）。
  **すでにアプリを開いたままリンクを叩くと、読み込み直されずハッシュだけが変わる**ので、
  起動時だけでなく `hashchange` / `pageshow` でも拾う。
- 30000 字を超えたらリンクにはせず、ファイルを使うよう促す。
- **ファイル**: 下の同期と同じ形の JSON をそのまま書き出す／読み込む。大きさの上限が無い。
  `app !== 'sunkan'` のものは受け取らない。
- **貼り付け**: ホーム画面に追加したアプリには**アドレス欄が無く、リンクを開かせられない**。
  その端末へ届ける道がこれしか無いので、受け口を広くとる —
  `#data=` のリンク、`#inbox=` のリンク（My Dictionary から）、生のひとかたまり、
  書き出しファイルの中身、のどれでも受け取る。`#inbox=` は `SUNKAN_INBOX.add()` に渡す。

### `window.SUNKAN_INBOX`（inbox.js が開けている口）

| 関数 | 内容 |
| --- | --- |
| `add(list)` | 受信箱にカードを足して帯を出し直す。足せた件数を返す。出題できないものは受け取らない |
| `refresh()` | 受信箱を見て帯を出し入れする |

## 同期（GitHub のシークレット Gist）

サーバーは持たない。GitHub の Gist を 1 枚の置き場として使う。ファイル名は `sunkan-data.json`
（My Dictionary の `mydict-data.json` と同じ Gist に同居できるよう分けてある。PATCH は
指定したファイルしか触らないので、互いを壊さない）。

```js
{
  app: 'sunkan', v: 1, at: 1750000000000,
  decks: [ /* sunkan:decks と同じ形 */ ],
  added: { /* sunkan:added と同じ形 */ },
  stars: { /* sunkan:stars と同じ形 */ },
  para:  { genres: [...], cards: [...], stars: [...] },
  tombs: [ { k: 'card:p…', t: 1750000000000, a: 0 } ]   // 消した / 足し直した記録
}
```

My Dictionary が送ったカードは、同じ Gist の **`sunkan-inbox.json`**（本体の `sunkan-data.json`
とは別ファイル）に置かれる。向こうは足すだけ、取り込み済みを間引くのはこちらだけ。
別ファイルにしてあるのは、互いの書き込みで相手のデータを踏まないため。
これがあるおかげで、My Dictionary は瞬間英作文を「開く」必要がない
（開くとその場のブラウザで別の入れ物のアプリが立ち上がり、本体とは別物が増えてしまう）。

受信箱（`sunkan:inbox`）も一緒に送る。My Dictionary から届いたカードは、送った側と同じ
入れ物の瞬間英作文にしか入らない。ホーム画面のアプリに届けるには、これを揃えるしかない。
取り込んだ分は `inbox.js` が `SUNKAN_SYNC.recordDelete(SUNKAN_SYNC.inboxKey(card))` で
消した記録に入れるので、同期で戻ってこない。

Gist の 1 ファイルは 1MB まで。送る前に大きさを見て、超えていれば往復せずに止め、
**どこが膨らんでいるのか（どのセットか）まで名指しする**。合計だけ言われても消しようがない。
受信箱と消した記録は際限なく増えうるので、件数の上限も入れてある。
それでも超えたときは行き止まりにせず、**捨てても覚えた文が失われない所から順に落として送り直す**
（受信箱 → 消した記録の順。セットと足した文には触らない）。落としたことは画面に出す。

**同期しないもの**: `sunkan:settings`（隠し方・文字サイズなどは端末ごとの好み）、
`sunkan:mode`、`sunkan:para:ui`、収録例文（`data.js` にあるので送る意味がない）。

### つなぐリンク（`#pair=`）

ホーム画面のアプリにはアドレス欄が無く、端末ごとにトークンを打ち込ませるのは現実的でない。
設定そのものを `#pair=<base64url の {t: トークン, g: Gist ID}>` に載せて渡し、
受けた側は貼り付けるだけで自動同期まで入る。**トークンが入っているので人に渡すものではない**旨を
画面にも書く。My Dictionary も同じリンクを受ける（1 つのトークンで両方のアプリが片付く）。

### 突き合わせ方

**足したものは両方から拾う**（どちらの端末の追加も消さない）。時刻で丸ごと勝ち負けを付けると、
片方がしばらくオフラインだったときにその間の追加が消えるため。
同じ id / 同じ (ja, en) は 1 つにまとめ、手元のほうを残す。

**消したものだけ記録を頼りに落とす。** `tombs` の 1 件は `t`（消した時刻）と `a`（足し直した時刻）を
持ち、`t > a` のときだけ落とす。`a` を残すのが肝で、消した記録は向こうの端末にも渡っているため、
足し直したときに記録ごと消すと、次の同期でまた向こうの記録が勝ってしまう。記録は 90 日で捨てる。

### 失敗したとき

**手元のデータには一切手を付けない。** 向こうが読めない（壊れている・1MB 超で途中で切られている）
ときは、空と解釈せず**同期そのものを止める**。空扱いすると、相手の端末にしか無いものを
こちらのデータで塗りつぶしてしまう。

`#sync-dialog` は設定ダイアログの中の `#btn-sync-open` から開く（設定は先に閉じる）。
自動同期は、保存を横取りせずに 3 秒ごとの見張りで気付き、2 秒待ってから送る。
裏に回っているタブでは見張らず、表に戻った時点で同期する。

## 保存（localStorage キー）

| キー | 内容 |
| --- | --- |
| `sunkan:settings` | `{ maskStyle, fontSize, autoHide, direction, starredOnly, deckId }` |
| `sunkan:decks` | ユーザーが取り込んだ自作デッキの配列（`data.js` と同じ形） |
| `sunkan:stars` | `{ [deckId]: string[] }` … ★を付けた項目の id |
| `sunkan:added` | `{ [deckId]: {ja,en,note}[] }` … アプリ内で1文ずつ足した分 |
| `sunkan:mode` | `drill` / `para` … 最後に開いていたモード |
| `sunkan:para:genres` | パラフレ帳のジャンル `[{id,name}]` |
| `sunkan:para:cards` | パラフレ本体 `[{id,genreId,headEn,headJa,lines}]` |
| `sunkan:para:stars` | ★を付けたパラフレの id `string[]` |
| `sunkan:para:ui` | `{ genreId, mask, sort, starredOnly }` … 表示の状態（シャッフルは持ち越さない） |
| `sunkan:inbox` | 別アプリから届いた取り込み待ちのカード（上の「受信箱」を参照）。書くのは送り手、消すのは `inbox.js` |
| `sunkan:sync:token` | GitHub のアクセストークン。**この端末の中だけ**。GitHub 以外へは送らない |
| `sunkan:sync:gistId` | 置き場の Gist ID |
| `sunkan:sync:auto` | `'1'` / `'0'` … 自動で同期するか |
| `sunkan:sync:last` | 最後に同期した時刻 |
| `sunkan:sync:tombs` | 消した / 足し直した記録 `[{k,t,a}]`（上の「同期」を参照） |

`sunkan:added` はデッキ本体を書き換えずに後ろへ足す方式。収録セット（`data.js`）にも
取り込んだセットにも同じように足せて、元データは無傷のまま保てる。
足した行には `.row.is-added` が付き、行内の `.row-delete` で1件ずつ消せる。

`settings.autoSpeak` … 英語を表示したときに自動で読み上げるか。逆向き（`en-ja`）のときは読み上げない。

## やらないこと

- 外部 CDN・npm・ビルドツールは使わない。素の HTML/CSS/JS のみ。
- 学習モード、スコア、タイマーなどの「練習モード」は作らない。
- パラフレ帳に例文は同梱しない（中身は使う人が入れる）。
