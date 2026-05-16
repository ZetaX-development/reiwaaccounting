const appState = {
  activeClient: 0,
  activeView: "dashboard",
  activeFilter: "all",
  search: "",
};

// Loaded from /api/clients on startup. The inline array below is kept as a
// fallback so the page still renders if the API is unreachable.
let clients = [
  {
    name: "青山デザイン株式会社",
    owner: "担当: 鈴木 / 締切 5月10日",
    progress: 87,
    tasksOpen: 6,
    risk: 2,
    receipt: 91,
    missing: 3,
    diff: 2,
    matches: 24,
    chatMessage: "青山デザインは今月も順調ですね！広告費の消費税区分だけ先方に確認を取れば、ほぼクローズできそうです。カード明細の証憑も早めに催促しましょう。",
    rules: ["広告費は過去6回の消費税区分を優先", "資産計上・少額減価償却資産の判定候補を検出", "役員名義カードは証憑必須"],
    message:
      "青山デザイン株式会社 ご担当者様\n\n5月月次確認のため、以下の資料をご共有ください。\n・4月分カード明細に紐づく領収書3件\n・請求INV-0421の入金差額に関する補足\n\n確認後、月次処理を進めます。よろしくお願いいたします。",
    tasks: [
      ["広告費 220,000円の消費税区分を確認", "過去ルールと異なる候補を検出", "AI仕訳候補", "urgent", 82],
      ["4月分カード明細の証憑が不足", "顧問先への依頼文を作成済み", "証憑", "urgent", 76],
      ["請求INV-0421と入金額に差異", "振込手数料の可能性あり", "消込", "open", 88],
      ["外注費 385,000円の源泉対象確認", "摘要に個人名を検出", "月次チェック", "open", 69],
      ["旅費交通費の領収書候補を承認", "Drive内に一致候補あり", "証憑", "done", 93],
      ["売掛金残高の前月差異確認", "増加率がルール閾値を超過", "月次チェック", "open", 71],
    ],
    entries: [
      ["広告宣伝費", "Meta広告 220,000円", "課税仕入10%", "前月は対象外", "urgent", 82],
      ["旅費交通費", "新幹線 EX予約 18,420円", "課税仕入10%", "証憑一致", "done", 94],
      ["外注費", "個人デザイナー 385,000円", "源泉確認", "摘要に個人名", "open", 69],
      ["消耗品費", "PC周辺機器 42,800円", "課税仕入10%", "過去処理一致", "done", 96],
    ],
    receipts: [
      ["カード明細 4/12", "領収書不足", "顧問先依頼待ち", "urgent", 76],
      ["EX予約", "領収書候補あり", "自動紐付け可能", "done", 94],
      ["Adobe", "請求書あり", "取引に紐付け済み", "done", 98],
      ["備品購入", "候補2件", "金額一致、日付差異", "open", 72],
    ],
    matching: [
      ["INV-0421", "330,000円", "326,700円", "振込手数料候補", "open", 88],
      ["INV-0422", "550,000円", "550,000円", "完全一致", "done", 99],
      ["INV-0425", "198,000円", "0円", "未入金", "urgent", 61],
    ],
    checks: [
      ["売掛金残高", "前月比 +32%", "増加率が高い", "open", 71],
      ["預金残高", "帳簿残高と銀行明細を照合", "月末残高一致", "done", 97],
      ["仮払金", "前月から繰越 2件", "内容確認が必要", "open", 74],
      ["役員貸付金", "変動なし", "問題なし", "done", 96],
      ["外注費", "源泉対象候補あり", "確認が必要", "urgent", 69],
    ],
    trendData: [
      { account: "売上高", prev3: [4200000, 4800000, 5100000], curr: 5400000, changePct: 5.9, flag: "ok" },
      { account: "広告宣伝費", prev3: [180000, 195000, 210000], curr: 350000, changePct: 66.7, flag: "alert" },
      { account: "外注費", prev3: [280000, 310000, 290000], curr: 385000, changePct: 32.8, flag: "alert" },
      { account: "売掛金", prev3: [1200000, 1350000, 1420000], curr: 1880000, changePct: 32.4, flag: "alert" },
      { account: "旅費交通費", prev3: [42000, 38000, 45000], curr: 48000, changePct: 6.7, flag: "ok" },
      { account: "消耗品費", prev3: [32000, 28000, 35000], curr: 43000, changePct: 22.9, flag: "ok" },
    ],
  },
  {
    name: "渋谷カフェ合同会社",
    owner: "担当: 田中 / 締切 5月12日",
    progress: 64,
    tasksOpen: 14,
    risk: 4,
    receipt: 74,
    missing: 9,
    diff: 5,
    matches: 18,
    chatMessage: "渋谷カフェは軽減税率の混在が複数あって要注意です。レジ日報の不足分を先に押さえましょう。現金残高も前月比で増えているので確認が必要です。",
    rules: ["飲食店は軽減税率の混在を重点確認", "現金売上は日報添付を必須", "食材仕入は仕入先別に消費税区分を保持"],
    message:
      "渋谷カフェ合同会社 ご担当者様\n\n5月月次処理にあたり、レジ日報とカード売上明細の不足分をご共有ください。軽減税率の確認が必要な仕入が複数ありますので、納品書もあわせてお願いいたします。",
    tasks: [
      ["軽減税率の候補を確認", "同一仕入先で消費税区分が混在", "AI仕訳候補", "urgent", 73],
      ["5月12日分レジ日報が不足", "売上取引に紐付け不可", "証憑", "urgent", 66],
      ["カード売上の入金差異", "決済手数料候補", "消込", "open", 84],
      ["現金残高が前月比で増加", "現金売上の締め確認", "月次チェック", "open", 68],
    ],
    entries: [
      ["仕入高", "食品卸 86,400円", "軽減税率8%候補", "同一仕入先で混在", "urgent", 73],
      ["売上高", "Uber Eats 124,800円", "課税売上10%", "手数料控除あり", "open", 81],
      ["水道光熱費", "東京電力 45,300円", "課税仕入10%", "過去処理一致", "done", 95],
    ],
    receipts: [
      ["レジ日報 5/12", "不足", "依頼文作成済み", "urgent", 66],
      ["食品卸納品書", "候補3件", "税率確認待ち", "open", 71],
      ["電気料金", "請求書あり", "取引に紐付け済み", "done", 95],
    ],
    matching: [
      ["カード売上 5/08", "168,000円", "162,960円", "手数料候補", "open", 84],
      ["Uber Eats", "124,800円", "118,560円", "手数料控除", "done", 92],
    ],
    checks: [
      ["現金残高", "前月比 +18%", "日報確認", "open", 68],
      ["軽減税率取引", "14件", "税率混在", "urgent", 73],
    ],
    trendData: [
      { account: "売上高", prev3: [3800000, 4100000, 3900000], curr: 4300000, changePct: 10.3, flag: "ok" },
      { account: "仕入高", prev3: [1400000, 1520000, 1480000], curr: 1720000, changePct: 16.2, flag: "alert" },
      { account: "現金残高", prev3: [320000, 380000, 420000], curr: 496000, changePct: 18.1, flag: "alert" },
      { account: "消耗品費", prev3: [28000, 32000, 30000], curr: 35000, changePct: 16.7, flag: "ok" },
    ],
  },
  {
    name: "日本橋工業株式会社",
    owner: "担当: 佐藤 / 締切 5月15日",
    progress: 42,
    tasksOpen: 25,
    risk: 7,
    receipt: 58,
    missing: 16,
    diff: 8,
    matches: 39,
    chatMessage: "日本橋工業は今月も案件コード未設定が多いです。まず資産計上候補の請求書を押さえて、その後案件コードの一括整理を優先しましょう。買掛金の滞留も気になります。",
    rules: ["資産計上・少額減価償却資産の判定候補を検出", "工事別原価は案件コード必須", "買掛金残高の長期滞留を検出"],
    message:
      "日本橋工業株式会社 ご担当者様\n\n月次処理のため、工具器具備品の請求書、工事別の納品書、未入金先の確認資料をご共有ください。案件コードが未設定の取引もあります。",
    tasks: [
      ["資産計上候補を確認", "工具器具備品または少額減価償却資産の可能性", "AI仕訳候補", "urgent", 65],
      ["案件コード未設定の外注費", "工事別原価に未割当", "月次チェック", "urgent", 58],
      ["納品書と請求書の紐付け待ち", "候補が複数あり", "証憑", "open", 64],
      ["売掛金の未消込", "前月から残っている入金待ち", "消込", "urgent", 62],
    ],
    entries: [
      ["工具器具備品", "測定器 248,000円", "資産計上候補", "少額減価償却資産の適用可否を確認", "urgent", 65],
      ["外注費", "現場応援 660,000円", "案件コード未設定", "原価未割当", "urgent", 58],
      ["材料費", "鋼材 1,120,000円", "課税仕入10%", "請求書候補あり", "open", 79],
    ],
    receipts: [
      ["測定器請求書", "不足", "固定資産判定に必要", "urgent", 65],
      ["鋼材納品書", "候補2件", "案件コード確認", "open", 72],
    ],
    matching: [
      ["工事A-041", "1,980,000円", "0円", "未入金", "urgent", 62],
      ["工事B-033", "880,000円", "879,450円", "手数料候補", "open", 83],
    ],
    checks: [
      ["買掛金滞留", "90日超 3件", "支払予定確認", "urgent", 60],
      ["案件コード", "未設定 8件", "原価集計不可", "urgent", 58],
      ["試算表", "売上総利益率が前月比 -6pt", "原価計上時期を確認", "open", 72],
      ["未払金", "期末未払計上候補 4件", "請求書到着済み", "open", 76],
    ],
    trendData: [
      { account: "売上高", prev3: [18000000, 22000000, 19500000], curr: 16800000, changePct: -13.8, flag: "alert" },
      { account: "外注費", prev3: [4200000, 5100000, 4800000], curr: 6600000, changePct: 37.5, flag: "alert" },
      { account: "売上総利益率", prev3: [28.0, 27.5, 29.0], curr: 23.0, changePct: -6.0, flag: "alert" },
      { account: "買掛金", prev3: [3200000, 3800000, 4100000], curr: 5400000, changePct: 31.7, flag: "alert" },
      { account: "材料費", prev3: [6800000, 7200000, 6900000], curr: 7800000, changePct: 13.0, flag: "ok" },
    ],
  },
  {
    name: "横浜メディカル株式会社",
    owner: "担当: 高橋 / 締切 5月11日",
    progress: 78,
    tasksOpen: 9,
    risk: 3,
    receipt: 86,
    missing: 5,
    diff: 3,
    matches: 31,
    chatMessage: "横浜メディカルは保険収入と自費収入の区分が今月の重点です。リース契約の更新資料さえ入手できれば、かなり進みますよ！部門配賦も忘れずに。",
    rules: ["医療材料は部門別に配賦", "保険収入と自費収入を区分", "リース契約は月額と残債を確認"],
    message:
      "横浜メディカル株式会社 ご担当者様\n\n保険収入の明細、自費診療の集計表、リース契約の更新資料をご共有ください。部門別配賦の確認が必要な取引があります。",
    tasks: [
      ["保険収入と自費収入の区分", "摘要から混在を検出", "AI仕訳候補", "urgent", 74],
      ["リース契約更新資料が不足", "月額変更の可能性", "証憑", "open", 70],
      ["部門別配賦の確認", "医療材料費が一括計上", "月次チェック", "open", 77],
    ],
    entries: [
      ["売上高", "診療収入 2,420,000円", "区分確認", "保険/自費混在", "urgent", 74],
      ["リース料", "医療機器 132,000円", "契約更新確認", "前月差異", "open", 70],
      ["材料費", "医療材料 520,000円", "部門配賦", "一括計上", "open", 77],
    ],
    receipts: [
      ["保険収入明細", "候補あり", "売上に紐付け待ち", "open", 80],
      ["リース契約", "不足", "月額変更確認", "open", 70],
    ],
    matching: [
      ["保険入金", "2,420,000円", "2,420,000円", "一致", "done", 98],
      ["自費診療", "318,000円", "315,600円", "決済手数料候補", "open", 86],
    ],
    checks: [
      ["部門別材料費", "未配賦 6件", "確認必要", "open", 77],
      ["リース債務", "前月差異", "契約更新確認", "open", 70],
    ],
    trendData: [
      { account: "診療収入", prev3: [2100000, 2250000, 2380000], curr: 2420000, changePct: 1.7, flag: "ok" },
      { account: "保険収入", prev3: [1680000, 1800000, 1900000], curr: 1930000, changePct: 1.6, flag: "ok" },
      { account: "材料費", prev3: [420000, 450000, 490000], curr: 520000, changePct: 6.1, flag: "ok" },
      { account: "リース料", prev3: [118000, 118000, 118000], curr: 132000, changePct: 11.9, flag: "alert" },
    ],
  },
];

const labels = {
  dashboard: "Review Center",
  progress: "Progress",
  feedback: "Staff Feedback",
  portal: "Client Messages",
  trends: "Trial Balance",
  receipts: "Documents / Matching",
  rules: "AI Rules",
  validation: "Notion Findings",
  settings: "Operations",
};

const validationNotes = [
  {
    title: "税理士事務所向け",
    source: "会計・税理士業務向けAIツールの壁打ち",
    verdict: "ITリテラシーが低い人でも迷わないUIを最優先",
    details: [
      "30〜50人規模の事務所が最初の狙い目",
      "資料不足対応が月次業務で最も詰まりやすい",
      "RAGやダッシュボードではなく、今日やることとして見せる",
    ],
  },
  {
    title: "監査法人向け",
    source: "監査業務効率化AIツールの開発相談",
    verdict: "PBC・質問・調書ドラフトは中堅監査法人に刺さる",
    details: [
      "Big Fourは内製ツールが強く、100〜500人規模が有望",
      "資料依頼の期限管理と未回答質問の管理が実務上つらい",
      "循環取引・不正検知は単体でも価値がある",
    ],
  },
  {
    title: "初回ヒアリング",
    source: "会計・監査業務支援SaaSに関する初回ミーティング",
    verdict: "仕訳作成より、レビュー・進捗・顧問先連絡に寄せる",
    details: [
      "作業者と購入者が違うため、所長のレビュー時間を削る",
      "記帳完了をトリガーにAIが点検して差戻しを作る",
      "開示チェック・監査計画・循環取引検知はAuditmee側に寄せる",
    ],
  },
];

const buildRoadmap = [
  ["今すぐ実装", "資料不足リスト、顧問先依頼文、所長レビュー、スタッフ差戻し"],
  ["次に実装", "MoneyForward/freeeのデータ読込、前月比ルール、顧問先別の学習ルール"],
  ["別プロダクト化", "PBC管理、監査調書ドラフト、開示チェック、循環取引検知"],
];

const $ = (selector) => document.querySelector(selector);
const clientStrip = $("#clientStrip");
const viewContent = $("#viewContent");
const toast = $("#toast");

function currentClient() { return clients[appState.activeClient]; }

async function loadClientsFromApi() {
  try {
    const listRes = await fetch("/api/clients");
    if (!listRes.ok) throw new Error("HTTP " + listRes.status);
    const summaries = await listRes.json();
    if (!Array.isArray(summaries) || summaries.length === 0) return;

    const detailed = await Promise.all(
      summaries.map(async (s) => {
        const detailRes = await fetch("/api/clients/" + encodeURIComponent(s.id));
        if (!detailRes.ok) return null;
        const detail = await detailRes.json();
        return adaptApiClient(detail);
      })
    );
    const filtered = detailed.filter(Boolean);
    if (filtered.length > 0) clients = filtered;
  } catch (err) {
    console.warn("Failed to load clients from API; using inline fallback", err);
  }
}

function adaptApiClient(d) {
  // Map the API detail payload (Prisma schema) onto the legacy shape the
  // existing render functions read from `clients[i]`.
  return {
    id: d.id,
    name: d.name,
    industry: d.industry,
    vendor: d.vendor,
    mode: d.mode,
    owner: d.ownerLabel ?? "",
    progress: d.progress,
    tasksOpen: d.tasksOpen,
    risk: d.risk,
    receipt: d.receipt,
    missing: d.missing,
    diff: d.diff,
    matches: d.matches,
    chatMessage: d.chatMessage ?? "",
    rules: (d.rules ?? []).map((r) => r.title),
    message: d.messageDraft ?? "",
    contactPrimary: d.contactPrimary,
    contactEndpoints: d.contactEndpoints ?? {},
    vendorSyncs: d.vendorSyncs ?? [],
    tasks: (d.tasks ?? []).map((t) => [
      t.title,
      t.note,
      t.category,
      t.status,
      t.score,
    ]),
    entries: (d.entries ?? []).map((e) => [
      e.account,
      e.description,
      e.taxClass ?? "",
      e.receiptStatus === "matched" ? "証憑一致" : e.receiptStatus === "missing" ? "証憑不足" : "確認",
      e.receiptStatus === "matched" ? "done" : e.receiptStatus === "missing" ? "urgent" : "open",
      e.score ?? 50,
    ]),
    receipts: (d.receipts ?? []).map((r) => [
      r.vendorRef ?? "(未設定)",
      r.status === "attached" ? "紐付け済み" : r.status === "missing" ? "領収書不足" : "候補あり",
      r.status === "missing" ? "顧問先依頼待ち" : "—",
      r.status === "attached" ? "done" : r.status === "missing" ? "urgent" : "open",
      80,
    ]),
    matching: (d.matchings ?? []).map((m) => [
      m.invoiceRef,
      "¥" + m.invoiceAmount.toLocaleString(),
      "¥" + m.paidAmount.toLocaleString(),
      m.diffNote ?? "",
      m.status === "matched" || m.status === "done" ? "done" : m.status === "urgent" ? "urgent" : "open",
      80,
    ]),
    checks: (d.monthlyChecks ?? []).map((c) => [
      c.title,
      c.note ?? "",
      c.detail ?? "",
      c.status,
      c.score,
    ]),
    trendData: d.trendData ?? [],
  };
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function statusLabel(status) {
  if (status === "urgent") return "要確認";
  if (status === "done") return "完了";
  if (status === "open") return "差戻し中";
  return "確認待ち";
}

function taskOwner(index) {
  const owners = ["鈴木", "田中", "山本", "高橋", "佐藤"];
  return owners[index % owners.length];
}

function taskReason(task) {
  const category = task[2];
  if (category === "AI仕訳候補") return "過去処理、摘要、金額、証憑状態を照合";
  if (category === "証憑") return "取引・明細・Drive証憑の突合結果";
  if (category === "消込") return "請求額、入金額、手数料候補を照合";
  return "前月比、残高、業種別ルールを照合";
}

function taskActionText(task) {
  const label = task[2];
  if (label === "証憑") return "顧問先へ不足資料依頼";
  if (label === "消込") return "担当者へ差異確認を依頼";
  if (label === "AI仕訳候補") return "担当者へ仕訳修正を依頼";
  return "担当者へレビューコメントを送信";
}

function progressStatus(client) {
  if (client.progress >= 80 && client.risk <= 3) return ["レビュー待ち", "urgent"];
  if (client.progress >= 70) return ["回収待ち", "open"];
  if (client.progress >= 50) return ["差戻し中", "open"];
  return ["未着手多め", "urgent"];
}

function matchesFilter(row) {
  const status = row.length === 6 ? row[4] : row[3];
  if (appState.activeFilter === "urgent") return status === "urgent" || status === "open";
  if (appState.activeFilter === "done") return status === "done";
  return true;
}

function matchesSearch(row) {
  if (!appState.search) return true;
  return row.join(" ").toLowerCase().includes(appState.search.toLowerCase());
}

function makeConfidence(score) {
  return '<div class="confidence"><b>' + score + '%</b><span><i style="width:' + score + '%"></i></span></div>';
}

function renderClients() {
  let html = "";
  for (let i = 0; i < clients.length; i++) {
    const client = clients[i];
    html += '<button class="client-card ' + (i === appState.activeClient ? "active" : "") + '" data-client="' + i + '">';
    html += "<strong>" + client.name + "</strong><span>" + client.owner + "</span>";
    html += vendorBadgeHtml(client.vendor);
    html += channelBadgeHtml(client.contactPrimary);
    html += '<div class="mini-progress"><i style="width:' + client.progress + '%"></i></div></button>';
  }
  clientStrip.innerHTML = html;
  clientStrip.querySelectorAll(".client-card").forEach((button) => {
    button.addEventListener("click", () => { appState.activeClient = Number(button.dataset.client); render(); });
  });
}

function vendorBadgeHtml(vendor) {
  if (vendor === "both") {
    return '<span class="pill vendor-mf">MF</span> <span class="pill vendor-freee">freee</span>';
  }
  if (vendor === "mf") return '<span class="pill vendor-mf">MF</span>';
  if (vendor === "freee") return '<span class="pill vendor-freee">freee</span>';
  return "";
}

function channelBadgeHtml(channel) {
  if (!channel) return "";
  const labels = { email: "メール", slack: "Slack", chatwork: "Chatwork", line_works: "LW", messenger: "FB" };
  return '<span class="pill channel-' + channel + '">' + (labels[channel] || channel) + '</span>';
}

function renderSummary() {
  const client = currentClient();
  $("#progressValue").textContent = client.progress + "%";
  $("#progressBar").style.width = client.progress + "%";
  $("#openTaskValue").textContent = client.tasksOpen;
  $("#riskValue").textContent = client.risk;
  $("#receiptValue").textContent = client.receipt + "%";
  $("#missingValue").textContent = client.missing;
  $("#diffValue").textContent = client.diff;
  $("#matchValue").textContent = client.matches;
  $("#panelTitle").textContent = client.name;
  $("#currentViewLabel").textContent = labels[appState.activeView];
  $("#aiSubtitle").textContent = client.name + " の月次処理を支援中";

  // Spec 01 F5: 5th summary card "ベンダー横断同期"
  const vendorEl = $("#vendorSyncValue");
  if (vendorEl) {
    fetch("/api/sync-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        vendorEl.textContent = data.okRate + "%";
      })
      .catch(() => {});
  }
}

// Spec 01 F4: Sidebar integration card with sync status
function renderIntegrationCard() {
  const card = $("#integrationCard");
  if (!card) return;
  fetch("/api/sync-status")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) {
        card.innerHTML = "<p>連携ステータス</p><span>取得できませんでした</span>";
        return;
      }
      let html = "<p>連携ステータス</p>";
      for (const v of data.vendors) {
        const dotClass = v.error > 0 ? "error" : v.warn > 0 ? "warn" : v.total > 0 ? "ok" : "warn";
        const label = v.vendor === "mf" ? "マネーフォワード" : "freee";
        const lastSyncLabel = v.lastSync ? formatRelative(new Date(v.lastSync)) : "未取得";
        html += '<div class="sync-row">';
        html += '<span class="status-dot ' + dotClass + '"></span>';
        html += '<span class="vendor-name">' + label + "</span>";
        html += '<span class="sync-detail">' + v.ok + "/" + v.total + " OK・" + lastSyncLabel + "</span>";
        html += "</div>";
      }
      card.innerHTML = html;
    })
    .catch(() => {});
}

function loadAndRenderThreads() {
  const client = currentClient();
  if (!client?.id) return;
  fetch("/api/clients/" + encodeURIComponent(client.id) + "/threads")
    .then((r) => (r.ok ? r.json() : null))
    .then((threads) => {
      const wrap = $("#portalThreads");
      if (!wrap) return;
      if (!Array.isArray(threads) || threads.length === 0) {
        wrap.innerHTML = '<div class="thread-item out"><span class="thread-header">まだやり取りはありません</span></div>';
        return;
      }
      let html = "";
      const channelLabels = { email: "メール", slack: "Slack", chatwork: "Chatwork", line_works: "LINE WORKS", messenger: "Messenger" };
      for (const t of threads) {
        html += '<div class="thread-item ' + t.direction + '">';
        html += '<span class="thread-header">';
        html += channelBadgeHtml(t.channel);
        html += ' <span class="pill thread-' + t.status + '">' + (t.status === "sent" ? "送信済み" : t.status === "queued" ? "送信待ち" : t.status === "failed" ? "うまく届かず" : t.status) + '</span>';
        html += ' ' + formatRelative(new Date(t.createdAt));
        if (t.direction === "out") html += " · " + (channelLabels[t.channel] || t.channel) + "へ送信";
        html += '</span>';
        if (t.subject) html += '<span class="thread-preview"><strong>' + escapeHtml(t.subject) + '</strong></span>';
        html += '<span class="thread-preview">' + escapeHtml(t.preview || t.body.slice(0, 120)) + '</span>';
        if (t.status === "failed" && t.errorMsg) {
          html += '<span class="thread-header" style="color:#9a3040">失敗: ' + escapeHtml(t.errorMsg) + '</span>';
          html += '<button class="row-action" data-action="resend-thread" data-thread-id="' + t.id + '">再送する</button>';
        }
        html += '</div>';
      }
      wrap.innerHTML = html;
      // Re-bind resend handlers
      wrap.querySelectorAll('[data-action="resend-thread"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          fetch("/api/messages/" + encodeURIComponent(btn.dataset.threadId) + "/send", { method: "POST" })
            .then(async (r) => {
              const t2 = await r.json();
              showToast(t2.status === "sent" ? "再送しました" : "再送失敗: " + (t2.errorMsg || ""));
              loadAndRenderThreads();
            });
        });
      });
    });
}

function formatRelative(d) {
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "今すぐ";
  if (diffMin < 60) return diffMin + "分前";
  const h = Math.floor(diffMin / 60);
  if (h < 24) return h + "時間前";
  const days = Math.floor(h / 24);
  return days + "日前";
}

function renderTable(rows, columns) {
  const visible = rows.filter(matchesFilter).filter(matchesSearch);
  if (!visible.length) return '<div class="empty-state">条件に合うデータがありません。</div>';
  // Spec 01 F3: append source column. Spec 08 O1: append vendor jump link.
  const client = currentClient();
  const vendorSource = client.vendor === "freee" ? "freee" : "mf";
  let html = '<div class="table-wrap"><table><thead><tr>';
  for (let i = 0; i < columns.length; i++) html += "<th>" + columns[i] + "</th>";
  html += "<th>状態</th><th>出所</th><th>確認優先度</th><th>操作</th></tr></thead><tbody>";
  for (let i = 0; i < visible.length; i++) {
    const row = visible[i];
    const hasNote = row.length === 6;
    const status = hasNote ? row[4] : row[3];
    const score = hasNote ? row[5] : row[4];
    html += "<tr><td><div class=\"item-title\"><strong>" + row[0] + "</strong><small>" + row[1] + "</small></div></td>";
    html += "<td>" + row[2] + "</td>";
    html += "<td>" + (hasNote ? row[3] : row[2]) + "</td>";
    html += '<td><span class="pill ' + status + '">' + statusLabel(status) + "</span></td>";
    html += '<td><span class="pill source-' + vendorSource + '">' + (vendorSource === "mf" ? "MF" : "freee") + '</span></td>';
    html += "<td>" + makeConfidence(score) + "</td>";
    html += '<td><div class="row-actions">';
    html += '<button class="row-action" data-action="approve" data-index="' + i + '">承認</button>';
    html += '<button class="row-action reject" data-action="reject" data-index="' + i + '">差戻し</button>';
    html += '<button class="vendor-link" data-action="open-vendor" data-vendor="' + vendorSource + '">' + (vendorSource === "mf" ? "MFで開く" : "freeeで開く") + '</button>';
    html += "</div></td></tr>";
  }
  html += "</tbody></table></div>";
  // Spec 08 O3: sync freshness label
  const sync = (client.vendorSyncs || []).find((s) => s.vendor === vendorSource);
  if (sync && sync.lastSync) {
    html += '<small class="sync-fresh">最終同期: ' + formatRelative(new Date(sync.lastSync)) + '</small>';
  }
  return html;
}

function renderDashboard() {
  const client = currentClient();
  const [stage, stageClass] = progressStatus(client);
  const reviewTasks = client.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task[3] !== "done")
    .filter(({ task }) => matchesSearch(task))
    .sort((a, b) => b.task[4] - a.task[4]);
  let html = '<div class="review-hero">';
  html += '<div><p class="eyebrow">記帳完了後レビュー</p><h3>担当者の作業結果をAIが先に点検済み</h3>';
  html += '<p>所長は異常点、根拠、次アクションだけを確認します。承認・差戻し・顧問先依頼までここで完結します。</p></div>';
  html += '<div class="review-run-card"><span class="pill ' + stageClass + '">' + stage + '</span><strong>' + reviewTasks.length + '件</strong><small>今すぐ確認すべきレビュー</small></div>';
  html += "</div>";

  html += '<div class="review-list">';
  if (!reviewTasks.length) {
    html += '<div class="empty-state">所長確認待ちのレビューはありません。</div>';
  }
  for (let i = 0; i < reviewTasks.length; i++) {
    const item = reviewTasks[i];
    const task = item.task;
    html += '<article class="review-card ' + task[3] + '">';
    html += '<div class="review-main"><div class="review-title-row">';
    html += '<span class="pill ' + task[3] + '">' + task[2] + '</span>';
    html += '<strong>' + task[0] + '</strong></div>';
    html += '<p>' + task[1] + '</p>';
    html += '<div class="review-evidence">';
    html += '<span><b>担当</b>' + taskOwner(item.index) + '</span>';
    html += '<span><b>AI根拠</b>' + taskReason(task) + '</span>';
    html += '<span><b>推奨</b>' + taskActionText(task) + '</span>';
    html += '</div></div>';
    html += '<div class="review-score">' + makeConfidence(task[4]) + '</div>';
    html += '<div class="review-actions">';
    html += '<button class="row-action" data-action="approve" data-task="' + item.index + '">承認</button>';
    html += '<button class="row-action reject" data-action="reject" data-task="' + item.index + '">差戻し</button>';
    html += '<button class="row-action" data-action="ask" data-task="' + item.index + '">依頼文</button>';
    html += '</div></article>';
  }
  html += "</div>";
  return html;
}

// ===== 新機能: 試算表増減・傾向分析 =====
function renderTrends() {
  const client = currentClient();
  const data = client.trendData;
  const alerts = data.filter((d) => d.flag === "alert");
  const oks = data.filter((d) => d.flag === "ok");

  let html = '<div class="trends-layout">';

  // サマリーカード
  html += '<div class="trend-summary">';
  html += '<div class="trend-card alert"><span>要確認科目</span><strong>' + alerts.length + '</strong></div>';
  html += '<div class="trend-card ok"><span>正常範囲</span><strong>' + oks.length + '</strong></div>';
  html += '<div class="trend-card"><span>分析対象月</span><strong>2026年4月</strong></div>';
  html += "</div>";

  // 増減テーブル（スパークバー付き）
  html += '<table class="trend-table"><thead><tr>';
  html += "<th>勘定科目</th><th>3ヶ月推移</th><th>当月</th><th>前月比</th><th>AIフラグ</th></tr></thead><tbody>";

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const pct = (d.changePct > 0 ? "+" : "") + d.changePct.toFixed(1) + "%";
    const pctClass = d.flag === "alert" ? "change-alert" : "change-ok";
    const currFmt = typeof d.curr === "number" && d.curr > 1000
      ? "¥" + d.curr.toLocaleString()
      : d.curr.toFixed(1) + "pt";

    // スパークバー
    const allVals = [...d.prev3, d.curr];
    const maxVal = Math.max(...allVals);
    html += "<tr><td><strong>" + d.account + "</strong></td><td>";
    html += '<div class="sparkbar">';
    for (let j = 0; j < d.prev3.length; j++) {
      const h = Math.round((d.prev3[j] / maxVal) * 24);
      html += '<div class="sparkbar-col" style="height:' + Math.max(h, 4) + 'px"></div>';
    }
    const currH = Math.round((d.curr / maxVal) * 24);
    html += '<div class="sparkbar-col current ' + (d.flag === "alert" ? "alert-col" : "") + '" style="height:' + Math.max(currH, 4) + 'px"></div>';
    html += "</div></td>";
    html += "<td>" + currFmt + "</td>";
    html += '<td class="' + pctClass + '">' + pct + "</td>";
    html += '<td><span class="pill ' + (d.flag === "alert" ? "urgent" : "done") + '">' + (d.flag === "alert" ? "要確認" : "正常") + "</span></td></tr>";
  }
  html += "</tbody></table>";

  if (alerts.length > 0) {
    html += '<div style="padding:14px;background:#fff5f6;border:1px solid #fbd5db;border-radius:10px;margin-top:4px">';
    html += '<strong style="font-size:13px;color:#8a2035">AIコメント</strong><br>';
    html += '<p style="margin:6px 0 0;font-size:13px;line-height:1.6">';
    const alertNames = alerts.map((a) => a.account).join("・");
    html += alertNames + ' に前月比で大きな変動が検出されました。仕訳内容と証憑の確認を優先してください。</p></div>';
  }

  html += "</div>";
  return html;
}

function renderProgress() {
  // Spec 01 F2: vendor filter tab
  const filter = appState.progressFilter || "deadline";
  let html = '<div class="progress-board">';
  html += '<div class="work-tabs">';
  html += '<button class="work-tab' + (filter === "deadline" ? " active" : "") + '" data-progress-filter="deadline">締切順</button>';
  html += '<button class="work-tab' + (filter === "owner" ? " active" : "") + '" data-progress-filter="owner">担当者別</button>';
  html += '<button class="work-tab' + (filter === "missing" ? " active" : "") + '" data-progress-filter="missing">回収待ち</button>';
  html += '<button class="work-tab' + (filter === "vendor" ? " active vendor-tab" : "") + '" data-progress-filter="vendor">ベンダー別</button>';
  html += '</div>';

  if (filter === "vendor") {
    // Group by vendor
    const groups = { freee: [], mf: [], both: [] };
    clients.forEach((c, i) => { (groups[c.vendor] || groups.mf).push({ client: c, index: i }); });
    const order = [
      { key: "mf", label: "マネーフォワード" },
      { key: "freee", label: "freee" },
      { key: "both", label: "freee と MF 両方" },
    ];
    html += '<div class="progress-table-wrap">';
    for (const g of order) {
      const rows = groups[g.key];
      if (!rows.length) continue;
      html += '<h4 style="margin:14px 0 6px;font-size:13px;color:#5c6675;">' + g.label + ' (' + rows.length + ')</h4>';
      html += '<table class="progress-table"><thead><tr>';
      html += '<th>顧問先</th><th>担当</th><th>進捗</th><th>所長確認</th><th>未回収</th></tr></thead><tbody>';
      for (const r of rows) {
        const owner = r.client.owner.split(" / ")[0].replace("担当: ", "");
        html += '<tr class="' + (r.index === appState.activeClient ? "selected-row" : "") + '">';
        html += '<td><div class="item-title"><strong>' + r.client.name + '</strong><small>' + r.client.owner + '</small></div></td>';
        html += '<td>' + owner + '</td>';
        html += '<td>' + r.client.progress + '%</td>';
        html += '<td>' + r.client.risk + '件</td>';
        html += '<td>' + r.client.missing + '件</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';
  } else {
    html += '<div class="progress-table-wrap"><table class="progress-table"><thead><tr>';
    html += '<th>顧問先</th><th>担当</th><th>状態</th><th>進捗</th><th>所長確認</th><th>未回収</th><th>次アクション</th></tr></thead><tbody>';
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      const [stage, stageClass] = progressStatus(client);
      const owner = client.owner.split(" / ")[0].replace("担当: ", "");
      const nextTask = client.tasks.find((task) => task[3] !== "done") || client.tasks[0];
      html += '<tr class="' + (i === appState.activeClient ? "selected-row" : "") + '">';
      html += '<td><div class="item-title"><strong>' + client.name + '</strong><small>' + client.owner + '</small></div></td>';
      html += '<td>' + owner + '</td>';
      html += '<td><span class="pill ' + stageClass + '">' + stage + '</span></td>';
      html += '<td><div class="progress-cell"><span>' + client.progress + '%</span><div class="mini-progress"><i style="width:' + client.progress + '%"></i></div></div></td>';
      html += '<td>' + client.risk + '件</td>';
      html += '<td>' + client.missing + '件</td>';
      html += '<td><button class="row-action" data-action="open-client" data-client-target="' + i + '">' + (nextTask ? nextTask[0] : "—") + '</button></td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  html += '<div class="dashboard-notes">';
  html += '<article><strong>所長向けに並び替え</strong><p>締切、リスク、未回収資料数をもとに、今日見る顧問先を自動で上位表示します。</p></article>';
  html += '<article><strong>担当者の作業待ちを可視化</strong><p>記帳担当・レビュー担当・顧問先待ちのどこで止まっているかを一画面で把握できます。</p></article>';
  html += '</div></div>';
  return html;
}

function renderFeedback() {
  const client = currentClient();
  const feedbackTasks = client.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task[3] !== "done")
    .filter(({ task }) => matchesSearch(task));
  let html = '<div class="feedback-layout">';
  html += '<section class="message-list">';
  if (!feedbackTasks.length) html += '<div class="empty-state">差戻し対象はありません。</div>';
  for (let i = 0; i < feedbackTasks.length; i++) {
    const item = feedbackTasks[i];
    const task = item.task;
    html += '<article class="message-card feedback-card">';
    html += '<span class="pill ' + task[3] + '">' + statusLabel(task[3]) + '</span>';
    html += '<h3>' + taskOwner(item.index) + 'さんへの差戻し</h3>';
    html += '<p>' + task[0] + 'について、' + task[1] + '。' + taskReason(task) + 'の結果を確認し、修正後に再度「記帳完了」を押してください。</p>';
    html += '<div class="feedback-meta"><span>対象: ' + task[2] + '</span><span>優先度: ' + task[4] + '%</span></div>';
    html += '<div class="row-actions"><button class="row-action" data-action="send-feedback" data-task="' + item.index + '">担当者に送る</button>';
    html += '<button class="row-action reject" data-action="approve" data-task="' + item.index + '">所長承認</button></div>';
    html += '</article>';
  }
  html += '</section><aside class="settings-card">';
  html += '<div class="setting-row"><div><strong>差戻しテンプレート</strong><p>根拠、修正内容、再提出条件を自動挿入</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>Slack通知</strong><p>担当者別にメンション付き通知</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>再レビュー予約</strong><p>修正完了後にAIレビューを自動再実行</p></div><span class="switch on"></span></div>';
  html += '</aside></div>';
  return html;
}

function renderReceipts() {
  const client = currentClient();
  let html = '<div class="split-review">';
  html += '<section><div class="section-heading"><p class="eyebrow">Documents</p><h3>証憑回収・紐付け</h3></div>';
  html += renderTable(client.receipts, ["証憑", "紐付け状況", "根拠"]);
  html += '</section><section><div class="section-heading"><p class="eyebrow">Reconciliation</p><h3>入金消込・差異</h3></div>';
  html += renderTable(client.matching, ["請求/入金", "候補判定", "根拠"]);
  html += '</section></div>';
  return html;
}

function renderValidation() {
  let html = '<div class="validation-layout">';
  html += '<section class="validation-hero"><div><p class="eyebrow">Notion Meeting Notes</p>';
  html += '<h3>今日の3つの議事録から、実装判断を固定</h3>';
  html += '<p>zeimeeは「AIで何でも自動化」ではなく、税理士事務所の所長が毎月迷うレビュー・資料不足・差戻しを減らす業務画面として作ります。</p></div>';
  html += '<div class="target-box"><span>初期ターゲット</span><strong>30〜50人規模の税理士事務所</strong><small>職員がいて、標準化による利益改善が見込める層</small></div></section>';

  html += '<section class="validation-grid">';
  for (let i = 0; i < validationNotes.length; i++) {
    const note = validationNotes[i];
    html += '<article class="validation-card">';
    html += '<span class="pill ai">' + note.source + '</span>';
    html += '<h3>' + note.title + '</h3>';
    html += '<strong>' + note.verdict + '</strong><ul>';
    for (let j = 0; j < note.details.length; j++) html += '<li>' + note.details[j] + '</li>';
    html += '</ul></article>';
  }
  html += '</section>';

  html += '<section class="roadmap-panel"><div class="section-heading"><p class="eyebrow">Build Decision</p><h3>作るもの / 後回しにするもの</h3></div>';
  for (let i = 0; i < buildRoadmap.length; i++) {
    html += '<div class="roadmap-row"><strong>' + buildRoadmap[i][0] + '</strong><p>' + buildRoadmap[i][1] + '</p></div>';
  }
  html += '</section>';

  html += '<section class="plain-ui-panel"><div><p class="eyebrow">UI Policy</p><h3>専門用語を隠して、行動だけ見せる</h3>';
  html += '<p>議事録では「RAG」「MCP」「ダッシュボード」より、税理士が今日押せるボタンに落とすことが重要でした。そのため画面上は「確認する」「差戻す」「依頼文を作る」を主役にしています。</p></div>';
  html += '<button class="primary-action" data-action="apply-validation">この方針を画面に反映</button></section>';
  html += '</div>';
  return html;
}

function renderSettings() {
  let html = '<div class="settings-layout">';
  html += '<section class="settings-card">';
  html += '<div class="setting-row"><div><strong>記帳完了トリガー</strong><p>担当者が完了にした顧問先だけAIレビューを開始</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>前月比しきい値</strong><p>15%以上の増減を所長レビューに上げる</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>証憑不足の自動依頼</strong><p>不足資料がある場合は顧問先メールを下書き</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>所長承認必須</strong><p>AI検出事項は承認後に月次完了へ反映</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>やさしい表示</strong><p>RAGやMCPなどの技術語を画面に出さない</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>ISMS準備モード</strong><p>大手事務所向けにログ、権限、証跡を強化</p></div><span class="switch"></span></div>';
  html += '</section><section class="rules-list">';
  html += '<article class="message-card"><span class="pill ai">freee / MF</span><h3>会計ソフト連携</h3><p>仕訳、残高、請求、入金、証憑ステータスを読み取り、レビューキューに変換します。</p></article>';
  html += '<article class="message-card"><span class="pill ai">初期導入先</span><h3>30〜50人規模の税理士事務所</h3><p>職員・アルバイトが複数いて、所長レビューと資料不足対応が詰まりやすい事務所に絞ります。</p></article>';
  html += '<article class="message-card"><span class="pill ai">MyKomon Alternative</span><h3>税理士事務所の業務OS</h3><p>顧問先別の進捗、担当者ToDo、顧問先依頼、所長レビューを同じワークフローにまとめます。</p></article>';
  html += '</section></div>';
  return html;
}

// Spec 03 F2: 3-column portal: edit | history | settings
function renderPortal() {
  const client = currentClient();
  if (!appState.portalChannel) {
    appState.portalChannel = client.contactPrimary || "email";
  }
  const ch = appState.portalChannel;
  const channels = ["email", "slack", "chatwork", "line_works"];
  const channelLabels = { email: "メール", slack: "Slack", chatwork: "Chatwork", line_works: "LINE WORKS", messenger: "Messenger" };
  const endpoints = client.contactEndpoints || {};

  let html = '<div class="portal-3col">';

  // Left: edit
  html += '<section>';
  html += '<p class="eyebrow">お客さまに連絡</p>';
  html += '<div class="channel-tabs">';
  for (const c of channels) {
    html += '<button class="channel-tab' + (c === ch ? " active" : "") + '" data-portal-channel="' + c + '">' + channelLabels[c] + '</button>';
  }
  html += '</div>';
  html += '<textarea id="portalDraft">' + escapeHtml(formatBodyForChannel(client.message || "", ch)) + '</textarea>';
  html += '<div class="row-actions" style="margin-top:8px">';
  html += '<button class="primary-action compact" data-action="portal-send-now">いま送る</button>';
  html += '<button class="row-action" data-action="portal-schedule">予約送信</button>';
  html += '</div>';
  html += '</section>';

  // Middle: thread history
  html += '<section>';
  html += '<p class="eyebrow">これまでのやり取り</p>';
  html += '<div id="portalThreads" style="border:1px solid #e3e7ee;border-radius:8px;background:#fff;max-height:520px;overflow:auto">';
  html += '<div class="thread-item out"><span class="thread-header">読み込み中…</span></div>';
  html += '</div>';
  html += '</section>';

  // Right: contact settings
  html += '<aside>';
  html += '<p class="eyebrow">連絡先の設定</p>';
  html += '<div class="settings-card">';
  for (const c of channels) {
    html += '<div class="setting-row"><div><strong>' + channelLabels[c] + '</strong>';
    html += '<input class="endpoint-input" data-endpoint-channel="' + c + '" value="' + (endpoints[c] || "") + '" placeholder="' + (c === "email" ? "メールアドレス" : c === "slack" ? "Channel ID" : c === "chatwork" ? "Room ID" : "Channel ID") + '" /></div>';
    html += '</div>';
  }
  html += '<div class="setting-row"><div><strong>優先チャンネル</strong>';
  html += '<select class="endpoint-input" id="primaryChannelSelect">';
  for (const c of channels) {
    html += '<option value="' + c + '"' + (c === client.contactPrimary ? " selected" : "") + '>' + channelLabels[c] + '</option>';
  }
  html += '</select></div></div>';
  html += '<div class="row-actions" style="margin-top:8px"><button class="primary-action compact" data-action="portal-save-contact">保存</button></div>';
  html += '</div>';
  html += '</aside>';

  html += '</div>';
  return html;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Mirror of server-side formatForChannel (kept simple)
function formatBodyForChannel(text, channel) {
  if (!text) return "";
  if (channel === "slack") {
    const lines = text.split("\n").filter(Boolean);
    return ["@channel"].concat(lines.map((l) => "• " + l.trim())).join("\n");
  }
  if (channel === "chatwork") return "[To:userid]\n" + text;
  if (channel === "line_works") return text.replace(/\n+/g, " ").slice(0, 280);
  if (channel === "messenger") return text.split("\n")[0] + " 📩";
  return text;
}

function renderRules() {
  const client = currentClient();
  let html = '<div class="rules-layout"><section class="rules-list">';
  for (let i = 0; i < client.rules.length; i++) {
    html += '<article class="message-card"><span class="pill ai">AIチェックルール</span>';
    html += "<h3>" + client.rules[i] + "</h3>";
    html += "<p>顧問先の過去処理、勘定科目、金額、摘要、証憑状態を見て自動判定します。</p></article>";
  }
  html += '</section><aside class="settings-card">';
  html += '<div class="setting-row"><div><strong>仕訳候補提示</strong><p>一致度90%以上の取引を確認候補化</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>確認者承認</strong><p>AI候補は担当者または税理士の確認後に反映</p></div><span class="switch"></span></div>';
  html += '<div class="setting-row"><div><strong>差異検知</strong><p>前月比15%以上を通知</p></div><span class="switch on"></span></div>';
  html += "</aside></div>";
  return html;
}

function renderView() {
  const client = currentClient();
  const views = {
    dashboard: () => renderDashboard(),
    progress: () => renderProgress(),
    feedback: () => renderFeedback(),
    portal: () => renderPortal(),
    trends: () => renderTrends(),
    receipts: () => renderReceipts(),
    rules: () => renderRules(),
    validation: () => renderValidation(),
    settings: () => renderSettings(),
  };
  viewContent.innerHTML = views[appState.activeView]();
  // Spec 01 F2: progress filter tab handlers
  viewContent.querySelectorAll("[data-progress-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.progressFilter = button.dataset.progressFilter;
      render();
    });
  });
  // Spec 03 F2: portal channel tab handlers + initial threads load
  viewContent.querySelectorAll("[data-portal-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.portalChannel = button.dataset.portalChannel;
      renderView();
    });
  });
  if (appState.activeView === "portal") {
    loadAndRenderThreads();
  }
  viewContent.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const taskIndex = button.dataset.task === undefined ? null : Number(button.dataset.task);
      if (action === "open-client") {
        appState.activeClient = Number(button.dataset.clientTarget);
        appState.activeView = "dashboard";
        render();
        showToast("レビュー対象の顧問先を開きました。");
        return;
      }
      if (action === "approve" && taskIndex !== null) {
        client.tasks[taskIndex][3] = "done";
        client.progress = Math.min(100, client.progress + 4);
        client.tasksOpen = Math.max(0, client.tasksOpen - 1);
        client.risk = Math.max(0, client.risk - 1);
        showToast("所長承認しました。月次進捗に反映します。");
        render();
        return;
      }
      if (action === "reject" && taskIndex !== null) {
        client.tasks[taskIndex][3] = "open";
        client.diff += 1;
        showToast("担当者への差戻しメモを作成しました。");
        appState.activeView = "feedback";
        render();
        return;
      }
      if (action === "ask" && taskIndex !== null) {
        const task = client.tasks[taskIndex];
        $("#messageDraft").value = client.name + " ご担当者様\n\nいつもお世話になっております。月次確認のため、以下の件について資料または補足をご共有ください。\n\n・" + task[0] + "\n\n確認後、月次処理を進めます。よろしくお願いいたします。";
        showToast("顧問先への依頼文を作成しました。");
        return;
      }
      if (action === "send-feedback") showToast("担当者に差戻し内容を送信しました。");
      if (action === "apply-validation") {
        appState.activeView = "dashboard";
        showToast("議事録の方針をレビューセンターに反映しました。");
        render();
        return;
      }
      if (action === "approve") showToast("AI候補を承認しました。月次進捗に反映します。");
      if (action === "reject") showToast("差戻しメモを作成しました。担当者ToDoに戻します。");
      if (action === "send") showToast("顧問先への依頼を送信予約しました。");
      if (action === "edit") showToast("右側の依頼文エリアで編集できます。");
      if (action === "open-vendor") {
        const vendor = button.dataset.vendor;
        const label = vendor === "mf" ? "マネーフォワード" : "freee";
        showToast(label + " の該当画面を別タブで開きます (PoCではモック)");
      }
      if (action === "portal-send-now") {
        const draft = $("#portalDraft").value;
        const client = currentClient();
        fetch("/api/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: client.id,
            channel: appState.portalChannel,
            subject: appState.portalChannel === "email" ? "月次のご確認のお願い" : undefined,
            body: draft,
          }),
        }).then(async (r) => {
          const t = await r.json();
          if (t.status === "sent") {
            showToast("送信しました");
          } else {
            showToast("送信に失敗しました: " + (t.errorMsg || t.error?.message || ""));
          }
          loadAndRenderThreads();
        }).catch(() => showToast("通信に失敗しました"));
      }
      if (action === "portal-schedule") {
        showToast("予約送信は未対応です（Bull導入後に有効化）");
      }
      if (action === "portal-save-contact") {
        const client = currentClient();
        const endpoints = {};
        document.querySelectorAll("[data-endpoint-channel]").forEach((inp) => {
          endpoints[inp.dataset.endpointChannel] = inp.value || null;
        });
        const primary = $("#primaryChannelSelect").value;
        fetch("/api/clients/" + encodeURIComponent(client.id) + "/contact", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ primary, endpoints }),
        }).then(() => {
          client.contactPrimary = primary;
          client.contactEndpoints = endpoints;
          showToast("連絡先を更新しました");
          render();
        });
      }
      if (action === "resend-thread") {
        const id = button.dataset.threadId;
        fetch("/api/messages/" + encodeURIComponent(id) + "/send", { method: "POST" })
          .then(async (r) => {
            const t = await r.json();
            showToast(t.status === "sent" ? "再送しました" : "失敗: " + (t.errorMsg || ""));
            loadAndRenderThreads();
          });
      }
    });
  });
}

function renderAiPanel() {
  const client = currentClient();

  // zeimeeくんチャット
  let chatHtml = '<div class="chat-bubble-z"><strong>zeimeeくん</strong>' + client.chatMessage + "</div>";
  if (appState.activeView === "trends") {
    const alertCount = client.trendData.filter((d) => d.flag === "alert").length;
    chatHtml += '<div class="chat-bubble-z"><strong>zeimeeくん</strong>' + alertCount + '科目で前月比の大きな変動を検出しました。スパークバーで3ヶ月トレンドが一目で分かります！</div>';
  }
  if (appState.activeView === "validation") {
    chatHtml += '<div class="chat-bubble-z"><strong>zeimeeくん</strong>今日の議事録では、税理士向けは「資料不足・進捗・レビュー」、監査向けは「PBC・調書・不正検知」に分ける方針が見えました。zeimeeは前者に集中します。</div>';
  }
  $("#zeimeeChat").innerHTML = chatHtml;

  // 優先リスト
  let listHtml = "";
  const openTasks = client.tasks.filter((t) => t[3] !== "done").slice(0, 4);
  for (let i = 0; i < openTasks.length; i++) {
    listHtml += "<li><strong>" + openTasks[i][2] + "</strong> " + openTasks[i][0] + "</li>";
  }
  $("#priorityList").innerHTML = listHtml;

  $("#messageDraft").value = client.message;

  let ruleHtml = "";
  for (let i = 0; i < client.rules.length; i++) {
    ruleHtml += '<div class="rule-hit"><strong>' + client.rules[i] + "</strong><span>直近処理と照合済み</span></div>";
  }
  $("#ruleHits").innerHTML = ruleHtml;
}

function renderNav() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === appState.activeView);
  });
  document.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === appState.activeFilter);
  });
}

function render() {
  renderClients();
  renderSummary();
  renderNav();
  renderView();
  renderAiPanel();
  renderIntegrationCard();
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    appState.activeView = button.dataset.view;
    appState.activeFilter = "all";
    render();
  });
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => { appState.activeFilter = button.dataset.filter; render(); });
});

$("#searchInput").addEventListener("input", (event) => {
  appState.search = event.target.value.trim();
  renderView();
});

$("#runAiButton").addEventListener("click", () => {
  const client = currentClient();
  client.progress = Math.min(99, client.progress + 3);
  client.tasksOpen = Math.max(0, client.tasksOpen - 1);
  showToast("AI処理が完了しました。新しい候補と依頼文を更新しました。");
  render();
});

$("#rewriteMessage").addEventListener("click", () => {
  const client = currentClient();
  const lines = client.tasks.filter((t) => t[3] !== "done").slice(0, 3).map((t) => "・" + t[0]).join("\n");
  $("#messageDraft").value = client.name + " ご担当者様\n\nいつもお世話になっております。月次処理の確認にあたり、不足資料と確認事項を整理しました。\n\n" + lines + "\n\nお手すきの際にご確認をお願いいたします。";
  showToast("依頼文を顧問先向けに整えました。");
});

$("#copyMessage").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#messageDraft").value);
    showToast("依頼文をコピーしました。");
  } catch {
    showToast("依頼文を選択してコピーできます。");
  }
});

loadClientsFromApi().finally(render);
