# 02. スタッフ→税理士 承認ワークフロー

改善案: ② スタッフ→税理士の承認ワークフロー

## 背景
- 牧野氏: 「税理士以外の人が作業することがほとんど。それを税理士がチェックする真実性承認ワークフロー、そういうのってないような気がする」
- 現状のzeimeeは「税理士が直接見る」前提だが、実態は スタッフ作業 → 税理士承認 の二段階。これがないと事務所運営に組み込めない。

## ゴール
1. 各タスクが「誰の手元にあるか」が常に明確
2. スタッフが「完了」を押すと、税理士の確認キューに自動で積まれる
3. 税理士が承認 / 差戻しできる。差戻し時はスタッフのToDoに戻る
4. 承認履歴がタスクごとに残る（誰が・いつ・何を）

## 本番アーキ前提
- データソースは `Task` テーブル（09 の Prisma スキーマ）
- `Task.stage`, `Task.assignee`, `Task.approver` を保持
- 履歴は `TaskHistory` テーブルに append-only
- ロール切替は **画面上の view filter のみ**（認証なし方針）。`appState.currentRole` は localStorage に保存

## DBモデル（09 で定義済み）
- `Task { id, clientId, title, note, category, status, score, stage, assignee, approver, ruleId, createdAt, updatedAt }`
- `TaskHistory { id, taskId, at, by, action, comment }`

`stage` の値:
- `staff_doing`: スタッフ作業中
- `awaiting_approval`: 税理士確認待ち
- `approved`: 承認済み（status=done）
- `rejected`: 差戻し（status=open、assigneeへ戻る）

## API

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/clients/:id/tasks?role=staff\|tax_accountant&stage=...` | role/stageでフィルタしたタスク |
| POST | `/api/tasks/:id/transition` | stage遷移 |
| GET | `/api/tasks/:id/history` | 履歴取得 |

`POST /api/tasks/:id/transition` の body:
```json
{ "action": "staff_complete" | "approve" | "reject" | "resubmit",
  "by": "鈴木",        // 認証なしのため、画面の currentRole + 名前を送る
  "comment": "..."     // reject 時の理由など、任意 }
```
- `staff_complete`: stage `staff_doing|rejected` → `awaiting_approval`
- `approve`: stage `awaiting_approval` → `approved`、status → `done`
- `reject`: stage `awaiting_approval` → `rejected`、status → `open`
- `resubmit`: stage `rejected` → `awaiting_approval`（スタッフが再提出）

サーバ側で stage 遷移の妥当性チェック → `TaskHistory` 追記 → 関連 `Client` の集計（progress 等）も再計算。

## 機能要件

### F1. ロール切替セレクタ
ヘッダー `topbar-actions` 内に小さなセレクタ:
- `<select id="roleSelector">` で `スタッフ` / `税理士`
- 切替で `appState.currentRole` 更新（localStorage 保存）+ `render()`

### F2. レビューセンターの表示分岐
`renderDashboard()`:
- `currentRole === 'tax_accountant'`: `stage === 'awaiting_approval'` のタスクのみ表示
- `currentRole === 'staff'`: `stage === 'staff_doing' || 'rejected'` のタスクのみ表示
- 表題切替: 税理士「所長確認待ち」/ スタッフ「あなたの作業中」

### F3. ステージ遷移ボタン
タスクカードのアクション列を再構成:
- スタッフ: 「記帳完了 → 確認依頼」 → `transition: staff_complete`
- 税理士: 「承認」「差戻し」「依頼文」
  - 承認 → `transition: approve`
  - 差戻し → モーダルで理由入力 → `transition: reject` with comment
  - 依頼文 → 03の portal へジャンプ + `#messageDraft` 自動生成

### F4. スタッフ差戻しビュー再設計
`renderFeedback()`:
- 税理士視点: `stage === 'rejected'` のタスク。誰に差戻したか（assignee）を見出し
- スタッフ視点: 自分宛の差戻し。修正後「再提出」ボタン → `transition: resubmit`

### F5. 承認履歴の表示
タスクカード展開時に `GET /api/tasks/:id/history` を呼んで `<ol>` で表示。
新規ヘルパー `renderTaskHistory(history)`。

### F6. サマリーカードの差替え
`#openTaskValue`「所長確認待ち」 = `stage='awaiting_approval'` 件数
`#diffValue`「差戻し中」 = `stage='rejected'` 件数
`GET /api/summary` の戻り値から。

## index.html 変更
- `topbar-actions` 内、`runAiButton` の左に `<select id="roleSelector"><option value="tax_accountant">税理士</option><option value="staff">スタッフ</option></select>`

## script.js 変更

| 関数 | 変更 |
|---|---|
| `appState.currentRole` 追加 | localStorage 永続化、既定 'tax_accountant' |
| `loadTasks(clientId, role)` 新設 | `GET /api/clients/:id/tasks?role=...` |
| `transitionTask(id, action, by, comment?)` 新設 | `POST /api/tasks/:id/transition` |
| `loadTaskHistory(id)` 新設 | `GET /api/tasks/:id/history` |
| `renderDashboard` | role による表示分岐、stage 別フィルタ |
| `renderFeedback` | role 分岐、再提出フロー |
| `renderSummary` | API由来の集計を反映 |
| `renderView` のクリックハンドラ | 新アクション `staff-complete`, `resubmit` 追加。`approve`/`reject` で transition 呼出 |
| 新規 `renderTaskHistory(history)` | 履歴 `<ol>` を返す |
| 新規イベント | `#roleSelector` change |

## サーバ側実装詳細

### `task-service.ts`
```ts
async function transitionTask(taskId, action, by, comment) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  // 妥当性チェック（許可遷移か）
  const next = computeNextStage(task.stage, action);
  await prisma.$transaction([
    prisma.task.update({
      where: { id: taskId },
      data: { stage: next.stage, status: next.status },
    }),
    prisma.taskHistory.create({
      data: { taskId, action, by, comment, at: new Date() },
    }),
  ]);
  // 関連集計の再計算（progress 等）
  await recomputeClientSummary(task.clientId);
}
```

### 既存 `task[index]` 配列形式の廃止
旧 `script.js` の `client.tasks = [[...], [...]]` 形式は廃止。
`prisma/seed.ts` で `Task` テーブルに展開する際に各タスクに `stage='awaiting_approval'`, `assignee=client.owner.split` 等を割り当てる。

## スコープ外
- 認証連動の権限制御（誰でも切替可、`by` も画面入力）
- 電子署名・タイムスタンプ証跡
- 複数承認者ルート（1段階のみ）
- 通知の自動送信（03 の依頼文作成は手動操作）

## 受入基準
- [ ] ヘッダーで「税理士／スタッフ」を切替できる（localStorage 保存）
- [ ] スタッフ視点で `staff_doing` と `rejected` のタスクが見える
- [ ] スタッフが「記帳完了」を押すと `transition: staff_complete` API が呼ばれ、税理士視点の「所長確認待ち」に出る
- [ ] 税理士「承認」で `Task.stage='approved'`, `status='done'` になり、`TaskHistory` に1行追加
- [ ] 税理士「差戻し」で stage='rejected' になり、スタッフ視点に戻る
- [ ] サマリーカード「所長確認待ち」「差戻し中」が API集計と一致
- [ ] 既存の 9 ビューが API データで回帰なく描画される
