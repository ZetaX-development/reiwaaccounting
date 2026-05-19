# 17. マルチテナント認証 + ユーザ管理 (Phase 1)

作成日: 2026-05-19

## 位置づけ

bookmee を複数の税理士事務所にパイロット導入するため、ログイン・ユーザ管理・テナント分離を追加する。Phase 1 は「ログインして自事務所のデータだけ見える」を最短で実現する範囲に絞り、細かいロール分け / MFA 強制 / 監査ログ / super-admin 画面 は Phase 2 以降に分ける。

### 既存スペックとの関係

- spec 01〜16 で作った全機能（Client / Voucher / OCR / 突合 / 仕訳ドラフト / Drive / LINE）はテナント分離されていない (= 全 user が全データを見える)。本 spec で **全テーブルに `firmId` を追加 + Row Level Security (RLS)** で事務所間の物理分離を導入する。
- 既存データ（日本橋工業含む 4 顧問先 + 全 voucher / inquiry / integration）は **「デモ事務所」配下に移行**。運営（kkouta）はデモ事務所の Owner として既存データを引き続き使える。パイロット先の事務所は別の Firm として作成し、その firm が自分の MF/freee に接続して顧問先データを引いてくる。

### MF/freee の read-only 原則との関係

変更なし。RLS による分離はあくまで bookmee 内のテナント間の話で、MF/freee に対しては従来通り read-only。

## ゴール

1. メールパスワード / Google OAuth でログインできる
2. ログイン後、自分が所属する事務所 (Firm) のデータのみ見える / 操作できる。他事務所のデータは API 経由でも DB 経由でも一切見えない
3. 運営側（kkouta）は CLI で新事務所 + 初期 Owner を作成、Supabase Auth 経由で招待メールを送れる
4. 事務所 Owner は自分の事務所にスタッフを招待 / 削除できる
5. 既存データ（日本橋工業 / aoyama-design 等）は「デモ事務所」配下で運営アカウントから見える
6. パイロット先の事務所は MF/freee に接続して顧問先データを引いてくる（このスペックの範囲外、既存の OAuth フローと連動）
7. **RLS で DB レベルにテナント分離を強制**。アプリのバグでも他事務所が漏れない

## アクター

- **運営 (kkouta)** — Firm 作成 + Owner 招待 (CLI)、デモ事務所の Owner として日常使い
- **事務所 Owner** — メンバー招待 / 削除 + 全データ操作可能
- **事務所 Member** — 自事務所内の全データ操作可能、メンバー管理不可
- **顧問先 (Client)** — Phase 1 ではログイン UI なし。outreach での問い合わせメール / LINE 返信のみ (既存仕様)

## アーキテクチャ

```
[ブラウザ]
  ├─ /login.html              Supabase JS SDK で signIn → JWT 取得
  ├─ /auth/set-password.html  招待リンクから来た時の初回パスワード設定
  └─ /index.html              本体アプリ。fetch wrapper が JWT を Authorization に付与
        │
        │ HTTPS + Bearer ${supabase_jwt}
        ▼
[Fastify on Cloud Run]
  ├─ preHandler: requireAuth
  │    1. JWT を Supabase JWKS で検証
  │    2. payload.sub = authUserId
  │    3. FirmMember を引いて status='active' を確認 → req.user に firmId / role 注入
  │    4. Prisma 接続に `SET LOCAL request.jwt.claims = '<JSON>'` を実行 → RLS が JWT を見る
  ├─ requireOwner: req.user.role === 'owner' でない場合 403
  └─ ルート群: /api/* は基本 requireAuth、webhook と /api/auth/* と /api/health はバイパス
        │
        ▼
[Supabase Postgres]
  ├─ auth schema (auth.users etc.) — Supabase が管理
  └─ public schema (Client / Voucher / Firm / FirmMember ... )
       全テーブルに firmId 列。RLS ポリシーで
       `firmId IN (SELECT firmId FROM FirmMember WHERE authUserId = current jwt.sub AND status='active')`
       を強制
```

## データモデル

### 新規テーブル

```prisma
model Firm {
  id        String   @id @default(cuid())
  name      String
  slug      String   @unique
  isDemo    Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  members  FirmMember[]
  clients  Client[]
  // 他テーブルは Client / Voucher 経由で接続するので
  // Firm からの直リレーションは最小限。
}

model FirmMember {
  id          String    @id @default(cuid())
  firm        Firm      @relation(fields: [firmId], references: [id], onDelete: Cascade)
  firmId      String
  authUserId  String                          // Supabase auth.users.id (UUID)
  role        String                          // 'owner' | 'member'
  email       String                          // 表示用キャッシュ (Supabase auth 側が真実)
  displayName String?
  invitedAt   DateTime?
  joinedAt    DateTime?
  status      String    @default("invited")   // 'invited' | 'active' | 'removed'
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@unique([firmId, authUserId])
  @@index([authUserId])
}
```

### 既存テーブルへの追加

以下のテーブルすべてに `firmId String` を追加（NOT NULL、Firm への外部キー）:

- Client
- VendorSync
- Entry
- Receipt
- Matching
- Task
- TaskHistory ← Task 経由なので不要 (削除カスケード済)
- Rule
- RuleHit ← Rule 経由
- Thread
- YearendCheck
- TrendDatum
- MonthlyCheck
- Voucher (Client 経由で取れるが、検索高速化のため firmId 直持ち)
- VoucherInquiry ← Voucher 経由
- LineUserMapping
- Integration
- DriveFolderMapping (Client + Firm 経由になる)
- DriveWatchChannel

### 既存ユニーク制約の変更

```prisma
model Integration {
  // 旧: @@unique([type])  →  1 グローバル設定
  @@unique([firmId, type])  // 事務所ごとに別々の連携
}
```

LineUserMapping の `lineUserId` も `[firmId, lineUserId]` でユニーク化 (同じ LINE user が複数事務所のスタッフを兼ねる可能性を許容)。

### RLS ポリシー

`Firm`, `FirmMember`, `ReceiptPolicy` 以外の全テーブルに次の形のポリシーを適用:

```sql
ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation_client" ON "Client"
  USING (
    "firmId" IN (
      SELECT "firmId" FROM "FirmMember"
      WHERE "authUserId" = (auth.jwt() ->> 'sub')::text
        AND "status" = 'active'
    )
  );
```

`FirmMember` 自体は「自分の所属している firm のメンバーは見える」ポリシー:

```sql
CREATE POLICY "tenant_isolation_firm_member" ON "FirmMember"
  USING (
    "firmId" IN (
      SELECT "firmId" FROM "FirmMember"
      WHERE "authUserId" = (auth.jwt() ->> 'sub')::text
        AND "status" = 'active'
    )
  );
```

`Firm` テーブルは「自分が所属している firm のみ」見える。

`ReceiptPolicy` は事務所横断のグローバル設定なので RLS なし (全 user が読める)。

### 既存データ移行

migration の手順:

```sql
-- 1. Firm / FirmMember テーブル作成
-- 2. 全テーブルに firmId 列を NULL 許容で追加
ALTER TABLE "Client" ADD COLUMN "firmId" TEXT;
-- (省略)

-- 3. デモ事務所を 1 つ作る
INSERT INTO "Firm" (id, name, slug, "isDemo", "updatedAt")
  VALUES ('demo-firm', 'bookmee デモ事務所', 'demo', true, NOW());

-- 4. 既存全レコードをデモ事務所に紐付け
UPDATE "Client" SET "firmId" = 'demo-firm' WHERE "firmId" IS NULL;
UPDATE "LineUserMapping" SET "firmId" = 'demo-firm';
UPDATE "Integration" SET "firmId" = 'demo-firm';
-- ... 全テーブル (Entry / Receipt / Matching / Voucher / Task / Rule / Thread / etc.)

-- 5. NOT NULL 制約 + 外部キー追加
ALTER TABLE "Client" ALTER COLUMN "firmId" SET NOT NULL;
ALTER TABLE "Client"
  ADD CONSTRAINT "Client_firmId_fkey"
  FOREIGN KEY ("firmId") REFERENCES "Firm"(id) ON DELETE CASCADE;
-- ... 全テーブル

-- 6. RLS 有効化 + ポリシー作成
ALTER TABLE "Client" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ... (前述)
-- ... 全テーブル

-- 7. 運営アカウント (kkouta@bookmee.jp 想定) を Supabase で作成して
--    FirmMember として demo-firm の owner にひも付け (手動 or bootstrap script)
```

## 環境変数追加

```env
# Supabase Auth
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=...                           # フロントの公開キー (JWT 検証も可能)
SUPABASE_SERVICE_ROLE_KEY=...                   # サーバ専用、RLS バイパス権限。CLI と admin endpoint で使う
SUPABASE_JWT_AUDIENCE=authenticated             # 通常デフォルト
SITE_URL=https://bookmee.example                # 招待リンクの戻り先 (本番 / ローカル)
```

`DATABASE_URL` は Supabase の Pooler URL に切替予定 (Phase 1 ではローカル開発用 docker-compose との両立を維持。本番デプロイ時に Supabase URL に切替)。

## 認証ミドルウェア (`server/src/middleware/auth.ts`)

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';

const JWKS = createRemoteJWKSet(
  new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } });
  }
  let payload;
  try {
    const result = await jwtVerify(auth.slice(7), JWKS, {
      issuer: `${env.SUPABASE_URL}/auth/v1`,
      audience: env.SUPABASE_JWT_AUDIENCE,
    });
    payload = result.payload;
  } catch {
    return reply.code(401).send({ error: { code: 'INVALID_TOKEN' } });
  }

  const member = await prisma.firmMember.findFirst({
    where: { authUserId: payload.sub as string, status: 'active' },
    select: { firmId: true, role: true, email: true },
  });
  if (!member) {
    return reply.code(403).send({ error: { code: 'NO_FIRM' } });
  }

  req.user = {
    authUserId: payload.sub as string,
    firmId: member.firmId,
    role: member.role as 'owner' | 'member',
    email: member.email,
  };

  // RLS のために JWT claims を session 変数にセット
  await prisma.$executeRawUnsafe(
    `SET LOCAL request.jwt.claims = '${JSON.stringify({
      sub: payload.sub,
      role: 'authenticated',
    })}'`,
  );
}

export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role !== 'owner') {
    return reply.code(403).send({ error: { code: 'OWNER_REQUIRED' } });
  }
}
```

### 認証バイパス対象

```ts
const AUTH_BYPASS = [
  '/api/health',
  '/api/auth/me',                                  // 自分自身は別 handler
  '/api/mf/oauth/callback',                        // Google OAuth callback
  '/api/integrations/drive/oauth/callback',
  '/api/integrations/drive/webhook',               // Google から
  '/api/integrations/line/webhook',                // LINE から (署名検証あり)
];
```

`buildApp` で global `preHandler` を登録、`url` が AUTH_BYPASS に含まれる場合は skip。

## サービス + API

### Firm / Member 関連

```ts
// server/src/services/firm-service.ts
export async function createFirm(input: { name, slug, ownerEmail }): Promise<Firm>;
//   1. Supabase Admin API で inviteUserByEmail(ownerEmail)
//   2. Prisma で Firm + FirmMember (role='owner', status='invited') 作成
//   3. firm を返す

export async function listMembers(firmId: string): Promise<FirmMember[]>;
export async function inviteMember(firmId, email, invitedBy): Promise<FirmMember>;
//   Supabase Admin API で invite + FirmMember (role='member', status='invited') 作成

export async function updateMember(memberId, patch): Promise<FirmMember>;
//   role / status のみ変更可

export async function removeMember(memberId): Promise<void>;
//   status='removed'。Supabase 側 user 自体は削除しない (他事務所兼任の可能性)
```

### 新規ルート

| メソッド | パス | 認可 | 役割 |
|---|---|---|---|
| GET | `/api/auth/me` | 認証済み | `{ authUserId, firmId, role, email, firmName }` |
| GET | `/api/firms/current` | 認証済み | 自事務所の基本情報 (`{ id, name, slug, isDemo, memberCount }`) |
| GET | `/api/firms/current/members` | Owner | メンバー一覧 |
| POST | `/api/firms/current/invite` | Owner | `{ email }` → 招待メール送信 |
| PATCH | `/api/firms/current/members/:mid` | Owner | `{ role?, status? }` |
| DELETE | `/api/firms/current/members/:mid` | Owner | `removeMember(:mid)` |

### CLI スクリプト

`server/scripts/create-firm.ts`:

```bash
npm run create-firm -- --name "ABC 会計事務所" --slug "abc" --owner-email owner@abc.co.jp
```

中身は `createFirm({...})` を呼ぶだけ。Service role キーを使うので `bypassRLS` で書き込める。

## フロント

### 新規ファイル

- `login.html` — Supabase JS で email/password + Google OAuth ボタン
- `auth/set-password.html` — 招待リンクから飛んできた user に初回パスワードを設定させる
- `auth/forgot-password.html` — パスワードリセットメール送信
- `auth/callback.html` — OAuth callback hash 受け取り → session.tokens を localStorage に保存して `/` へリダイレクト
- `auth-shared.js` — Supabase JS の wrapper (sessions / signIn / signOut)

### 既存 `script.js` への変更

冒頭で session チェック → 未ログインなら `/login.html` にリダイレクト:

```js
import { supabase } from './auth-shared.js';
const { data: { session } } = await supabase.auth.getSession();
if (!session) {
  window.location.href = '/login.html?redirect=' + encodeURIComponent(location.pathname + location.hash);
  // 以降の初期化はスキップ
}
appState.user = { ... session.user info ... };

// fetch wrapper: 全 /api/* リクエストに Authorization を自動付与
const _fetch = window.fetch;
window.fetch = (input, init = {}) => {
  if (typeof input === 'string' && input.startsWith('/api/')) {
    init.headers = { ...init.headers, Authorization: `Bearer ${session.access_token}` };
  }
  return _fetch(input, init);
};
```

### 設定ビュー (`renderSettings`) にメンバー管理セクションを追加

Owner のみ可視:

```
事務所メンバー (3 / 10)
+ 招待 (email + send button)

table:
  email             |  role    |  status   |  joined   |  action
  -------------------------------------------------------------
  owner@abc.co.jp   | owner    | active    | 2026-05-10| -
  staff@abc.co.jp   | member   | active    | 2026-05-12| 削除
  newbie@abc.co.jp  | member   | invited   | -         | 削除
```

### ヘッダ右上

ユーザー名 / 事務所名 / ログアウトボタン。`appState.user` から取得。

## テスト

### 認証 helper (`tests/helpers/auth.ts`)

```ts
import { SignJWT } from 'jose';

export async function signTestToken(opts: {
  authUserId: string;
  email?: string;
}): Promise<string> {
  // テスト用の secret で署名 (Supabase の jwt_secret を tests/.env に置く想定)
  const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
  return new SignJWT({ sub: opts.authUserId, email: opts.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('1h')
    .sign(secret);
}

export async function authHeaders(authUserId: string) {
  const token = await signTestToken({ authUserId });
  return { Authorization: `Bearer ${token}` };
}
```

テスト中は `requireAuth` の JWKS 検証を `vi.spyOn` で localの secret 検証に差し替えるか、test DB に対しては JWKS endpoint を mock する。

### 新規テストファイル

- `tests/services/firm-service.test.ts` (4 ケース)
  - createFirm が Supabase Admin API spy を呼んで Firm + FirmMember を作る
  - listMembers が自 firm のメンバーのみ返す (RLS 動作)
  - inviteMember で email が送られる
  - removeMember で status=removed

- `tests/middleware/auth.test.ts` (4 ケース)
  - JWT 無し → 401
  - 不正 JWT → 401
  - 有効 JWT + FirmMember 無し → 403
  - 有効 JWT + active FirmMember → req.user セット

- `tests/routes/firms.test.ts` (3 ケース)
  - POST /api/firms/current/invite で Supabase admin spy + FirmMember invited
  - PATCH /api/firms/current/members/:mid で role 更新
  - 他事務所のメンバー触ろうとして 403

### 既存テストの全件更新

131 件すべての `app.inject(...)` 呼び出しに `Authorization: Bearer ${testToken}` ヘッダを付与。test setup で「テスト用の demo-firm + テスト user」を 1 件 seed → 全テストはそのユーザとして実行。AUTH_BYPASS 対象のテスト (webhook 等) はヘッダ不要。

## 受入基準

- [ ] `npm run prisma:migrate` で Firm / FirmMember 作成 + 全テーブルに firmId 追加 + RLS ポリシー適用
- [ ] `/login.html` で email/password ログインができる
- [ ] `npm run create-firm -- --name X --slug y --owner-email z@example.com` で Firm 作成 + 招待メール送信
- [ ] 招待リンクから `/auth/set-password.html` でパスワード設定 → ログイン → 自事務所のデータのみ見える
- [ ] 他事務所の Voucher の id を直接 `GET /api/vouchers/<id>/image` で叩いても 404
- [ ] 他事務所の Client の id を `PATCH /api/vouchers/:id` の body に入れても 403 or 404
- [ ] Owner はメンバー一覧 + 招待 + 削除ができる、Member は 403
- [ ] 既存データ（4 顧問先 + 全 voucher）はデモ事務所所属で運営アカウントから見える
- [ ] vitest 全テスト (旧 131 + 新 11 = 142) PASS
- [ ] `tsc --noEmit` で新規エラー無し (既存の pre-existing は除く)

## 非ゴール (Phase 2 以降)

- MFA 強制 / 任意 (Phase 2)
- SAML SSO / OIDC (Phase 3)
- 監査ログ (誰が何をいつ操作したか) (Phase 2)
- アシスタント / 経理担当 等の細かいロール分け (Phase 2)
- 顧問先 (Client) 側の login (Phase 3)
- 1 ユーザ複数事務所所属 (Phase 1.5)
- super-admin 画面 = 運営用ダッシュボード (Phase 2)
- パスワード変更 / プロフィール編集 UI (Phase 1.5)
- セッションタイムアウト / 強制ログアウト (Phase 2)
- ベンダー (MF/freee) トークンの firm-level 共有 (Phase 2、現状は Client ごと保管のまま)

## セキュリティ補強

- Supabase JWT は **JWKS で署名検証** (シークレット共有不要、ローテーション容易)
- RLS は DB レベル → アプリのバグで他事務所が漏れない最終防衛
- `SUPABASE_SERVICE_ROLE_KEY` は Cloud Run の Secret Manager に保管、コンテナ環境変数で注入
- 招待メール link の有効期限 24h (Supabase デフォルト)
- パスワードリセット link の有効期限 24h
- ログイン失敗のレート制限 (Supabase 内蔵、5 回 / 15 分 / IP)
- フロントの JWT は localStorage 保管 (Supabase JS のデフォルト)。XSS 対策は CSP で別途強化
- CSRF: 全 API は Authorization ヘッダ必須 (cookie ベースでないので CSRF リスクなし)
- HTTPS 強制 (Cloud Run でデフォルト)

## メモ: なぜ Auth0 / Clerk ではなく Supabase Auth か

- DB と Auth が同じ Supabase Postgres にあるため **RLS と直接連携**できる (Auth0 / Clerk だと外部 JWT を毎クエリで検証 → 同じ DB に書き込む形になる)
- 50,000 MAU まで Free。Auth0 は 7,000 MAU で $240/月、Clerk は 10,000 MAU で $25/月の上に超過課金 → スケール時のコスト差が大きい
- GoTrue (Supabase Auth の中身) は OSS で、必要なら Supabase を抜けて self-host できる (vendor lock-in 弱め)
