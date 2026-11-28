# CAT-ORDER-1 — Keep official category tab order — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公式大会ページの `#cat_tab` に載っている順番を、そのまま `MeetCategory.order` として保存する。関西で `CK3` が先頭になる問題を直す。

**Architecture:** `findMeetEntry` の HTML 解析部分を、純粋関数 `parseCategoryTabs(html, redirectedRaceId)` に切り出す。この関数が `#cat_tab li` を文書順に読み、`li.selected` の位置にリダイレクト先のカテゴリーを入れる。固定の優先リストによる並べ替えは削除する。最後に、全シーズンの discovery を 1 回やり直して `meets.json` を更新する。

**Tech Stack:** TypeScript、cheerio、`node:test` + `tsx`。

**Spec:** viewer repo の `docs/DESIGN.md` → 「Official category tab order (CAT-ORDER-1)」。

**Branch:** `fix/official-category-tab-order`（collector repo の `main` から作る）。

## Global Constraints

- JSON の形（`MeetEntry` / `MeetCategory`）、`raceId`、race JSON、ファイルパスは変えない。変わるのは `order` だけ。
- 新しい依存は追加しない。
- viewer のコードは変更しない。
- collector の `npm test` と `npm run typecheck` を通す。

## Review Focus

1. **表示中のカテゴリーがタブの途中にある HTML**（例: `MMJ-267-002` はリダイレクト先が `MM2+3`）。リダイレクト先が先頭に来ず、タブ上の位置に入ること → Task 1 のテスト。
2. **`li.selected` がない、または `#cat_tab` 自体がない HTML。** 従来どおり、リダイレクト先を先頭にしてリンク順に並べる → Task 1 のテスト。
3. **同じ `raceId` へのリンクが重複している HTML。** 最初に出たものだけを残す（既存の `seen` の挙動）→ Task 1 のテスト。
4. **ラベルの前後の空白や改行**（実 HTML は `<a href …> E2 </a>`）。名前は trim される → Task 1 のテスト。
5. **再 discovery で `categories` の件数や `raceId` の集合が変わってしまうこと。** order 以外が変わったら、コミットしないで止める → Task 2 の確認スクリプト。

---

### Task 1: `#cat_tab` の順番どおりに解析する

**Files:**
- Modify: `scripts/discover.ts`（30–46 行の `OFFICIAL_CATEGORY_PRIORITY` 関連と 86–103 行の `orderCategoriesByOfficialPriority` を削除。256–274 行の解析を新しい関数へ移す。295 行は新しい関数の結果をそのまま使う）
- Test: `tests/discoveryConfig.test.ts`（60–97 行の優先順テストを置き換える）

**Interfaces:**
- Produces: `export function parseCategoryTabs(html: string, redirectedRaceId: string | null): MeetEntry["categories"]` — 戻り値の `order` は 0 からの連番。

アルゴリズム:
- `#cat_tab li` を文書順に処理する。`li` の中に `a[href*='/race/']` があれば、その `raceId` と trim したテキストを追加する。`li.selected` でリンクがなく、`redirectedRaceId` がまだ追加されていなければ、`redirectedRaceId` と `#ec_name` のテキスト（なければ `li` のテキスト）を追加する。`raceId` が重複したら飛ばす。
- 処理後に `redirectedRaceId` が含まれていなければ（`li.selected` がない、`#cat_tab` がないなど）、従来どおり先頭に `{ raceId: redirectedRaceId, name: #ec_name }` を挿入する。
- 最後に `order` を振り直す。

- [ ] **Step 1: テストを書く**（HTML は文字列で組み立てる。実ページと同じ空白を入れる）
  - selected が先頭（KNS 型）: `<ul id="cat_tab"><li class="selected"><span>E1</span></li><li><a href="https://data.cyclocross.jp/race/2"> E2 </a></li><li><a href="https://data.cyclocross.jp/race/3"> CK3 </a></li></ul><h2 id="ec_name">E1</h2>` と `"1"` → names `["E1","E2","CK3"]`、raceIds `["1","2","3"]`、order `[0,1,2]`。
  - selected が途中（MMJ 型）: `ME1(link 10)`、`selected MM2+3`、`CK1(link 12)` と `"11"` → names `["ME1","MM2+3","CK1"]`。
  - selected なし: link `20`・`21` と redirect `"19"` → raceIds `["19","20","21"]`。
  - `#cat_tab` なし: redirect `"30"` → `[{ raceId: "30", name: <#ec_name>, order: 0 }]`。
  - 重複リンク: link `40` が 2 回 → 1 件だけ。
  - redirect `null` で selected がある場合: selected は飛ばし、リンクだけを返す。
- [ ] **Step 2: `npm test` で失敗を確認する**（`parseCategoryTabs is not a function`）
- [ ] **Step 3: `parseCategoryTabs` を実装し、`findMeetEntry` から使う。優先リストと `orderCategoriesByOfficialPriority` を削除する**
- [ ] **Step 4: `npm test` と `npm run typecheck` で PASS を確認する**
- [ ] **Step 5: 実ページで確認する** — `KNS-267-004` の HTML を取得して `parseCategoryTabs` に通し、`E1 E2 E3 E4 W1 W2 W3 M1 M2 M3A M3B M4 A60-64 A65-69 A70-74 A75-79 J U17 U15 WU15 CK3 CK2 CK1 E5` になることを確認する（一時スクリプトは scratchpad に置き、repo にはコミットしない）
- [ ] **Step 6: Commit** — `fix(discover): keep official category tab order`

---

### Task 2: 全シーズンの `order` を書き直す

**Files:**
- Modify（生成物）: `meets.json`（必要なら `races.json` / `known_meets.json` も discover が書き換える。差分は `order` だけであることを確認する）

- [ ] **Step 1: `--force` が既知の大会を取り直し、`mergeMeetEntries` が既存エントリーを上書きすることを、`scripts/discover.ts` と `lib/` のコードで確認する。** 上書きしないなら、作業を止めて利用者に報告する（この場合は計画の変更が必要）
- [ ] **Step 2: 実行前の `meets.json` を scratchpad にコピーする**
- [ ] **Step 3: シーズンごとに実行する:** `npm run discover -- --season 2023-24 --force`、`2024-25`、`2025-26`、`2026-27`（公式サイトへの負荷を考え、並列では実行しない）
- [ ] **Step 4: 差分を検証する** — 実行前後の `meets.json` を比較する一時スクリプトで、全大会の `meetId` の集合、大会ごとの `categories` の件数、`raceId` の集合、`name` が一致し、違いが `order` だけであることを確認する。`KNS-267-004` の先頭が `E1` であること、先頭が `CK3` の大会が 0 件であることも確認する。差分が `order` 以外にもあれば、コミットしないで利用者に報告する
- [ ] **Step 5: `npm test` と `npm run typecheck` を再実行して PASS を確認する**
- [ ] **Step 6: Commit** — `data: rewrite category order from official tabs`
- [ ] **Step 7: 利用者の確認後に `main` へマージ・push する。** viewer は実行時に `meets.json` を読むので、viewer のデプロイは不要。本番 viewer で関西の大会を開き、初期カテゴリーが `E1` であることを確認する
- [ ] **Step 8: viewer repo の `docs/DESIGN.md` の CAT-ORDER-1 の Status に結果を追記する。2026-10-03 の設計には「CAT-ORDER-1 で置き換え」と注記する**
