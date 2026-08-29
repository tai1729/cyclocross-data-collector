# 全国レース自動発見・収集 設計書（MVP-1）

## 背景・目的

MVP-0/MVP-1の当初ゴール（GitHub Actionsによる収集の自動化）はすでに達成済みだが、対象は`races.json`に手動で書いた単一レース（race_id）のみだった。今回のMVP-1拡張では、AJOCC全国・全カテゴリーのレースを人手を介さず自動的に発見し、収集対象に加える仕組みを構築する。

対象サイト（data.cyclocross.jp）への負荷を最小限にするため、「レースが開催される日だけ」収集ジョブが動く設計とする。

## 全体アーキテクチャ

2つのGitHub Actionsワークフローで構成する。

```
[update-schedule.yml]  月1回（1日 0:00 UTC）+ 手動実行可
   1. https://www.cyclocross.jp/calendar/ を1回fetch
   2. .CL_raceDate 要素から開催日一覧を抽出 → race_days.json に保存
   3. race_days.json の開催日ぶんのcron行を生成し、
      collect.yml の `on.schedule` を丸ごと書き換える
   4. race_days.json と collect.yml の変更をcommit & push

[collect.yml]  開催日の 9:00〜24:00 JST に毎時（上記で動的に設定されたスケジュール）
   1. scripts/discover.ts … 新しい大会・レースをrace_idとして発見し races.json に追加
   2. scripts/collect.ts … races.json の各レースを条件に応じて収集
   3. 変更をcommit & push（部分的に失敗しても成功分は必ずコミットする）
```

非開催日はcronの条件に一致しないため、GitHub Actions自体が起動しない（サイトへのアクセスはゼロ、Actionsの実行分も消費しない）。

## データ構造

### `race_days.json`（新規）
開催日の一覧。`update-schedule.yml`が月1回全件書き換える。
```json
["2026-09-21", "2026-09-27", "2026-10-04"]
```

### `races.json`（形式変更）
現行の`string[]`から、大会日を持つオブジェクト配列に変更する（大会日は「直近か古いか」の判定に使う）。
```json
[
  { "raceId": "27160", "meetDate": "2026-02-08" }
]
```
既存の`races.json`（`string[]`）はマイグレーション時に変換する。

### `known_meets.json`（新規）
発見済みの大会スラッグ一覧。discover.tsが同じ大会を何度も展開しないようにするための重複排除用。
```json
["KNS-256-011", "MMJ-256-005"]
```

## コンポーネント設計

### `scripts/updateSchedule.ts`（新規）
- `https://www.cyclocross.jp/calendar/` をfetchし、`.CL_raceDate`（例: `2026<br>9.21(月)`）から日付を抽出して`race_days.json`に書き出す
- `race_days.json`の各日付から、JST 9:00〜24:00を毎時実行するcron行（例: `0 0-15 21 9 *`。UTC変換済み）を生成する
- `.github/workflows/collect.yml`の`on.schedule`セクションをこの内容で完全に置き換える（毎回フルリライトなので、過去日の掃除は自然に行われる）
- 変更があれば`race_days.json`・`.github/workflows/collect.yml`をcommit & push

### `scripts/discover.ts`（新規）
- `https://data.cyclocross.jp/meet` を1回fetchし、大会一覧（日付・大会スラッグ）を取得
- 直近60日以内 かつ `known_meets.json`に未登録の大会のみを対象にする（初回実行時に何百件も一気に処理しないための下限）
- 対象大会ごとに`https://data.cyclocross.jp/meet/{slug}`をfetch（リダイレクト先ページの`#cat_tab`から、その大会の全カテゴリー分の`race_id`と、リダイレクト先URL自身のrace_id/カテゴリーを取得）
- 新しい`{raceId, meetDate}`を`races.json`に追加、大会スラッグを`known_meets.json`に追加
- 大会詳細ページの取得は同時実行数を絞る（例: 5件ずつ）

### `scripts/collect.ts`（変更）
- `races.json`の各エントリについて、`meetDate`が**直近14日以内なら常に再取得**、**それより古い場合は`data/race-{id}.json`が存在しなければ初回のみ取得**（存在すればスキップ）
- **信頼性修正**: 現状は1件でも失敗すると`process.exitCode = 1`となり、GitHub Actions上で後続のcommitステップがスキップされてしまう。件数が増えると一時的な失敗は毎回起こり得るため、**部分的な失敗があっても成功した分は必ずcommit&pushされるようにする**（失敗はログに出すのみとし、exit codeで後続処理を止めない）

## ワークフロー変更

- `update-schedule.yml`（新規）: `schedule: 0 0 1 * *`（毎月1日）+ `workflow_dispatch`
- `collect.yml`（既存を変更）: `schedule`セクションは`updateSchedule.ts`が書き換える対象になるため、初期値は空、または現在判明している開催日で仮置き。`workflow_dispatch`は残し手動実行・動作確認に使う

## 初回セットアップ手順

1. 既存の`races.json`（`string[]`）を新形式（`{raceId, meetDate}[]`）に変換する（既知の1件は大会日が判明しているのでそれを設定する）
2. `update-schedule.yml`を`workflow_dispatch`で一度手動実行し、`race_days.json`の作成と`collect.yml`のスケジュール書き換え・commitを行う（これをやらないと`collect.yml`は一度も自動起動しない）
3. `collect.yml`を`workflow_dispatch`で一度手動実行し、`discover.ts`・`collect.ts`・信頼性修正が意図通り動くか確認する

## 既知の制限

- カレンダーに月の途中で新しい開催日が追加された場合、次回の月次更新まで自動では反映されない（`update-schedule.yml`を手動実行すれば即反映可能）
- 初回実行時、直近60日以内に大会が集中している場合はその分だけ`discover.ts`の処理が重くなる（同時実行数の制限で緩和）

## テスト方法

- `updateSchedule.ts`を実行し、`race_days.json`と生成される`collect.yml`のcron行が正しいか確認
- `discover.ts`を実行し、直近の実大会が正しく発見され`races.json`・`known_meets.json`に追加されるか確認
- `races.json`に意図的に不正なrace_idを混ぜて`collect.ts`を実行し、他の正常なレースの収集結果が問題なくcommit対象になることを確認（信頼性修正の検証）
- 14日以内/より古いレースそれぞれで、再収集される/されないが意図通りになるか確認
