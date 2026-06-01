# spec 28: web/drive 証憑の不足情報メール送信（Resend）

- 日付: 2026-06-02
- ステータス: design
- 関連: spec 14（証憑問い合わせ outreach）, spec 16（LINE インバウンド）, [Resend 対応コミット b6af71b]

## 目的

web アプリ／Google Drive から登録された証憑(Voucher)が、MF 仕訳と突合できず情報不足（`journalStatus = 'needs_info'`）になったとき、不足情報を尋ねる確認メールを **Resend 経由で実送信**する。

LINE 由来の証憑は既に `sendLinePushForVoucherStatus`（spec 16）で送信者本人に質問が返るため対象外。web(`source='manual'`)/drive(`source='drive'`) には送り先メールを使った経路が機能していなかった（送信チャネルがグローバルな `OUTREACH_CHANNEL` 1 つしか無く、ソース別に出し分けられなかった）ため、これを埋める。

## 非ゴール / 既知の割り切り

- **宛先メールは当面ハードコード `kkouta2017@gmail.com`**。
  - **TODO（将来差し替え）**: 既に存在する顧問先ごとのメール設定（会社情報→連絡先タブの「メール」欄＝`Client.contactEndpoints.email`、`PATCH /api/clients/:id/contact` で保存）を宛先に使うよう変更する。今回はデモ優先でハードコードし、コードに `// TODO` と本 spec に明記する。
- LINE 経路は変更しない（現状維持）。
- メール文面は既存の静的テンプレ（`composeBody`：OCR＋missingFields）を流用。AI 生成にはしない（YAGNI）。
- ドメイン検証は行わない（Resend サンドボックス。宛先がアカウント所有メールなので送信可）。

## 設計

### 1. ソース別ルーティング（`services/outreach-service.ts`）

`inquireAboutVoucher(voucherId)` をソース判定に変更:

- voucher 取得時に `source` も select する。
- `source === 'line'` → **何もせず return**（LINE プッシュが担当。メールの二重送信を防ぐ）。
- `source` が `manual` / `drive`（その他）→ メール送信:
  - `channel = env.OUTREACH_CHANNEL === 'mock' ? 'mock' : 'email'`（mock はローカル/テストの安全弁、それ以外は email で実送信）
  - 宛先 `target = DEMO_INQUIRY_EMAIL`（モジュール定数 `'kkouta2017@gmail.com'`、`// TODO: client.contactEndpoints.email に差し替え`）
  - 文面は既存 `composeBody` を流用
  - 既存どおり `VoucherInquiry` に `sent/failed` を記録し、Voucher の `inquiryAt/inquiryChannel/journalStatus` を更新

email チャネル時の実送信は `EmailOutreachAdapter`（`RESEND_API_KEY` があれば Resend、無ければ SendGrid）に委譲＝既存実装をそのまま使う。

### 2. トリガー（自動＋手動）

- **自動**: 既存 `voucher-service.ts` の `OUTREACH_AUTO` ゲート（needs_info で `inquireAboutVoucher` 呼び出し）をそのまま使う。line は inquire 内で skip されるので、自動送信は実質 web/drive のみ。デモでは `.env` で `OUTREACH_AUTO=true` にする。
- **手動**: 既存 `POST /api/vouchers/:id/inquire` を使う。フロント（証憑一覧/詳細）に「**確認メールを送る**」ボタンを追加し、このエンドポイントを叩く。

### 3. 設定（env）

- `.env`（ローカル/デモ）: `OUTREACH_CHANNEL=email`（実装済み）、`OUTREACH_AUTO=true` を追加。
- 本番 Railway: 同様に env 設定で有効化。

## テスト方針

`tests/services/outreach-service.test.ts` を拡張（実 Postgres、外部送信は mock channel）:

- `source='line'` の Voucher に `inquireAboutVoucher` → **VoucherInquiry が作られない**（skip）。
- `source='manual'` の Voucher（mock channel）→ VoucherInquiry が `sent` で記録され、`target` がハードコード宛先になる。
- `source='drive'` も manual と同様に送信される。
- 既存テスト（mock channel・manual voucher）が壊れないこと。

フロントのボタンは Vanilla JS のため `node --check script.js` ＋手動確認で代用。

## 受入基準

1. `OUTREACH_CHANNEL=email` + `OUTREACH_AUTO=true` で web から証憑を登録 → needs_info → `kkouta2017@gmail.com` に確認メールが届く。
2. 証憑一覧/詳細の「確認メールを送る」ボタンからも送信でき、メールが届く。
3. `source='line'` の証憑ではメールが送られない（LINE 経路は従来どおり）。
4. `npm test` 全 green。`node --check script.js` が通る。
5. コードと spec に「宛先ハードコードは将来 `contactEndpoints.email` へ差し替え」の TODO が残っている。
