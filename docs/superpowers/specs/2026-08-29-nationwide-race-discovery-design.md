# 全国レース自動発見・収集 設計書（MVP-1拡張）

## 目的

手動管理していた`races.json`を廃止し、AJOCCの全国・全カテゴリーのレースを自動発見して収集対象に加える。レース開催日以外に収集ワークフローを起動しないことで、対象サイトとGitHub Actionsの負荷を抑える。

## ワークフロー

### カレンダー・スケジュール更新

`.github/workflows/update-schedule.yml`を毎月1日 09:00 JSTに実行する。手動実行も可能にする。

1. `https://www.cyclocross.jp/calendar/`を取得する。
2. `.CL_raceDate`から開催日を抽出し、`race_days.json`に保存する。
3. `collect.yml`の生成用マーカー範囲を、開催日ごとのcron設定に置き換える。
4. `race_days.json`と`collect.yml`をコミット・pushする。

収集用cronはJSTを明示し、開催日当日の**09:00〜23:00に毎時**実行する。

```yaml
- cron: "0 9-23 21 9 *"
  timezone: "Asia/Tokyo" # 2026-09-21
```

月の途中で開催日が追加・変更された場合は、`Update race collection schedule`を手動実行して即時反映する。

### レース収集

`.github/workflows/collect.yml`は、カレンダー更新で生成された開催日・時間帯だけ自動実行する。`workflow_dispatch`を維持するため、リザルトが日付をまたいで公開された場合もActions画面から手動実行できる。

1. `discover.ts`が`https://data.cyclocross.jp/meet`を取得する。
2. 実行日から前後60日以内かつ未発見の大会を探す。
3. 各大会の詳細ページから、全カテゴリーの`race_id`を取り出す。
4. `collect.ts`が対象レースを取得・正規化し、`data/race-{race_id}.json`として保存する。
5. 成功分の`data/`、`races.json`、`known_meets.json`をコミット・pushする。

大会詳細ページとレースページの同時取得数は最大5件とする。

## データファイル

### `race_days.json`

カレンダーから抽出した開催日。

```json
["2026-09-21", "2026-09-22"]
```

### `races.json`

大会日を持つ収集対象レース。

```json
[
  { "raceId": "27160", "meetDate": "2026-02-08" }
]
```

### `known_meets.json`

展開済み大会スラッグの一覧。同じ大会を再発見してカテゴリー一覧を重複追加しないために使う。

```json
["KNS-256-011"]
```

## 収集方針

- 大会日から14日以内のレースは毎回再取得する。結果の後日修正に追従するため。
- 14日より古いレースは、対応するJSONが未作成の場合だけ取得する。
- 将来日のレースは取得しない。
- 一部のレース取得に失敗しても処理全体は失敗終了しない。成功したデータと発見済み設定は必ずコミット対象に残す。

## 手動確認手順

1. `Update race collection schedule`を`workflow_dispatch`で実行し、`race_days.json`と`collect.yml`のcronが更新されることを確認する。
2. `Collect race data`を`workflow_dispatch`で実行し、レース発見・収集・コミットが成功することを確認する。
3. 日付またぎでリザルトが公開された場合は、同じ`Collect race data`を手動実行する。
