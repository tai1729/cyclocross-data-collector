# cyclocross-data-collector — Project Rules

このファイルは、このリポジトリ固有のルールを定義する（`CLAUDE.md` から読み込まれる）。全体像は `README.md` を参照。

## Project commands

| 用途      | コマンド                          |
| --------- | --------------------------------- |
| Install   | `npm ci`                          |
| Test      | `npm test`                        |
| Typecheck | `npm run typecheck`               |
| Artifacts | `npm run build-artifacts -- --strict` |

コード変更の完了前に、test と typecheck を通す。Worker（`infra/cloudflare-collector-trigger/`）を変更した場合は、そのディレクトリで `npm test` も通す。

## 役割の境界

- このリポジトリは収集・整形・配信用JSONの生成を担う。表示や分析はviewer（`../01_ajocc-laptime-viewer`、GitHub `tai1729/cyclocross-viewer`）の責務。
- 生成したJSONはviewerがGitHub Raw（`main` ブランチ）から直接読む。`main` へのpushはそのまま本番データの公開になる。

## データ契約と互換性

- `MeetEntry` / `RaceResult` / `Rider` / `LapRecord`（`lib/types.ts`）はviewerの `lib/types.ts` と互換でなければならない。フィールドの削除・改名・意味の変更はviewer側の対応と同時に行う。追加は後方互換な形で行う。
- ルート直下のJSON（`meets.json`、`rider-index.json`、`site-metadata.json`、`races.json`、`race_days.json` など）と `data/race-{raceId}.json` のパスを移動・改名しない。viewer・GitHub Actions・Cloudflare Workerが直接参照している。
- 周回遅れの選手の欠けた周回を補完しない。最終周タイムの補完は、結果表の正式ゴールタイムがある完走者（`finished`）に限り、注記付き順位（`annotated-rank`）は対象外。DNSは除外し、DNFは部分ラップを保持して完走者の後ろに連番の `finalPosition` を付ける（`lib/parseRaceHtml.ts`）。
- `rankAtLap` は周回ごとの累積タイムから再計算する。

## 運用上の注意

- `github-actions[bot]` が頻繁に `chore: update race data` をcommitする。作業前と push 前に `git pull --rebase origin main` を行う。
- `data/` と生成JSONを手で編集しない。収集ロジックを直して再収集する。
- 対象サイトへのアクセスは同時実行数の上限（`scripts/collect.ts` の `MAX_CONCURRENCY = 5`）を守る。負荷を増やす変更は事前に相談する。
- GitHub Actions の workflow や Cloudflare Worker の設定を変更する場合は、収集が止まらないことを確認してから反映する。
- トークン（例: Worker secret `GITHUB_ACTIONS_TOKEN`）や `.env` を読まない・出力しない・コミットしない。
