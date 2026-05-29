# Spec 23: RAG仕訳AIエンジン — 最強の仕訳分類脳

**日付**: 2026-05-29
**番号**: spec-23
**担当**: Bookmee コア

---

## 1. 目的とゴール

現状の `journal-ai-review-service.ts` は「勘定科目名と金額を渡すだけの素朴なLLMコール」。
会計知識ゼロのまま GPT-4o-mini に丸投げしているため、精度に限界がある。

本 spec では **RAGアーキテクチャ** を導入し、日本SMB会計の公開情報から学習した
仕訳パターン知識ベースを武器に「最強の仕訳分類AI」を実現する。

### ゴール

| # | ゴール |
|---|--------|
| G1 | 日本会計実務の仕訳パターン約500件をコーパスとして保持 |
| G2 | RAGパイプライン: 入力仕訳 → embedding類似検索 → GPT-4o生成 |
| G3 | 3段階 confidence routing（auto / pending / difficult） |
| G4 | `difficult` 判定 → Todo自動追加（「AI判断困難」タスク） |
| G5 | `npm run seed:patterns` でパターンDB初期化 |
| G6 | UI に `difficult` バッジ表示 |

### 非ゴール

- MFへの書き込み（read-only方針を維持）
- 外部URLリアルタイム取得
- OpenAI fine-tuning
- pgvector（PostgreSQL JSON列でembeddingを保存し cosine 計算はアプリ層で行う）
- パターン自動クロール（静的コーパスをコードに埋め込む）

---

## 2. ユーザー体験

```
税理士スタッフが「AI自動仕訳」ボタンを押す
      ↓
RAGエンジンが摘要空白仕訳を処理
      ↓
┌─────────────────────────────────────────┐
│ confidence >= 0.85  → 自動適用（緑バッジ） │
│ 0.60 ≤ conf < 0.85  → 確認待ち（黄バッジ） │
│ confidence < 0.60   → AI判断困難（赤バッジ）│
│                       → Todoに自動追加     │
└─────────────────────────────────────────┘
```

`difficult` になった仕訳はダッシュボードの手動Todoリストに
「AI判断困難: 借方[科目] / 貸方[科目] ¥金額」として追加される。
スタッフが目視で確認して処理する。

---

## 3. 知識コーパス設計

### 3-1. パターン構造

```ts
interface JournalPattern {
  id: string;
  debit: string;          // 借方科目（MF勘定科目名と合わせる）
  credit: string;         // 貸方科目
  scenario: string;       // ビジネスシナリオ（1行）
  memoExamples: string[]; // 摘要例（5〜10件）
  industry: string | null; // null = 汎用
  tags: string[];          // キーワードタグ
  amountHint?: string;     // 金額の目安（'小額(<10万)', '大額(>100万)'等）
}
```

### 3-2. コーパス範囲（約500件）

| カテゴリ | 件数目安 | 例 |
|----------|----------|----|
| 売上・収益 | 60 | 売掛金/売上高, 現金/受取利息, ... |
| 仕入・原価 | 50 | 仕入高/買掛金, 棚卸資産/仕入高, ... |
| 人件費 | 40 | 給料手当/普通預金, 役員報酬/未払費用, ... |
| 販管費（交通・通信等） | 100 | 旅費交通費/現金, 通信費/未払費用, ... |
| 固定資産 | 40 | 建物/未払金, 減価償却費/建物, ... |
| 金融・借入 | 40 | 普通預金/長期借入金, 支払利息/普通預金, ... |
| 税金・社会保険 | 50 | 法人税等/未払法人税等, 租税公課/現金, ... |
| 決算整理 | 40 | 前払費用/支払保険料, 未収収益/受取利息, ... |
| その他・特殊 | 80 | 仮払金/普通預金, 立替金/現金, ... |

### 3-3. データソース（静的・公開情報）

以下の公開情報を参照して Codex がコーパスを作成する：

1. **国税庁「勘定科目の説明」** — https://www.nta.go.jp
2. **日本公認会計士協会「会計用語集」**
3. **マネーフォワードのデフォルト仕訳テンプレート**（MF UIの公開情報）
4. **弥生会計・freee の公開仕訳サンプル**
5. **中小企業向け会計基準**（経産省・中小企業庁の公開資料）
6. **会計実務の教科書的パターン**（簿記2級相当の仕訳パターン）

---

## 4. データモデル

### 4-1. JournalPattern テーブル（新規）

```prisma
model JournalPattern {
  id            String   @id @default(cuid())
  debit         String               // 借方科目
  credit        String               // 貸方科目
  scenario      String               // シナリオ説明
  memoExamples  String[]             // 摘要例
  industry      String?              // 業種タグ（null=汎用）
  tags          String[]             // 検索タグ
  amountHint    String?              // 金額ヒント
  embeddingJson String?              // text-embedding-3-small の結果（JSON float[])
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([debit, credit])
}
```

### 4-2. JournalAiReview.status 拡張

```
// 現在: 'pending' | 'approved' | 'skipped' | 'auto_applied'
// 追加: 'difficult'
status String @default("pending")
// pending | approved | skipped | auto_applied | difficult
```

`difficult` = AIが confidence < 0.60 と判断し、人間の確認を強く要求する状態。
対応するTodoが自動生成される。

### 4-3. Todo 追加パターン（既存モデル流用）

```ts
await prisma.todo.create({
  data: {
    firmId,
    clientId,
    title: `AI判断困難: ${debit} / ${credit} ¥${amount.toLocaleString('ja-JP')}`,
    note: `仕訳日: ${transactionDate}\nAI理由: ${reasoning}\nMF仕訳ID: ${mfJournalId}`,
  },
});
```

---

## 5. RAGパイプライン設計

### 5-1. 全体フロー

```
入力: { debit, credit, amount, date, originalMemo }
  ↓
Step 1: クエリテキスト生成
  "借方: {debit} 貸方: {credit} 金額: ¥{amount} 摘要: {originalMemo}"
  ↓
Step 2: embedding生成 (text-embedding-3-small)
  ↓
Step 3: 類似パターン検索
  3a. (debit, credit) 完全一致 → 最大3件を上位に固定
  3b. cosine similarity → 全パターンから top-7 取得
  3c. マージ・重複除去 → 最終 top-5
  ↓
Step 4: GPT-4o でmemo生成 + reasoning + confidence
  システムプロンプト: 日本の会計実務専門家として振る舞う
  ユーザープロンプト: 検索結果パターン5件 + 入力仕訳情報
  出力: { memo, confidence, reasoning, canJudge }
  ↓
Step 5: routing
  canJudge=false OR confidence < 0.60 → difficult
  confidence >= 0.85                 → auto_applied
  else                               → pending
```

### 5-2. Embeddingキャッシュ戦略

- `JournalPattern.embeddingJson` に初回生成後キャッシュ
- `seedEmbeddings()`: 全パターンの embedding を一括生成してDB保存
- 起動時: `loadPatterns()` でDB全件読み込み + embedding をFloat32Arrayに変換してメモリキャッシュ
- インクリメンタル: embeddingJson が null のパターンのみ再生成

### 5-3. Cosine similarity（アプリ層で計算）

```ts
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const normB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (normA * normB);
}
```

~500件ならメモリ内計算で十分（10ms以下）。

### 5-4. GPT-4o プロンプト設計

**System:**
```
あなたは日本の中小企業会計の専門家（税理士補助者）です。
MFクラウド会計の仕訳の「摘要」欄を埋めるアシスタントとして動作します。
- 摘要は日本語で簡潔に1行（30字以内）
- 類似パターンがあれば参考にするが、当該仕訳の実態に合わせて調整する
- 勘定科目名を摘要に機械的に繰り返さない（例: ×「旅費交通費」→ ○「大阪出張旅費」）
- 判断できない場合は canJudge: false を返す
```

**User:**
```
【参考パターン（類似仕訳の実例）】
1. {debit}/{credit}: {scenario} → 摘要例: "{memoExamples[0]}", "{memoExamples[1]}"
2. ...（最大5件）

【今回の仕訳】
借方: {debit}
貸方: {credit}
金額: ¥{amount}
日付: {date}
元の摘要（空欄もあり）: {originalMemo}

上記を踏まえ、最も適切な摘要と確信度を JSON で返してください:
{"memo":"...","confidence":0.0,"reasoning":"...","canJudge":true}
```

---

## 6. 新規ファイル構成

```
server/src/
├── data/
│   └── journal-patterns.ts      ← コーパス (~500件の静的定義)
├── services/
│   ├── journal-pattern-service.ts  ← パターン管理・embedding・類似検索
│   ├── journal-rag-service.ts      ← RAGパイプライン (retrieve + generate)
│   └── journal-ai-review-service.ts  ← 既存を RAG ベースに書き換え
└── scripts/
    └── seed-journal-patterns.ts   ← npm run seed:patterns
```

---

## 7. APIルート変更・追加

### 7-1. 既存ルート（変更なし）

- `POST /api/clients/:id/journals/ai-review/process` → 内部でRAGを使用するだけ（インターフェース変更なし）
- `GET /api/clients/:id/journals/ai-review` → `status=difficult` も返るようになる

### 7-2. 新規ルート

| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/journals/patterns/seed` | パターン投入 + embedding生成（管理用） |
| GET | `/api/journals/patterns` | パターン一覧（デバッグ用） |

---

## 8. フロントエンド変更（script.js）

### 8-1. mf-review ビュー

- `difficult` フィルターボタン追加（既存: 要確認 / 完了 → 追加: AI困難）
- `difficult` カードに赤バッジ「AI判断困難」表示
- `difficult` カードのアクション: 「Todoに追加済み」表示（再追加ボタンは不要）

### 8-2. ダッシュボード

- `aiPendingCount` には `difficult` を含めない（別カウント）
- `aiDifficultCount` を新設し、バナーに「判断困難: N件」を表示

---

## 9. テスト方針

| テスト | 対象 | モック |
|--------|------|--------|
| unit: cosine similarity | journal-pattern-service | なし |
| unit: パターン検索 | journal-pattern-service | なし（静的データ） |
| integration: RAGパイプライン | journal-rag-service | OpenAI をモック |
| integration: 3段階routing | journal-ai-review-service | OpenAI をモック |
| integration: difficult → Todo | journal-ai-review-service | OpenAI をモック、DB実使用 |

**OpenAIモック戦略:**
```ts
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
    embeddings: { create: vi.fn() },
  })),
}));
```

---

## 10. 受入基準

- [ ] `npm run seed:patterns` で500件以上のパターンがDBに投入される
- [ ] embedding が生成されDBに保存される
- [ ] モックで confidence=0.9 → status='auto_applied'
- [ ] モックで confidence=0.5 → status='difficult' + Todo追加
- [ ] `GET /api/clients/:id/journals/ai-review?status=difficult` で難件一覧取得
- [ ] UIで difficult バッジが赤で表示される
- [ ] テスト全件pass（`npm test`）

---

## 11. マイグレーション

```bash
# スキーマ変更後
TS=$(date +%Y%m%d%H%M%S) && \
mkdir -p server/prisma/migrations/${TS}_add_journal_pattern && \
npx prisma migrate diff \
  --from-schema-datasource server/prisma/schema.prisma \
  --to-schema-datamodel server/prisma/schema.prisma \
  --script > server/prisma/migrations/${TS}_add_journal_pattern/migration.sql && \
npx prisma generate
```

---

## 12. 実装上の注意

1. **CLAUDE.mdの read-only 方針は維持**: RAGはmemo提案のみ。MFへの書き込みは既存の `localOnly=false` 時のみ（spec21から変更なし）
2. **embedding APIコスト**: text-embedding-3-small は $0.02/1M tokens。500件 × 約200トークン = 0.1M tokens ≈ $0.002。問題なし
3. **GPT-4oへのアップグレード**: 現在の gpt-4o-mini → gpt-4o に変更。RAGコンテキストを活かすため高性能モデルを使用
4. **パターンのメモリキャッシュ**: サーバー起動時に全パターンをメモリロード（~500件 × 1536dim ≈ 3MB）
5. **既存テストへの影響**: journal-ai-review-service の OpenAI モック方法を更新が必要
