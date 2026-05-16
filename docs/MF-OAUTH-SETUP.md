# Money Forward Cloud Accounting API — Setup & 接続手順

最終確認日: 2026-05-16
仕様参照元: <https://developers.api-accounting.moneyforward.com/v3/openapi.yaml>

zeimee は MF クラウド会計の **読み取り専用 API** を OAuth 2.0 で叩きます。書き込みは spec 08 の方針通り行いません。

## ホスト構成

| 用途 | ホスト | エンドポイント |
|---|---|---|
| OAuth 認可・トークン | `https://api.biz.moneyforward.com` | `/authorize` (GET), `/token` (POST) |
| クラウド会計データ | `https://api-accounting.moneyforward.com` | `/api/v3/...` |

`MF_AUTH_BASE_URL` と `MF_ACCOUNTING_BASE_URL` は `.env` で別個に設定します（既定値が上記）。

## トークン仕様

- アクセストークン: 1 時間
- リフレッシュトークン: 540 日
- `Authorization: Bearer <token>` で API リクエスト
- 401 が返ったらリフレッシュ → 再試行

`mf-api.ts` の `ensureToken()` が、有効期限まで 60 秒を切ったら自動で refresh します。

## 必要なスコープ

`server/src/adapters/mf-api.ts` の `MF_SCOPES` に定義済み:

| スコープ | 用途 | zeimee で使う場面 |
|---|---|---|
| `mfc/accounting/journal.read` | 仕訳の参照 | レビューセンター・差戻しの元データ |
| `mfc/accounting/accounts.read` | 勘定科目・補助科目の参照 | 仕訳整形・分類表示 |
| `mfc/accounting/sub_accounts.read` | 補助科目の参照 | 同上 |
| `mfc/accounting/departments.read` | 部門の参照 | 部門別集計 |
| `mfc/accounting/taxes.read` | 税区分の参照 | 消費税区分の検証 |
| `mfc/accounting/trade_partners.read` | 取引先の参照 | 取引先別レビュー |
| `mfc/accounting/offices.read` | 事業者情報の取得 | 連携確認・事業者名表示 |
| `mfc/accounting/report.read` | 帳票の参照 | 試算表 (BS/PL) 取得 |
| `mfc/accounting/connected_account.read` | 連携サービス参照 | 同期元の確認 |

書き込み系 (`*.write`) はスコープに含めません。

## アプリ登録手順 (アプリポータル)

公式手順: <https://biz.moneyforward.com/support/app-portal/guide/g011.html>

1. MF クラウドにログインし、アプリポータルへ
2. 「新規アプリ作成」で zeimee を登録
3. 「リダイレクト URI」に **実際の URL を一字一句一致** で登録:
   - 開発: `http://localhost:3000/api/mf/oauth/callback`
   - 本番: `https://your-domain.example.com/api/mf/oauth/callback`
4. 必要スコープを上記 9 個チェック
5. 発行された `Client ID` / `Client Secret` を `.env` に設定:

```
MF_CLIENT_ID=xxxxxxxx
MF_CLIENT_SECRET=yyyyyyyy
MF_REDIRECT_URI=http://localhost:3000/api/mf/oauth/callback
```

## 接続フロー (顧問先 1 件あたり)

zeimee 側 URL: `GET /api/mf/oauth/start?clientId=<zeimee_client_id>`

```
ブラウザ
  │  GET /api/mf/oauth/start?clientId=aoyama-design
  ▼
zeimee (302) → MF authorize URL (state=aoyama-design)
  │
  ▼
MF クラウド (ユーザがログイン+同意)
  │  302 → http://localhost:3000/api/mf/oauth/callback?code=...&state=aoyama-design
  ▼
zeimee /callback
  │  POST https://api.biz.moneyforward.com/token (code → access_token + refresh_token)
  │  GET  https://api-accounting.moneyforward.com/api/v3/offices (連携先確認)
  │  Prisma update Client { mfAccessToken, mfRefreshToken, mfTokenExpiresAt, mfExternalId }
  ▼
HTML "MF 連携完了" 画面表示
```

## 取得対象エンドポイント (現状の zeimee 実装)

`mf-api.ts` から実際に呼ぶのは以下。

### 仕訳一覧 (会計レビューの元データ)
```
GET /api/v3/journals?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&per_page=200
Authorization: Bearer <token>
```
レスポンスの `journals[].branches[].debitor` を `RawEntry` に変換:
- `account_name` → `Entry.account`
- `value` → `Entry.amount`
- `tax_name` → `Entry.taxClass`
- `transaction_date` → `Entry.occurredAt`
- `voucher_file_ids.length > 0` → `Entry.receiptStatus = 'matched' / 'missing'`

### 事業者確認 (OAuth コールバック後の疎通確認)
```
GET /api/v3/offices
```
返却の `name` を「MF 連携完了」画面に表示し、`code` を `Client.mfExternalId` に保存。

## まだ呼んでいないエンドポイント

`/openapi.yaml` には以下が定義されていますが、現状の zeimee では未利用:

| パス | 用途 | 使う予定 |
|---|---|---|
| `/api/v3/accounts` | 勘定科目マスタ | 将来: 自動分類補助 |
| `/api/v3/sub_accounts` | 補助科目マスタ | 将来 |
| `/api/v3/departments` | 部門 | spec 04 のルール拡張時 |
| `/api/v3/taxes` | 税区分 | 将来: 区分検証 |
| `/api/v3/trade_partners` | 取引先 | 将来: 取引先別レビュー |
| `/api/v3/journals/{id}` | 仕訳個別 | 履歴詳細表示 |
| `/api/v3/reports/trial_balance_bs` | BS 試算表 | spec 05 期末モード |
| `/api/v3/reports/trial_balance_pl` | PL 試算表 | spec 05 期末モード |
| `/api/v3/reports/transition_bs` | BS 推移表 | 試算表トレンドビュー強化 |
| `/api/v3/reports/transition_pl` | PL 推移表 | 同上 |
| `/api/v3/connected_accounts` | 連携金融機関 | 同期元の表示 |
| `/api/v3/term_settings` | 会計期間 | 期末日の自動取得 |
| `/api/v3/vouchers` (POST/DELETE のみ) | 証憑添付 | zeimee は read-only なので非対象 |
| `/api/v3/transactions` (POST のみ) | 明細作成 | 同上 |

## 動作確認 (実トークン取得後)

```bash
# 1. OAuth 開始 (ブラウザで)
open http://localhost:3000/api/mf/oauth/start?clientId=aoyama-design

# 2. 同意完了後、 callback で「MF 連携完了」画面が出れば成功

# 3. 同期実行
curl -X POST http://localhost:3000/api/clients/aoyama-design/sync

# 4. DB を確認
docker compose exec postgres psql -U zeimee -d zeimee \
  -c 'SELECT count(*) FROM "Entry" WHERE "clientId"=$$aoyama-design$$ AND source=$$mf$$;'
```

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| 「MF_NOT_CONFIGURED」 | `.env` に `MF_CLIENT_ID` / `MF_REDIRECT_URI` が未設定 |
| MF 側で「リダイレクト URI が一致しません」 | アプリポータル登録 URI と `.env` の値が完全一致するか確認 (末尾スラッシュ・スキーム含む) |
| 401 が継続的に返る | リフレッシュトークンが失効 (540 日超 / 取り消し)。OAuth フロー再実行 |
| 429 が出る | `Retry-After` 秒待つ。複数顧問先の同期は時刻をずらす |
| `start_date`/`end_date` のエラー | 必須なので未指定だと 400。`fetchEntries(externalId, since)` の `since` を渡すか、デフォルトの 90 日窓を使う |

## 想定する制約

- API キー認証は **非対応** (OAuth 2.0 のみ)
- Money Forward Cloud Accounting **有償プラン** が必要 (アプリポータル登録時に同意が必要)
- 本番運用にはアクセストークンの暗号化保存が望ましい (現状 `Client.mfAccessToken` 平文)。これは将来課題
