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

`app.js` と `paraphrase.js` は状態も保存先も共有しない。触れ合うのは `<html data-mode>` だけで、
`app.js` は `data-mode="para"` の間キー操作を受け取らない（表が画面に無いため）。

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
| `sunkan:para:ui` | `{ genreId, mask }` … 選んでいるジャンルと、伏せているか |

`sunkan:added` はデッキ本体を書き換えずに後ろへ足す方式。収録セット（`data.js`）にも
取り込んだセットにも同じように足せて、元データは無傷のまま保てる。
足した行には `.row.is-added` が付き、行内の `.row-delete` で1件ずつ消せる。

`settings.autoSpeak` … 英語を表示したときに自動で読み上げるか。逆向き（`en-ja`）のときは読み上げない。

## やらないこと

- 外部 CDN・npm・ビルドツールは使わない。素の HTML/CSS/JS のみ。
- 学習モード、スコア、タイマーなどの「練習モード」は作らない。
- パラフレ帳に例文は同梱しない（中身は使う人が入れる）。
