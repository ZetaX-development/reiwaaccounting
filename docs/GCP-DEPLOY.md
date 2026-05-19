# デプロイ手順 (GCP Cloud Run + Supabase)

zeimee をローカル WSL → 本番に持っていく最短経路。1 アカウントの個人プロト前提で、IaC は使わず `gcloud` + Supabase ダッシュボードベース。

**DB は Cloud SQL ではなく Supabase**（Cloud SQL の最小インスタンスでも月 $7+、Supabase は free tier で 500MB / 60 connections まで無料）。Postgres 16 互換なので Prisma と zeimee のコードは完全にそのまま動く。

## アーキテクチャ

```
[ブラウザ / LINE / Google Drive]
        │ HTTPS (Cloud Run が自動発行)
        ▼
[Cloud Run service: zeimee]   ← コンテナは server/Dockerfile.prod でビルド (context=repo root)
        │ Postgres over TLS (port 5432)
        ▼
[Supabase: managed PostgreSQL 16 (free tier)]
        ▲
        └─ env / secret 値 ── GCP Secret Manager
```

- 静的フロント (`index.html` / `script.js` / `styles.css`) は同 image に同梱、Fastify が `staticPlugin` で配信
- ローカル開発の `docker-compose.yml` + `server/Dockerfile` は本番デプロイには **使わない**（`.dockerignore` / `.gcloudignore` で除外済）
- ビルドは `cloudbuild.yaml` で `server/Dockerfile.prod` を指定して走らせる
- DB マイグレーションは Cloud Run の cold start で `prisma migrate deploy` が自動適用（冪等）

## 0. 事前準備

```bash
# gcloud CLI を入れて認証 (1 回だけ)
gcloud auth login
gcloud config set project <PROJECT_ID>

# 必要 API を有効化 (sqladmin は Supabase を使うので不要)
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com
```

リージョン: 以下の手順では `asia-northeast1` (東京) を仮定。変えたければ `REGION=...` を全コマンドで上書き。

```bash
export PROJECT_ID=<your-project-id>
export REGION=asia-northeast1
export SERVICE=zeimee
```

## 1. Supabase で Postgres を準備する

ブラウザで操作:

1. https://supabase.com にサインアップ / ログイン
2. **New Project** で作成
   - Name: `zeimee` (何でもよい)
   - Database Password: **強いパスワードを生成してメモ**（後で使う）
   - Region: `Northeast Asia (Tokyo)` を推奨（Cloud Run と近い region）
   - Plan: Free
3. プロジェクト立ち上げ完了まで 2-3 分待つ

接続文字列を取得:

1. **Settings → Database → Connection string** を開く
2. **URI** タブを選ぶ（`Direct connection`、port 5432）
3. パスワード欄に上で設定したパスワードを入れて、表示された URL をコピー
   - 形は `postgresql://postgres.xxxxx:<PASSWORD>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`
   - **`.pooler.supabase.com`** ではなく **直接接続 (port 5432)** を使う。Prisma のマイグレーションが prepared statements で衝突しないため
4. 末尾に `?sslmode=require` を付ける

最終的な DATABASE_URL の例:

```
postgresql://postgres.xxxxxxxx:<PASSWORD>@db.xxxxxxxx.supabase.co:5432/postgres?sslmode=require
```

メモして `<SUPABASE_DB_URL>` として後の手順で使う。

## 2. Secret Manager に env を入れる

機密値は `--set-env-vars` で渡すと履歴に残るので、Secret Manager に置いて Cloud Run から参照させる。

```bash
# DATABASE_URL は Supabase の direct connection (上の手順で取得した URL)
echo -n "<SUPABASE_DB_URL>" \
  | gcloud secrets create zeimee-database-url --data-file=-

# LINE
gcloud secrets create zeimee-line-channel-access-token --data-file=<(echo -n "<TOKEN>")
gcloud secrets create zeimee-line-channel-secret --data-file=<(echo -n "<SECRET>")

# Google (Drive 連携)
gcloud secrets create zeimee-google-client-id --data-file=<(echo -n "<CID>")
gcloud secrets create zeimee-google-client-secret --data-file=<(echo -n "<CSECRET>")

# MF (任意、必要なら)
gcloud secrets create zeimee-mf-client-id --data-file=<(echo -n "<CID>")
gcloud secrets create zeimee-mf-client-secret --data-file=<(echo -n "<CSECRET>")

# OpenAI Vision
gcloud secrets create zeimee-openai-api-key --data-file=<(echo -n "<KEY>")
```

Cloud Run サービスアカウントに secret アクセス権を付与:

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for s in zeimee-database-url zeimee-line-channel-access-token zeimee-line-channel-secret \
         zeimee-google-client-id zeimee-google-client-secret zeimee-mf-client-id \
         zeimee-mf-client-secret zeimee-openai-api-key; do
  gcloud secrets add-iam-policy-binding $s \
    --member=serviceAccount:$SA \
    --role=roles/secretmanager.secretAccessor
done
```

## 3. Cloud Build でコンテナを build & push

```bash
# Artifact Registry のリポジトリを 1 回だけ作る
gcloud artifacts repositories create zeimee \
  --repository-format=docker \
  --location=$REGION

# repo root の cloudbuild.yaml + server/Dockerfile.prod でビルド & push
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions=_PROJECT=$PROJECT_ID,_REGION=$REGION,_REPO=zeimee \
  .
```

`gcloud builds submit` は `.gcloudignore` を見て送信ファイルを除外するので、`docker-compose.yml` や `docs/` は送られない。`cloudbuild.yaml` は SHORT_SHA と `latest` の 2 タグを Artifact Registry に push する。

## 4. Cloud Run にデプロイ

```bash
SHORT_SHA=$(git rev-parse --short HEAD)
gcloud run deploy $SERVICE \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/zeimee/server:$SHORT_SHA \
  --region=$REGION \
  --platform=managed \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production" \
  --set-secrets="DATABASE_URL=zeimee-database-url:latest" \
  --set-secrets="LINE_CHANNEL_ACCESS_TOKEN=zeimee-line-channel-access-token:latest" \
  --set-secrets="LINE_CHANNEL_SECRET=zeimee-line-channel-secret:latest" \
  --set-secrets="GOOGLE_CLIENT_ID=zeimee-google-client-id:latest" \
  --set-secrets="GOOGLE_CLIENT_SECRET=zeimee-google-client-secret:latest" \
  --set-secrets="MF_CLIENT_ID=zeimee-mf-client-id:latest" \
  --set-secrets="MF_CLIENT_SECRET=zeimee-mf-client-secret:latest" \
  --set-secrets="OPENAI_API_KEY=zeimee-openai-api-key:latest" \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=2 \
  --timeout=300
```

デプロイ完了すると公開 URL が出る (`https://zeimee-xxxxx-an.a.run.app` 等)。

```bash
export RUN_URL=$(gcloud run services describe $SERVICE --region=$REGION --format='value(status.url)')
echo $RUN_URL
```

## 5. 公開 URL を各サービスに反映

### Google OAuth (Drive 連携)

GCP Console → OAuth 同意画面 → クライアント ID → **承認済みのリダイレクト URI** に追加:

```
${RUN_URL}/api/integrations/drive/oauth/callback
```

その後、Cloud Run の env も更新:

```bash
gcloud run services update $SERVICE --region=$REGION \
  --update-env-vars="GOOGLE_REDIRECT_URI=${RUN_URL}/api/integrations/drive/oauth/callback" \
  --update-env-vars="GOOGLE_DRIVE_WEBHOOK_BASE_URL=${RUN_URL}"
```

### LINE Messaging API (webhook)

LINE Developers Console → Messaging API channel → Webhook 設定:

```
Webhook URL: ${RUN_URL}/api/integrations/line/webhook
Use webhook: ON
Auto-reply messages: OFF
```

「Verify」ボタンで 200 が返れば疎通 OK。

Cloud Run 側にも `LINE_WEBHOOK_BASE_URL` を反映 (画面表示用):

```bash
gcloud run services update $SERVICE --region=$REGION \
  --update-env-vars="LINE_WEBHOOK_BASE_URL=${RUN_URL}"
```

### MF OAuth

MF Developers Portal → 連携アプリ → **リダイレクト URI** に追加:

```
${RUN_URL}/api/mf/oauth/callback
```

```bash
gcloud run services update $SERVICE --region=$REGION \
  --update-env-vars="MF_REDIRECT_URI=${RUN_URL}/api/mf/oauth/callback"
```

## 6. seed (初回 / 任意)

本番に開発用のダミー顧問先 (`aoyama-design` 等) を入れる必要は通常ない。**入れる場合のみ** ローカルから Supabase に向けて `npm run seed` を流す:

```bash
cd server
DATABASE_URL='<SUPABASE_DB_URL>' npm run seed
# → "Seed complete. clients=4"
```

Supabase ダッシュボードの **Table Editor** で `Client` テーブルに 4 行入っていることを確認できる。

## 7. 動作確認

```bash
curl -s $RUN_URL/api/health
# → {"ok":true}

curl -s $RUN_URL/api/integrations/line
# → {"connected":true,"channelId":"...","webhookUrl":".../api/integrations/line/webhook",...}

curl -sX POST $RUN_URL/api/integrations/line/verify
# → {"ok":true,"botInfo":{...}}

curl -s $RUN_URL/api/integrations/drive
# → {"connected":false}  (まだ OAuth してないので false)
```

ブラウザで `$RUN_URL/` を開くとフロント。「連携 / LINE」「連携 / Google Drive」が表示されて、それぞれ接続ボタン / 友だち追加 / mapping ができる。

## 8. 再デプロイ

コード変更後:

```bash
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions=_PROJECT=$PROJECT_ID,_REGION=$REGION,_REPO=zeimee \
  .

SHORT_SHA=$(git rev-parse --short HEAD)
gcloud run services update $SERVICE --region=$REGION \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/zeimee/server:$SHORT_SHA
```

env / secret を変えるときは `--set-secrets` / `--update-env-vars` を渡し直す。

## 9. ローカル開発との関係

| 観点 | ローカル | Cloud Run |
|---|---|---|
| Dockerfile | `server/Dockerfile` (tsx watch、hot reload) | `server/Dockerfile.prod` (multi-stage、本番ビルド) |
| 起動 | `docker compose up` or `npm run dev` | `gcloud run deploy` |
| Build context | `./server` | repo root (フロント静的ファイルを含めるため) |
| Postgres | `docker compose` で同居 | Cloud SQL (Auth Proxy) |
| URL | `http://localhost:3000` | `https://...run.app` |
| Webhook | 不可 (HTTPS なし) | OK |
| Push Notification (Drive watch) | `GOOGLE_DRIVE_WEBHOOK_BASE_URL` 空で手動 sync のみ | URL 設定で自動受信 |

ローカルで本番イメージを試したいとき:

```bash
docker build -f server/Dockerfile.prod -t zeimee:prod .
docker run --rm --name zeimee-prod-test \
  --add-host=host.docker.internal:host-gateway \
  -e DATABASE_URL='postgresql://zeimee:zeimee_dev@host.docker.internal:5432/zeimee' \
  -e LINE_CHANNEL_ACCESS_TOKEN='dummy' -e LINE_CHANNEL_SECRET='dummy' \
  -p 8081:3000 zeimee:prod
```

ローカルでロジック検証 → push & deploy で webhook / 公開 URL を要する機能を最終確認、というフローを想定。

## 10. 既知の落とし穴

- **Cloud Run の `PORT` は環境変数で渡されるので `process.env.PORT` を尊重**。本リポジトリの `env.ts` は `PORT` を読むので OK。
- **Supabase は TLS 必須**。DATABASE_URL の末尾に `?sslmode=require` を忘れない。Prisma は `sslmode=require` を素直に解釈する。
- **Supabase の free tier は max_connections=60**。Cloud Run の `--max-instances=2` × 1 instance あたり Prisma の `connection_limit`（デフォルト 10）程度なら余裕。トラフィックが増えて足りなくなったら Supabase 側で Pro plan (max=200) に上げるか、Prisma の `?pgbouncer=true&connection_limit=1` で Pooler 経由に切り替える。
- **Supabase は inactivity で `paused` になる**（free tier は 1 週間未使用で）。pause されると DB アクセスが失敗するので、ダッシュボードから resume するか cron で週 1 回 ping する。
- **Cloud Run のリクエストタイムアウトは最大 60 分** (`--timeout`)。LINE webhook は 30 秒以内に 200 を返す必要があるので、heavy 処理は `setImmediate` で fire-and-forget (本リポジトリは実装済)。
- **Cloud Run の cold start**: `--min-instances=1` にすると常時 1 instance 待機、料金は増える。LINE webhook の cold start delay が気になるなら 1 にする。
- **`prisma migrate deploy` は cold start のたびに走るが冪等**。pending migration が無ければ即座に skip。Supabase に DB スキーマが存在しない初回起動時に migrations 6 件を一気に流す。
- **画像バイナリは Voucher の BYTEA に入る**。Supabase free tier 500MB ストレージなので、数百枚程度までは耐える。本格運用するなら Cloud Storage への移行を spec 17 以降で検討（spec 10 にも記載）。
