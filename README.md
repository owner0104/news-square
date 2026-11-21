# NEWS SQUARE

日本と世界のニュースを、タイムズスクエアの電光掲示板風に流すページ。

- `scripts/fetch.mjs` … Google ニュース / Yahoo!ニュース / BBC の RSS を取得して `news.json` を作る
- `.github/workflows/news.yml` … 10分ごとに上を実行し、新着があればコミット
- `index.html` … `news.json` を1分ごとに確認し、新着をビルボード・テロップ・一覧に反映

フィードを増やす・減らすときは `scripts/fetch.mjs` の `FEEDS` を編集します。
