# GCP デプロイ手順 (Cloud Run + Cloud SQL)

zeimee をローカル WSL → Cloud Run に持っていく最短経路の手順。1 アカウントの個人プロト前提で、IaC は使わず `gcloud` コマンドベース。

## アーキテクチャ

```
[ブラウザ / LINE / Google Drive]
        │ HTTPS (Cloud Run が自動発行)
        ▼
[Cloud Run service: zeimee]   ← コンテナは server/Dockerfile.prod でビルド (context=repo root)
        │ /cloudsql/<conn> UNIX socket
        ▼
[Cloud SQL: PostgreSQL 16]
        ▲
        └─ env / secret 値 ── Secret Manager
```

- 静的フロント (`index.html` / `script.js` / `styles.css`) は同 image に同梱、Fastify が `staticPlugin` で配信
- ローカル開発の `docker-compose.yml` + `server/Dockerfile` は本番デプロイには **使わない**（`.dockerignore` / `.gcloudignore` で除外済）
- ビルドは `cloudbuild.yaml` で `server/Dockerfile.prod` を指定して走らせる

## 0. 事前準備

```bash
# gcloud CLI を入れて認証 (1 回だけ)
gcloud auth login
gcloud config set project <PROJECT_ID>

# 必要 API を有効化
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com
```

リージョン: 以下の手順では `asia-northeast1` (東京) を仮定。変えたければ `REGION=...` を全コマンドで上書き。

```bash
export PROJECT_ID=<your-project-id>
export REGION=asia-northeast1
export SERVICE=zeimee
```

## 1. Cloud SQL (PostgreSQL 16) を立てる

```bash
gcloud sql instances create zeimee-pg \
  --database-version=POSTGRES_16 \
  --region=$REGION \
  --tier=db-f1-micro \
  --storage-size=10GB \
  --storage-type=SSD

# DB とユーザを作成
gcloud sql databases create zeimee --instance=zeimee-pg
gcloud sql users create zeimee --instance=zeimee-pg --password=<STRONG_PASSWORD>

# インスタンス接続名を取得 (後で使う)
gcloud sql instances describe zeimee-pg --format='value(connectionName)'
# → 例: my-project:asia-northeast1:zeimee-pg
export SQL_CONN=$(gcloud sql instances describe zeimee-pg --format='value(connectionName)')
```

## 2. Secret Manager に env を入れる

機密値は `--set-env-vars` で渡すと履歴に残るので、Secret Manager に置いて Cloud Run から参照させる。

```bash
# DATABASE_URL は Cloud SQL Auth Proxy 経由 (UNIX socket)
echo -n "postgresql://zeimee:<STRONG_PASSWORD>@localhost/zeimee?host=/cloudsql/$SQL_CONN" \
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
  --add-cloudsql-instances=$SQL_CONN \
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

開発時のダミー顧問先を本番に入れる必要は通常ない。**入れる場合のみ** Cloud SQL に一時接続して `npm run seed` を流す:

```bash
# ローカルに Cloud SQL Auth Proxy をダウンロードして起動
gcloud sql connect zeimee-pg --user=zeimee
# (パスワード入力後、SQL prompt で psql 操作するか、別 shell から DATABASE_URL を設定して
#  cd server && npm run seed)
```

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
- **Cloud SQL Auth Proxy は UNIX socket**。`DATABASE_URL` の `host=/cloudsql/<conn>` を忘れない。
- **Cloud Run のリクエストタイムアウトは最大 60 分** (`--timeout`)。LINE webhook は 30 秒以内に 200 を返す必要があるので、heavy 処理は `setImmediate` で fire-and-forget (本リポジトリは実装済)。
- **Cloud Run の cold start**: `--min-instances=1` にすると常時 1 instance 待機、料金は増える。LINE webhook の cold start delay が気になるなら 1 にする。
- **`prisma migrate deploy` は cold start のたびに走るが冪等**。pending migration が無ければ即座に skip。
- **画像バイナリは Voucher の BYTEA に入る**。データ量が増えたら Cloud Storage への移行を spec 17 以降で検討（spec 10 にも記載）。
