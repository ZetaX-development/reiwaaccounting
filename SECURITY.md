# Security

詳細な要件定義書 → **デスクトップ: `SECURITY_REQUIREMENTS.md`**

## 未対処の既知リスク（優先度順）

| # | 場所 | 内容 | 優先度 |
|---|------|------|--------|
| C-1 | `server/src/middleware/auth.ts:90` | `$executeRawUnsafe` でSQLインジェクションリスク | 🔴 Critical |
| C-2 | `server/src/env.ts` | 本番で `DEV_BYPASS_AUTH=true` を禁止する検証がない | 🔴 Critical |
| C-3 | `server/src/server.ts` | Rate Limiting が未実装 | 🔴 Critical |
| H-1 | `server/src/server.ts` | CORS が全オリジン許可 (`origin: true`) | 🟡 High |
| H-2 | `server/src/routes/auth.ts` | パスワード複雑性要件がない（8文字のみ） | 🟡 High |
| H-3 | `login.html` | JWTが localStorage 保存（XSSリスク） | 🟡 High |
| M-1 | Supabase Dashboard | 全テーブルの RLS 有効化を確認 | 🟠 Medium |
| M-2 | LINE Webhook | `X-Line-Signature` 検証が未確認 | 🟠 Medium |

## 絶対にやってはいけないこと

- `SUPABASE_SERVICE_ROLE_KEY` をコードに直書きしない
- `DEV_BYPASS_AUTH=true` を本番の Railway Variables に設定しない
- `.env` を Git にコミットしない
- 新しい API ルートに `requireAuth` を付け忘れない
- DB クエリで `firmId` による絞り込みを省略しない
