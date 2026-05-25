# Plan: spec 17b — Supabase Auth + RLS + ログインUI

作成日: 2026-05-25

## 前提
- spec 17a 完了済み（Firm/FirmMember テーブル + 全テーブル firmId 追加 + demo-firm seed）
- テスト 133 件全 PASS
- `jose`, `@supabase/supabase-js` パッケージ未インストール
- `server/src/middleware/` ディレクトリ未作成
- Supabase project_ref: `kmgjmlcijhgaqddtjdou`

---

## Task 1: パッケージ追加 + env 拡張

**Files**
- `server/package.json`
- `server/src/env.ts`
- `server/.env`
- `server/.env.example`（あれば）

**Steps**
1. `npm install jose @supabase/supabase-js` (server/ 内で実行)
2. `env.ts` に追加:
   - `SUPABASE_URL` (string, required)
   - `SUPABASE_ANON_KEY` (string, required)
   - `SUPABASE_SERVICE_ROLE_KEY` (string, required)
   - `SUPABASE_JWT_SECRET` (string, required — テスト用 HS256 検証)
   - `SUPABASE_JWT_AUDIENCE` (string, default: 'authenticated')
3. `.env` にプレースホルダ行を追記（値はユーザーが設定）

**Commit**: `chore(spec 17b): add jose/supabase-js and extend env schema`

---

## Task 2: 認証ミドルウェア

**Files**
- `server/src/middleware/auth.ts` (新規)
- `server/src/types/fastify.d.ts` (新規 — FastifyRequest.user 型拡張)

**Steps**
1. `FastifyRequest` に `user?: { authUserId, firmId, role, email }` を型拡張
2. `requireAuth` を実装:
   - Bearer token を取り出し `jwtVerify` (JWKS) で検証
   - `FirmMember` を `authUserId` + `status='active'` で検索
   - `req.user` にセット
   - `prisma.$executeRawUnsafe` で RLS 用 JWT claims をセット
3. `requireOwner` を実装: `req.user.role !== 'owner'` → 403
4. Red → Green: `tests/middleware/auth.test.ts` (4 ケース) を書いてから実装
   - JWT なし → 401
   - 不正 JWT → 401
   - 有効 JWT + FirmMember なし → 403
   - 有効 JWT + active FirmMember → req.user セット

**Commit**: `feat(spec 17b): add requireAuth and requireOwner middleware`

---

## Task 3: テスト認証ヘルパー + setup 更新

**Files**
- `tests/helpers/auth.ts` (新規)
- `tests/setup.ts`

**Steps**
1. `tests/helpers/auth.ts` を作成（spec の `signTestToken` + `authHeaders`）
   - HS256 で署名（SUPABASE_JWT_SECRET を使用）
   - issuer: `${SUPABASE_URL}/auth/v1`
   - audience: `authenticated`
2. `tests/setup.ts` に追記:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` を process.env にセット（テスト用ダミー値）
   - テスト用 FirmMember を beforeAll で seed（authUserId: 'test-user-id', firmId: 'demo-firm', role: 'owner', status: 'active'）
   - afterAll で cleanup
3. `requireAuth` がテスト環境では HS256 でフォールバックできるよう env の `NODE_ENV=test` を確認

**Commit**: `test(spec 17b): add auth helper and update test setup`

---

## Task 4: firm-service 拡張

**Files**
- `server/src/services/firm-service.ts`

**Steps**
1. Red → Green: `tests/services/firm-service.test.ts` に 4 ケース追加してから実装
   - `createFirm` が Supabase Admin API spy を呼んで Firm + FirmMember を作る
   - `listMembers` が自 firm のメンバーのみ返す
   - `inviteMember` で Supabase Admin API (inviteUserByEmail) が呼ばれる
   - `removeMember` で status=removed
2. 実装:
   - `createFirm({ name, slug, ownerEmail })`: Supabase Admin `inviteUserByEmail` → Firm + FirmMember(owner/invited)
   - `listMembers(firmId)`: FirmMember findMany (status != removed)
   - `inviteMember(firmId, email, invitedBy)`: inviteUserByEmail → FirmMember(member/invited) upsert
   - `updateMember(memberId, patch)`: role/status のみ変更
   - `removeMember(memberId)`: status=removed
3. `@supabase/supabase-js` createClient を SERVICE_ROLE_KEY で初期化

**Commit**: `feat(spec 17b): extend firm-service with createFirm/invite/remove`

---

## Task 5: 新規ルート (auth + firms)

**Files**
- `server/src/routes/auth.ts` (新規)
- `server/src/routes/firms.ts` (新規)

**Steps**
1. Red → Green: `tests/routes/firms.test.ts` に 3 ケース追加してから実装
   - POST /api/firms/current/invite で Admin spy + FirmMember invited
   - PATCH /api/firms/current/members/:mid で role 更新
   - 他事務所のメンバーを触って 403
2. `auth.ts`:
   - `GET /api/auth/me` → `{ authUserId, firmId, role, email, firmName }`
3. `firms.ts`:
   - `GET /api/firms/current` → `{ id, name, slug, isDemo, memberCount }`
   - `GET /api/firms/current/members` (requireOwner) → FirmMember[]
   - `POST /api/firms/current/invite` (requireOwner) → inviteMember
   - `PATCH /api/firms/current/members/:mid` (requireOwner) → updateMember
   - `DELETE /api/firms/current/members/:mid` (requireOwner) → removeMember

**Commit**: `feat(spec 17b): add auth and firms routes`

---

## Task 6: server.ts — global preHandler + 新ルート登録

**Files**
- `server/src/server.ts`

**Steps**
1. AUTH_BYPASS リストを定義（spec の通り）
2. `app.addHook('preHandler', ...)` でバイパス判定 + requireAuth 呼び出し
3. `authRoutes` / `firmRoutes` を import して register

**Commit**: `feat(spec 17b): register auth middleware and new routes in server`

---

## Task 7: 既存テスト全件への認証ヘッダー追加

**Files**
- `tests/routes/*.test.ts` (6 ファイル)
- `tests/services/*.test.ts` (11 ファイル)

**Steps**
1. `authHeaders('test-user-id')` を各テストの inject に追加
2. AUTH_BYPASS 対象（/api/health, webhook 等）はヘッダ不要のまま
3. `npm test` で 133 → 133 PASS を確認

**Commit**: `test(spec 17b): add auth headers to all existing tests`

---

## Task 8: RLS Migration (Supabase)

**Files**
- `server/prisma/migrations/<timestamp>_rls_policies/migration.sql` (新規)

**Steps**
1. 全対象テーブルに `ENABLE ROW LEVEL SECURITY`
2. 各テーブルに tenant_isolation ポリシーを作成（spec の SQL パターン通り）
3. `FirmMember` 自体のポリシー
4. `Firm` テーブルのポリシー
5. RLS ポリシーは Supabase MCP の `apply_migration` で適用
   - ローカル test DB (5433) には RLS を入れない（テストが BYPASS しにくくなるため）
   - Supabase (本番) に apply_migration

**Commit**: `feat(spec 17b): add RLS policies migration`

---

## Task 9: CLIスクリプト

**Files**
- `server/scripts/create-firm.ts` (新規)
- `server/package.json` (scripts に create-firm 追加)

**Steps**
1. `minimist` or `process.argv` でオプション解析（--name, --slug, --owner-email）
2. `createFirm(...)` を呼ぶ
3. 成功時に firm id + 招待メール送信済みメッセージを出力

**Commit**: `feat(spec 17b): add create-firm CLI script`

---

## Task 10: フロント実装

**Files**
- `login.html` (新規)
- `auth/set-password.html` (新規)
- `auth/callback.html` (新規)
- `auth/forgot-password.html` (新規)
- `auth-shared.js` (新規)
- `script.js` (修正)
- `index.html` (修正)

**Steps**
1. `auth-shared.js`: `@supabase/supabase-js` CDN で Supabase client 初期化、session/signIn/signOut export
2. `login.html`: email/password + Google OAuth (supabase.auth.signInWithOAuth) ボタン
3. `auth/callback.html`: hash から session 取得 → localStorage に保存 → `/` へリダイレクト
4. `auth/set-password.html`: 招待リンクから来た user のパスワード設定
5. `auth/forgot-password.html`: パスワードリセットメール送信
6. `script.js`:
   - 冒頭で session チェック → 未ログインなら `/login.html` へ
   - fetch wrapper で `/api/*` に Authorization ヘッダを自動付与
   - `appState.user` に session 情報格納
7. `index.html`: ヘッダ右上にユーザー名 / 事務所名 / ログアウトボタン
8. `renderSettings` に Owner 限定メンバー管理セクション追加

**Commit**: `feat(spec 17b): add login UI and auth-shared integration`

---

## 実装順序

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10
```

T2〜T5 は T1 完了後に並列可能（依存なし）

---

## 事前確認事項（ユーザーに確認）

以下の値が `.env` に設定されている必要があります：

```
SUPABASE_URL=https://kmgjmlcijhgaqddtjdou.supabase.co
SUPABASE_ANON_KEY=<Supabase ダッシュボード → Project Settings → API>
SUPABASE_SERVICE_ROLE_KEY=<同上>
SUPABASE_JWT_SECRET=<同上 → JWT Settings>
```

これらが手元にない場合は Supabase ダッシュボードから取得してから T1 を開始します。

---

## 完了基準

- [ ] 全受入基準（spec 17b ゴール欄）が PASS
- [ ] vitest: 旧 133 + 新 11 = 144 件全 PASS
- [ ] `tsc --noEmit` で新規エラーなし（pre-existing 3 件を除く）
