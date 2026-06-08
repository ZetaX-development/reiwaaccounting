# spec 30: MF一致なし証憑の自動仕訳確定（auto-classify）

作成日: 2026-06-02

## 目的

MF（MoneyForward）仕訳と突合できなかった証憑について、不足情報が埋まって仕訳ドラフトが
完成した瞬間に、**人手の承認なしで自動的に「仕訳確定（`journalStatus = approved`）」へ昇格**する。

ユーザ要望:
- LINE/Drive から入った証憑が MF 仕訳と一致しないとき、勝手に仕訳に分類されてほしい。
- メール/LINE で不足情報をヒアリングし、情報が揃って（＝ドラフトが完成して）「OK」になったら、
  そのまま仕訳に確定してほしい。

## 背景（現状の自動パイプライン）

証憑は既に次の流れで自動処理される（spec 12/14/16/19/29）:

1. OCR → 顧問先振り分け → MF 仕訳と突合（`assignAndMatchVoucher`）
2. **MF一致なし** → `generateDraftJournal` で仕訳ドラフトを自動生成
3. 情報不足 → `journalStatus = 'needs_info'` → LINE/メールで自動ヒアリング
4. 返信受信 → `generateDraftJournal` を再実行 → 情報が揃えば `journalStatus = 'drafted'`

唯一自動化されていないのが **`drafted` → `approved`（確定）** の一手で、現状は人の承認
（または LINE の OK ボタン）が必要。本スペックはこの一手を自動化する。

## 決定事項

- **発火タイミングは「確認したい情報が全てなくなった瞬間」だけ**：`missingFields` が1つでも
  残っている間は確定せず（`needs_info` のまま）、突合結果ビューに表示されたまま蓄積される。
  ヒアリングで全項目が解消された瞬間にのみ自動確定が発火する。
- **信頼度ゲートなし**：完成したドラフトは信頼度に関係なく全て自動確定する。
- **LINE 通知は「通知のみ」**：自動確定時は「✓ 〇〇 ¥X で仕訳に登録しました」を1通プッシュする
  だけ（OK/直す/あとで・MF入力 などのボタンは出さない）。
- **トレーサビリティ**：自動確定したものは `draftJournalJson.autoClassified = true` を付けて、
  人手承認と区別できるようにする（スキーマ変更＝migration は不要、JSON 内に持つ）。

## 対象範囲

- 対象: `matchStatus !== 'matched'`（MF一致なし）の証憑で、ドラフトの `missingFields` が空のもの。
- 非対象: MF一致あり（そもそも `generateDraftJournal` を呼ばない）。情報不足（`needs_info`）の
  ものは従来通りヒアリングを継続し、確定しない。

## 非ゴール

- 信頼度による自動/手動の振り分け（今回はしない）。
- MoneyForward への自動書き込み（read-only ポリシー。確定は bookmee 内のみ。MF 反映は従来通り
  CSV エクスポート経由）。
- spec 21 の「MF取込仕訳の摘要レビュー自動適用」は別機能（本スペックは証憑→仕訳ドラフト側のみ）。
- 新しい「確定済み仕訳一覧」ビューの新設（既存の証憑ビュー表示＋CSVエクスポートで足りる）。

## データモデル

スキーマ変更なし。既存列のみ:
- `Voucher.journalStatus`: `none | drafting | needs_info | drafted | approved`。本変更で
  「未一致＆完成」のとき `drafted` を飛ばして `approved` を入れる。
- `Voucher.draftJournalJson`: 既存の MF 準拠ドラフト JSON に `autoClassified: true` を追加する。
- `Voucher.matchStatus`: 自動確定の判定に使用（`'matched'` 以外が対象）。

## 実装方針

### 1. 自動確定（中核・1箇所）

`server/src/services/journal-draft-service.ts` の `generateDraftJournal`:

- 現在: `nextStatus = missingFields.length > 0 ? 'needs_info' : 'drafted'`
- 変更後:
  - `missingFields` が空でない → `needs_info`（従来通り）
  - `missingFields` が空 かつ 当該 Voucher の `matchStatus !== 'matched'` → **`approved`**、
    かつ保存する `draftJournalJson` に `autoClassified: true` を付与
  - `missingFields` が空 かつ `matchStatus === 'matched'` → `drafted`（従来の挙動を維持。
    通常このパスは呼ばれないが安全側）
- `matchStatus` は当該関数内で Voucher から取得する（既存の Voucher 取得に `matchStatus` を含める、
  または保存直前に読む）。

この1箇所の変更で、初回（`assignAndMatchVoucher` 経由）も、LINE/メールの Q&A 後の再ドラフト
（`answerPendingQuestion` / `applyVoucherReply` 経由）も、完成時に自動確定する。

### 2. LINE 通知（通知のみ）

`server/src/services/line-importer.ts` の `sendLinePushForVoucherStatus`:

- 新ブランチを追加: `journalStatus === 'approved'` かつ `draftJournalJson.autoClassified === true`
  の場合、借方勘定科目と金額から要約を作り、**「✓ {account} {amount} で仕訳に登録しました」**を
  `pushMessage` で1通送る（Quick Reply なし）。
- 既存の `'drafted'` ブランチ（OK/直す/あとで・MF入力クイックリプライ）はそのまま残す（後方互換）。
  自動確定パスでは `'drafted'` を経由しなくなるため、結果として LINE 利用者にはボタンが出ず通知のみ
  になる（要望どおり）。
- 金額/勘定科目の取り出しは既存 `'drafted'` ブランチの実装を流用（`draft.debit.account` /
  `draft.debit.amount`、旧フラット形式フォールバックも踏襲）。

### 注意点（既存挙動への影響）

- これまで MF 連携済み顧客の LINE には「MFにも入力しますか？」(spec 20) が出ていたが、自動確定に
  伴い**出なくなる**（ユーザ選択 A のとおり）。`mf_write` postback ハンドラ自体は残す（他経路から
  到達可能なため削除しない）。

## テスト方針

### バックエンド（vitest・実 Postgres、OpenAI はモック）

`generateDraftJournal` のテスト（既存の journal-draft 系テストがあれば追記、なければ新規）:
- 未一致（`matchStatus = 'unmatched'`）＆ OpenAI が `missingFields: []` を返す
  → `journalStatus === 'approved'` かつ `draftJournalJson.autoClassified === true`。
- 未一致 ＆ `missingFields: ['支払方法']` を返す → `journalStatus === 'needs_info'`、
  `autoClassified` は付かない。
- 一致あり（`matchStatus = 'matched'`）＆ `missingFields: []` → `journalStatus === 'drafted'`
  （自動確定しない）。

`sendLinePushForVoucherStatus` のテスト（既存 line-importer テストに追記、`lineService` を spy）:
- `journalStatus = 'approved'` ＆ `draftJournalJson.autoClassified = true` ＆ `source = 'line'`
  → `pushMessage` が「仕訳に登録しました」を含む文言で1回呼ばれ、`pushQuickReply` は呼ばれない。

### 手動 UI / 実地

- LINE で不足情報のある証憑を送る → ヒアリング → 回答 → 「✓ 〇〇 ¥X で仕訳に登録しました」通知。
- 当該証憑が証憑ビューで「確定/分類済み」表示になり、CSV エクスポート対象に入る。

## 受入基準

1. MF一致なしの証憑で、不足情報なくドラフトが完成した時点で `journalStatus` が自動的に
   `approved` になる（人手の承認なし）。
2. 不足情報がある間は `needs_info` のままで、ヒアリングが続き、確定しない。回答で情報が揃えば
   自動確定する。
3. 自動確定された証憑の `draftJournalJson.autoClassified === true` になっている。
4. LINE 経由の証憑が自動確定したら、LINE に「✓ … で仕訳に登録しました」通知が1通届く
   （OK/MF入力等のボタンは出ない）。
5. MF一致ありの証憑は自動確定の対象外（従来挙動を維持）。
6. 自動確定された証憑は CSV エクスポート（MF/弥生/汎用）の対象に含まれる（既存挙動）。
