# cyclocross-data-collector

AJOCCシクロクロスの大会結果・ラップタイムを [data.cyclocross.jp](https://data.cyclocross.jp) から収集し、JSONとしてこのリポジトリに保存します。

保存したJSONは、[AJOCC LapTime Viewer](https://ajocc-laptime-viewer.vercel.app/)（[cyclocross-viewer](https://github.com/tai1729/cyclocross-viewer)）がGitHub Raw経由で読み込みます。このリポジトリがviewerのデータ配信元を兼ねています。

## 仕組み

```
cyclocross.jp/calendar ──(月次 update-schedule.yml)──> race_days.json
                                                          │
Cloudflare Worker（毎時。開催日とその後2日間だけ発火）<────┘
   │ workflow_dispatch
   ▼
GitHub Actions collect.yml: discover → collect → build-artifacts --strict
   │ github-actions[bot] が commit & push
   ▼
data/race-*.json, meets.json, rider-index.json, site-metadata.json …
   │ GitHub Raw
   ▼
viewer（Vercel）
```

- 公式サイトにCSVはないため、結果ページのHTML（`table__result` / `table__laptime`）をCheerioで解析しています。
- 収集の起動は Cloudflare Worker（`infra/cloudflare-collector-trigger/`）が担当します。GitHub Actions の `schedule` は収集には使っていません。
- データに変化がない実行ではコミットしません。内容が同じレースは再取得してもファイル（`updatedAt` を含む）を書き換えません。collector の稼働状況は Actions の実行履歴で確認します。
- `collect.yml` は Actions 画面から手動実行もできます。`season` を指定すると過去シーズンを再収集します。

全体のアーキテクチャ図は viewer 側の [docs/ARCHITECTURE.md](https://github.com/tai1729/cyclocross-viewer/blob/main/docs/ARCHITECTURE.md) にあります。

## ファイルの役割

| パス | 役割 | 書き込み元 |
| --- | --- | --- |
| `data/race-{raceId}.json` | カテゴリー別のレース結果とラップ（viewerが読む） | collect |
| `meets.json` | 大会とカテゴリーの一覧（viewerが読む） | discover / collect |
| `rider-index.json` | 選手の横断検索用インデックス（移行中。viewerは `rider-index/` に切り替える） | build-artifacts |
| `rider-index/manifest.json`, `rider-index/{season}.json` | シーズンごとの選手索引（1シーズン約3MB、改行なし） | build-artifacts |
| `site-metadata.json` | データが最後に変わった日時 `updatedAt`（viewerが表示） | collect |
| `races.json` | 収集対象のレースIDと開催日 | discover |
| `known_meets.json` | 展開済み大会スラッグ（重複防止） | discover |
| `race_days.json` | 公式カレンダーの開催日（Workerが参照） | update-schedule |
| `inventory.json` | 収集状況の集計と検証結果 | build-artifacts |
| `discovery-failures.json` | 発見・収集に失敗した対象の記録 | discover / collect |

ルート直下のJSONと `data/` のパスは、viewer・Actions・Workerが直接参照しています。**移動・改名しないでください。**

## 開発

```bash
npm ci
npm test               # テスト
npm run typecheck      # 型チェック
npm run discover       # 新しい大会・カテゴリーを発見
npm run collect        # レース結果を収集
npm run build-artifacts -- --strict  # インデックス生成と検証
npm run update-schedule              # 開催日カレンダーを更新
```

Cloudflare Worker については [infra/cloudflare-collector-trigger/README.md](infra/cloudflare-collector-trigger/README.md) を参照してください。

## 注意

- botが頻繁にcommitするため、pushする前に `git pull --rebase origin main` で最新を取り込んでください。
- Actionsがファイルを更新できるよう、リポジトリ設定の Workflow permissions は `Read and write permissions` にしておく必要があります。
