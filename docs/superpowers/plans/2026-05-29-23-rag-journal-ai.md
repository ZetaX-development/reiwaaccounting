# Plan 23: RAG仕訳AIエンジン 実装タスクリスト

**対応spec**: `docs/superpowers/specs/2026-05-29-23-rag-journal-ai-design.md`

---

## Task 1: 仕訳パターンコーパス作成

**Files**
- `server/src/data/journal-patterns.ts` (新規)

**Step 1**: 日本SMB会計の仕訳パターンを500件以上収集・定義する
- 公開情報（国税庁・MF・弥生・freee・簿記テキスト）を参照
- 以下カテゴリを網羅:
  - 売上・収益 (~60): 売掛金/売上高, 現金/売上高, 受取手形/売上高, 普通預金/売上高, 売上値引/売掛金 ...
  - 仕入・原価 (~50): 仕入高/買掛金, 仕入高/現金, 棚卸資産/期首棚卸, 期末棚卸/棚卸資産 ...
  - 人件費 (~40): 給料手当/普通預金, 役員報酬/未払費用, 法定福利費/普通預金, 退職給付費用/退職給付引当金 ...
  - 販管費・経費 (~100): 旅費交通費, 通信費, 広告宣伝費, 接待交際費, 地代家賃, 水道光熱費, 消耗品費, 修繕費, 保険料 ...
  - 固定資産 (~40): 建物/普通預金, 工具器具備品/未払金, 減価償却費/建物, 減価償却費/工具器具備品 ...
  - 金融・借入 (~40): 普通預金/長期借入金, 長期借入金/普通預金, 支払利息/普通預金, 受取利息/普通預金 ...
  - 税金・社会保険 (~50): 法人税等/未払法人税等, 租税公課/現金, 社会保険料/普通預金 ...
  - 決算整理 (~40): 前払費用/支払保険料, 未収収益/受取利息, 売上原価/棚卸資産, 繰延税金資産/法人税等 ...
  - 仮払・立替・その他 (~80): 仮払金/普通預金, 立替金/現金, 預り金/現金, 仮受消費税/売掛金 ...

**Step 2**: 各パターンに以下を付与
- `debit`: MFクラウド会計の勘定科目名と一致させる
- `credit`: 同上
- `scenario`: 1行で何のビジネスイベントか説明
- `memoExamples`: 実際の摘要例を5〜10個
- `industry`: null（汎用）or '小売業'/'飲食業'/'建設業'/'IT業'/'医療'等
- `tags`: 検索を補助するキーワード配列

**Commit**: `feat(spec23): 仕訳パターンコーパス500件作成`

---

## Task 2: Prismaスキーマ更新

**Files**
- `server/prisma/schema.prisma`
- `server/prisma/migrations/` (新規migration)

**Step 1**: JournalPatternモデル追加
```prisma
model JournalPattern {
  id            String   @id @default(cuid())
  debit         String
  credit        String
  scenario      String
  memoExamples  String[]
  industry      String?
  tags          String[]
  amountHint    String?
  embeddingJson String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([debit, credit])
}
```

**Step 2**: JournalAiReview.status コメントに 'difficult' 追加
```prisma
// pending | approved | skipped | auto_applied | difficult
status String @default("pending")
```

**Step 3**: マイグレーション実行
```bash
cd server
TS=$(date +%Y%m%d%H%M%S)
mkdir -p prisma/migrations/${TS}_add_journal_pattern
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/${TS}_add_journal_pattern/migration.sql
npx prisma migrate resolve --applied "${TS}_add_journal_pattern"
docker compose exec -T postgres psql -U bookmee -d bookmee \
  -f - < prisma/migrations/${TS}_add_journal_pattern/migration.sql
# test DB にも適用
docker compose exec -T postgres-test psql -U bookmee -d bookmee_test \
  -f - < prisma/migrations/${TS}_add_journal_pattern/migration.sql
npx prisma generate
```

**Commit**: `feat(spec23): JournalPatternモデル追加・マイグレーション`

---

## Task 3: journal-pattern-service.ts 作成

**Files**
- `server/src/services/journal-pattern-service.ts` (新規)
- `server/tests/services/journal-pattern-service.test.ts` (新規)

**Step 1 (RED)**: テストを先に書く
```ts
// テスト項目:
// - cosineSimilarity: 同一ベクトルで1.0, 直交で0.0
// - findByExactMatch: (debit,credit)完全一致で正しいパターン返却
// - findSimilar: モックembeddingで類似パターン返却
// - loadPatternsCache: DB未接続時はエラーなく空配列返却
```

**Step 2 (GREEN)**: 実装

```ts
// journal-pattern-service.ts の公開インターフェース:

// embedding生成（OpenAI text-embedding-3-small）
export async function generateEmbedding(text: string): Promise<number[]>

// テキストクエリで類似パターン検索 (メモリキャッシュから)
// debit/credit完全一致を上位に, cosine similarity で残りを補完
export async function findSimilarPatterns(
  debit: string,
  credit: string,
  queryText: string,
  topK: number = 5
): Promise<JournalPatternWithSimilarity[]>

// 全パターンのembeddingを生成してDBに保存
// embeddingJsonがすでにあればスキップ
export async function seedEmbeddings(): Promise<{ seeded: number; skipped: number }>

// 起動時にパターンを全件メモリロード
export async function loadPatternsCache(): Promise<void>

// コサイン類似度計算（純粋関数、テスト容易）
export function cosineSimilarity(a: number[], b: number[]): number
```

**Step 3 (REFACTOR)**: TypeScript型を整理

**Commit**: `feat(spec23): journal-pattern-service実装`

---

## Task 4: journal-rag-service.ts 作成

**Files**
- `server/src/services/journal-rag-service.ts` (新規)
- `server/tests/services/journal-rag-service.test.ts` (新規)

**Step 1 (RED)**: テストを書く
```ts
// テスト項目:
// - generateMemoWithRag: OpenAIモック → confidence 0.9 → auto_applied
// - generateMemoWithRag: OpenAIモック → confidence 0.5 → difficult
// - generateMemoWithRag: OpenAIモック → canJudge=false → difficult
// - プロンプトに参考パターンが含まれている
```

**Step 2 (GREEN)**: 実装

```ts
// journal-rag-service.ts の公開インターフェース:

export interface RagResult {
  memo: string;
  confidence: number;
  reasoning: string;
  canJudge: boolean;
  routing: 'auto_applied' | 'pending' | 'difficult';
  patternsUsed: string[]; // 使用パターンのid
}

// メインRAG関数
export async function generateMemoWithRag(input: {
  debit: string;
  credit: string;
  amount: number;
  date: string;
  originalMemo: string;
}): Promise<RagResult>
```

**GPT-4o プロンプト（仕様通り）**:
- System: 日本会計専門家ロール
- User: 参考パターン5件 + 入力仕訳
- response_format: json_object
- model: 'gpt-4o'（gpt-4o-mini から変更）

**Routing ロジック**:
```ts
function routeByConfidence(confidence: number, canJudge: boolean): RagResult['routing'] {
  if (!canJudge || confidence < 0.60) return 'difficult';
  if (confidence >= 0.85) return 'auto_applied';
  return 'pending';
}
```

**Commit**: `feat(spec23): journal-rag-service実装`

---

## Task 5: journal-ai-review-service.ts 書き換え

**Files**
- `server/src/services/journal-ai-review-service.ts` (全面書き換え)
- `server/tests/services/journal-ai-review-service.test.ts` (更新)

**Step 1**: 既存 `suggestMemo()` を削除し `generateMemoWithRag()` に置き換え

**Step 2**: `processBlankMemoJournals()` の routing ロジックを3段階に変更

```ts
// routing 処理
switch (ragResult.routing) {
  case 'auto_applied':
    // localOnly=false の場合 MF PUT（既存ロジック）
    status = 'auto_applied';
    break;
  case 'pending':
    status = 'pending';
    break;
  case 'difficult':
    status = 'difficult';
    // Todoに自動追加
    await prisma.todo.create({
      data: {
        firmId,
        clientId,
        title: `AI判断困難: ${debit} / ${credit} ¥${amount.toLocaleString('ja-JP')}`,
        note: `仕訳日: ${transactionDate}\nAI理由: ${ragResult.reasoning}\nMF仕訳ID: ${j.id}`,
      },
    });
    break;
}
```

**Step 3**: `ProcessResult` に `difficult` カウント追加

```ts
export interface ProcessResult {
  total: number;
  autoApplied: number;
  pending: number;
  difficult: number; // 追加
  errors: number;
}
```

**Step 4 (RED → GREEN)**: テスト更新・実行

**Commit**: `feat(spec23): journal-ai-review-serviceをRAGベースに移行`

---

## Task 6: seed:patterns スクリプト

**Files**
- `server/scripts/seed-journal-patterns.ts` (新規)
- `server/package.json` (scripts追加)

**Step 1**: スクリプト実装
```ts
// 1. journal-patterns.ts の全パターンを JournalPattern テーブルに upsert
//    (debit, credit, scenario の組み合わせが同じなら更新、なければ挿入)
// 2. seedEmbeddings() を呼び出してembedding生成・保存
// 3. 完了件数をログ出力
```

**Step 2**: package.json に追加
```json
"seed:patterns": "tsx scripts/seed-journal-patterns.ts"
```

**Step 3**: 動作確認
```bash
cd server && npm run seed:patterns
# 期待: "Seeded 500 patterns, generated 500 embeddings" 等のログ
```

**Commit**: `feat(spec23): seed:patternsスクリプト追加`

---

## Task 7: APIルート追加

**Files**
- `server/src/routes/journal-patterns.ts` (新規)
- `server/src/server.ts` (register追加)

**Step 1**: ルート実装
```ts
// POST /api/journals/patterns/seed
// → seed:patterns スクリプトと同じ処理をHTTP経由で実行

// GET /api/journals/patterns?debit=X&credit=Y
// → JournalPattern テーブルから検索（デバッグ・確認用）
```

**Step 2**: server.ts に register 追加

**Commit**: `feat(spec23): journal-patternsルート追加`

---

## Task 8: フロントエンド変更

**Files**
- `script.js`
- `styles.css`

### 8-1. mf-review ビュー

**Step 1**: フィルターボタンに `difficult` を追加
```js
// 既存: ['pending', 'completed']
// 変更後: ['pending', 'difficult', 'completed']
```

**Step 2**: `difficult` カードのスタイリング
- バッジ: 赤背景「AI判断困難」
- アクション: 「Todoに追加済み」テキスト（クリック不要）

**Step 3**: 確認バナーのカウント更新
- 既存 `aiPendingCount` = pending のみ
- 新規 `aiDifficultCount` を dashboard API から返す
- バナーに「判断困難: N件」を追加表示

### 8-2. ダッシュボード API 側

**Files**: `server/src/routes/client.ts` または dashboard 集計ロジック

- `GET /api/clients/:id/todos` レスポンスに `aiDifficultCount` 追加
  ```ts
  const aiDifficultCount = await prisma.journalAiReview.count({
    where: { clientId, status: 'difficult' },
  });
  ```

**Commit**: `feat(spec23): フロントエンドにdifficultバッジ・フィルター追加`

---

## Task 9: 統合テスト・仕上げ

**Files**
- `server/tests/services/journal-ai-review-service.test.ts` (確認・補完)

**Step 1**: エンドツーエンドの流れをテスト
1. DBにパターンを手動insert
2. processBlankMemoJournals を実行（OpenAIモック）
3. stats.difficult > 0 を確認
4. prisma.todo に「AI判断困難」レコードがあることを確認

**Step 2**: npm test 全件パス確認

**Step 3**: README/CLAUDE.md の変更は不要（CLAUDE.mdは変更しない）

**Commit**: `test(spec23): RAG仕訳AIエンジン統合テスト`

---

## 実装順序

```
Task 1 (コーパス) → Task 2 (schema) → Task 3 (pattern-svc)
  → Task 4 (rag-svc) → Task 5 (review-svc) → Task 6 (seed)
  → Task 7 (routes) → Task 8 (フロント) → Task 9 (統合テスト)
```

Task 1〜2 は並列実行可能。Task 3〜4 は Task 2 完了後。
Task 5 は Task 3・4 完了後。以降は逐次。

---

## 完了確認チェックリスト

- [ ] `npm run seed:patterns` が成功する
- [ ] `npm test` が全件パス
- [ ] `POST /api/clients/:id/journals/ai-review/process` でRAGが動く
- [ ] confidence < 0.60 の仕訳が status='difficult' になる
- [ ] difficult 仕訳に対応するTodoが自動生成される
- [ ] UIで difficult フィルターが機能する
- [ ] 赤バッジ「AI判断困難」が表示される
