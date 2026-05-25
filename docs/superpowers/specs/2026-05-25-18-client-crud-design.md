# Spec 18 — 顧問先 CRUD 管理

作成日: 2026-05-25

## 目的

現在 `GET /api/clients` と `GET /api/clients/:id` しかない顧問先 API に
**POST / PATCH / DELETE** を追加し、設定画面から顧問先を追加・編集・削除できるようにする。

seed 投入だけでなく、運用中に税理士が顧問先を管理できる状態を作ることがゴール。

---

## データモデル（既存 Prisma Client を利用）

新規マイグレーション不要。既存フィールドを使う。

作成時に必須なフィールド:
| フィールド | 型 | 説明 |
|---|---|---|
| `name` | String | 顧問先名 |
| `fiscalYearStart` | DateTime | 事業年度開始日 |
| `fiscalYearEnd` | DateTime | 事業年度終了日 |

省略可能フィールド（デフォルト値あり）:
| フィールド | 型 | デフォルト |
|---|---|---|
| `industry` | String | `"その他"` |
| `vendor` | String | `"mf"` |
| `mode` | String | `"monthly"` |
| `contactPrimary` | String | `"email"` |

---

## API 設計

### POST /api/clients

新規顧問先を作成する。

**Request body:**
```json
{
  "name": "サンプル株式会社",
  "fiscalYearStart": "2025-01-01",
  "fiscalYearEnd": "2025-12-31",
  "industry": "製造業",
  "vendor": "mf",
  "mode": "monthly"
}
```

**Response 201:**
```json
{
  "id": "clxxx...",
  "name": "サンプル株式会社",
  "industry": "製造業",
  "vendor": "mf",
  "mode": "monthly",
  "fiscalYearStart": "2025-01-01T00:00:00.000Z",
  "fiscalYearEnd": "2025-12-31T00:00:00.000Z"
}
```

**Validation:**
- `name`: 必須、1〜100文字
- `fiscalYearStart`, `fiscalYearEnd`: 必須、ISO 8601 日付文字列
- `fiscalYearEnd` は `fiscalYearStart` より後

**Error 400:**
```json
{ "error": { "code": "INVALID_BODY", "message": "..." } }
```

---

### PATCH /api/clients/:id

指定 ID の顧問先を部分更新する。`firmId` スコープで検索（他テナント保護）。

**Request body（すべて省略可能）:**
```json
{
  "name": "新社名",
  "industry": "小売業",
  "mode": "yearend",
  "fiscalYearStart": "2025-04-01",
  "fiscalYearEnd": "2026-03-31"
}
```

**Response 200:**
```json
{ "ok": true }
```

**Error 404 (not found or other tenant):**
```json
{ "error": { "code": "NOT_FOUND", "message": "client not found" } }
```

---

### DELETE /api/clients/:id

指定 ID の顧問先を削除する。

Prisma スキーマの `onDelete: Cascade` により関連する
Entry / Receipt / Matching / Task / Rule / Thread / Voucher 等は連鎖削除される。

**Response 200:**
```json
{ "ok": true }
```

**Error 404:**
```json
{ "error": { "code": "NOT_FOUND", "message": "client not found" } }
```

---

## フロント設計

### 設定ビュー（`renderSettings`）への追加

既存の「メンバー管理」セクションに加え、**顧問先管理**セクションを追加する。

```
┌─────────────────────────────────────────────┐
│ 顧問先管理                                   │
├─────────────────────────────────────────────┤
│ [+ 顧問先を追加]                             │
│                                             │
│ 青山デザイン事務所   [編集] [削除]           │
│ 渋谷カフェ           [編集] [削除]           │
│ 日本橋工業           [編集] [削除]           │
└─────────────────────────────────────────────┘
```

### 追加・編集モーダル

設定ビュー内にインラインフォームを表示する（モーダルは使わずビュー内展開）。

フォームフィールド:
- 顧問先名（テキスト、必須）
- 業種（セレクト: その他 / 製造業 / 小売業 / サービス業 / 飲食業 / 医療・介護 / 不動産 / 建設業）
- 会計ソフト（セレクト: mf / freee）
- モード（セレクト: monthly / yearend）
- 事業年度開始日（date input）
- 事業年度終了日（date input）

### アクション

| アクション | 処理 |
|---|---|
| `settings-add-client` | フォームを展開（新規モード）|
| `settings-save-client` | POST or PATCH を呼び出してリスト更新 |
| `settings-edit-client` | フォームを展開（編集モード）、既存値を埋める |
| `settings-delete-client` | confirm ダイアログ → DELETE → リスト更新・ダッシュボードリロード |

---

## テスト方針

`server/tests/routes/clients.test.ts` に追加:

1. **POST /api/clients** — 201 with required fields only
2. **POST /api/clients** — 400 for missing `name`
3. **POST /api/clients** — 400 when `fiscalYearEnd` < `fiscalYearStart`
4. **PATCH /api/clients/:id** — 200 partial update
5. **PATCH /api/clients/:id** — 404 for unknown id
6. **PATCH /api/clients/:id** — 404 for other-tenant client
7. **DELETE /api/clients/:id** — 200 OK
8. **DELETE /api/clients/:id** — 404 for unknown id
9. **DELETE /api/clients/:id** — 404 for other-tenant client

---

## 受入基準

- [ ] `POST /api/clients` で顧問先が作成でき、`GET /api/clients` に反映される
- [ ] `PATCH /api/clients/:id` で name / industry / mode が更新される
- [ ] `DELETE /api/clients/:id` で顧問先が削除され、GET からも消える
- [ ] 他テナントの ID を指定しても 404 が返る
- [ ] バリデーション不正時は 400 + `{error:{code,message}}` が返る
- [ ] 設定ビューに顧問先管理セクションが表示され、追加・編集・削除が操作できる
- [ ] 既存 147 テストが回帰しない

## 非ゴール

- MF OAuth 連携の設定（spec 01 の責務）
- 顧問先の一括インポート
- 顧問先の並び順変更
- フロント側のバリデーション（submit 時に API エラーを表示するだけで十分）
