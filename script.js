const appState = {
  activeClient: 0,
  activeView: "dashboard",
  activeFilter: "all",
  clients: [],
  crmSearch: "",
  crmStatusFilter: "all",
  dashboardTodos: [],
  dashboardAiPendingCount: 0,
  dashboardAiDifficultCount: 0,
  dashboardMissingReceipts: [],
  dashboardMissingCount: 0,
  mfReviewStatus: "pending",
  search: "",
  currentRole: (typeof localStorage !== "undefined" && localStorage.getItem("bookmee.role")) || "tax_accountant",
  simpleMode: (typeof localStorage !== "undefined" && localStorage.getItem("bookmee.simpleMode") === "true"),
  expandedHistory: {}, // taskId -> bool
  pendingDraftBody: null,
  vouchers: [],
  voucherTab: 'unassigned',
  voucherCounts: {},
  uploadQueue: [],
  voucherPollTimer: null,
  matchingTab: null,
  matchingVouchers: [],
  matchingEntries: [],
  matchingLoadedTab: null,
  driveIntegration: null,
  driveFolders: [],
  driveMappings: [],
  driveLastSync: null,
  driveLastBackfill: null,
  driveVouchers: [],
  driveFiles: [],
  driveLoadedAt: null,
  lineIntegration: null,
  lineUsers: [],
  lineVerifyResult: null,
  lineLoadedAt: null,
  inboundPollTimer: null,
  notifications: [],
  user: null, // { authUserId, firmId, role, email, firmName } — set on startup
};

// Authenticated fetch wrapper — injects Bearer token for all /api/ requests.
function apiFetch(url, options) {
  var opts = options || {};
  var session = window.__bookmeeSession;
  var token = session && session.access_token;
  var headers = Object.assign({}, opts.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(url, Object.assign({}, opts, { headers: headers }));
}

async function loadVoucherImageBlob(voucherId) {
  try {
    const res = await apiFetch(`/api/vouchers/${voucherId}/image`);
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (_) {
    return null;
  }
}

// 証憑画像/PDF を新しいタブで開く。/api/vouchers/:id/image は JWT 必須なので
// 素の <a href>/window.open では Authorization ヘッダが付かず UNAUTHORIZED になる。
// apiFetch で取得して blob URL を開く。クリックのジェスチャ内でタブを先に開き、
// 取得後に遷移させてポップアップブロックを回避する。
async function openVoucherImage(voucherId) {
  const w = window.open('', '_blank');
  const url = await loadVoucherImageBlob(voucherId);
  if (!url) {
    if (w) w.close();
    showToast('画像の取得に失敗しました');
    return;
  }
  if (w) w.location.href = url;
  else window.open(url, '_blank');
}

function hydrateVoucherImages() {
  document.querySelectorAll('[data-voucher-img]').forEach(async (img) => {
    const id = img.dataset.voucherImg;
    if (!id) return;
    if (img.dataset.voucherImgLoading === '1') return;
    if (img.getAttribute('src')) return;
    img.dataset.voucherImgLoading = '1';
    const url = await loadVoucherImageBlob(id);
    if (url) img.src = url;
    delete img.dataset.voucherImgLoading;
  });
}

// Loaded from /api/clients on startup. Empty until the first fetch resolves.
let clients = appState.clients;

// 中央集約 labels: API は英語コード (e.g. "awaiting_approval") を返す。
// UI は常に labels.* を経由して日本語化する。
const labels = {
  // View titles (eyebrow)
  dashboard: "ToDo",
  company: "顧問先",
  crm: "顧問先CRM",
  "jobs-journal": "月次業務 / 仕訳",
  "jobs-vouchers": "月次業務 / 証憑",
  "jobs-monthly-check": "月次業務 / 月次チェック",
  "vouchers-register": "証憑登録",
  "matching-results": "突合結果",
  portal: "メッセージ",
  "integrations-drive": "連携 / Google Drive",
  "integrations-line": "連携 / LINE",
  "mf-review": "月次業務 / 摘要レビュー",
  rules: "学習",
  "rag-db": "RAG知識DB",
  training: "新人研修",
  settings: "設定",
  guide: "使い方",
  "tax-suggestions": "コンサル / 節税提案",
  cashflow: "コンサル / CF予測",
  "client-portal": "コンサル / 顧問先ポータル",
  "fixed-assets": "会計分析 / 固定資産台帳",
  accruals: "会計分析 / 期間配分チェック",
  "ar-matching": "会計分析 / 売上突合",
  "bank-statement": "会計分析 / 銀行明細",

  status: { urgent: "要確認", open: "作業中", done: "終わった" },
  stage: {
    staff_doing: "担当者が作業中",
    awaiting_approval: "所長に見てもらい待ち",
    approved: "所長OK",
    rejected: "やり直し依頼中",
  },
  channel: {
    email: "メール",
    slack: "Slack",
    chatwork: "Chatwork",
    line_works: "LINE WORKS",
    messenger: "Messenger",
  },
  vendor: { freee: "freee", mf: "マネーフォワード", both: "freeeとMF両方" },
  mode: { monthly: "毎月のチェック", yearend: "決算のチェック" },
  syncStatus: { ok: "取り込み済み", warn: "一部失敗", error: "取り込めず" },
  threadStatus: {
    queued: "送信待ち",
    sent: "送信済み",
    failed: "うまく届かず",
    received: "受信",
  },
  helper: {
    dashboard: "AIが先にチェックした件のうち、あなたが今日触る分だけ表示しています。",
    company: "選んだ顧問先の会社情報・連携状況・過去の取引履歴を確認できます。",
    crm: "顧問先の対応状況、最終連絡日、未処理件数をまとめて確認できます。",
    "jobs-journal": "マネーフォワードから取り込んだ仕訳一覧です。",
    "jobs-vouchers": "領収書が足りていない取引と、依頼文の作成。",
    "jobs-monthly-check": "前月比や残高チェックなど月次レビューの観点。",
    "vouchers-register": "領収書・請求書などの画像をまとめてアップロードします。未分類プールに入り、後で OCR で振り分けます。",
    "matching-results": "アップロード済み証憑と MF 仕訳の突合結果を顧問先ごとに確認します。",
    portal: "お客さまにメールやSlackなどで連絡できます。届かなかったら再送できます。",
    "integrations-drive": "Google Drive にあるレシート画像を自動取り込みします。スタッフ用の事務所共通アカウントを 1 つ接続して、サブフォルダを顧問先に割り当ててください。",
    "integrations-line": "公式 LINE アカウントに送られた画像を自動取り込みします。スタッフが LINE で画像を送るだけで Voucher になります。",
    "mf-review": "摘要が空のMF仕訳をAIで自動補完します。信頼度が高いものは自動適用、低いものだけ確認が必要です。",
    rules: "この顧問先で過去にミスしやすかった点を、企業ごとのチェック項目として保存します。",
    "rag-db": "AIが参照する仕訳パターン辞書と会計事典を管理します",
    training: "事務所のルールとAI補正履歴から、新人向け研修カードを自動生成します。",
    settings: "事務所全体の運用設定。",
    guide: "経理丸ごとAIの基本的な使い方を確認できます。",
    "tax-suggestions": "仕訳データをAIで分析して節税の提案を生成します。提案を「実施済み」「見送り」で管理できます。",
    cashflow: "過去6ヶ月の仕訳から翌3ヶ月のキャッシュフローを予測します。資金繰りの警戒ラインを早期に把握できます。",
    "client-portal": "顧問先が直接閲覧できる月次レポートURLを発行します。ログイン不要でアクセスできます。",
    "fixed-assets": "MFの仕訳から固定資産を抽出し、法定耐用年数・年間償却額を表示します。30万円以上は契約書確認フラグ付き。",
    accruals: "未払費用（地代家賃・リース等）と前払費用（年払保険・ソフト年額等）の計上漏れ候補を検出します。",
    "ar-matching": "売掛金の発生と入金を突合して、未回収の売掛金を一覧表示します。回収遅延のエイジング分析付き。",
    "bank-statement": "銀行明細CSVをインポートして、不明な出金を自動検出します。顧問先への確認依頼に活用できます。",
  },
};

const viewDocumentTitles = {
  dashboard: "ToDo | 経理丸ごとAI",
  company: "顧問先 | 経理丸ごとAI",
  crm: "顧問先CRM | 経理丸ごとAI",
  "jobs-journal": "仕訳 | 経理丸ごとAI",
  "jobs-vouchers": "証憑 | 経理丸ごとAI",
  "jobs-monthly-check": "月次チェック | 経理丸ごとAI",
  "vouchers-register": "証憑登録 | 経理丸ごとAI",
  "matching-results": "突合結果 | 経理丸ごとAI",
  portal: "メッセージ | 経理丸ごとAI",
  "integrations-drive": "Google Drive連携 | 経理丸ごとAI",
  "integrations-line": "LINE連携 | 経理丸ごとAI",
  "mf-review": "摘要レビュー | 経理丸ごとAI",
  rules: "学習 | 経理丸ごとAI",
  "rag-db": "RAG知識DB | 経理丸ごとAI",
  training: "新人研修 | 経理丸ごとAI",
  settings: "設定 | 経理丸ごとAI",
  guide: "使い方 | 経理丸ごとAI",
  "tax-suggestions": "節税提案 | 経理丸ごとAI",
  cashflow: "CF予測 | 経理丸ごとAI",
  "client-portal": "顧問先ポータル | 経理丸ごとAI",
  "fixed-assets": "固定資産台帳 | 経理丸ごとAI",
  accruals: "期間配分チェック | 経理丸ごとAI",
  "ar-matching": "売上突合 | 経理丸ごとAI",
  "bank-statement": "銀行明細 | 経理丸ごとAI",
};

function friendlyError(err) {
  if (!err) return "うまくいきませんでした。";
  const msg = String(err.message || err);
  if (/network|fetch/i.test(msg)) return "ネットがつながっていないかもしれません。";
  if (/timeout/i.test(msg)) return "通信が時間切れになりました。もう一度お試しください。";
  return "うまくいきませんでした。";
}

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
const clientChips = $("#clientChips");
const viewContent = $("#viewContent");
const toast = $("#toast");

function currentClient() { return clients[appState.activeClient]; }

function hasEditableFocus(target) {
  if (!target) return false;
  const tag = (target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return !!target.closest?.('[contenteditable="true"]');
}

function ensureHelpModal() {
  let modal = document.getElementById("helpModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "helpModal";
  modal.className = "help-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="help-modal-backdrop" data-help-close></div>
    <div class="help-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="helpModalTitle">
      <div class="help-modal-head">
        <h3 id="helpModalTitle">使い方ガイド</h3>
        <button class="ghost-btn" type="button" data-help-close>✕閉じる</button>
      </div>
      <div class="help-modal-body">
        <p class="help-modal-section-title">基本的な使い方</p>
        <ol>
          <li>顧問先チップ（左上）をクリック</li>
          <li>「月次業務」から各メニューへ</li>
        </ol>
        <p class="help-modal-section-title">よくある操作</p>
        <ul>
          <li>LINEで領収書を送る → LINE設定から</li>
          <li>仕訳をMFに反映 → 摘要レビューから</li>
          <li>証憑不足を確認 → ToDoダッシュから</li>
          <li>弥生にCSV出力 → 仕訳/証憑ビューから</li>
        </ul>
        <p class="help-modal-section-title">ショートカット</p>
        <ul>
          <li><code>?</code> : このヘルプを開く</li>
          <li><code>Esc</code> : モーダルを閉じる</li>
        </ul>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelectorAll("[data-help-close]").forEach((el) => {
    el.addEventListener("click", closeOpenModal);
  });
  return modal;
}

function closeOpenModal() {
  const helpModal = document.getElementById("helpModal");
  if (helpModal && !helpModal.hidden) {
    helpModal.hidden = true;
    return true;
  }
  const voucherModal = document.getElementById("voucherModal");
  if (voucherModal && !voucherModal.hidden) {
    voucherModal.hidden = true;
    return true;
  }
  return false;
}

function openHelpModal() {
  const modal = ensureHelpModal();
  modal.hidden = false;
}

function updateClientContextBar() {
  const bar = document.getElementById('clientContextBar');
  const nameEl = document.getElementById('clientContextName');
  const eyebrowEl = document.getElementById('topbarEyebrow');
  const defaultEyebrow = '2026年5月 月次レビュー';
  if (!bar || !nameEl) return;
  const c = currentClient();
  if (c) {
    nameEl.textContent = c.name;
    bar.style.display = 'block';
    if (eyebrowEl) eyebrowEl.textContent = `顧問先: ${c.name} ・ ${defaultEyebrow}`;
  } else {
    nameEl.textContent = '未選択';
    bar.style.display = 'block';
    if (eyebrowEl) eyebrowEl.textContent = `顧問先: 未選択 ・ ${defaultEyebrow}`;
  }
}

async function loadClientsFromApi() {
  try {
    const listRes = await apiFetch("/api/clients");
    if (!listRes.ok) throw new Error("HTTP " + listRes.status);
    const summaries = await listRes.json();
    if (!Array.isArray(summaries) || summaries.length === 0) return;

    const detailed = await Promise.all(
      summaries.map(async (s) => {
        const detailRes = await apiFetch("/api/clients/" + encodeURIComponent(s.id));
        if (!detailRes.ok) return null;
        const detail = await detailRes.json();
        return adaptApiClient(detail);
      })
    );
    const filtered = detailed.filter(Boolean);
    if (filtered.length > 0) {
      clients = filtered;
      appState.clients = clients;
      restoreClientOrder();
    }
  } catch (err) {
    console.warn("Failed to load clients from API; using inline fallback", err);
  }
}

function saveClientOrder() {
  try {
    localStorage.setItem("clientOrder", JSON.stringify(clients.map((c) => c.id)));
  } catch (e) {}
}

function restoreClientOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem("clientOrder") || "[]");
    if (!saved.length) return;
    const ordered = [];
    for (const id of saved) {
      const c = clients.find((cl) => cl.id === id);
      if (c) ordered.push(c);
    }
    for (const c of clients) {
      if (!ordered.find((o) => o.id === c.id)) ordered.push(c);
    }
    clients.length = 0;
    ordered.forEach((c) => clients.push(c));
  } catch (e) {}
}

async function loadVouchers() {
  const tab = appState.voucherTab;
  const url =
    tab === 'unassigned'
      ? '/api/vouchers?clientId=unassigned'
      : `/api/vouchers?clientId=${encodeURIComponent(tab)}`;
  try {
    const res = await apiFetch(url);
    if (!res.ok) throw new Error('list failed');
    appState.vouchers = await res.json();
    appState.vouchersLoadedTab = tab;
    await refreshVoucherCounts();
    renderView();
    hydrateVoucherImages();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function refreshVoucherCounts() {
  try {
    const res = await apiFetch('/api/vouchers');
    if (!res.ok) return;
    const all = await res.json();
    const counts = { unassigned: 0 };
    for (const v of all) {
      const key = v.clientId ?? 'unassigned';
      counts[key] = (counts[key] || 0) + 1;
    }
    appState.voucherCounts = counts;
  } catch (_err) {
    // counts are best-effort
  }
}

async function uploadVouchers(files) {
  const role =
    document.querySelector('#roleSelector')?.value || 'スタッフ';
  for (const file of files) {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
      showToast(`${file.name}: 対応していない形式です`);
      continue;
    }
    if (file.size > 10 * 1024 * 1024) {
      showToast(`${file.name}: ファイルが大きすぎます (上限 10MB)`);
      continue;
    }
    const tempId = 'tmp-' + Math.random().toString(36).slice(2);
    appState.uploadQueue.push({
      tempId,
      filename: file.name,
      status: 'uploading',
    });
    renderView();
    const form = new FormData();
    form.append('file', file);
    if (appState.voucherTab !== 'unassigned') {
      form.append('clientId', appState.voucherTab);
    }
    // 証憑種別（請求書/売上 vs 経費/領収書）
    const voucherTypeEl = document.querySelector('input[name="voucherType"]:checked');
    const voucherType = voucherTypeEl?.value || 'manual';
    if (voucherType === 'invoice') {
      form.append('voucherSource', 'invoice');
    }
    try {
      const res = await apiFetch('/api/vouchers', {
        method: 'POST',
        body: form,
        headers: { 'x-uploaded-by': role },
      });
      if (!res.ok) throw new Error('upload failed');
      const idx = appState.uploadQueue.findIndex((q) => q.tempId === tempId);
      if (idx >= 0) appState.uploadQueue.splice(idx, 1);
    } catch (_err) {
      const item = appState.uploadQueue.find((q) => q.tempId === tempId);
      if (item) item.status = 'failed';
      showToast(`${file.name}: アップロードに失敗しました`);
    }
  }
  appState.vouchersLoadedTab = null;
  await loadVouchers();
}

async function deleteVoucherById(id) {
  if (!confirm('この証憑を削除しますか？')) return;
  try {
    const res = await apiFetch(`/api/vouchers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('delete failed');
    appState.vouchersLoadedTab = null;
    await loadVouchers();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function loadMatchingData() {
  const tab = appState.matchingTab;
  if (!tab) return;
  try {
    const voucherUrl =
      tab === 'unassigned'
        ? '/api/vouchers?clientId=unassigned'
        : `/api/vouchers?clientId=${encodeURIComponent(tab)}`;
    const requests = [apiFetch(voucherUrl).then((r) => r.json())];
    if (tab !== 'unassigned') {
      requests.push(
        apiFetch(`/api/clients/${encodeURIComponent(tab)}`).then((r) => r.json()),
      );
    }
    const [vouchers, client] = await Promise.all(requests);
    appState.matchingVouchers = vouchers;
    appState.matchingEntries = client?.entries || [];
    appState.matchingLoadedTab = tab;
    renderView();
    hydrateVoucherImages();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function rematchVoucher(id) {
  try {
    const res = await apiFetch(`/api/vouchers/${id}/match`, { method: 'POST' });
    if (!res.ok) throw new Error('rematch failed');
    setTimeout(() => {
      appState.matchingLoadedTab = null;
      loadMatchingData();
    }, 800);
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function redraftVoucherJournal(id) {
  try {
    const res = await apiFetch(`/api/vouchers/${id}/draft-journal`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('redraft failed');
    setTimeout(() => {
      appState.matchingLoadedTab = null;
      loadMatchingData();
    }, 1500);
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function inquireVoucherClient(id) {
  try {
    const res = await apiFetch(`/api/vouchers/${id}/inquire`, { method: 'POST' });
    if (!res.ok) throw new Error('inquire failed');
    setTimeout(() => {
      appState.matchingLoadedTab = null;
      loadMatchingData();
    }, 800);
  } catch (err) {
    showToast(friendlyError(err));
  }
}

// spec 29: 顧客のメール返信本文を取り込んで仕訳ドラフトを作り直す（疑似受信）
// 再ドラフト(OpenAI)はサーバ側でバックグラウンド実行され即応答する。完了まで数十秒
// かかるので、ボタンを無効化（連打防止）し、matching を数回ポーリング更新して反映する。
async function submitVoucherReply(id, btn) {
  const ta = document.querySelector(`[data-voucher-reply-text="${id}"]`);
  const text = ta && ta.value ? ta.value.trim() : '';
  if (!text) {
    showToast('返信内容を入力してください');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = '取り込み中…';
  }
  try {
    const res = await apiFetch(`/api/vouchers/${id}/email-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error('reply failed');
    showToast('返信を取り込みました。仕訳を作り直しています…');
    appState.matchingLoadedTab = null;
    loadMatchingData();
    // 再ドラフト完了（drafting → drafted/needs_info）まで最大 ~96 秒ポーリング更新
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (appState.activeView !== 'matching-results' || tries > 12) {
        clearInterval(timer);
        return;
      }
      appState.matchingLoadedTab = null;
      loadMatchingData();
    }, 8000);
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '返信を取り込む';
    }
    showToast(friendlyError(err));
  }
}

async function approveVoucherJournal(id) {
  try {
    const res = await apiFetch(`/api/vouchers/${id}/journal`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    if (!res.ok) throw new Error('approve failed');
    appState.matchingLoadedTab = null;
    await loadMatchingData();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function writeMfJournal(id) {
  try {
    const res = await apiFetch(`/api/vouchers/${id}/mf-write`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || 'mf-write failed');
    }
    showToast('MoneyForwardへの入力を開始しました。', "info");
    appState.matchingLoadedTab = null;
    appState.vouchersLoadedTab = null;
    if (appState.activeView === 'integrations-drive') {
      await loadDriveVouchers();
      renderView();
    } else if (appState.activeView === 'vouchers-register') {
      await loadVouchers();
    } else if (appState.activeView === 'jobs-vouchers') {
      await loadAndRenderJobsVouchers();
    } else {
      await loadMatchingData();
    }
  } catch (err) {
    showToast(friendlyError(err), "error");
  }
}

async function retryMfWrite(clientId, voucherId) {
  try {
    const res = await apiFetch(
      `/api/clients/${encodeURIComponent(clientId)}/vouchers/${encodeURIComponent(voucherId)}/mf-retry`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || 'mf-retry failed');
    }
    showToast('MF送信を再試行しました。', "info");
    appState.matchingLoadedTab = null;
    appState.vouchersLoadedTab = null;
    if (appState.activeView === 'integrations-drive') {
      await loadDriveVouchers();
      renderView();
    } else if (appState.activeView === 'vouchers-register') {
      await loadVouchers();
    } else if (appState.activeView === 'jobs-vouchers') {
      await loadAndRenderJobsVouchers();
    } else {
      await loadMatchingData();
    }
  } catch (err) {
    showToast(friendlyError(err), "error");
  }
}

function filenameFromDisposition(disposition) {
  if (!disposition) return null;
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (_err) {
      return utf8Match[1];
    }
  }
  const basicMatch = disposition.match(/filename="([^"]+)"/i);
  if (basicMatch && basicMatch[1]) return basicMatch[1];
  return null;
}

async function exportVouchersCsv() {
  const clientId = currentClient()?.id;
  if (!clientId) {
    showToast('顧問先を選択してください', 'error');
    return;
  }
  const formatEl = document.getElementById('csvFormat');
  const format = formatEl && formatEl.value ? formatEl.value : 'generic';
  try {
    const res = await apiFetch(
      `/api/clients/${encodeURIComponent(clientId)}/vouchers/export-csv?format=${encodeURIComponent(format)}`,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || 'csv export failed');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition');
    const filename =
      filenameFromDisposition(disposition) ||
      `journals-${new Date().toISOString().slice(0, 10)}.csv`;
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    showToast(friendlyError(err), 'error');
  }
}

async function reassignVoucherClient(id, newClientId) {
  try {
    const res = await apiFetch(`/api/vouchers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: newClientId }),
    });
    if (!res.ok) throw new Error('reassign failed');
    setTimeout(() => {
      appState.matchingLoadedTab = null;
      loadMatchingData();
    }, 800);
  } catch (err) {
    showToast(friendlyError(err));
  }
}

// -----------------------------------------------------------------------------
// Spec 15: Google Drive integration fetchers
// -----------------------------------------------------------------------------

async function loadDriveStatus() {
  try {
    const res = await apiFetch('/api/integrations/drive');
    if (!res.ok) throw new Error('drive status failed');
    appState.driveIntegration = await res.json();
  } catch (_err) {
    appState.driveIntegration = null;
  }
}

async function loadDriveMappings() {
  try {
    const res = await apiFetch('/api/integrations/drive/mappings');
    if (!res.ok) return;
    const json = await res.json();
    // Backend wraps the list as { mappings: [...] }
    appState.driveMappings = Array.isArray(json) ? json : json.mappings || [];
  } catch (_err) {
    /* best-effort */
  }
}

async function loadDriveFolders() {
  try {
    const res = await apiFetch('/api/integrations/drive/folders');
    if (!res.ok) {
      appState.driveFolders = [];
      return;
    }
    const json = await res.json();
    appState.driveFolders = Array.isArray(json) ? json : json.folders || [];
  } catch (_err) {
    appState.driveFolders = [];
  }
}

async function loadDriveFiles() {
  try {
    const res = await apiFetch('/api/integrations/drive/files');
    if (!res.ok) { appState.driveFiles = []; return; }
    const data = await res.json();
    appState.driveFiles = data.files || [];
  } catch (_) { appState.driveFiles = []; }
}

async function loadDriveVouchers() {
  const mappings = appState.driveMappings || [];
  if (mappings.length === 0) { appState.driveVouchers = []; return; }
  const clientIds = [...new Set(mappings.map(m => m.clientId).filter(Boolean))];
  let all = [];
  for (const cid of clientIds) {
    try {
      const res = await apiFetch(`/api/vouchers?clientId=${encodeURIComponent(cid)}`);
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.vouchers || data);
      all = all.concat(list.filter(v => v.source === 'drive'));
    } catch (_) {}
  }
  all.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  appState.driveVouchers = all;
}

async function triggerDriveSync() {
  try {
    const res = await apiFetch('/api/integrations/drive/sync', { method: 'POST' });
    if (!res.ok) throw new Error('sync failed');
    appState.driveLastSync = await res.json();
    const s = appState.driveLastSync || {};
    const importedCount = s.imported ?? 0;
    if (importedCount > 0) {
      showToast(`${importedCount}件の新しいファイルを取り込みました。`);
    } else {
      showToast('新着ファイルはありませんでした。');
    }
    renderView();
    await Promise.all([loadDriveVouchers(), loadDriveFiles()]);
    renderView();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function triggerDriveBackfill() {
  try {
    const res = await apiFetch('/api/integrations/drive/backfill', { method: 'POST' });
    if (!res.ok) throw new Error('backfill failed');
    const s = await res.json();
    appState.driveLastBackfill = s;
    const r = s.skipReasons || {};
    const importedCount = s.imported ?? 0;
    const skippedCount = s.skipped ?? 0;
    if (importedCount > 0) {
      showToast(`${importedCount}件の画像を取り込みました。`);
    } else if (skippedCount > 0) {
      const parts = [];
      if (r.duplicate) parts.push(`重複${r.duplicate}件`);
      if (r.tooLarge) parts.push(`容量超${r.tooLarge}件`);
      if (r.wrongType) parts.push(`形式NG${r.wrongType}件`);
      const detail = parts.length ? ` (${parts.join('、')})` : '';
      showToast(`スキップ: ${skippedCount}件${detail}`);
    } else {
      showToast('取込対象ファイルがありませんでした。');
    }
    await Promise.all([loadDriveVouchers(), loadDriveFiles()]);
    renderView();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function saveDriveMapping(driveFolderId, folderName, clientId) {
  try {
    const res = await apiFetch('/api/integrations/drive/mappings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driveFolderId, folderName, clientId }),
    });
    if (!res.ok) throw new Error('save mapping failed');
    await loadDriveMappings();
    renderView();
    showToast('mapping を保存しました');
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function deleteDriveMapping(id) {
  try {
    const res = await apiFetch(`/api/integrations/drive/mappings/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('delete failed');
    await loadDriveMappings();
    renderView();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function saveDriveSettings(rootFolderInput) {
  try {
    // URL形式 (https://drive.google.com/drive/folders/XXXX) からIDを抽出
    let rootFolderId = (rootFolderInput || '').trim();
    const urlMatch = rootFolderId.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) rootFolderId = urlMatch[1];
    const res = await apiFetch('/api/integrations/drive/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootFolderId }),
    });
    if (!res.ok) throw new Error('save settings failed');
    await loadDriveStatus();
    await loadDriveFolders();
    renderView();
    showToast('フォルダを設定しました');
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function disconnectDrive() {
  if (!confirm('Google Drive 連携を解除しますか？')) return;
  try {
    const res = await apiFetch('/api/integrations/drive', { method: 'DELETE' });
    if (!res.ok) throw new Error('disconnect failed');
    appState.driveIntegration = null;
    appState.driveFolders = [];
    appState.driveMappings = [];
    renderView();
    showToast('Drive 連携を解除しました');
  } catch (err) {
    showToast(friendlyError(err));
  }
}

// -----------------------------------------------------------------------------
// Spec 16: LINE integration fetchers
// -----------------------------------------------------------------------------

async function loadLineStatus() {
  try {
    const res = await apiFetch('/api/integrations/line');
    if (!res.ok) throw new Error('line status failed');
    appState.lineIntegration = await res.json();
  } catch (_err) {
    appState.lineIntegration = null;
  }
}

async function loadLineUsers() {
  try {
    const res = await apiFetch('/api/integrations/line/users');
    if (!res.ok) return;
    const json = await res.json();
    appState.lineUsers = Array.isArray(json) ? json : json.users || [];
  } catch (_err) {
    /* best-effort */
  }
}

async function verifyLine() {
  try {
    const res = await apiFetch('/api/integrations/line/verify', {
      method: 'POST',
    });
    appState.lineVerifyResult = await res.json();
    renderView();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function updateLineUser(id, patch) {
  try {
    const res = await apiFetch(`/api/integrations/line/users/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('update failed');
    await loadLineUsers();
    renderView();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

async function deleteLineUser(id) {
  if (!confirm('このユーザの mapping を削除しますか？')) return;
  try {
    const res = await apiFetch(`/api/integrations/line/users/${id}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('delete failed');
    await loadLineUsers();
    renderView();
  } catch (err) {
    showToast(friendlyError(err));
  }
}

// -----------------------------------------------------------------------------
// Spec 02: staff approval workflow fetchers
// -----------------------------------------------------------------------------

// Fetch tasks filtered by the active role for the current client.
async function loadTasksForCurrentClient() {
  const client = currentClient();
  if (!client?.id) return [];
  try {
    const url =
      "/api/clients/" +
      encodeURIComponent(client.id) +
      "/tasks?role=" +
      encodeURIComponent(appState.currentRole);
    const res = await apiFetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const tasks = await res.json();
    appState.tasks = tasks;
    appState.tasksLoadedClient = client.id + ":" + appState.currentRole;
    return tasks;
  } catch (err) {
    showToast(friendlyError(err));
    return [];
  }
}

// Apply a stage transition to a task (approve/reject/staff_complete/resubmit).
async function transitionTask(id, action, comment) {
  try {
    const by = appState.currentRole === "staff" ? "鈴木" : "畠山";
    const res = await apiFetch(
      "/api/tasks/" + encodeURIComponent(id) + "/transition",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, by, comment }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || "HTTP " + res.status);
    }
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// Fetch append-only audit history for a single task.
async function loadTaskHistory(id) {
  try {
    const res = await apiFetch(
      "/api/tasks/" + encodeURIComponent(id) + "/history",
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    return [];
  }
}

// -----------------------------------------------------------------------------
// Spec 03: unified client channels (portal) fetchers
// -----------------------------------------------------------------------------

// Fetch the channel-history timeline for the currently selected client.
async function loadThreads() {
  const client = currentClient();
  if (!client?.id) return [];
  try {
    const res = await apiFetch(
      "/api/clients/" + encodeURIComponent(client.id) + "/threads",
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const threads = await res.json();
    appState.threads = Array.isArray(threads) ? threads : [];
    appState.threadsLoadedClient = client.id;
    return appState.threads;
  } catch (err) {
    showToast(friendlyError(err));
    return [];
  }
}

// Create a Thread (queued) and trigger immediate send on the server.
async function sendMessage(payload) {
  try {
    const res = await apiFetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || "HTTP " + res.status);
    }
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// Re-trigger send for a previously-failed thread.
async function resendMessage(id) {
  try {
    const res = await apiFetch(
      "/api/messages/" + encodeURIComponent(id) + "/send",
      { method: "POST" },
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Spec 05: monthly vs yearend mode fetchers
// -----------------------------------------------------------------------------

// Switch the current client's mode (monthly | yearend) on the server.
async function updateClientMode(mode) {
  const client = currentClient();
  if (!client?.id) return null;
  try {
    const res = await apiFetch(
      "/api/clients/" + encodeURIComponent(client.id) + "/mode",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      },
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// Fetch the yearend checklist for the current client.
async function loadYearendChecklist() {
  const client = currentClient();
  if (!client?.id) return [];
  try {
    const res = await apiFetch(
      "/api/clients/" +
        encodeURIComponent(client.id) +
        "/yearend-checklist",
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    appState.yearend = Array.isArray(rows) ? rows : [];
    appState.yearendLoadedClient = client.id;
    return appState.yearend;
  } catch (err) {
    showToast(friendlyError(err));
    return [];
  }
}

// Update a single yearend checklist row (status / note).
async function updateYearendCheck(id, body) {
  try {
    const res = await apiFetch(
      "/api/yearend-checks/" + encodeURIComponent(id),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Spec 04: per-client risk rules fetchers
// -----------------------------------------------------------------------------

// Fetch the rule list for the current client.
async function loadRules() {
  const client = currentClient();
  if (!client?.id) return [];
  try {
    const res = await apiFetch(
      "/api/clients/" + encodeURIComponent(client.id) + "/rules",
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rules = await res.json();
    appState.rules = Array.isArray(rules) ? rules : [];
    appState.rulesLoadedClient = client.id;
    return appState.rules;
  } catch (err) {
    showToast(friendlyError(err));
    return [];
  }
}

// Fetch the industry rule-template catalog (e.g. "広告制作").
async function loadRuleTemplates(industry) {
  try {
    const res = await apiFetch(
      "/api/rule-templates?industry=" + encodeURIComponent(industry || ""),
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    return [];
  }
}

// Create a new rule (template or custom).
async function addRule(body) {
  const client = currentClient();
  if (!client?.id) return null;
  try {
    const res = await apiFetch(
      "/api/clients/" + encodeURIComponent(client.id) + "/rules",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// Update an existing rule (active toggle, title, severity, etc.).
async function updateRule(id, body) {
  try {
    const res = await apiFetch("/api/rules/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// Delete a rule by id.
async function deleteRuleById(id) {
  try {
    const res = await apiFetch("/api/rules/" + encodeURIComponent(id), {
      method: "DELETE",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return true;
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

// Fetch RuleHit rows (recent firing events) for a single rule.
async function loadRuleHits(ruleId) {
  try {
    const res = await apiFetch(
      "/api/rules/" + encodeURIComponent(ruleId) + "/hits",
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    return [];
  }
}

// Update the client's primary channel + endpoint map.
async function updateContact(body) {
  const client = currentClient();
  if (!client?.id) return null;
  try {
    const res = await apiFetch(
      "/api/clients/" + encodeURIComponent(client.id) + "/contact",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || "HTTP " + res.status);
    }
    return await res.json();
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

function adaptApiClient(d) {
  // Save raw tasks (with stage etc.) so spec 02 can render workflow buttons.
  const rawTasks = (d.tasks ?? []);
  const mfConnected = !!d.mfConnected;
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
    memo: d.memo ?? "",
    tags: d.tags ?? [],
    crmStatus: d.crmStatus ?? "active",
    lastContactAt: d.lastContactAt ?? null,
    vendorSyncs: d.vendorSyncs ?? [],
    fiscalYearEnd: d.fiscalYearEnd ?? null,
    yearendKpi: d.yearendKpi ?? null,
    tasks: rawTasks.map((t) => [
      t.title,
      t.note,
      t.category,
      t.status,
      t.score,
    ]),
    rawTasks: rawTasks,
    mfConnected: mfConnected,
    mfAccessToken: d.mfAccessToken ?? null,
    // Preserve entry objects as-is so renderers (renderJobsJournal,
    // renderJobsMonthlyCheck, etc.) can read occurredAt/amount/etc. The
    // earlier positional-array transform was a leftover from a removed
    // dashboard variant and broke jobs-journal with "Invalid time value".
    entries: d.entries ?? [],
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

function inferToastType(message) {
  const text = String(message || "");
  if (/失敗|エラー|できません|うまくいきません|not found|failed/i.test(text)) {
    return "error";
  }
  if (/完了|しました|保存|更新|送信|追加|削除|反映|開始/i.test(text)) {
    return "success";
  }
  return "info";
}

function showToast(message, type, durationMs) {
  if (!toast) return;
  const resolvedType = type || inferToastType(message);
  toast.textContent = message;
  toast.classList.remove("toast-success", "toast-error", "toast-info");
  toast.classList.add("toast-" + resolvedType);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), durationMs || 2400);
}

// spec 27: LINE/Drive からの証憑投入を検知してトースト表示する。
function buildInboundMessage(counts) {
  const parts = [];
  if (counts.line > 0) parts.push("LINEから" + counts.line + "件");
  if (counts.drive > 0) parts.push("Google Driveから" + counts.drive + "件");
  if (parts.length === 0) return "";
  return parts.join("、") + "の証憑が追加されました";
}

async function checkInboundVouchers() {
  if (typeof document !== "undefined" && document.hidden) return;
  const since = localStorage.getItem("bookmee.lastInboundSeenAt");
  try {
    const url = since
      ? "/api/vouchers/inbound-since?since=" + encodeURIComponent(since)
      : "/api/vouchers/inbound-since";
    const res = await apiFetch(url);
    if (!res.ok) return;
    const data = await res.json();
    if (since && data.total > 0) {
      const msg = buildInboundMessage(data.counts);
      if (msg) showToast(msg, "info", 5400);
    }
    if (data.now) localStorage.setItem("bookmee.lastInboundSeenAt", data.now);
  } catch (err) {
    console.warn("inbound voucher check failed", err);
  }
}

// spec 31: 通知センター。最近の LINE/Drive 証憑を取得して未読バッジを更新する。
async function refreshNotifications() {
  try {
    const res = await apiFetch('/api/vouchers/inbound-recent?limit=20');
    if (!res.ok) return;
    appState.notifications = await res.json();
    if (!localStorage.getItem('bookmee.notifSeenAt')) {
      localStorage.setItem('bookmee.notifSeenAt', new Date().toISOString());
    }
    renderNotifBadge();
  } catch (err) {
    console.warn('refreshNotifications failed', err);
  }
}

function notifUnreadCount() {
  const seen = localStorage.getItem('bookmee.notifSeenAt') || '';
  return (appState.notifications || []).filter((n) => n.uploadedAt > seen).length;
}

function renderNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  const n = notifUnreadCount();
  if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
  else { badge.hidden = true; }
}

function notifSourceLabel(s) { return s === 'line' ? 'LINE' : s === 'drive' ? 'Drive' : s; }

function notifRelTime(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return m + '分前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '時間前';
  return Math.floor(h / 24) + '日前';
}

function renderNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const seen = localStorage.getItem('bookmee.notifSeenAt') || '';
  const items = appState.notifications || [];
  const rows = items.length
    ? items.map((n) => {
        const unread = n.uploadedAt > seen;
        const amt = n.amount != null ? '¥' + Number(n.amount).toLocaleString('ja-JP') : '';
        const acct = n.account || '（未分類）';
        const cli = n.clientName || '未割当';
        return `<button class="notif-item${unread ? ' notif-unread' : ''}" data-notif-voucher="${n.id}" data-notif-client="${n.clientId || ''}">
          <span class="notif-source">${notifSourceLabel(n.source)}</span>
          <span class="notif-main">${escapeHtml(acct)} ${amt}</span>
          <span class="notif-sub">${escapeHtml(cli)} ・ ${notifRelTime(n.uploadedAt)}</span>
        </button>`;
      }).join('')
    : '<div class="notif-empty">通知はありません</div>';
  panel.innerHTML = `<div class="notif-head"><span>通知</span><button id="notifClear" type="button">クリア</button></div>${rows}`;
}

function highlightVoucherAfterRender(voucherId, tries) {
  tries = tries || 0;
  const el = document.getElementById('voucher-card-' + voucherId);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('voucher-highlight');
    setTimeout(() => el.classList.remove('voucher-highlight'), 2000);
    return;
  }
  if (tries < 20) setTimeout(() => highlightVoucherAfterRender(voucherId, tries + 1), 150);
}

function setupNotifications() {
  const bell = document.getElementById('notifBell');
  const panel = document.getElementById('notifPanel');
  if (!bell || !panel) return;
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.hidden) { renderNotifPanel(); panel.hidden = false; }
    else { panel.hidden = true; }
  });
  panel.addEventListener('click', (e) => {
    const clr = e.target.closest('#notifClear');
    if (clr) {
      localStorage.setItem('bookmee.notifSeenAt', new Date().toISOString());
      renderNotifBadge();
      renderNotifPanel();
      return;
    }
    const item = e.target.closest('[data-notif-voucher]');
    if (item) {
      appState.matchingTab = item.dataset.notifClient || 'unassigned';
      panel.hidden = true;
      location.hash = '#/matching-results';
      highlightVoucherAfterRender(item.dataset.notifVoucher);
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target.id !== 'notifBell') {
      panel.hidden = true;
    }
  });
}

function startInboundPolling() {
  checkInboundVouchers();
  refreshNotifications();
  if (appState.inboundPollTimer) return;
  appState.inboundPollTimer = setInterval(() => {
    checkInboundVouchers();
    refreshNotifications();
  }, 15000);
}

function setButtonPending(button, pending, pendingText) {
  if (!button) return;
  if (pending) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent || "";
    }
    button.disabled = true;
    button.textContent = pendingText || "処理中...";
    return;
  }
  button.disabled = false;
  if (button.dataset.originalText !== undefined) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}

function stageLabel(stage) { return labels.stage[stage] || stage; }
function channelLabel(ch) { return labels.channel[ch] || ch; }
function vendorLabel(v) { return labels.vendor[v] || v; }
function modeLabel(m) { return labels.mode[m] || m; }
function syncStatusLabel(s) { return labels.syncStatus[s] || s; }
function threadStatusLabel(s) { return labels.threadStatus[s] || s; }

function statusLabel(status) {
  return labels.status[status] || status;
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

// Render the client filter chips (replaces the former full-detail strip).
// Each chip is a pill showing the company name + vendor + channel.
// Click → switch the active client and re-render every view bound to it.
function renderClients() {
  if (!clientChips) return;
  let html = "";
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const active = i === appState.activeClient ? " active" : "";
    const pending = Number(c.tasksOpen) || 0;
    const statusClass = pending === 0 ? "complete" : pending >= 5 ? "error" : "review";
    const statusLabel = pending === 0 ? "完了" : pending >= 5 ? "要確認" : "処理中";
    const mfLinked = !!(c.mfAccessToken || c.mfConnected);
    const mfBadgeClass = mfLinked ? "connected" : "unlinked";
    const mfBadgeText = mfLinked ? "✓ MF連携済" : "⚠️ MF未連携";
    const mfBadgeTitle = mfLinked ? "MoneyForward連携済み" : "MoneyForward未連携";
    html += '<span class="chip-wrap' + active + '" data-client-wrap="' + i + '" draggable="true">';
    html += '<button class="chip-select' + active + '" data-client="' + i + '">';
    html += '<span class="client-chip-main">';
    html += '<span class="client-chip-name">' + escapeHtml(c.name) + '</span>';
    html += '<span class="client-chip-meta">未処理 ' + pending + '件 ・ ' + (c.mode === "yearend" ? "期末" : "月次") + '</span>';
    html += '</span>';
    html += '<span class="mf-badge ' + mfBadgeClass + '" title="' + mfBadgeTitle + '">' + mfBadgeText + '</span>';
    html += '<span class="status-chip ' + statusClass + '">' + statusLabel + '</span>';
    html += "</button>";
    html += '<button class="chip-del" data-client-del="' + i + '" title="削除" style="display:' + (i === appState.activeClient ? "inline" : "none") + '">×</button>';
    html += "</span>";
  }
  html += '<button class="chip chip-add" id="chipsAddBtn">＋ 追加</button>';
  clientChips.innerHTML = html;
  clientChips.querySelectorAll("[data-client]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.activeClient = Number(btn.dataset.client);
      updateClientContextBar();
      render();
    });
  });
  clientChips.querySelectorAll("[data-client-del]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.clientDel);
      const c = clients[idx];
      if (!c) return;
      if (!confirm("「" + c.name + "」を削除しますか？\nこの操作は元に戻せません。")) return;
      apiFetch("/api/clients/" + encodeURIComponent(c.id), { method: "DELETE" })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast("削除失敗: " + ((body.error && body.error.message) || res.status));
            return;
          }
          showToast(c.name + " を削除しました");
          loadClientsFromApi();
        })
        .catch(() => showToast("削除に失敗しました"));
    });
  });
  const chipsAddBtn = document.getElementById("chipsAddBtn");
  if (chipsAddBtn) {
    chipsAddBtn.addEventListener("click", () => {
      appState.activeView = "settings";
      location.hash = "#/settings";
      setTimeout(() => {
        const form = document.getElementById("clientMgmtForm");
        const editId = document.getElementById("clientMgmtEditId");
        if (form && editId) {
          editId.value = "";
          const fields = {
            clientMgmtName: "",
            clientMgmtIndustry: "その他",
            clientMgmtVendor: "mf",
            clientMgmtMode: "monthly",
            clientMgmtFyStart: "",
            clientMgmtFyEnd: "",
          };
          Object.entries(fields).forEach(([id, val]) => {
            const el = document.getElementById(id);
            if (el) el.value = val;
          });
          form.hidden = false;
          form.scrollIntoView({ behavior: "smooth" });
        }
      }, 150);
    });
  }

  // drag-and-drop reorder
  let dragSrcIdx = null;
  clientChips.querySelectorAll("[data-client-wrap]").forEach((chipWrap) => {
    chipWrap.addEventListener("dragstart", (e) => {
      dragSrcIdx = Number(chipWrap.dataset.clientWrap);
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
      }
      chipWrap.classList.add("dragging");
    });
    chipWrap.addEventListener("dragend", () => {
      chipWrap.classList.remove("dragging");
      clientChips.querySelectorAll("[data-client-wrap]").forEach((b) => b.classList.remove("drag-over"));
    });
    chipWrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "move";
      }
      clientChips.querySelectorAll("[data-client-wrap]").forEach((b) => b.classList.remove("drag-over"));
      chipWrap.classList.add("drag-over");
    });
    chipWrap.addEventListener("drop", (e) => {
      e.preventDefault();
      const destIdx = Number(chipWrap.dataset.clientWrap);
      if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
      const activeClientId = currentClient()?.id;
      const moved = clients.splice(dragSrcIdx, 1)[0];
      clients.splice(destIdx, 0, moved);
      appState.activeClient = clients.findIndex((c) => c.id === activeClientId);
      saveClientOrder();
      renderClients();
      render();
    });
  });
  updateClientContextBar();
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
  // Summary cards (レビュー完了率 / 所長確認待ち / 証憑回収率 / 差戻し中 /
  // ベンダー横断同期) are dashboard-only. Hide everywhere else.
  const grid = $("#summaryGrid");
  if (grid) grid.style.display = appState.activeView === "dashboard" ? "" : "none";
  const client = currentClient();
  if (!client) return;
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
  // Helper line under the panel header
  let helperEl = $("#viewHelper");
  if (!helperEl) {
    helperEl = document.createElement("div");
    helperEl.id = "viewHelper";
    helperEl.className = "helper-line";
    const panelHeader = document.querySelector(".panel-header");
    if (panelHeader) panelHeader.insertAdjacentElement("afterend", helperEl);
  }
  helperEl.textContent = labels.helper[appState.activeView] || "";

  // 5th summary card. Spec 05: in yearend mode, repurpose the same DOM as
  // "残申告日数"; otherwise compute spec 01's vendor-sync KPI from the
  // client's own VendorSync rows.
  const vendorEl = $("#vendorSyncValue");
  const vendorLabelEl = $("#vendorSyncLabel");
  const vendorDetailEl = $("#vendorSyncDetail");
  if (vendorEl) {
    if (client.mode === "yearend") {
      // Spec 05 F2: in yearend mode, repurpose the 5th card as "残申告日数".
      // Filing deadline = fiscalYearEnd + 2 months.
      if (vendorLabelEl) vendorLabelEl.textContent = "残申告日数";
      let daysLeft = null;
      if (client.fiscalYearEnd) {
        const due = new Date(client.fiscalYearEnd);
        due.setMonth(due.getMonth() + 2);
        const diffMs = due.getTime() - Date.now();
        daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      }
      vendorEl.textContent = daysLeft != null ? daysLeft + "日" : "—";
      if (vendorDetailEl) {
        const kpi = client.yearendKpi || {};
        const ready = typeof kpi.filingReadiness === "number" ? kpi.filingReadiness : null;
        vendorDetailEl.textContent =
          ready != null
            ? "申告草案準備度 " + ready + "%"
            : "決算+2ヶ月の申告期限まで";
      }
    } else {
      // Spec 01 F5: cross-vendor sync rate from the active client's VendorSync rows.
      const syncs = Array.isArray(client.vendorSyncs) ? client.vendorSyncs : [];
      if (vendorLabelEl) vendorLabelEl.textContent = "ベンダー横断同期";
      if (syncs.length === 0) {
        vendorEl.textContent = "—";
        if (vendorDetailEl) {
          vendorDetailEl.textContent = "freee/MF の取り込み履歴がまだありません";
        }
      } else {
        const okCount = syncs.filter((s) => s.status === "ok").length;
        const pct = Math.round((okCount / syncs.length) * 100);
        vendorEl.textContent = pct + "%";
        if (vendorDetailEl) {
          // e.g. "MF: ✓ 15分前 / freee: ✗ 6時間前"
          const parts = syncs.map((s) => {
            const label = s.vendor === "mf" ? "MF" : s.vendor === "freee" ? "freee" : s.vendor;
            const mark = s.status === "ok" ? "✓" : s.status === "warn" ? "△" : "✗";
            const when = s.lastSync ? formatRelative(new Date(s.lastSync)) : "未取得";
            return label + ": " + mark + " " + when;
          });
          vendorDetailEl.textContent = parts.join(" / ");
        }
      }
    }
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

function loadAndRenderThreads(opts) {
  const client = currentClient();
  if (!client?.id) return;
  const useCache =
    opts?.useCache && appState.threadsLoadedClient === client.id;
  const promise = useCache
    ? Promise.resolve(appState.threads || [])
    : loadThreads();
  promise.then((threads) => {
    const wrap = $("#portalThreads");
    if (!wrap) return;
    if (!Array.isArray(threads) || threads.length === 0) {
      wrap.innerHTML = '<div class="thread-item out"><span class="thread-header">まだやり取りはありません</span></div>';
    } else {
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
          html += '<button class="row-action" data-portal-resend data-thread-id="' + t.id + '">再送する</button>';
        }
        html += '</div>';
      }
      wrap.innerHTML = html;
      // Re-bind resend handlers via the data-portal-resend attribute.
      wrap.querySelectorAll('[data-portal-resend]').forEach((btn) => {
        btn.addEventListener("click", () => {
          resendMessage(btn.dataset.threadId)
            .then((t2) => {
              showToast(t2.status === "sent" ? "再送しました" : "再送失敗: " + (t2.errorMsg || ""));
              loadAndRenderThreads();
            })
            .catch(() => {});
        });
      });
    }

    if (appState.pendingDraftBody) {
      const portalDraft = $("#portalDraft");
      if (portalDraft) {
        portalDraft.value = formatBodyForChannel(appState.pendingDraftBody, appState.portalChannel);
        appState.pendingDraftBody = null;
      }
    }
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
  if (!client) {
    if (!clients || clients.length === 0) {
      return '<div class="dashboard-empty" style="padding:2.5rem 2rem;line-height:1.8">' +
        '<div style="font-size:1.4rem;margin-bottom:.75rem">ようこそ</div>' +
        '<p style="font-weight:400;color:#374151">まず「顧問先」から顧問先を追加してください。</p>' +
        '<p style="font-weight:400;color:#374151;margin-top:.5rem">MoneyForward Cloud Accountingとの連携後、仕訳データが表示されます。</p>' +
        '<button class="primary-action" style="margin-top:1.25rem" onclick="document.querySelector(\'[data-view=company]\')?.click()">顧問先を追加する →</button>' +
        '</div>';
    }
    return '<div class="dashboard-empty">顧問先を選択してください。</div>';
  }
  // Spec 05 F3: yearend mode shows yearend checklist instead of tasks.
  if (client.mode === "yearend") {
    return renderYearendDashboard();
  }
  let html = '<section class="dashboard-stack">';
  html += '<div id="aiPendingBanner">' + renderDashboardAiPendingBannerHtml(appState.dashboardAiPendingCount || 0, appState.dashboardAiDifficultCount || 0) + '</div>';
  html += '<div id="missingReceiptsBanner">' + renderDashboardMissingBannerHtml(appState.dashboardMissingCount || 0, appState.dashboardMissingReceipts || []) + '</div>';
  html += '<div id="unknownWithdrawalBanner">' + renderUnknownWithdrawalBannerHtml() + '</div>';
  html += '<section class="dashboard-section-card">';
  html += '<div class="dashboard-section-head"><h3>手動ToDo</h3><span class="status-chip processing">' + (appState.dashboardTodos || []).length + '件</span></div>';
  html += '<div id="todoList">' + renderDashboardTodoListHtml(appState.dashboardTodos || []) + '</div>';
  html += '</section>';
  html += '<section class="dashboard-section-card">';
  html += '<div class="dashboard-section-head"><h3>ToDoを追加</h3></div>';
  html += '<div class="dashboard-todo-form">';
  html += '<label class="dashboard-todo-field"><span>タイトル</span><input id="todoTitleInput" type="text" placeholder="ToDoタイトル"></label>';
  html += '<label class="dashboard-todo-field"><span>メモ（任意）</span><input id="todoNoteInput" type="text" placeholder="補足メモ"></label>';
  html += '<button class="primary-action compact" data-action="todo-add">追加</button>';
  html += '</div>';
  html += '</section>';
  html += '</section>';
  return html;
}

function dashboardTodoDone(todo) {
  return (
    todo?.done === true ||
    todo?.done === 1 ||
    todo?.done === "true" ||
    todo?.status === "done"
  );
}

function dashboardTodoVisible(todo) {
  if (appState.activeFilter === "urgent") return !dashboardTodoDone(todo);
  if (appState.activeFilter === "done") return dashboardTodoDone(todo);
  return true;
}

function decodeDataToken(token) {
  try {
    return decodeURIComponent(token || "");
  } catch (_) {
    return token || "";
  }
}

function renderUnknownWithdrawalBannerHtml() {
  // 不明出金照会フォーム（手動で出金情報を入力して照会メッセージを送る）
  return `
    <section class="dashboard-section-card dashboard-withdrawal">
      <div class="dashboard-section-head">
        <h3>不明出金の照会</h3>
        <span class="status-chip warning">銀行明細から確認</span>
      </div>
      <p class="dashboard-alert-sub">銀行口座からの現金引き出しや用途不明の出金について、顧問先に内容確認メッセージを送れます。</p>
      <div class="withdrawal-entries" id="withdrawalEntries">
        <div class="withdrawal-entry">
          <input type="date" class="withdrawal-date" placeholder="日付" />
          <input type="number" class="withdrawal-amount" placeholder="金額（円）" min="1" />
          <input type="text" class="withdrawal-desc" placeholder="明細の摘要（例: 現金引出）" />
          <button class="withdrawal-remove-btn" title="削除">×</button>
        </div>
      </div>
      <div class="withdrawal-actions">
        <button class="btn btn-secondary withdrawal-add-btn" id="withdrawalAddEntry">＋ 出金を追加</button>
        <button class="btn btn-primary" id="withdrawalSendInquiry">照会メッセージを送信</button>
      </div>
      <div id="withdrawalResult" class="withdrawal-result" hidden></div>
    </section>
  `;
}

function renderDashboardAiPendingBannerHtml(aiPendingCount, aiDifficultCount) {
  const pendingCount = Number(aiPendingCount) || 0;
  const difficultCount = Number(aiDifficultCount) || 0;
  if (pendingCount <= 0 && difficultCount <= 0) {
    return '<section class="dashboard-section-card"><div class="dashboard-empty">AI摘要レビュー待ちは何もありません ✓</div></section>';
  }
  let html = '<section class="dashboard-section-card dashboard-alert">';
  html += '<div class="dashboard-alert-title">AI摘要レビュー待ち ' + pendingCount + ' 件</div>';
  html += '<p class="dashboard-alert-sub">判断困難: ' + difficultCount + '件</p>';
  html += '<p class="dashboard-alert-sub">AI提案摘要を確認して一括反映できます。</p>';
  html += '<div class="dashboard-section-head" style="margin:0">';
  if (pendingCount > 0) {
    html += '<button class="primary-action" data-action="ai-auto-classify">AI自動仕訳（' + pendingCount + '件）</button>';
  }
  html += '<button class="row-action" data-action="go-mf-review">詳細を見る →</button>';
  html += '</div></section>';
  return html;
}

function renderDashboardMissingBannerHtml(missingCount, missingReceipts) {
  const count = Number(missingCount) || 0;
  if (count <= 0) {
    return '<section class="dashboard-section-card"><div class="dashboard-empty">証憑不足は何もありません ✓</div></section>';
  }
  const rows = Array.isArray(missingReceipts) ? missingReceipts.slice(0, 5) : [];
  let html = '<section class="dashboard-section-card dashboard-alert">';
  html += '<div class="dashboard-alert-title">証憑なし ' + count + '件</div>';
  html += '<p class="dashboard-alert-sub">優先度の高い順で表示しています。すぐに依頼文を作成できます。</p>';
  if (rows.length > 0) {
    html += '<table class="table-dense" style="margin-top:8px;width:100%;border-collapse:collapse">';
    html += '<tbody>';
    for (const r of rows) {
      const occurredAt = r?.occurredAt ? new Date(r.occurredAt).toLocaleDateString('ja-JP') : '-';
      const account = escapeHtml(r?.account || "-");
      const description = escapeHtml(r?.description || "-");
      const amount = Number(r?.amount) || 0;
      html += '<tr>';
      html += '<td style="white-space:nowrap">' + occurredAt + '</td>';
      html += '<td style="white-space:nowrap">' + account + '</td>';
      html += '<td>' + description + '</td>';
      html += '<td style="text-align:right;white-space:nowrap">¥' + amount.toLocaleString('ja-JP') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '<div class="dashboard-section-head" style="margin-top:8px">';
  html += '<button class="row-action" data-action="missing-send-request">依頼文を送る → メッセージへ</button>';
  html += '</div></section>';
  return html;
}

function renderDashboardTodoListHtml(todos) {
  const rows = (Array.isArray(todos) ? todos.slice() : [])
    .sort((a, b) => Number(dashboardTodoDone(a)) - Number(dashboardTodoDone(b)))
    .filter((t) => dashboardTodoVisible(t))
    .filter((t) => matchesSearch([t.title || "", t.note || ""]));

  if (rows.length === 0) {
    return '<div class="dashboard-empty">何もありません ✓</div>';
  }

  let html = '<div class="dashboard-todo-list">';
  for (const todo of rows) {
    const todoId = encodeURIComponent(String(todo.id || ""));
    const note = String(todo.note || "");
    const done = dashboardTodoDone(todo);
    html += '<div class="dashboard-todo-item' + (done ? " is-done" : "") + '">';
    html += '<label class="dashboard-todo-main">';
    html += '<input type="checkbox" data-action="todo-toggle" data-todo-id="' + todoId + '"' + (done ? " checked" : "") + '>';
    html += '<span class="dashboard-todo-title">' + escapeHtml(todo.title || "Untitled") + '</span>';
    html += '</label>';
    html += '<div class="voucher-status-actions">';
    html += '<button class="ghost-btn" data-action="todo-note" data-note="' + encodeURIComponent(note) + '"' + (note ? "" : " disabled") + '>メモ</button>';
    html += '<button class="row-action reject" data-action="todo-delete" data-todo-id="' + todoId + '">削除</button>';
    html += '</div></div>';
  }
  html += '</div>';
  return html;
}

async function addTodo(clientId, title, note) {
  try {
    const res = await apiFetch(
      "/api/clients/" + encodeURIComponent(clientId) + "/todos",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title, note: note }),
      },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || err.message || "HTTP " + res.status);
    }
    return await res.json().catch(() => ({}));
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

async function toggleTodo(todoId, done) {
  try {
    const res = await apiFetch("/api/todos/" + encodeURIComponent(todoId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done: done }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || err.message || "HTTP " + res.status);
    }
    return await res.json().catch(() => ({}));
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

async function deleteTodo(todoId) {
  try {
    const res = await apiFetch("/api/todos/" + encodeURIComponent(todoId), {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || err.message || "HTTP " + res.status);
    }
    return true;
  } catch (err) {
    showToast(friendlyError(err));
    throw err;
  }
}

async function loadAndRenderDashboard(clientId) {
  if (!clientId) return;
  try {
    const res = await apiFetch(
      "/api/clients/" + encodeURIComponent(clientId) + "/todos",
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const payload = await res.json();
    appState.dashboardTodos = Array.isArray(payload.todos) ? payload.todos : [];
    appState.dashboardAiPendingCount = Number(payload.aiPendingCount) || 0;
    appState.dashboardAiDifficultCount = Number(payload.aiDifficultCount) || 0;
    appState.dashboardMissingCount = Number(payload.missingReceiptCount) || 0;
    appState.dashboardMissingReceipts = Array.isArray(payload.missingReceipts) ? payload.missingReceipts : [];
  } catch (err) {
    appState.dashboardAiPendingCount = 0;
    appState.dashboardAiDifficultCount = 0;
    appState.dashboardMissingCount = 0;
    appState.dashboardMissingReceipts = [];
    showToast(friendlyError(err));
  }

  const bannerSlot = $("#aiPendingBanner");
  if (bannerSlot) {
    bannerSlot.innerHTML = renderDashboardAiPendingBannerHtml(
      appState.dashboardAiPendingCount || 0,
      appState.dashboardAiDifficultCount || 0,
    );
    const autoClassifyBtn = bannerSlot.querySelector('[data-action="ai-auto-classify"]');
    if (autoClassifyBtn) {
      autoClassifyBtn.addEventListener("click", async () => {
        const pendingCount = Number(appState.dashboardAiPendingCount) || 0;
        setButtonPending(autoClassifyBtn, true, "処理中...");
        try {
          const res = await apiFetch(
            "/api/clients/" + encodeURIComponent(clientId) + "/mf/journal-reviews/auto-classify",
            { method: "POST" },
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || err.message || "HTTP " + res.status);
          }
          showToast(pendingCount + "件を自動仕訳しました", "success");
          await loadAndRenderDashboard(clientId);
        } catch (err) {
          showToast(friendlyError(err), "error");
        } finally {
          setButtonPending(autoClassifyBtn, false);
        }
      });
    }
    const mfReviewBtn = bannerSlot.querySelector('[data-action="go-mf-review"]');
    if (mfReviewBtn) {
      mfReviewBtn.addEventListener("click", () => {
        location.hash = "#/mf-review";
      });
    }
  }

  const missingSlot = $("#missingReceiptsBanner");
  if (missingSlot) {
    missingSlot.innerHTML = renderDashboardMissingBannerHtml(
      appState.dashboardMissingCount || 0,
      appState.dashboardMissingReceipts || [],
    );
    const requestBtn = missingSlot.querySelector('[data-action="missing-send-request"]');
    if (requestBtn) {
      requestBtn.addEventListener("click", async () => {
        const client = currentClient();
        if (!client?.id) return;
        const targets = (appState.dashboardMissingReceipts || [])
          .slice(0, 5)
          .map((r) => r?.entryId)
          .filter(Boolean);
        if (targets.length === 0) return;
        const channel = client.contactPrimary || "email";
        setButtonPending(requestBtn, true, "処理中...");
        try {
          const res = await apiFetch(
            "/api/clients/" + encodeURIComponent(client.id) + "/receipt-requests",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ entryIds: targets, channel }),
            },
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || err.message || "HTTP " + res.status);
          }
          const draftRes = await res.json().catch(() => ({}));
          appState.portalChannel = channel;
          appState.pendingDraftBody = draftRes?.body || draftRes?.draft?.body || "";
          location.hash = "#/portal";
        } catch (err) {
          showToast(friendlyError(err), "error");
        } finally {
          setButtonPending(requestBtn, false);
        }
      });
    }
  }

  const listSlot = $("#todoList");
  if (!listSlot) return;
  listSlot.innerHTML = renderDashboardTodoListHtml(appState.dashboardTodos || []);
  listSlot.querySelectorAll('[data-action="todo-note"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const note = decodeDataToken(btn.dataset.note);
      if (!note) return;
      window.alert(note);
    });
  });
  listSlot.querySelectorAll('[data-action="todo-toggle"]').forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const todoId = decodeDataToken(checkbox.dataset.todoId);
      if (!todoId) return;
      checkbox.disabled = true;
      toggleTodo(todoId, checkbox.checked)
        .then(() => loadAndRenderDashboard(clientId))
        .catch(() => {
          checkbox.checked = !checkbox.checked;
        })
        .finally(() => {
          checkbox.disabled = false;
        });
    });
  });
  listSlot.querySelectorAll('[data-action="todo-delete"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const todoId = decodeDataToken(btn.dataset.todoId);
      if (!todoId) return;
      btn.disabled = true;
      deleteTodo(todoId)
        .then(() => loadAndRenderDashboard(clientId))
        .catch(() => {})
        .finally(() => {
          btn.disabled = false;
        });
    });
  });
}

function renderYearendDashboard() {
  let html = '<div class="review-hero">';
  html += '<div><p class="eyebrow">期末クローズモード</p><h3>申告期限までに残しておくべき手続き</h3>';
  html += '<p>月次決算ではなく、期末調整・税務調整・申告書草案の準備状況を見せています。</p></div>';
  html += '<div class="review-run-card"><strong>進行中</strong><small>期末項目チェック</small></div>';
  html += '</div>';
  html += '<div id="yearendSlot" class="yearend-checklist"><div class="empty-state">読み込み中…</div></div>';
  return html;
}

function loadAndRenderYearend() {
  const client = currentClient();
  if (!client?.id || client.mode !== "yearend") return;
  loadYearendChecklist().then((rows) => {
    const slot = $("#yearendSlot");
    if (!slot) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      slot.innerHTML = '<div class="empty-state">期末チェック項目はまだありません</div>';
      return;
    }
    let h = "";
    for (const r of rows) {
      h += '<div class="yearend-check-row ' + (r.status === "done" ? "done" : "") + '">';
      h += '<div><strong>' + escapeHtml(r.title) + '</strong>';
      if (r.note) h += '<br><small style="color:#5c6675">' + escapeHtml(r.note) + '</small>';
      h += '</div>';
      h += '<div style="display:flex;gap:6px">';
      if (r.status !== "done") {
        h += '<button class="row-action" data-action="yearend-status" data-yc-id="' + r.id + '" data-yc-status="done">完了</button>';
      } else {
        h += '<button class="vendor-link" data-action="yearend-status" data-yc-id="' + r.id + '" data-yc-status="open">未完了に戻す</button>';
      }
      h += '</div></div>';
    }
    slot.innerHTML = h;
    slot.querySelectorAll('[data-action="yearend-status"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        updateYearendCheck(btn.dataset.ycId, { status: btn.dataset.ycStatus })
          .then(() => {
            showToast("更新しました");
            // Force a re-fetch on the next paint.
            appState.yearendLoadedClient = null;
            loadAndRenderYearend();
          })
          .catch(() => {});
      });
    });
  });
}

function stageJpLabel(stage) {
  const labels = {
    staff_doing: "担当者が作業中",
    awaiting_approval: "所長に見てもらい待ち",
    approved: "所長OK",
    rejected: "やり直し依頼中",
  };
  return labels[stage] || stage;
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

// Spec 02 F4: differ for staff vs tax_accountant
function renderFeedback() {
  const client = currentClient();
  const role = appState.currentRole;
  const rawTasks = client.rawTasks || [];
  const targets = rawTasks.filter((t) => t.stage === "rejected");

  let html = '<div class="feedback-layout"><section class="message-list">';
  const headline = role === "staff"
    ? "あなた宛のやり直し依頼"
    : "差戻し中の件 (誰に戻したか)";
  html += '<p class="eyebrow">' + headline + '</p>';

  if (!targets.length) {
    html += '<div class="empty-state">' + (role === "staff" ? "戻ってきた件はありません。" : "差戻し中の件はありません。") + '</div>';
  }

  for (const t of targets) {
    html += '<article class="message-card feedback-card">';
    html += '<span class="pill stage-rejected">やり直し依頼中</span>';
    html += '<h3>' + escapeHtml(t.assignee || "担当") + ' さんへの差戻し</h3>';
    html += '<p>' + escapeHtml(t.title) + 'について、' + escapeHtml(t.note) + '。修正後に「再提出」を押してください。</p>';
    html += '<div class="feedback-meta"><span>対象: ' + escapeHtml(t.category) + '</span><span>優先度: ' + t.score + '%</span></div>';
    html += '<div class="row-actions">';
    if (role === "staff") {
      html += '<button class="row-action" data-action="task-transition" data-task-id="' + t.id + '" data-task-action="resubmit">再提出する</button>';
    } else {
      html += '<button class="vendor-link" data-action="toggle-history" data-task-id="' + t.id + '">履歴を見る</button>';
    }
    html += '</div>';
    html += '</article>';
  }

  html += '</section><aside class="settings-card">';
  html += '<div class="setting-row"><div><strong>差戻しテンプレート</strong><p>根拠、修正内容、再提出条件を自動挿入</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>Slack通知</strong><p>担当者別にメンション付き通知</p></div><span class="switch on"></span></div>';
  html += '<div class="setting-row"><div><strong>再レビュー予約</strong><p>修正完了後にAIレビューを自動再実行</p></div><span class="switch on"></span></div>';
  html += '</aside></div>';
  return html;
}

// Spec 07: 3-section receipt view
function renderReceipts() {
  const client = currentClient();
  let html = '';
  // Section 1: missing alert (loaded async)
  html += '<div id="missingAlertSlot"></div>';
  html += '<div id="missingTableSlot"></div>';
  // Section 3: existing tables
  html += '<div class="split-review" style="margin-top:14px">';
  html += '<section><div class="section-heading"><p class="eyebrow">Documents</p><h3>証憑回収・紐付け</h3></div>';
  html += renderTable(client.receipts, ["証憑", "紐付け状況", "根拠"]);
  html += '</section><section><div class="section-heading"><p class="eyebrow">Reconciliation</p><h3>入金消込・差異</h3></div>';
  html += renderTable(client.matching, ["請求/入金", "候補判定", "根拠"]);
  html += '</section></div>';
  return html;
}

function loadAndRenderMissing() {
  const client = currentClient();
  if (!client?.id) return;
  fetch("/api/clients/" + encodeURIComponent(client.id) + "/missing-receipts")
    .then((r) => r.json())
    .then((rows) => {
      const alertSlot = $("#missingAlertSlot");
      const tableSlot = $("#missingTableSlot");
      if (!alertSlot || !tableSlot) return;
      if (!Array.isArray(rows) || rows.length === 0) {
        alertSlot.innerHTML = '<div class="missing-alert empty"><div><strong>今日はありません</strong><br><small>不足している領収書はありません。お疲れさまでした。</small></div></div>';
        tableSlot.innerHTML = '';
        return;
      }
      alertSlot.innerHTML = '<div class="missing-alert">' +
        '<div><strong>あと ' + rows.length + ' 件、お客さまに連絡すれば終わります</strong>' +
        '<br><small>優先度の高い順に並べています。複数選択して依頼文をまとめて作れます。</small></div>' +
        '<button class="primary-action compact" data-action="missing-build-request">依頼文を作る</button>' +
        '</div>';
      let h = '<table class="missing-table"><thead><tr>';
      h += '<th><input type="checkbox" id="missingSelectAll" /></th>';
      h += '<th>日付</th><th>科目</th><th>取引先</th><th>金額</th><th>不足理由</th><th>優先度</th><th>操作</th>';
      h += '</tr></thead><tbody>';
      for (const r of rows) {
        h += '<tr>';
        h += '<td><input type="checkbox" class="missing-row-check" data-entry-id="' + r.entryId + '" /></td>';
        h += '<td>' + new Date(r.occurredAt).toISOString().slice(0, 10) + '</td>';
        h += '<td>' + escapeHtml(r.account) + '</td>';
        h += '<td>' + escapeHtml(r.vendor || "—") + '</td>';
        h += '<td>¥' + r.amount.toLocaleString("ja-JP") + '</td>';
        h += '<td>' + escapeHtml(r.reason) + '</td>';
        h += '<td><span class="priority-bar"><i style="width:' + Math.min(100, r.priority) + '%"></i></span> ' + r.priority + '</td>';
        h += '<td><button class="vendor-link" data-action="missing-not-required" data-entry-id="' + r.entryId + '">不要</button> ';
        h += '<button class="vendor-link" data-action="open-vendor" data-vendor="' + r.source + '">' + (r.source === "mf" ? "MFで見る" : "freeeで見る") + '</button></td>';
        h += '</tr>';
      }
      h += '</tbody></table>';
      tableSlot.innerHTML = h;
      bindMissingHandlers(rows);
    });
}

function bindMissingHandlers(rows) {
  const selectAll = $("#missingSelectAll");
  if (selectAll) {
    selectAll.addEventListener("change", () => {
      document.querySelectorAll(".missing-row-check").forEach((cb) => {
        cb.checked = selectAll.checked;
      });
    });
  }
  document.querySelectorAll('[data-action="missing-not-required"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      fetch("/api/entries/" + encodeURIComponent(btn.dataset.entryId) + "/mark-not-required", { method: "POST" })
        .then(() => { showToast("不要として除外しました"); loadAndRenderMissing(); });
    });
  });
  document.querySelectorAll('[data-action="missing-build-request"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const checked = Array.from(document.querySelectorAll(".missing-row-check"))
        .filter((cb) => cb.checked)
        .map((cb) => cb.dataset.entryId);
      const targets = checked.length > 0 ? checked : rows.map((r) => r.entryId);
      const client = currentClient();
      const channel = client.contactPrimary || "email";
      fetch("/api/clients/" + encodeURIComponent(client.id) + "/receipt-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entryIds: targets, channel }),
      }).then((r) => r.json()).then((draft) => {
        appState.portalChannel = channel;
        location.hash = "#/portal";
        // Stash draft in messageDraft so portal renderer picks it up
        if ($("#messageDraft")) $("#messageDraft").value = draft.body;
        client.message = draft.body;
        render();
        const portalDraft = $("#portalDraft");
        if (portalDraft) portalDraft.value = formatBodyForChannel(draft.body, channel);
        showToast("依頼文を作りました。確認して送信してください");
        // Mark as requested so they disappear from the missing list once sent.
        // (Marking happens after the user actually sends in spec 03, but for the
        // PoC we mark immediately to demo end-to-end.)
        fetch("/api/entries/mark-requested", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entryIds: targets }),
        });
      });
    });
  });
}

function renderValidation() {
  let html = '<div class="validation-layout">';
  html += '<section class="validation-hero"><div><p class="eyebrow">Notion Meeting Notes</p>';
  html += '<h3>今日の3つの議事録から、実装判断を固定</h3>';
  html += '<p>bookmeeは「AIで何でも自動化」ではなく、税理士事務所の所長が毎月迷うレビュー・資料不足・差戻しを減らす業務画面として作ります。</p></div>';
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
  html += '</section>';

  // Owner-only: member management
  if (appState.user && appState.user.role === 'owner') {
    html += '<section class="settings-card" id="memberSection">';
    html += '<h3 style="font-size:15px;margin-bottom:12px;color:#1e293b">メンバー管理</h3>';
    html += '<div id="memberList" style="margin-bottom:12px"><p class="voucher-status-meta">読み込み中…</p></div>';
    html += '<div class="setting-row" style="align-items:flex-end">';
    html += '<div style="flex:1"><strong>メンバーを招待</strong><p>メールアドレスを入力してください</p>';
    html += '<input id="inviteEmail" type="email" placeholder="staff@example.com" style="width:100%;min-height:36px;padding:0 10px;margin-top:6px" /></div>';
    html += '<button class="primary-action compact" data-action="settings-invite-member" style="margin-left:.75rem;flex-shrink:0">招待送信</button>';
    html += '</div>';
    html += '</section>';
  }

  // Client management section
  html += '<section class="settings-card" id="clientMgmtSection">';
  html += '<div class="dashboard-section-head">';
  html += '<h3 style="font-size:15px;color:#1e293b">顧問先管理</h3>';
  html += '<button class="primary-action compact" data-action="settings-add-client">+ 顧問先を追加</button>';
  html += '</div>';
  html += '<div id="clientMgmtList" style="margin-bottom:12px"><p class="voucher-status-meta">読み込み中…</p></div>';
  html += '<div id="clientMgmtForm" class="settings-client-panel" hidden>';
  html += '<div class="dashboard-section-head" style="margin-bottom:10px"><strong>顧問先を編集</strong><button class="ghost-btn" data-action="settings-cancel-client">閉じる</button></div>';
  html += '<input type="hidden" id="clientMgmtEditId" value="" />';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">';
  html += '<div><label class="text-label">顧問先名 *</label><input id="clientMgmtName" type="text" placeholder="○○株式会社" style="width:100%;min-height:36px;padding:0 10px;margin-top:4px" /></div>';
  html += '<div><label class="text-label">業種</label><select id="clientMgmtIndustry" style="width:100%;min-height:36px;padding:0 10px;margin-top:4px">';
  html += '<option value="その他">その他</option><option value="製造業">製造業</option><option value="小売業">小売業</option><option value="サービス業">サービス業</option><option value="飲食業">飲食業</option><option value="医療・介護">医療・介護</option><option value="不動産">不動産</option><option value="建設業">建設業</option>';
  html += '</select></div>';
  html += '<div><label class="text-label">会計ソフト</label><select id="clientMgmtVendor" style="width:100%;min-height:36px;padding:0 10px;margin-top:4px"><option value="mf">MoneyForward</option><option value="freee">freee</option></select></div>';
  html += '<div><label class="text-label">モード</label><select id="clientMgmtMode" style="width:100%;min-height:36px;padding:0 10px;margin-top:4px"><option value="monthly">月次</option><option value="yearend">期末</option></select></div>';
  html += '<div><label class="text-label">事業年度開始日 *</label><input id="clientMgmtFyStart" type="date" style="width:100%;min-height:36px;padding:0 10px;margin-top:4px" /></div>';
  html += '<div><label class="text-label">事業年度終了日 *</label><input id="clientMgmtFyEnd" type="date" style="width:100%;min-height:36px;padding:0 10px;margin-top:4px" /></div>';
  html += '</div>';
  html += '<div class="settings-client-actions">';
  html += '<button class="primary-action compact" data-action="settings-save-client">保存</button>';
  html += '<button class="ghost-btn" data-action="settings-cancel-client">キャンセル</button>';
  html += '</div>';
  html += '</div>';
  html += '</section>';

  html += '<section class="rules-list">';
  html += '<article class="message-card"><span class="pill ai">freee / MF</span><h3>会計ソフト連携</h3><p>仕訳、残高、請求、入金、証憑ステータスを読み取り、レビューキューに変換します。</p></article>';
  html += '<article class="message-card"><span class="pill ai">初期導入先</span><h3>30〜50人規模の税理士事務所</h3><p>職員・アルバイトが複数いて、所長レビューと資料不足対応が詰まりやすい事務所に絞ります。</p></article>';
  html += '<article class="message-card"><span class="pill ai">MyKomon Alternative</span><h3>税理士事務所の業務OS</h3><p>顧問先別の進捗、担当者ToDo、顧問先依頼、所長レビューを同じワークフローにまとめます。</p></article>';
  html += '</section></div>';
  return html;
}

async function loadMemberList() {
  const listEl = document.getElementById('memberList');
  if (!listEl) return;
  try {
    const res = await apiFetch('/api/firms/current/members');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const members = await res.json();
    if (!members.length) {
      listEl.innerHTML = '<p style="color:#999;font-size:.85rem">メンバーはまだいません</p>';
      return;
    }
    const roleLabel = { owner: '所長', member: 'スタッフ' };
    const statusLabel = { active: '有効', invited: '招待中', removed: '削除済み' };
    listEl.innerHTML = members.map(m =>
      '<div class="setting-row" style="font-size:.85rem">' +
      '<div><strong>' + escapeHtml(m.email || '') + '</strong>' +
      ' <span style="color:#64748b">(' + (roleLabel[m.role] || m.role) + '・' + (statusLabel[m.status] || m.status) + ')</span></div>' +
      (m.authUserId !== appState.user.authUserId
        ? '<button class="row-action" data-action="settings-remove-member" data-member-id="' + escapeHtml(m.id) + '" style="color:#dc2626">削除</button>'
        : '') +
      '</div>'
    ).join('');
  } catch (e) {
    listEl.innerHTML = '<p style="color:#dc2626;font-size:.85rem">読み込みに失敗しました</p>';
  }
}

async function loadClientList() {
  const listEl = document.getElementById('clientMgmtList');
  if (!listEl) return;
  try {
    const res = await apiFetch('/api/clients');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const clients = await res.json();
    if (!clients.length) {
      listEl.innerHTML = '<p style="color:#999;font-size:.85rem">顧問先はまだありません</p>';
      return;
    }
    const modeLabel = { monthly: '月次', yearend: '期末' };
    listEl.innerHTML = clients.map(c =>
      '<div class="setting-row" style="font-size:.85rem">' +
      '<div><strong>' + escapeHtml(c.name) + '</strong>' +
      ' <span style="color:#64748b">(' + escapeHtml(c.industry || '') + '・' + (modeLabel[c.mode] || c.mode) + ')</span></div>' +
      '<div class="settings-client-actions">' +
      '<button class="row-action" data-action="settings-edit-client" data-client-id="' + escapeHtml(c.id) + '">編集</button>' +
      '<button class="row-action danger-action" data-action="settings-delete-client" data-client-id="' + escapeHtml(c.id) + '" data-client-name="' + escapeHtml(c.name) + '">削除</button>' +
      '</div></div>'
    ).join('');
  } catch (e) {
    listEl.innerHTML = '<p style="color:#dc2626;font-size:.85rem">読み込みに失敗しました</p>';
  }
}

// Spec 03 F2: 3-column portal: edit | history | settings
function renderPortal() {
  const client = currentClient();
  if (!client) return '<div class="empty-state">顧問先を読み込み中…</div>';
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
  html += '<div style="margin-bottom:6px"><button class="row-action compact" data-action="portal-reminder-draft" style="font-size:.8rem">証憑リマインドを作成</button></div>';
  html += '<input id="portalSubject" type="text" placeholder="件名（送信前に確認してください）" value="" style="width:100%;padding:.4rem .6rem;border:1px solid #dde1e9;border-radius:6px;font-size:.9rem;box-sizing:border-box;margin-bottom:6px" />';
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

function escapeAttribute(s) {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

// Spec 04 F1: AIルールビュー 2-column redesign
// ---------------------------------------------------------------------------
// Spec 21: MF摘要レビュー
// ---------------------------------------------------------------------------

function renderMfReview() {
  const client = currentClient();
  if (!client) return '<div class="empty-state">顧問先を選択してください。</div>';

  let html = '<section class="dashboard-section-card">';
  html += '<div class="setup-guide-banner">';
  html += '<strong>AI摘要レビューとは</strong><br>';
  html += 'MFの仕訳の中で摘要が空白のものをAIが自動で補完します。<br>';
  html += '「AI処理」ボタンを押すとAIが分析し、提案内容を確認して承認するとMFに反映されます。';
  html += '</div>';
  html += '<div class="dashboard-section-head">';
  html += '<h3>AI摘要レビュー</h3>';
  html += '<div class="voucher-status-actions">';
  html += '<span id="mfReviewStatus" class="status-chip processing">読み込み中</span>';
  html += '<button class="primary-action compact" id="mfReviewProcessBtn">AI処理を実行</button>';
  html += '</div></div>';
  html += '<div id="mfReviewList" class="mf-review-list"><div class="empty-state">読み込み中…</div></div>';
  html += '</section>';
  return html;
}

async function loadAndRenderMfReview(clientId) {
  const listEl = document.getElementById('mfReviewList');
  const processBtn = document.getElementById('mfReviewProcessBtn');
  const statusEl = document.getElementById('mfReviewStatus');
  const status = appState.mfReviewStatus === 'approved' || appState.mfReviewStatus === 'difficult'
    ? appState.mfReviewStatus
    : 'pending';
  const isApprovedView = status === 'approved';
  const isDifficultView = status === 'difficult';

  if (!listEl) return;

  // Fetch reviews by selected status.
  let data;
  try {
    const res = await apiFetch(`/api/clients/${clientId}/mf/journal-reviews?status=${encodeURIComponent(status)}`);
    if (!res.ok) throw new Error('fetch failed');
    data = await res.json();
  } catch (err) {
    listEl.innerHTML = '<div class="empty-state">読み込みに失敗しました。</div>';
    return;
  }

  const reviews = data.reviews ?? [];
  const pendingCount = data.pendingCount ?? 0;

  if (statusEl) {
    statusEl.className = 'status-chip ' + (isApprovedView ? 'complete' : isDifficultView ? 'error' : pendingCount > 0 ? 'review' : 'complete');
    if (isApprovedView) {
      statusEl.textContent = reviews.length > 0 ? `完了 ${reviews.length} 件` : '完了一覧はありません';
    } else if (isDifficultView) {
      statusEl.textContent = reviews.length > 0 ? `判断困難 ${reviews.length} 件` : '判断困難はありません';
    } else {
      statusEl.textContent = pendingCount > 0 ? `確認待ち ${pendingCount} 件` : '確認待ちなし';
    }
  }

  if (reviews.length === 0) {
    listEl.innerHTML = isApprovedView
      ? '<div class="dashboard-empty">完了一覧はまだありません。</div>'
      : isDifficultView
        ? '<div class="dashboard-empty">判断困難の仕訳はありません。</div>'
        : '<div class="dashboard-empty">レビュー待ちの仕訳はありません。AI処理を実行すると摘要が空の仕訳を自動チェックします。</div>';
  } else {
    let h = '';
    for (const r of reviews) {
      const conf = typeof r.aiConfidence === 'number' ? Math.round(r.aiConfidence * 100) : null;
      const confidenceClass = conf == null ? "processing" : conf >= 60 ? "complete" : "review";
      const isDifficultCard = r.status === 'difficult';
      h += `<article class="mf-review-card${isDifficultCard ? ' is-difficult' : ''}" data-review-id="${r.id}">`;
      h += '<div class="dashboard-section-head" style="margin-bottom:10px">';
      h += `<div class="voucher-status-meta">${escapeHtml(r.transactionDate ?? '')} ・ ${escapeHtml(r.debitAccount ?? '')} / ${escapeHtml(r.creditAccount ?? '')} ・ ¥${(r.amount ?? 0).toLocaleString('ja-JP')}</div>`;
      if (isDifficultCard) {
        h += '<span class="status-chip error mf-review-difficult-badge">AI判断困難</span>';
      } else {
        h += `<span class="status-chip ${confidenceClass}">信頼度 ${conf == null ? "—" : conf + "%"}</span>`;
      }
      h += '</div>';
      h += '<div class="mf-review-grid">';
      h += '<div class="mf-review-field"><span>元の摘要（空欄）</span>';
      h += `<div class="mf-review-original">${escapeHtml(r.originalMemo || "—") || "—"}</div></div>`;
      h += '<div class="mf-review-field"><span>AI提案摘要</span>';
      if (isApprovedView || isDifficultView) {
        h += `<div class="mf-review-original">${escapeHtml(r.aiMemo ?? '—')}</div>`;
      } else {
        h += `<input class="mf-review-memo-input mf-review-input" value="${escapeHtml(r.aiMemo ?? '')}" data-review-id="${r.id}" />`;
      }
      h += '</div></div>';
      h += '<div class="mf-review-footer">';
      h += '<span class="voucher-status-meta">仕訳ID: ' + escapeHtml(r.mfJournalId || "—") + '</span>';
      if (isApprovedView) {
        h += `<span class="status-chip complete">完了</span>`;
      } else if (isDifficultView) {
        h += '<span class="mf-review-difficult-note">Todoに追加済み</span>';
      } else {
        h += '<div class="settings-client-actions">';
        h += `<button class="primary-action compact" data-action="mf-review-approve" data-review-id="${r.id}">承認してMFへ</button>`;
        h += `<button class="ghost-btn" data-action="mf-review-skip" data-review-id="${r.id}">スキップ</button>`;
        h += '</div>';
      }
      h += '</div>';
      h += '</article>';
    }
    listEl.innerHTML = h;
  }

  // "AI処理を実行" button handler
  if (processBtn) {
    processBtn.onclick = async () => {
      setButtonPending(processBtn, true, "処理中...");
      if (statusEl) {
        statusEl.className = 'status-chip processing';
        statusEl.textContent = 'AI処理中...';
      }
      try {
        const res = await apiFetch(`/api/clients/${clientId}/mf/journal-reviews/process`, { method: 'POST' });
        if (!res.ok) throw new Error('process failed');
        if (statusEl) {
          statusEl.className = 'status-chip processing';
          statusEl.textContent = 'AI処理を開始しました';
        }
        // Reload after a short delay to pick up auto_applied items
        setTimeout(() => loadAndRenderMfReview(clientId), 3000);
      } catch (err) {
        if (statusEl) {
          statusEl.className = 'status-chip error';
          statusEl.textContent = '処理に失敗しました';
        }
      } finally {
        setButtonPending(processBtn, false);
      }
    };
  }

  // Approve / Skip button handlers
  listEl.querySelectorAll('[data-action="mf-review-approve"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      const memoInput = listEl.querySelector(`.mf-review-memo-input[data-review-id="${reviewId}"]`);
      const memo = memoInput ? memoInput.value : undefined;
      setButtonPending(btn, true, "処理中...");
      try {
        const res = await apiFetch(
          `/api/clients/${clientId}/mf/journal-reviews/${reviewId}/approve`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memo }) },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error?.message ?? 'approve failed');
        }
        showToast('MFに反映しました', "success");
        loadAndRenderMfReview(clientId);
      } catch (err) {
        showToast('反映に失敗しました: ' + (err.message ?? ''), "error");
        setButtonPending(btn, false);
      }
    });
  });

  listEl.querySelectorAll('[data-action="mf-review-skip"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reviewId = btn.dataset.reviewId;
      setButtonPending(btn, true, "処理中...");
      try {
        const res = await apiFetch(
          `/api/clients/${clientId}/mf/journal-reviews/${reviewId}/skip`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error('skip failed');
        showToast('スキップしました', "success");
        loadAndRenderMfReview(clientId);
      } catch (err) {
        showToast('スキップに失敗しました', "error");
        setButtonPending(btn, false);
      }
    });
  });
}

function renderRules() {
  const client = currentClient();
  let html = '<div class="rules-2col">';

  // Left: rule list (loaded async)
  html += '<section>';
  html += '<p class="eyebrow">' + escapeHtml(client.industry || "業種未設定") + ' のルール</p>';
  html += '<div id="rulesList"><div class="empty-state">読み込み中…</div></div>';
  html += '</section>';

  // Right: add panel
  html += '<aside>';
  html += '<p class="eyebrow">ルールを追加</p>';

  // Templates
  html += '<div class="rule-form">';
  html += '<strong style="font-size:12px">業種テンプレから追加</strong>';
  html += '<div id="ruleTemplates" class="template-list" style="margin-top:6px"><div class="empty-state">読み込み中…</div></div>';
  html += '</div>';

  // Custom
  html += '<div class="rule-form">';
  html += '<strong style="font-size:12px">カスタムルール</strong>';
  html += '<label>タイトル</label><input id="ruleNewTitle" placeholder="例: 広告費は領収書必須" />';
  html += '<label>詳細</label><textarea id="ruleNewDetail" rows="3" placeholder="判定の根拠を自由記述"></textarea>';
  html += '<label>重要度</label><select id="ruleNewSeverity"><option value="high">高</option><option value="mid" selected>中</option><option value="low">低</option></select>';
  html += '<div class="form-actions"><button class="primary-action compact" data-action="rule-add-custom">追加</button></div>';
  html += '</div>';
  html += '</aside>';

  html += '</div>';
  return html;
}

function loadAndRenderRules() {
  const client = currentClient();
  if (!client?.id) return;
  Promise.all([loadRules(), loadRuleTemplates(client.industry || "")]).then(
    ([rules, templates]) => {
    const listEl = $("#rulesList");
    if (listEl) {
      if (!Array.isArray(rules) || rules.length === 0) {
        listEl.innerHTML = '<div class="empty-state">まだルールがありません。右側から追加できます。</div>';
      } else {
        let h = "";
        for (const r of rules) {
          h += '<div class="rule-row ' + (r.active ? "" : "inactive") + '">';
          h += '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">';
          h += '<div><span class="pill severity-' + r.severity + '">' + (r.severity === "high" ? "高" : r.severity === "mid" ? "中" : "低") + '</span> ';
          h += '<strong>' + escapeHtml(r.title) + '</strong></div>';
          h += '<label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" data-action="rule-toggle" data-rule-id="' + r.id + '"' + (r.active ? " checked" : "") + ' /> 有効</label>';
          h += '</div>';
          if (r.detail) h += '<p style="font-size:12px;margin:6px 0 0">' + escapeHtml(r.detail) + '</p>';
          h += '<div class="rule-meta">ヒット ' + r.hitCount + ' 件' + (r.lastHit ? ' · 最終 ' + formatRelative(new Date(r.lastHit)) : "") + ' · 作成: ' + escapeHtml(r.createdBy) + '</div>';
          h += '<div class="rule-actions">';
          h += '<button class="vendor-link" data-action="rule-history" data-rule-id="' + r.id + '">履歴</button>';
          h += '<button class="vendor-link" data-action="rule-delete" data-rule-id="' + r.id + '" style="color:#9a3040">削除</button>';
          h += '</div>';
          h += '</div>';
        }
        listEl.innerHTML = h;
      }
    }
    const tplEl = $("#ruleTemplates");
    if (tplEl) {
      if (!Array.isArray(templates) || templates.length === 0) {
        tplEl.innerHTML = '<div class="empty-state">テンプレなし</div>';
      } else {
        let h = "";
        for (const t of templates) {
          h += '<div class="template-item">';
          h += '<div><span class="pill severity-' + t.severity + '">' + (t.severity === "high" ? "高" : t.severity === "mid" ? "中" : "低") + '</span> ' + escapeHtml(t.title) + '</div>';
          h += '<button class="row-action" data-action="rule-add-template" data-title="' + escapeHtml(t.title) + '" data-detail="' + escapeHtml(t.detail) + '" data-severity="' + t.severity + '">+</button>';
          h += '</div>';
        }
        tplEl.innerHTML = h;
      }
    }
    // Bind handlers (event delegation re-bind)
    bindRuleHandlers();
  });
}

function bindRuleHandlers() {
  document.querySelectorAll('[data-action="rule-add-template"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const client = currentClient();
      addRule({
        type: "template",
        industry: client.industry,
        title: btn.dataset.title,
        detail: btn.dataset.detail,
        severity: btn.dataset.severity,
        createdBy: appState.currentRole === "staff" ? "鈴木" : "畠山",
      })
        .then(() => {
          showToast("ルールを追加しました");
          loadAndRenderRules();
          loadClientsFromApi().finally(render);
        })
        .catch(() => {});
    });
  });
  document.querySelectorAll('[data-action="rule-add-custom"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const title = $("#ruleNewTitle").value.trim();
      if (!title) { showToast("タイトルを入力してください"); return; }
      addRule({
        type: "custom",
        title,
        detail: $("#ruleNewDetail").value,
        severity: $("#ruleNewSeverity").value,
        createdBy: appState.currentRole === "staff" ? "鈴木" : "畠山",
      })
        .then(() => {
          showToast("ルールを追加しました");
          loadAndRenderRules();
          loadClientsFromApi().finally(render);
        })
        .catch(() => {});
    });
  });
  document.querySelectorAll('[data-action="rule-toggle"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      updateRule(cb.dataset.ruleId, { active: cb.checked })
        .then(() => {
          showToast(cb.checked ? "ルールを有効にしました" : "ルールを停止しました");
          loadAndRenderRules();
        })
        .catch(() => {});
    });
  });
  document.querySelectorAll('[data-action="rule-delete"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("このルールを削除しますか？")) return;
      deleteRuleById(btn.dataset.ruleId)
        .then(() => {
          showToast("削除しました");
          loadAndRenderRules();
        })
        .catch(() => {});
    });
  });
  document.querySelectorAll('[data-action="rule-history"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      loadRuleHits(btn.dataset.ruleId).then((hits) => {
        const parent = btn.closest(".rule-row");
        let existing = parent.querySelector(".rule-history");
        if (existing) { existing.remove(); return; }
        const ul = document.createElement("ul");
        ul.className = "rule-history";
        if (!Array.isArray(hits) || hits.length === 0) {
          ul.innerHTML = "<li>ヒット履歴なし</li>";
        } else {
          ul.innerHTML = hits
            .slice(0, 20)
            .map(
              (h) =>
                "<li>" +
                new Date(h.at).toLocaleString("ja-JP") +
                " — " +
                escapeHtml(h.target) +
                " (" +
                h.outcome +
                ")</li>",
            )
            .join("");
        }
        parent.appendChild(ul);
      });
    });
  });
}

// ===== 業務 > 顧問先 (会社情報・履歴閲覧) =====
// ===== 業務 > 顧問先 (会社情報 + MF 会計帳簿閲覧) =====
function renderCompany() {
  const c = currentClient();
  if (!c) {
    return '<p class="company-selection-guide">顧問先が未選択です。上部の顧問先チップから選択してください。</p>';
  }
  const tab = appState.companyTab || "info";
  const tabs = [
    { key: "info", label: "基本情報" },
    { key: "journal", label: "仕訳帳" },
    { key: "cash", label: "現金出納帳" },
    { key: "general-ledger", label: "総勘定元帳" },
    { key: "sub-ledger", label: "補助元帳" },
    { key: "trial-bs", label: "残高試算表 BS" },
    { key: "trial-pl", label: "残高試算表 PL" },
    { key: "contact", label: "連絡先" },
  ];
  const pending = Number(c.tasksOpen) || 0;
  let html = '<section class="dashboard-section-card" style="padding-bottom:12px">';
  html += '<div class="dashboard-section-head">';
  html += '<div><h3>' + escapeHtml(c.name) + '</h3><p class="dashboard-alert-sub">業種: ' + escapeHtml(c.industry || "未設定") + ' ・ 連絡: ' + (c.contactPrimary ? channelLabel(c.contactPrimary) : "未設定") + '</p></div>';
  html += '<span class="status-chip ' + (pending > 0 ? "review" : "complete") + '">未処理 ' + pending + '件</span>';
  html += '</div>';
  html += '<div class="company-tabs">';
  for (const t of tabs) {
    html += '<button class="company-tab' + (t.key === tab ? " active" : "") + '" data-company-tab="' + t.key + '">' + t.label + '</button>';
  }
  html += '</div>';

  if (tab === "info") {
    html += renderCompanyInfo(c);
  } else if (tab === "contact") {
    html += renderCompanyContact(c);
  } else if (!c.mfConnected) {
    html += '<div class="empty-state">MF クラウド会計と連携してください。<br><br><a href="/api/mf/oauth/start?clientId=' + escapeHtml(c.id) + '" class="btn btn-primary">MoneyForwardと連携する</a></div>';
  } else {
    html += '<div id="companyTabBody"><div class="empty-state">読み込み中…</div></div>';
  }
  html += '</section>';
  return html;
}

function renderCompanyInfo(c) {
  let html = '<section class="company-info-card">';
  html += '<p class="eyebrow">基本情報</p>';
  html += '<h3>' + escapeHtml(c.name) + '</h3>';
  html += '<dl class="info-grid">';
  html += '<dt>業種</dt><dd>' + escapeHtml(c.industry || "未設定") + '</dd>';
  html += '<dt>会計ソフト</dt><dd>' + vendorBadgeHtml(c.vendor) + '</dd>';
  html += '<dt>連絡手段</dt><dd>' + (c.contactPrimary ? channelBadgeHtml(c.contactPrimary) : "未設定") + '</dd>';
  html += '<dt>モード</dt><dd>' + (c.mode === "yearend" ? "決算のチェック" : "毎月のチェック") + '</dd>';
  if (c.vendorSyncs && c.vendorSyncs.length) {
    for (const s of c.vendorSyncs) {
      const label = s.vendor === "mf" ? "MF 最終取込" : "freee 最終取込";
      html += '<dt>' + label + '</dt><dd>' + (s.lastSync ? new Date(s.lastSync).toLocaleString("ja-JP") + '（' + s.count + '件）' : "未取得") + '</dd>';
    }
  }
  html += '</dl>';
  if (c.vendor === 'mf' || !c.vendor) {
    if (c.mfConnected) {
      html += '<div style="margin-top:1rem"><a href="/api/mf/oauth/start?clientId=' + escapeHtml(c.id) + '" class="btn btn-secondary" style="font-size:.8rem">MF再連携（スコープ更新）</a></div>';
    } else {
      html += '<div style="margin-top:1rem"><a href="/api/mf/oauth/start?clientId=' + escapeHtml(c.id) + '" class="btn btn-primary">MoneyForwardと連携する</a></div>';
    }
  }
  if (c.vendor === 'freee' || !c.vendor) {
    if (c.freeeExternalId) {
      html += '<div style="margin-top:1rem"><span class="status-chip complete">freee連携済み</span></div>';
    } else {
      html += '<div style="margin-top:1rem"><a href="/api/freee/oauth/start?clientId=' + escapeHtml(c.id) + '" class="btn btn-primary">freeeと連携する</a></div>';
    }
  }
  // オンボーディングガイド: 未設定項目があれば設定を促す
  const endpointsForCheck = c.contactEndpoints || {};
  const hasContactConfigured = !!(endpointsForCheck.email || endpointsForCheck.chatwork || endpointsForCheck.line || endpointsForCheck.line_works);
  const needsAccountingConn = !c.mfConnected && !c.freeeExternalId && c.vendor !== 'yayoi';
  if (!hasContactConfigured || needsAccountingConn) {
    html += '<div class="client-setup-guide">';
    html += '<p class="client-setup-guide-title">セットアップを完了しましょう</p>';
    if (needsAccountingConn) {
      html += '<div class="client-setup-item pending">会計ソフトとの連携が未完了です（上のボタンから連携できます）</div>';
    }
    if (!hasContactConfigured) {
      html += '<div class="client-setup-item pending">連絡先が未設定です — <button class="link-btn" data-company-tab="contact">「連絡先」タブで設定する →</button></div>';
    }
    html += '</div>';
  }
  const crmStatus = ["active", "pending", "inactive"].includes(c.crmStatus) ? c.crmStatus : "active";
  const lastContactDate = c.lastContactAt ? String(c.lastContactAt).slice(0, 10) : "";
  html += '<div class="company-crm-form">';
  html += '<div><p class="eyebrow">CRM情報</p><h4>顧問先対応メモ</h4></div>';
  html += '<div class="company-crm-field">';
  html += '<label for="companyCrmMemo">メモ</label>';
  html += '<textarea id="companyCrmMemo" rows="5" placeholder="次回連絡時の確認事項など">' + escapeHtml(c.memo || "") + '</textarea>';
  html += '<button class="primary-action compact" data-action="company-crm-save">メモを保存</button>';
  html += '</div>';
  html += '<div class="company-crm-field">';
  html += '<label for="companyCrmTags">タグ（カンマ区切り）</label>';
  html += '<input id="companyCrmTags" type="text" value="' + escapeAttribute((c.tags || []).join(", ")) + '" placeholder="重点顧客, 飲食業">';
  html += '<button class="primary-action compact" data-action="company-crm-save">タグを保存</button>';
  html += '</div>';
  html += '<div class="company-crm-status-row">';
  html += '<div><label for="companyCrmStatus">ステータス</label><select id="companyCrmStatus">';
  html += '<option value="active"' + (crmStatus === "active" ? " selected" : "") + '>対応中</option>';
  html += '<option value="pending"' + (crmStatus === "pending" ? " selected" : "") + '>確認待ち</option>';
  html += '<option value="inactive"' + (crmStatus === "inactive" ? " selected" : "") + '>完了</option>';
  html += '</select></div>';
  html += '<div><label for="companyCrmLastContactAt">最終連絡日</label><input id="companyCrmLastContactAt" type="date" value="' + escapeAttribute(lastContactDate) + '"></div>';
  html += '<button class="primary-action compact" data-action="company-crm-save">状態を保存</button>';
  html += '</div>';
  html += '</div>';
  html += '</section>';
  return html;
}

async function saveCompanyCrm(button) {
  const client = currentClient();
  if (!client?.id) return;

  const memo = ($("#companyCrmMemo")?.value || "").trim();
  const tags = ($("#companyCrmTags")?.value || "")
    .split(/[,、]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const crmStatus = $("#companyCrmStatus")?.value || "active";
  const lastContactAt = $("#companyCrmLastContactAt")?.value || null;
  const payload = { memo, tags, crmStatus, lastContactAt };

  setButtonPending(button, true, "保存中...");
  try {
    const res = await apiFetch("/api/clients/" + encodeURIComponent(client.id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || "HTTP " + res.status);
    }
    Object.assign(client, payload);
    showToast("CRM情報を保存しました", "success");
    render();
  } catch (err) {
    showToast("CRM情報の保存に失敗しました", "error");
  } finally {
    setButtonPending(button, false);
  }
}

function renderCompanyContact(c) {
  const endpoints = c.contactEndpoints || {};
  const primary = c.contactPrimary || "email";
  let html = '<div class="settings-card">';
  html += '<h3>連絡先の設定</h3>';
  html += '<div class="form-grid">';
  html += '<label>メール</label><input type="email" data-contact-channel="email" value="' + escapeHtml(endpoints.email || "") + '" placeholder="example@company.com">';
  html += '<label>Slack</label><input type="text" data-contact-channel="slack" value="' + escapeHtml(endpoints.slack || "") + '" placeholder="Channel ID">';
  html += '<label>Chatwork</label><input type="text" data-contact-channel="chatwork" value="' + escapeHtml(endpoints.chatwork || "") + '" placeholder="Room ID">';
  html += '<label>LINE WORKS</label><input type="text" data-contact-channel="line_works" value="' + escapeHtml(endpoints.line_works || "") + '" placeholder="Channel ID">';
  html += '<label>優先チャンネル</label>';
  html += '<select id="companyPrimaryChannelSelect">';
  html += '<option value="email"' + (primary === "email" ? " selected" : "") + '>メール</option>';
  html += '<option value="slack"' + (primary === "slack" ? " selected" : "") + '>Slack</option>';
  html += '<option value="chatwork"' + (primary === "chatwork" ? " selected" : "") + '>Chatwork</option>';
  html += '<option value="line_works"' + (primary === "line_works" ? " selected" : "") + '>LINE WORKS</option>';
  html += '</select>';
  html += '</div>';
  html += '<div class="row-actions" style="margin-top:8px"><button class="primary-action compact" data-action="company-contact-save">保存</button></div>';
  html += '</div>';
  return html;
}

function loadAndRenderCompanyTab() {
  const tab = appState.companyTab || "info";
  if (tab === "info") return;
  const c = currentClient();
  const body = $("#companyTabBody");
  if (!c?.mfConnected || !body) return;
  const cid = encodeURIComponent(c.id);

  if (tab === "journal") {
    fetch("/api/clients/" + cid + "/mf/journal-book")
      .then((r) => r.json())
      .then((d) => { body.innerHTML = renderJournalBook(d.journals || []); });
    return;
  }
  if (tab === "cash") {
    fetch("/api/clients/" + cid + "/mf/accounts")
      .then((r) => r.json())
      .then(async (acc) => {
        const cashAccounts = (acc.accounts || []).filter((a) => a.category === "CASH_AND_DEPOSITS");
        body.innerHTML = '<div class="empty-state">' + cashAccounts.length + ' 件の現預金科目を確認中…</div>';
        const all = [];
        for (const a of cashAccounts) {
          const r = await apiFetch("/api/clients/" + cid + "/mf/journal-book?account_id=" + encodeURIComponent(a.id));
          const d = await r.json();
          for (const j of (d.journals || [])) all.push(j);
        }
        const seen = new Set();
        const unique = all.filter((j) => seen.has(j.id) ? false : (seen.add(j.id), true));
        unique.sort((x, y) => new Date(x.transaction_date).getTime() - new Date(y.transaction_date).getTime());
        body.innerHTML = renderCashBook(unique, cashAccounts);
      });
    return;
  }
  if (tab === "general-ledger") {
    const selected = appState.companyAccountId || "";
    fetch("/api/clients/" + cid + "/mf/accounts")
      .then((r) => r.json())
      .then(async (acc) => {
        const accounts = acc.accounts || [];
        let html = '<div class="book-picker">';
        html += '<label>勘定科目:</label>';
        html += '<select id="generalLedgerPicker"><option value="">選択してください…</option>';
        for (const a of accounts) {
          html += '<option value="' + a.id + '"' + (a.id === selected ? " selected" : "") + '>' + escapeHtml(a.name) + '</option>';
        }
        html += '</select></div>';
        if (selected) {
          const r = await apiFetch("/api/clients/" + cid + "/mf/journal-book?account_id=" + encodeURIComponent(selected));
          const d = await r.json();
          const accountName = accounts.find((a) => a.id === selected)?.name || "";
          html += '<p class="eyebrow">' + escapeHtml(accountName) + ' の元帳</p>';
          html += renderLedger((d.journals || []), selected, null);
        } else {
          html += '<div class="empty-state">勘定科目を選んでください。</div>';
        }
        body.innerHTML = html;
        const picker = $("#generalLedgerPicker");
        if (picker) picker.addEventListener("change", () => {
          appState.companyAccountId = picker.value;
          loadAndRenderCompanyTab();
        });
      });
    return;
  }
  if (tab === "sub-ledger") {
    const selected = appState.companySubAccountId || "";
    fetch("/api/clients/" + cid + "/mf/sub-accounts")
      .then((r) => r.json())
      .then(async (acc) => {
        const subs = acc.sub_accounts || [];
        let html = '<div class="book-picker">';
        html += '<label>補助科目:</label>';
        html += '<select id="subLedgerPicker"><option value="">選択してください…</option>';
        for (const s of subs) {
          html += '<option value="' + s.id + '"' + (s.id === selected ? " selected" : "") + '>' + escapeHtml(s.name) + '</option>';
        }
        html += '</select></div>';
        if (selected) {
          const r = await apiFetch("/api/clients/" + cid + "/mf/journal-book?sub_account_id=" + encodeURIComponent(selected));
          const d = await r.json();
          const subName = subs.find((s) => s.id === selected)?.name || "";
          html += '<p class="eyebrow">' + escapeHtml(subName) + ' の補助元帳</p>';
          html += renderLedger((d.journals || []), null, selected);
        } else {
          html += '<div class="empty-state">補助科目を選んでください。</div>';
        }
        body.innerHTML = html;
        const picker = $("#subLedgerPicker");
        if (picker) picker.addEventListener("change", () => {
          appState.companySubAccountId = picker.value;
          loadAndRenderCompanyTab();
        });
      });
    return;
  }
  if (tab === "trial-bs" || tab === "trial-pl") {
    const type = tab === "trial-bs" ? "bs" : "pl";
    fetch("/api/clients/" + cid + "/mf/trial-balance/" + type)
      .then((r) => r.json())
      .then((d) => { body.innerHTML = renderTrialBalance(d, type); });
    return;
  }
}

function renderJournalBook(journals) {
  if (!journals.length) return '<div class="empty-state">この会計期間に仕訳はありません。</div>';
  journals.sort((a, b) => new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime());
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += '<th>日付</th><th>借方科目</th><th>借方金額</th><th>貸方科目</th><th>貸方金額</th><th>摘要</th>';
  html += '</tr></thead><tbody>';
  for (const j of journals) {
    for (const b of (j.branches || [])) {
      html += '<tr>';
      html += '<td>' + j.transaction_date + '</td>';
      html += '<td>' + escapeHtml(b.debitor?.account_name || "-") + '</td>';
      html += '<td style="text-align:right">¥' + (b.debitor?.value || 0).toLocaleString("ja-JP") + '</td>';
      html += '<td>' + escapeHtml(b.creditor?.account_name || "-") + '</td>';
      html += '<td style="text-align:right">¥' + (b.creditor?.value || 0).toLocaleString("ja-JP") + '</td>';
      html += '<td>' + escapeHtml(j.memo || b.remark || "") + '</td>';
      html += '</tr>';
    }
  }
  html += '</tbody></table></div>';
  return html;
}

function renderCashBook(journals, cashAccounts) {
  if (!journals.length) return '<div class="empty-state">現預金関連の仕訳がありません。</div>';
  const cashIds = new Set(cashAccounts.map((a) => a.id));

  // まずは行を平坦化して並び替え (同日の仕訳番号順)
  const rows = [];
  for (const j of journals) {
    for (const b of (j.branches || [])) {
      const d = b.debitor;
      const cr = b.creditor;
      const debitIsCash = d && cashIds.has(d.account_id);
      const creditIsCash = cr && cashIds.has(cr.account_id);
      const memo = j.memo || b.remark || "";
      // 借方・貸方の両方が現預金 (例: 現金 / 普通預金 引出) → 2 行に展開
      if (debitIsCash) {
        rows.push({
          date: j.transaction_date,
          number: j.number,
          account: d.account_name,
          income: d.value,
          outgo: 0,
          memo,
          other: cr?.account_name || "",
        });
      }
      if (creditIsCash) {
        rows.push({
          date: j.transaction_date,
          number: j.number,
          account: cr.account_name,
          income: 0,
          outgo: cr.value,
          memo,
          other: d?.account_name || "",
        });
      }
    }
  }
  rows.sort((a, b) => {
    const t = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (t !== 0) return t;
    return (a.number || 0) - (b.number || 0);
  });

  // 科目別の累計残高
  const balances = {};
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += '<th>日付</th><th>科目</th><th>摘要</th><th>入金</th><th>出金</th><th>科目残高</th>';
  html += '</tr></thead><tbody>';
  for (const r of rows) {
    balances[r.account] = (balances[r.account] || 0) + r.income - r.outgo;
    html += '<tr>';
    html += '<td>' + r.date + '</td>';
    html += '<td>' + escapeHtml(r.account) + '</td>';
    html += '<td>' + escapeHtml(r.memo + (r.other ? " (相手: " + r.other + ")" : "")) + '</td>';
    html += '<td style="text-align:right">' + (r.income ? '¥' + r.income.toLocaleString("ja-JP") : "") + '</td>';
    html += '<td style="text-align:right">' + (r.outgo ? '¥' + r.outgo.toLocaleString("ja-JP") : "") + '</td>';
    html += '<td style="text-align:right">¥' + balances[r.account].toLocaleString("ja-JP") + '</td>';
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  html += '<small class="sync-fresh">残高は科目ごとに集計しています。期首残高は試算表で確認してください。</small>';
  return html;
}

function renderLedger(journals, accountId, subAccountId) {
  if (!journals.length) return '<div class="empty-state">該当する仕訳がありません。</div>';
  let balance = 0;
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += '<th>日付</th><th>相手科目</th><th>摘要</th><th>借方</th><th>貸方</th><th>残高</th>';
  html += '</tr></thead><tbody>';
  for (const j of journals) {
    for (const b of (j.branches || [])) {
      const d = b.debitor;
      const cr = b.creditor;
      let debit = 0, credit = 0, other = "";
      if (accountId) {
        if (d?.account_id === accountId) { debit = d.value; other = cr?.account_name || ""; }
        else if (cr?.account_id === accountId) { credit = cr.value; other = d?.account_name || ""; }
        else continue;
      } else if (subAccountId) {
        if (d?.sub_account_id === subAccountId) { debit = d.value; other = cr?.account_name || ""; }
        else if (cr?.sub_account_id === subAccountId) { credit = cr.value; other = d?.account_name || ""; }
        else continue;
      }
      balance += debit - credit;
      html += '<tr>';
      html += '<td>' + j.transaction_date + '</td>';
      html += '<td>' + escapeHtml(other) + '</td>';
      html += '<td>' + escapeHtml(j.memo || "") + '</td>';
      html += '<td style="text-align:right">' + (debit ? '¥' + debit.toLocaleString("ja-JP") : "") + '</td>';
      html += '<td style="text-align:right">' + (credit ? '¥' + credit.toLocaleString("ja-JP") : "") + '</td>';
      html += '<td style="text-align:right">¥' + balance.toLocaleString("ja-JP") + '</td>';
      html += '</tr>';
    }
  }
  html += '</tbody></table></div>';
  return html;
}

function renderTrialBalance(data, type) {
  const rows = data?.rows;
  if (!rows || !rows.length) {
    return '<div class="empty-state">試算表が空です（取引が無い、または会計期間外）。</div>';
  }
  const cols = data.columns || ["opening_balance", "debit_amount", "credit_amount", "closing_balance", "ratio"];
  const colLabels = {
    opening_balance: "前期残高",
    debit_amount: "借方金額",
    credit_amount: "貸方金額",
    closing_balance: "期末残高",
    ratio: "構成比",
  };
  let html = '';
  html += '<p class="eyebrow">' + (type === "bs" ? "貸借対照表" : "損益計算書") + ' (' + (data.end_date || "") + '時点)</p>';
  html += '<div class="table-wrap"><table class="trial-balance-table"><thead><tr>';
  html += '<th>科目</th>';
  for (const k of cols) html += '<th>' + (colLabels[k] || k) + '</th>';
  html += '</tr></thead><tbody>';
  const walk = (nodes, depth = 0) => {
    for (const n of (nodes || [])) {
      const cls = n.type === "account" ? "tb-row-account" : "tb-row-section";
      html += '<tr class="' + cls + '">';
      html += '<td style="padding-left:' + (12 + depth * 14) + 'px">' + escapeHtml(n.name) + '</td>';
      for (let i = 0; i < cols.length; i++) {
        const v = n.values?.[i];
        if (cols[i] === "ratio") {
          html += '<td>' + (v == null ? "—" : v + "%") + '</td>';
        } else {
          html += '<td>' + (v == null ? "—" : "¥" + Number(v).toLocaleString("ja-JP")) + '</td>';
        }
      }
      html += '</tr>';
      if (n.rows && n.rows.length) walk(n.rows, depth + 1);
    }
  };
  walk(rows);
  html += '</tbody></table></div>';
  html += '<small class="sync-fresh">マネーフォワード クラウド会計から取得 (' + (data.created_at ? new Date(data.created_at).toLocaleString("ja-JP") : "") + ')</small>';
  return html;
}

// ===== 業務 > 月次業務 > 仕訳 (live MF journals list) =====
function renderVoucherCsvExportBar() {
  return (
    '<div class="export-bar">' +
    '<select id="csvFormat">' +
    '<option value="yayoi">弥生会計形式</option>' +
    '<option value="generic">汎用CSV</option>' +
    '<option value="mf">MoneyForward形式</option>' +
    '</select>' +
    '<button class="btn btn-secondary" id="exportCsvBtn">CSVダウンロード</button>' +
    '</div>'
  );
}

function renderJobsJournal() {
  const c = currentClient();
  if (!c) return '<div class="empty-state">顧問先を選んでください。</div>';
  const hasMfConnection = !!(c.mfAccessToken || c.mfConnected);
  const entries = (c.entries || []).filter((e) => {
    // live MF entries or DB MF/freee entries depending on connection
    if (hasMfConnection) return (e.id || "").toString().startsWith("live-");
    return true;
  });
  let html = '<section>';
  html += '<p class="eyebrow">仕訳一覧</p>';
  if (!hasMfConnection) {
    html += '<div class="setup-guide-banner">';
    html += '<strong>MoneyForwardと連携していません</strong><br>';
    html += '仕訳データを取得するにはOAuth連携が必要です。<br>';
    html += '<button class="setup-guide-btn" onclick="location.hash=\'#/settings\'">設定から連携する →</button>';
    html += '</div>';
  }
  html += renderVoucherCsvExportBar();
  if (entries.length === 0) {
    html += '<div class="empty-state">仕訳がありません。マネフォと連携すると自動で取り込まれます。</div>';
  } else {
    html += '<div class="table-wrap"><table class="journal-table"><thead><tr>';
    html += '<th>日付</th><th>科目</th><th>摘要</th><th>金額</th><th>税区分</th><th>証憑</th><th>操作</th>';
    html += '</tr></thead><tbody>';
    for (const e of entries) {
      const dateStr = new Date(e.occurredAt).toISOString().slice(0, 10);
      const memo = (e.description || "").trim();
      const memoHtml = memo ? escapeHtml(memo.slice(0, 70)) : '<span class="memo-empty">摘要未入力</span>';
      const receiptLabel = e.receiptStatus === "matched"
        ? '<span class="status-chip complete">添付済</span>'
        : e.receiptStatus === "missing"
          ? '<span class="status-chip review">未添付</span>'
          : e.receiptStatus === "partial"
            ? '<span class="status-chip processing">一部</span>'
            : '<span class="status-chip">-</span>';
      html += '<tr>';
      html += '<td>' + dateStr + '</td>';
      html += '<td><strong>' + escapeHtml(e.account) + '</strong></td>';
      html += '<td>' + memoHtml + '</td>';
      html += '<td style="text-align:right">¥' + e.amount.toLocaleString("ja-JP") + '</td>';
      html += '<td>' + escapeHtml(e.taxClass || "-") + '</td>';
      html += '<td>' + receiptLabel + '</td>';
      html += '<td><button class="vendor-link" data-action="open-vendor" data-vendor="' + e.source + '">' + (e.source === "mf" ? "MFで開く" : "freeeで開く") + '</button></td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<small class="sync-fresh">マネーフォワード クラウド会計からライブ取得</small>';
  html += '</section>';
  // Spec 14: bookmee 側で承認したドラフトを別セクションで一覧表示する。
  // MF への書き戻しは禁止なのでここに溜まる。loadApprovedDraftsIntoSlot が
  // renderView の jobs-journal ブロックから非同期で埋める。
  html += '<div id="approvedDraftsSlot"></div>';
  return html;
}

async function loadApprovedDraftsIntoSlot(clientId) {
  const slot = document.querySelector('#approvedDraftsSlot');
  if (!slot) return;
  try {
    const res = await apiFetch(
      '/api/vouchers?clientId=' + encodeURIComponent(clientId),
    );
    if (!res.ok) return;
    const vouchers = await res.json();
    const approved = vouchers.filter((v) => v.journalStatus === 'approved');
    if (approved.length === 0) {
      slot.innerHTML = '';
      return;
    }
    const cell = (s) => (s ? escapeHtml(String(s)) : '-');
    const yen = (n) =>
      n != null ? '¥' + Number(n).toLocaleString('ja-JP') : '-';
    let html = '<section style="margin-top:24px">';
    html +=
      '<p class="eyebrow">承認済み仕訳ドラフト (MF 形式、bookmee 側、' +
      approved.length +
      ' 件)</p>';
    html += '<div class="table-wrap"><table class="mf-draft-table"><thead><tr>';
    html +=
      '<th>取引No</th><th>取引日</th>' +
      '<th colspan="6" class="th-debit">借方</th>' +
      '<th colspan="6" class="th-credit">貸方</th>' +
      '<th>摘要</th><th>証憑</th>';
    html += '</tr><tr class="mf-sub-header">';
    html += '<th></th><th></th>';
    html += '<th>勘定科目</th><th>補助</th><th>取引先</th><th>税区分</th><th>インボイス</th><th>金額</th>';
    html += '<th>勘定科目</th><th>補助</th><th>取引先</th><th>税区分</th><th>インボイス</th><th>金額</th>';
    html += '<th></th><th></th>';
    html += '</tr></thead><tbody>';
    let no = 1;
    for (const v of approved) {
      const d = v.draftJournalJson || {};
      const debit = d.debit || {
        account: d.account,
        subAccount: null,
        partner: null,
        taxClass: d.taxClass,
        invoiceNumber: null,
        amount: d.amount,
      };
      const credit = d.credit || {
        account: '現金',
        subAccount: null,
        partner: null,
        taxClass: '対象外',
        invoiceNumber: null,
        amount: d.amount,
      };
      const txDate = d.transactionDate || d.occurredAt || '-';
      html += '<tr>';
      html += '<td>' + no + '</td>';
      html += '<td>' + cell(txDate) + '</td>';
      html += '<td>' + cell(debit.account) + '</td>';
      html += '<td>' + cell(debit.subAccount) + '</td>';
      html += '<td>' + cell(debit.partner) + '</td>';
      html += '<td>' + cell(debit.taxClass) + '</td>';
      html += '<td>' + cell(debit.invoiceNumber) + '</td>';
      html += '<td class="num">' + yen(debit.amount) + '</td>';
      html += '<td>' + cell(credit.account) + '</td>';
      html += '<td>' + cell(credit.subAccount) + '</td>';
      html += '<td>' + cell(credit.partner) + '</td>';
      html += '<td>' + cell(credit.taxClass) + '</td>';
      html += '<td>' + cell(credit.invoiceNumber) + '</td>';
      html += '<td class="num">' + yen(credit.amount) + '</td>';
      html += '<td>' + cell(d.description) + '</td>';
      html +=
        '<td><button class="vendor-link" data-voucher-open="' + v.id + '">画像</button></td>';
      html += '</tr>';
      no += 1;
    }
    html += '</tbody></table></div>';
    html +=
      '<small class="sync-fresh">bookmee で生成・承認されたドラフト。MF にはまだ転記されていません（CSVをエクスポートして、MFに入れてください）。</small>';
    html += '</section>';
    slot.innerHTML = html;
    slot.querySelectorAll('[data-voucher-open]').forEach((btn) => {
      btn.addEventListener('click', () => openVoucherImage(btn.dataset.voucherOpen));
    });
  } catch (_err) {
    // best-effort
  }
}

// ===== 業務 > 月次業務 > 証憑 (=旧 receipts) =====
function renderJobsVouchers() {
  let html = '<div class="jobs-vouchers-layout">';
  html += '<div id="missingAlertSlot"></div>';
  html += '<div id="missingTableSlot"></div>';
  html += '<div id="lineInboxSlot"></div>';
  html += '<section class="dashboard-section-card">';
  html += '<div class="dashboard-section-head"><h3>証憑一覧</h3><span id="jobsVoucherCount" class="status-chip processing">読み込み中</span></div>';
  html += renderVoucherCsvExportBar();
  html += '<div id="jobsVouchersGrid"><div class="empty-state">読み込み中…</div></div>';
  html += '</section>';
  html += '<div class="voucher-modal" id="voucherModal" hidden>';
  html += '<div class="voucher-modal-backdrop"></div>';
  html += '<img id="voucherModalImg" alt="" />';
  html += '<button class="voucher-modal-close" id="voucherModalClose" aria-label="閉じる">×</button>';
  html += '</div>';
  html += '</div>';
  return html;
}

function mfWriteStatusBadgeHtml(status) {
  if (status === "done") return '<span class="status-chip complete">MF送信済み</span>';
  if (status === "writing" || status === "pending") return '<span class="status-chip processing">MF送信中</span>';
  if (status === "failed") return '<span class="status-chip error">MF送信失敗</span>';
  return '<span class="status-chip">未送信</span>';
}

function renderJobsVoucherCardHtml(voucher, clientId) {
  const sourceBadge =
    voucher.source === 'drive'
      ? '<span class="voucher-source-badge src-drive">Drive</span>'
      : voucher.source === 'line'
        ? '<span class="voucher-source-badge src-line">LINE</span>'
        : voucher.source === 'cc_csv'
          ? '<span class="voucher-source-badge src-cc">CC CSV</span>'
          : '';
  const mimeType = String(voucher.mimeType || '').toLowerCase();
  const thumb = mimeType.includes('pdf')
    ? '<div class="pdf">📄</div>'
    : mimeType.includes('csv')
      ? '<div class="pdf">CSV</div>'
      : `<img data-voucher-img="${voucher.id}" alt="${escapeHtml(voucher.filename || "voucher")}" />`;
  const mfStatus = voucher.mfWriteStatus || 'none';
  const canWrite = mfStatus !== 'done' && mfStatus !== 'writing' && mfStatus !== 'pending';
  let html = '<article class="voucher-status-card" data-voucher-id="' + voucher.id + '" data-mime-type="' + escapeHtml(voucher.mimeType || "") + '">';
  html += '<div class="voucher-status-thumb">' + thumb + '</div>';
  html += '<div class="voucher-status-body">';
  html += '<div class="voucher-status-name">' + escapeHtml(voucher.filename || "名称未設定") + sourceBadge + '</div>';
  html += '<div class="voucher-status-meta">' + new Date(voucher.uploadedAt).toLocaleString("ja-JP") + '</div>';
  html += '<div class="voucher-status-actions">' + mfWriteStatusBadgeHtml(mfStatus);
  if (mfStatus === 'failed') {
    html += '<button class="voucher-mfretry-btn" data-voucher-mfretry="' + voucher.id + '" data-voucher-client-id="' + clientId + '">再試行</button>';
  } else if (canWrite) {
    html += '<button class="voucher-mfwrite-btn" data-voucher-mfwrite="' + voucher.id + '">MFに登録</button>';
  }
  html += '</div>';
  if (mfStatus === "failed" && voucher.mfWriteError) {
    html += '<details class="voucher-error-panel"><summary>エラー詳細を表示</summary><p class="voucher-error-message">' + escapeHtml(voucher.mfWriteError) + '</p></details>';
  }
  html += '</div></article>';
  return html;
}

// 仕訳ドラフトをMF手入力用のテキスト形式に変換（スタッフのコピペ用）
function formatJournalCopyText(txDate, debit, credit, description) {
  const y = (n) => n != null ? '¥' + Number(n).toLocaleString('ja-JP') : '—';
  const c = (s) => s || '—';
  const debitLine = [c(debit.account), c(debit.subAccount), c(debit.partner), c(debit.taxClass), y(debit.amount)]
    .join(' | ');
  const creditLine = [c(credit.account), c(credit.subAccount), c(credit.partner), c(credit.taxClass), y(credit.amount)]
    .join(' | ');
  return `【仕訳ドラフト】\n取引日: ${c(txDate)}\n借方: ${debitLine}\n貸方: ${creditLine}\n摘要: ${c(description)}`;
}

function parseVoucherDraftJournal(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_err) {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function formatLineInboxDate(dateText, fallbackDateText) {
  const source = dateText || fallbackDateText;
  const dt = source ? new Date(source) : new Date();
  if (Number.isNaN(dt.getTime())) return '—';
  return String(dt.getMonth() + 1).padStart(2, '0') + '/' + String(dt.getDate()).padStart(2, '0');
}

function lineInboxStatusMeta(status) {
  if (status === 'drafted') return { css: 'drafted', text: '✅ 仕訳済み' };
  if (status === 'needs_info' || status === 'inquired') return { css: 'needs-info', text: '❓ 情報確認中' };
  if (status === 'approved') return { css: 'approved', text: '✔ 承認済み' };
  if (status === 'pending' || status === 'unprocessed') return { css: 'processing', text: '🔄 処理中' };
  return { css: 'processing', text: '🔄 処理中' };
}

function renderLineInboxCardHtml(voucher) {
  const draft = parseVoucherDraftJournal(voucher.draftJournalJson);
  const debit = draft && typeof draft.debit === 'object' ? draft.debit : {};
  const credit = draft && typeof draft.credit === 'object' ? draft.credit : {};
  const debitAccount = (debit && typeof debit.account === 'string' ? debit.account : draft.account) || '未設定';
  const creditAccount = (credit && typeof credit.account === 'string' ? credit.account : '未設定');
  const amountNum = typeof debit.amount === 'number'
    ? debit.amount
    : typeof draft.amount === 'number'
      ? draft.amount
      : (voucher.ocrJson && typeof voucher.ocrJson === 'object' && typeof voucher.ocrJson.amount === 'number' ? voucher.ocrJson.amount : null);
  const amountLabel = amountNum != null ? '¥' + Number(amountNum).toLocaleString('ja-JP') : '金額未確定';
  const txDate = typeof draft.transactionDate === 'string' ? draft.transactionDate : null;
  const dateText = formatLineInboxDate(txDate, voucher.uploadedAt);
  const status = lineInboxStatusMeta(voucher.journalStatus);
  const thumb = String(voucher.mimeType || '').toLowerCase().includes('pdf')
    ? '<div class="line-notif-pdf">📄</div>'
    : '<img src="/api/vouchers/' + encodeURIComponent(voucher.id) + '/image" alt="証憑" loading="lazy" />';

  return `
    <div class="line-notif-card" data-status="${escapeHtml(status.css)}" data-line-voucher-id="${escapeHtml(voucher.id)}">
      <div class="line-notif-thumb">${thumb}</div>
      <div class="line-notif-body">
        <div class="line-notif-meta">
          <span class="line-notif-date">${escapeHtml(dateText)}</span>
          <span class="line-notif-status-badge ${escapeHtml(status.css)}">${escapeHtml(status.text)}</span>
        </div>
        <div class="line-notif-amount">${escapeHtml(amountLabel)}</div>
        <div class="line-notif-account">${escapeHtml(String(debitAccount))} → ${escapeHtml(String(creditAccount))}</div>
      </div>
      <div class="line-notif-actions">
        <button class="row-action" data-line-open-voucher="${escapeHtml(voucher.id)}" data-line-open-mime="${escapeHtml(voucher.mimeType || '')}">確認</button>
      </div>
    </div>
  `;
}

function renderLineInboxHtml(lineVouchers) {
  const rows = Array.isArray(lineVouchers) ? lineVouchers : [];
  if (rows.length === 0) return '';
  return `
    <section class="line-inbox">
      <div class="line-inbox-header">
        <span class="line-inbox-icon">💬</span>
        <strong>LINE受信トレイ</strong>
        <span class="line-inbox-count">${rows.length}件</span>
      </div>
      <div class="line-inbox-feed">
        ${rows.map((v) => renderLineInboxCardHtml(v)).join('')}
      </div>
    </section>
  `;
}

async function fetchLineVouchers(clientId) {
  const primaryPath = '/api/clients/' + encodeURIComponent(clientId) + '/vouchers?source=line&limit=10';
  try {
    const res = await apiFetch(primaryPath);
    if (res.ok) {
      const body = await res.json();
      const list = Array.isArray(body) ? body : body?.vouchers;
      if (Array.isArray(list)) return list.slice(0, 10);
    }
  } catch (_err) {
    // fall through to legacy endpoint
  }
  const fallbackRes = await apiFetch('/api/vouchers?clientId=' + encodeURIComponent(clientId));
  if (!fallbackRes.ok) return [];
  const fallbackRows = await fallbackRes.json();
  return (Array.isArray(fallbackRows) ? fallbackRows : [])
    .filter((v) => v.source === 'line')
    .slice(0, 10);
}

function openVoucherPreview(voucherId, mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('pdf') || normalized.includes('csv')) {
    openVoucherImage(voucherId);
    return;
  }
  const modal = document.querySelector('#voucherModal');
  const img = document.querySelector('#voucherModalImg');
  if (modal && img) {
    img.src = '';
    loadVoucherImageBlob(voucherId).then((url) => {
      if (url) img.src = url;
    });
    modal.hidden = false;
  }
}

async function loadAndRenderJobsVouchers() {
  const client = currentClient();
  if (!client?.id) return;
  const grid = document.getElementById('jobsVouchersGrid');
  const countEl = document.getElementById('jobsVoucherCount');
  const inboxSlot = document.getElementById('lineInboxSlot');
  if (!grid || !countEl) return;
  try {
    const [res, lineRowsRaw] = await Promise.all([
      apiFetch('/api/vouchers?clientId=' + encodeURIComponent(client.id)),
      fetchLineVouchers(client.id),
    ]);
    if (!res.ok) throw new Error('fetch failed');
    const vouchers = await res.json();
    const rows = Array.isArray(vouchers) ? vouchers : [];
    const lineRows = Array.isArray(lineRowsRaw) ? lineRowsRaw : [];
    if (inboxSlot) {
      inboxSlot.innerHTML = renderLineInboxHtml(lineRows);
      inboxSlot.querySelectorAll('[data-line-open-voucher]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          openVoucherPreview(btn.dataset.lineOpenVoucher, btn.dataset.lineOpenMime);
        });
      });
    }
    countEl.textContent = rows.length + '件';
    countEl.className = 'status-chip ' + (rows.length === 0 ? 'complete' : 'processing');
    if (rows.length === 0) {
      grid.innerHTML = '<div class="dashboard-empty">証憑はまだありません ✓</div>';
      return;
    }
    rows.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
    grid.innerHTML = '<div class="voucher-status-grid">' + rows.map((v) => renderJobsVoucherCardHtml(v, client.id)).join('') + '</div>';
    grid.querySelectorAll('[data-voucher-mfwrite]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        writeMfJournal(btn.dataset.voucherMfwrite);
      });
    });
    grid.querySelectorAll('[data-voucher-mfretry]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        retryMfWrite(btn.dataset.voucherClientId, btn.dataset.voucherMfretry);
      });
    });
    grid.querySelectorAll('[data-voucher-id]').forEach((card) => {
      card.addEventListener('click', (event) => {
        if (event.target.closest('button') || event.target.closest('summary') || event.target.closest('details')) return;
        const id = card.dataset.voucherId;
        const mimeType = card.dataset.mimeType;
        openVoucherPreview(id, mimeType);
      });
    });
    const closeBtn = document.querySelector('#voucherModalClose');
    const backdrop = document.querySelector('.voucher-modal-backdrop');
    const closeModal = () => {
      const modal = document.querySelector('#voucherModal');
      if (modal) modal.hidden = true;
    };
    if (closeBtn) closeBtn.onclick = closeModal;
    if (backdrop) backdrop.onclick = closeModal;
    hydrateVoucherImages();
  } catch (err) {
    countEl.textContent = '読込失敗';
    countEl.className = 'status-chip error';
    grid.innerHTML = '<div class="empty-state">証憑一覧の読み込みに失敗しました。</div>';
  }
}

// ===== 業務 > 月次業務 > 月次チェック =====
function renderJobsMonthlyCheck() {
  const c = currentClient();
  if (!c) return '<div class="empty-state">顧問先を選んでください。</div>';

  // 簡易な月次チェック観点:
  //   - 高額仕訳 (¥1,000,000 以上)
  //   - 証憑未添付
  //   - 月次の取引総額
  const entries = c.entries || [];
  const liveOnly = c.mfConnected ? entries.filter((e) => (e.id || "").toString().startsWith("live-")) : entries;

  const highValue = liveOnly.filter((e) => e.amount >= 1000000);
  const missingReceipt = liveOnly.filter((e) => e.receiptStatus === "missing");
  const totalAmount = liveOnly.reduce((sum, e) => sum + e.amount, 0);

  let html = '<div class="check-summary">';
  html += '<article class="check-card"><span>当月仕訳件数</span><strong>' + liveOnly.length + '件</strong></article>';
  html += '<article class="check-card alert"><span>高額仕訳 (100万円超)</span><strong>' + highValue.length + '件</strong></article>';
  html += '<article class="check-card alert"><span>証憑未添付</span><strong>' + missingReceipt.length + '件</strong></article>';
  html += '<article class="check-card"><span>合計取引金額</span><strong>¥' + totalAmount.toLocaleString("ja-JP") + '</strong></article>';
  html += '</div>';

  if (highValue.length > 0) {
    html += '<section style="margin-top:14px"><p class="eyebrow">高額仕訳の確認</p>';
    html += '<div class="table-wrap"><table><thead><tr>';
    html += '<th>日付</th><th>科目</th><th>金額</th><th>摘要</th>';
    html += '</tr></thead><tbody>';
    for (const e of highValue) {
      html += '<tr>';
      html += '<td>' + new Date(e.occurredAt).toISOString().slice(0, 10) + '</td>';
      html += '<td>' + escapeHtml(e.account) + '</td>';
      html += '<td style="text-align:right">¥' + e.amount.toLocaleString("ja-JP") + '</td>';
      html += '<td>' + escapeHtml((e.description || "").slice(0, 40)) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div></section>';
  }

  if (liveOnly.length === 0) {
    html += '<div class="empty-state" style="margin-top:14px">取引データがありません。マネフォと連携すると自動でチェックされます。</div>';
  }
  return html;
}

function renderCcCsvUploadSection(clientId) {
  let html = '<section class="dashboard-section-card cc-csv-upload-card">';
  html += '<div class="dashboard-section-head">';
  html += '<div><p class="eyebrow">CC明細インポート</p><h3>クレジットカード明細CSV</h3></div>';
  html += '</div>';
  html += '<p class="cc-csv-upload-help">カード会社のWebからダウンロードしたCSVをアップロードすると、各行を証憑として登録してAI仕訳ドラフトを生成します。</p>';
  html += '<div class="cc-csv-upload-form">';
  html += '<input type="file" id="ccCsvInput" accept=".csv,text/csv" hidden>';
  html += '<label for="ccCsvInput" class="primary-action cc-csv-file-label">📎 CSVを選ぶ</label>';
  html += '<span id="ccCsvFilename" class="cc-csv-filename"></span>';
  html += '<button id="ccCsvUploadBtn" class="primary-action" disabled>アップロード</button>';
  html += '</div>';
  if (!clientId) {
    html += '<p class="cc-result-warn">アップロードする顧問先を選択してください。</p>';
  }
  html += '<div id="ccCsvResult" class="cc-csv-result" aria-live="polite"></div>';
  html += '</section>';
  return html;
}

function renderVoucherRegister() {
  const tab = appState.voucherTab;
  const counts = appState.voucherCounts || {};
  const client = currentClient();
  // `clients` is the module-level array populated from /api/clients on startup
  const clientNameById = Object.fromEntries(
    (clients || []).map((c) => [c.id, c.name]),
  );

  // Build a tab for every clientId that has at least one voucher, even when
  // the client list hasn't loaded yet (fall back to cuid as the label).
  const clientIdsWithVouchers = Object.keys(counts).filter(
    (k) => k !== 'unassigned' && counts[k] > 0,
  );
  const tabClients = clientIdsWithVouchers.map((id) => ({
    id,
    name: clientNameById[id] || id,
    count: counts[id],
  }));

  const tabs = [
    {
      id: 'unassigned',
      label: '未分類',
      count: counts.unassigned || 0,
    },
    ...tabClients.map((c) => ({
      id: c.id,
      label: c.name,
      count: c.count,
    })),
  ];

  const tabHtml = tabs
    .map(
      (t) => `
      <button class="voucher-tab ${t.id === tab ? 'active' : ''}"
              data-voucher-tab="${t.id}">
        ${escapeHtml(t.label)} <span class="count">${t.count}</span>
      </button>
    `,
    )
    .join('');

  const uploadingCards = appState.uploadQueue
    .map(
      (q) => `
      <div class="voucher-card uploading">
        <div class="spinner"></div>
        <div class="voucher-filename">${escapeHtml(q.filename)}</div>
        <div class="voucher-status">${q.status === 'failed' ? '失敗' : 'アップロード中'}</div>
      </div>
    `,
    )
    .join('');

  const cards = (appState.vouchers || [])
    .map((v) => {
      const ocr = v.ocrStatus || 'pending';
      let ocrHtml = '';
      if (ocr === 'pending' || ocr === 'processing') {
        ocrHtml = `<div class="voucher-ocr ocr-running"><span class="spinner-sm"></span>OCR 中…</div>`;
      } else if (ocr === 'failed') {
        ocrHtml = `<div class="voucher-ocr ocr-failed"><span>OCR 失敗</span><button class="voucher-ocr-retry" data-voucher-retry-ocr="${v.id}">再試行</button></div>`;
      } else if ((ocr === 'done' || ocr === 'skipped') && v.ocrJson) {
        const j = v.ocrJson;
        const amount = j.amount != null ? '¥' + j.amount.toLocaleString('ja-JP') : '—';
        const vendor = j.vendor_name ? escapeHtml(j.vendor_name) : '—';
        const date = j.issue_date ? escapeHtml(j.issue_date) : '—';
        const addressee = j.addressee ? escapeHtml(j.addressee) : '—';
        const invoice = j.invoice_number ? escapeHtml(j.invoice_number) : '—';
        ocrHtml = `
          <div class="voucher-ocr ocr-done">
            <div class="voucher-ocr-amount">${amount}</div>
            <div class="voucher-ocr-row"><span class="voucher-ocr-label">発行</span>${vendor}</div>
            <div class="voucher-ocr-row"><span class="voucher-ocr-label">宛名</span>${addressee}</div>
            <div class="voucher-ocr-row"><span class="voucher-ocr-label">日付</span>${date}</div>
            <div class="voucher-ocr-row"><span class="voucher-ocr-label">登録番号</span>${invoice}</div>
          </div>`;
      }

      let matchHtml = '';
      const ms = v.matchStatus;
      if (ms === 'matched') {
        matchHtml = `<div class="voucher-match match-ok">🔗 ✓ MF 仕訳と突合済み</div>`;
      } else if (ms === 'unmatched' && ocr === 'done') {
        matchHtml = `<div class="voucher-match match-no"><span>🔗 MF 仕訳と一致なし</span><button class="voucher-match-retry" data-voucher-rematch="${v.id}">再突合</button></div>`;
      } else if (ms === 'no_client') {
        matchHtml = `<div class="voucher-match match-gray">🔗 顧問先未割当て</div>`;
      } else if (ms === 'no_data') {
        matchHtml = `<div class="voucher-match match-gray">🔗 OCR データ不足</div>`;
      }
      const assignHtml = appState.voucherTab === 'unassigned'
        ? `<div class="voucher-assign">
             <select data-voucher-assign="${v.id}" style="width:100%;padding:4px 6px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;margin-top:6px">
               <option value="">— 顧問先を選択 —</option>
               ${(clients || []).map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}
             </select>
           </div>`
        : '';

      const sourceBadge =
        v.source === 'drive'
          ? '<span class="voucher-source-badge src-drive">Drive</span>'
          : v.source === 'line'
            ? '<span class="voucher-source-badge src-line">LINE</span>'
            : v.source === 'cc_csv'
              ? '<span class="voucher-source-badge src-cc">CC CSV</span>'
              : '';
      const captionHtml = v.caption
        ? `<div class="voucher-caption">${escapeHtml(v.caption)}</div>`
        : '';

      // MF 仕訳登録状態
      const mfStatus = v.mfWriteStatus;
      let mfHtml = '';
      const js = v.journalStatus || 'none';
      if (js !== 'none' && js !== 'drafting') {
        const mfBadge = mfStatus === 'done'
          ? '<span class="voucher-mf-badge mf-done">MF登録済</span>'
          : mfStatus === 'writing' || mfStatus === 'pending'
            ? '<span class="voucher-mf-badge mf-writing"><span class="spinner-sm"></span>MF入力中</span>'
            : mfStatus === 'failed'
              ? '<span class="voucher-mf-badge mf-failed">MF送信失敗</span>'
              : '';
        const mfBtn = mfStatus !== 'done' && mfStatus !== 'writing' && mfStatus !== 'pending'
          ? (mfStatus === 'failed' && v.clientId
            ? `<button class="voucher-mfretry-btn" data-voucher-mfretry="${v.id}" data-voucher-client-id="${escapeHtml(v.clientId)}">再試行</button>`
            : `<button class="voucher-mfwrite-btn" data-voucher-mfwrite="${v.id}">MFに登録</button>`)
          : '';
        if (mfBadge || mfBtn) {
          mfHtml = `<div class="voucher-mf-row">${mfBadge}${mfBtn}</div>`;
          if (mfStatus === 'failed' && v.mfWriteError) {
            mfHtml += `<details class="voucher-error-panel"><summary>エラー詳細</summary><p class="voucher-error-message">${escapeHtml(v.mfWriteError)}</p></details>`;
          }
        }
      }

      return `
      <div class="voucher-card" data-voucher-id="${v.id}" data-mime-type="${escapeHtml(v.mimeType || '')}" draggable="true">
        ${String(v.mimeType || '').toLowerCase().includes('pdf')
          ? '<div class="voucher-document-thumb">📄</div>'
          : String(v.mimeType || '').toLowerCase().includes('csv')
            ? '<div class="voucher-document-thumb">CSV</div>'
            : `<img data-voucher-img="${v.id}" alt="${escapeHtml(v.filename)}" style="background:#f3f4f6;" />`}
        <button class="voucher-delete" data-voucher-delete="${v.id}" aria-label="削除">×</button>
        <div class="voucher-meta">
          <div class="voucher-filename">${escapeHtml(v.filename)}${sourceBadge}</div>
          <div class="voucher-date">${new Date(v.uploadedAt).toLocaleString('ja-JP')}</div>
        </div>
        ${captionHtml}
        ${ocrHtml}
        ${matchHtml}
        ${assignHtml}
        ${mfHtml}
      </div>
    `;
    })
    .join('');

  // 弥生CSV出力バー（顧問先タブ選択時のみ表示）
  const yayoiExportBar = tab !== 'unassigned' ? `
    <div class="yayoi-export-bar">
      <div class="yayoi-export-info">
        <strong>弥生会計インポート用CSV</strong>
        <span class="yayoi-export-hint">日付で絞り込んで出力できます（空欄なら全件）</span>
      </div>
      <div class="yayoi-export-controls">
        <input type="date" id="yayoiFromDate" class="yayoi-date-input" placeholder="開始日" title="開始日" />
        <span>〜</span>
        <input type="date" id="yayoiToDate" class="yayoi-date-input" placeholder="終了日" title="終了日" />
        <button class="btn btn-primary" id="yayoiExportBtn">弥生CSVをダウンロード</button>
      </div>
    </div>
  ` : '';

  return `
    <section class="voucher-register">
      ${yayoiExportBar}
      ${renderCcCsvUploadSection(client?.id)}
      <div class="voucher-dropzone" id="voucherDropzone">
        <div class="voucher-drop-icon">⬆</div>
        <p class="voucher-dropzone-label">証憑ファイルをここにドラッグ＆ドロップ</p>
        <small class="voucher-status-meta">JPEG / PNG / GIF / WebP (10MBまで)</small>
        <div class="voucher-type-selector">
          <label class="voucher-type-opt">
            <input type="radio" name="voucherType" value="manual" checked /> 経費・領収書
          </label>
          <label class="voucher-type-opt">
            <input type="radio" name="voucherType" value="invoice" /> 請求書（売上）
          </label>
        </div>
        <label class="voucher-pick-btn">
          ファイルを選択してアップロード
          <input type="file" id="voucherFileInput" multiple
                 accept="image/jpeg,image/png,image/gif,image/webp" hidden />
        </label>
      </div>
      <div class="setup-guide-banner">
        <strong>他にも以下の方法で証憑を追加できます：</strong>
        <div class="upload-guides">
          <div>📱 LINE → 顧問先のスマホからLINEで送ってもらう</div>
          <div>📁 Google Drive → スキャナーから自動取り込み</div>
        </div>
      </div>
      <div class="voucher-tabs">${tabHtml}</div>
      <div class="voucher-grid">
        ${uploadingCards}
        ${cards}
      </div>
      <div class="voucher-modal" id="voucherModal" hidden>
        <div class="voucher-modal-backdrop"></div>
        <img id="voucherModalImg" alt="" />
        <button class="voucher-modal-close" id="voucherModalClose" aria-label="閉じる">×</button>
      </div>
    </section>
  `;
}

function renderMatchingResults() {
  // Default tab = first client by id, fallback to 'unassigned'
  if (!appState.matchingTab) {
    appState.matchingTab = (clients || [])[0]?.id || 'unassigned';
  }
  const tab = appState.matchingTab;
  const clientNameById = Object.fromEntries(
    (clients || []).map((c) => [c.id, c.name]),
  );
  const entriesById = Object.fromEntries(
    (appState.matchingEntries || []).map((e) => [e.sourceEntryId, e]),
  );

  const tabs = [
    ...(clients || []).map((c) => ({ id: c.id, label: c.name })),
    { id: 'unassigned', label: '未割当て' },
  ];
  const tabHtml = tabs
    .map(
      (t) => `
      <button class="voucher-tab ${t.id === tab ? 'active' : ''}"
              data-matching-tab="${t.id}">
        ${escapeHtml(t.label)}
      </button>
    `,
    )
    .join('');

  const vouchers = appState.matchingVouchers || [];
  const matched = vouchers.filter((v) => v.matchStatus === 'matched');
  const pending = vouchers.filter((v) => v.matchStatus !== 'matched');

  function clientOptions(currentId) {
    const opts = [
      `<option value="">未割当て</option>`,
      ...(clients || []).map(
        (c) =>
          `<option value="${c.id}"${c.id === currentId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`,
      ),
    ];
    return opts.join('');
  }

  const matchedHtml = matched
    .map((v) => {
      const j = v.ocrJson || {};
      const entry = entriesById[v.matchedEntryId] || null;
      const amount =
        j.amount != null ? '¥' + j.amount.toLocaleString('ja-JP') : '—';
      const vendor = j.vendor_name ? escapeHtml(j.vendor_name) : '—';
      const date = j.issue_date ? escapeHtml(j.issue_date) : '—';
      const entryAmount = entry
        ? '¥' + entry.amount.toLocaleString('ja-JP')
        : '—';
      const entryDesc = entry ? escapeHtml(entry.description) : '—';
      const entryDate = entry
        ? new Date(entry.occurredAt).toISOString().slice(0, 10)
        : '—';
      const entryAccount = entry ? escapeHtml(entry.account) : '—';
      return `
      <div class="matching-card-matched">
        <img data-voucher-img="${v.id}" alt="${escapeHtml(v.filename)}" style="background:#f3f4f6;" />
        <div class="matching-side voucher-side">
          <div class="matching-label">証憑 OCR</div>
          <div class="matching-amount">${amount}</div>
          <div class="matching-row">${vendor}</div>
          <div class="matching-row matching-muted">${date}</div>
        </div>
        <div class="matching-arrow">↔</div>
        <div class="matching-side entry-side">
          <div class="matching-label">MF 仕訳</div>
          <div class="matching-amount">${entryAmount}</div>
          <div class="matching-row">${entryAccount} — ${entryDesc}</div>
          <div class="matching-row matching-muted">${entryDate}</div>
        </div>
      </div>`;
    })
    .join('');

  const pendingHtml = pending
    .map((v) => {
      const j = v.ocrJson || {};
      const status = v.matchStatus || 'unmatched';
      const statusLabel =
        status === 'no_client'
          ? '顧問先未割当て'
          : status === 'no_data'
            ? 'OCR データ不足'
            : 'MF 仕訳と一致なし';
      const amount =
        j.amount != null ? '¥' + j.amount.toLocaleString('ja-JP') : '—';
      const vendor = j.vendor_name ? escapeHtml(j.vendor_name) : '—';
      const date = j.issue_date ? escapeHtml(j.issue_date) : '—';
      const reason = v.matchedClientReason
        ? `振り分け根拠: ${escapeHtml(v.matchedClientReason)}`
        : '';

      // Spec 14: 仕訳ドラフト + 不足情報 + 顧客問い合わせ
      let draftHtml = '';
      const dj = v.draftJournalJson;
      const js = v.journalStatus || 'none';
      if (js === 'drafting') {
        draftHtml = `<div class="matching-draft matching-draft-running"><span class="spinner-sm"></span>仕訳ドラフト生成中…</div>`;
      } else if (
        dj &&
        (js === 'drafted' || js === 'needs_info' || js === 'inquired' || js === 'approved')
      ) {
        // Spec 14 (MF-style 借方/貸方): dj は debit/credit/transactionDate/description.
        // 旧フォーマット (account/amount/taxClass/occurredAt) で残ってる古いレコードも一応サポート。
        const debit = dj.debit || { account: dj.account, amount: dj.amount, taxClass: dj.taxClass, partner: dj.vendor_name, invoiceNumber: null, subAccount: null };
        const credit = dj.credit || { account: '現金', amount: dj.amount, taxClass: '対象外', partner: null, invoiceNumber: null, subAccount: null };
        const txDate = dj.transactionDate || dj.occurredAt || '—';
        const description = dj.description ? escapeHtml(String(dj.description)) : '—';
        const missing = Array.isArray(dj.missingFields) ? dj.missingFields : [];
        const yen = (n) => n != null ? '¥' + Number(n).toLocaleString('ja-JP') : '—';
        const cell = (s) => s ? escapeHtml(String(s)) : '—';
        const statusBadge =
          js === 'approved'
            ? (dj.autoClassified
                ? '<span class="matching-draft-badge badge-approved">自動仕訳済</span>'
                : '<span class="matching-draft-badge badge-approved">承認済</span>')
            : js === 'inquired'
              ? `<span class="matching-draft-badge badge-inquired">問合せ済 ${v.inquiryAt ? new Date(v.inquiryAt).toLocaleDateString('ja-JP') : ''}</span>`
              : js === 'needs_info'
                ? '<span class="matching-draft-badge badge-needs">不足情報あり</span>'
                : '<span class="matching-draft-badge badge-drafted">ドラフト</span>';
        const missingHtml = missing.length
          ? `<div class="matching-draft-missing">
                <div class="matching-draft-missing-label">⚠ 確認したい情報:</div>
                <ul>${missing.map((m) => `<li>${escapeHtml(String(m))}</li>`).join('')}</ul>
                <button class="matching-inquire-btn" data-matching-inquire="${v.id}" ${js === 'inquired' ? 'disabled' : ''}>
                  ${js === 'inquired' ? '問い合わせ送信済み' : '情報を依頼'}
                </button>
                <div class="voucher-reply-box" style="margin-top:8px">
                  <textarea data-voucher-reply-text="${v.id}" rows="2" placeholder="顧客からのメール返信を貼り付け" style="width:100%;box-sizing:border-box"></textarea>
                  <button class="matching-inquire-btn" data-voucher-reply="${v.id}" style="margin-top:4px">返信を取り込む</button>
                </div>
              </div>`
          : '';
        const mfStatus = v.mfWriteStatus;
        const mfBadge = mfStatus === 'done'
          ? '<span class="matching-draft-badge badge-approved">MF登録済</span>'
          : mfStatus === 'writing' || mfStatus === 'pending'
            ? '<span class="matching-draft-badge badge-drafting"><span class="spinner-sm"></span>MF入力中</span>'
            : mfStatus === 'failed'
              ? `<span class="matching-draft-badge badge-needs" title="${escapeHtml(v.mfWriteError || '')}">MF失敗</span>`
              : '';
        const mfWriteBtn = mfStatus !== 'done' && mfStatus !== 'writing' && mfStatus !== 'pending'
          ? `<button class="matching-mfwrite-btn" data-matching-mfwrite="${v.id}">MFに登録</button>`
          : '';
        draftHtml = `
          <div class="matching-draft">
            <div class="matching-draft-header">
              📝 仕訳ドラフト (MF 形式) ${statusBadge} ${mfBadge}
            </div>
            <div class="matching-draft-mf">
              <div class="matching-draft-mf-meta">
                <span><span class="matching-draft-label">取引日</span>${cell(txDate)}</span>
                <span><span class="matching-draft-label">摘要</span>${description}</span>
              </div>
              <table class="matching-draft-mf-table">
                <thead>
                  <tr><th></th><th>勘定科目</th><th>補助</th><th>取引先</th><th>税区分</th><th>インボイス</th><th>金額</th></tr>
                </thead>
                <tbody>
                  <tr class="row-debit">
                    <th>借方</th>
                    <td>${cell(debit.account)}</td>
                    <td>${cell(debit.subAccount)}</td>
                    <td>${cell(debit.partner)}</td>
                    <td>${cell(debit.taxClass)}</td>
                    <td>${cell(debit.invoiceNumber)}</td>
                    <td class="num">${yen(debit.amount)}</td>
                  </tr>
                  <tr class="row-credit">
                    <th>貸方</th>
                    <td>${cell(credit.account)}</td>
                    <td>${cell(credit.subAccount)}</td>
                    <td>${cell(credit.partner)}</td>
                    <td>${cell(credit.taxClass)}</td>
                    <td>${cell(credit.invoiceNumber)}</td>
                    <td class="num">${yen(credit.amount)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            ${missingHtml}
            <div class="matching-draft-actions">
              <button class="matching-redraft-btn" data-matching-redraft="${v.id}">再生成</button>
              ${js !== 'approved' ? `<button class="matching-approve-btn" data-matching-approve="${v.id}">承認</button>` : ''}
              ${mfWriteBtn}
              <button class="matching-copy-btn" data-matching-copy="${v.id}" data-copy-text="${escapeAttribute(formatJournalCopyText(txDate, debit, credit, d.description))}">📋 コピー</button>
            </div>
          </div>`;
      } else if (status === 'unmatched' && v.ocrStatus === 'done') {
        draftHtml = `<div class="matching-draft matching-draft-empty">
          <button class="matching-redraft-btn" data-matching-redraft="${v.id}">仕訳ドラフトを生成</button>
        </div>`;
      }

      return `
      <div class="matching-card-pending" id="voucher-card-${v.id}">
        <img data-voucher-img="${v.id}" alt="${escapeHtml(v.filename)}" style="background:#f3f4f6;" />
        <div class="matching-side">
          <div class="matching-label matching-status-${status}">${statusLabel}</div>
          <div class="matching-amount">${amount}</div>
          <div class="matching-row">${vendor}</div>
          <div class="matching-row matching-muted">${date}</div>
          ${reason ? `<div class="matching-row matching-muted">${reason}</div>` : ''}
        </div>
        <div class="matching-actions">
          <button class="matching-rematch-btn" data-matching-rematch="${v.id}">再突合</button>
          <select class="matching-client-select" data-matching-reassign="${v.id}">
            ${clientOptions(v.clientId)}
          </select>
        </div>
        ${draftHtml}
      </div>`;
    })
    .join('');

  return `
    <section class="matching-results">
      <div class="voucher-tabs">${tabHtml}</div>
      <div class="matching-section">
        <h3 class="matching-section-header">✓ 突合済み (${matched.length} 件)</h3>
        ${matched.length === 0 ? '<p class="matching-empty">突合済みの証憑はありません。</p>' : matchedHtml}
      </div>
      <div class="matching-section">
        <h3 class="matching-section-header">⚠ 要対応 (${pending.length} 件)</h3>
        ${pending.length === 0 ? '<p class="matching-empty">対応が必要な証憑はありません。</p>' : pendingHtml}
      </div>
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Spec 15: Google Drive integration view
// -----------------------------------------------------------------------------
function renderIntegrationsDrive() {
  const integ = appState.driveIntegration;
  const folders = appState.driveFolders || [];
  const mappings = appState.driveMappings || [];
  const driveVouchers = appState.driveVouchers || [];

  // 未接続
  if (!integ || !integ.connected) {
    return `
      <section class="integrations-drive">
        <div class="integration-panel">
          <h3>Google Drive 連携</h3>
          <p class="muted">レシート画像を保存しているフォルダを連携すると、自動で証憑として取り込まれます。</p>
          <a class="primary-btn" href="/api/integrations/drive/oauth/authorize">Google アカウントで連携する</a>
        </div>
      </section>
    `;
  }

  const settings = integ.settings || {};
  const expires = integ.watchExpiresAt
    ? new Date(integ.watchExpiresAt).toLocaleString('ja-JP')
    : null;

  // Step 1: フォルダ設定
  const folderSettingsPanel = `
    <div class="integration-panel">
      <h3>フォルダ設定</h3>
      <p class="muted">レシートを保存している Google Drive フォルダの URL を貼り付けてください。</p>
      <div style="display:flex;gap:8px;align-items:flex-end;">
        <div style="flex:1;">
          <input type="text" id="driveRootFolderUrl"
            value="${escapeHtml(settings.rootFolderId || '')}"
            placeholder="https://drive.google.com/drive/folders/..."
            style="width:100%;padding:8px;font-size:13px;border:1px solid var(--line);border-radius:6px;" />
        </div>
        <button class="primary-btn" data-drive-action="save-settings">設定</button>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;font-size:12px;">
        <span class="muted">${escapeHtml(integ.email || '')} で接続中${expires ? ' · watch 期限: ' + escapeHtml(expires) : ''}</span>
        <button class="ghost-btn" style="font-size:11px;" data-drive-action="disconnect">連携解除</button>
      </div>
    </div>
  `;

  // Step 2: 顧問先の割り当て
  let mappingPanel = '';
  if (settings.rootFolderId) {
    const mappingByFolderId = Object.fromEntries(mappings.map(m => [m.driveFolderId, m]));

    const clientOptionsHtml = (selectedId) => {
      const head = `<option value="">— 顧問先を選択 —</option>`;
      const rest = (clients || []).map(c =>
        `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
      ).join('');
      return head + rest;
    };

    let mappingContent;
    if (folders.length === 0) {
      // サブフォルダなし → ルートフォルダ直接マッピング
      const existingRoot = mappingByFolderId[settings.rootFolderId];
      const assignedName = existingRoot
        ? escapeHtml((clients || []).find(c => c.id === existingRoot.clientId)?.name || existingRoot.clientId)
        : '';
      mappingContent = `
        <p class="muted" style="font-size:13px;margin-bottom:8px;">このフォルダ内の画像を取り込む顧問先を選択してください：</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <select id="driveRootClientSelect" style="flex:1;min-width:160px;padding:8px;border:1px solid var(--line);border-radius:6px;">
            ${clientOptionsHtml(existingRoot?.clientId)}
          </select>
          <button class="primary-btn" data-drive-action="map-root-folder">割り当てる</button>
          ${existingRoot ? `<button class="ghost-btn" data-drive-mapping-delete="${escapeHtml(existingRoot.id)}">解除</button>` : ''}
        </div>
        ${existingRoot ? `<p style="font-size:12px;color:var(--green);margin-top:8px;">✓ ${assignedName} に割り当て済み</p>` : ''}
      `;
    } else {
      const rows = folders.map(f => {
        const existing = mappingByFolderId[f.id];
        return `<tr>
          <td style="padding:8px 4px;">${escapeHtml(f.name)}</td>
          <td style="padding:8px 4px;">
            <select data-drive-mapping-select="${escapeHtml(f.id)}" data-drive-folder-name="${escapeHtml(f.name)}"
                    style="width:100%;padding:6px;border:1px solid var(--line);border-radius:4px;">
              ${clientOptionsHtml(existing?.clientId)}
            </select>
          </td>
          <td style="padding:8px 4px;white-space:nowrap;">
            <button class="primary-btn" style="font-size:12px;" data-drive-mapping-save="${escapeHtml(f.id)}">保存</button>
            ${existing ? `<button class="ghost-btn" style="font-size:12px;" data-drive-mapping-delete="${escapeHtml(existing.id)}">×</button>` : ''}
          </td>
        </tr>`;
      }).join('');
      const orphanRows = mappings
        .filter(m => !folders.find(f => f.id === m.driveFolderId))
        .map(m => `<tr>
          <td style="padding:8px 4px;">${escapeHtml(m.folderName)}<span class="muted"> (非表示)</span></td>
          <td style="padding:8px 4px;">${escapeHtml((clients||[]).find(c=>c.id===m.clientId)?.name||m.clientId)}</td>
          <td style="padding:8px 4px;"><button class="ghost-btn" style="font-size:12px;" data-drive-mapping-delete="${escapeHtml(m.id)}">×</button></td>
        </tr>`).join('');
      mappingContent = `
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr style="font-size:12px;color:var(--muted);">
            <th style="text-align:left;padding:4px;">フォルダ名</th>
            <th style="text-align:left;padding:4px;">顧問先</th>
            <th></th>
          </tr></thead>
          <tbody>${rows}${orphanRows}</tbody>
        </table>
      `;
    }

    mappingPanel = `
      <div class="integration-panel">
        <h3>顧問先の割り当て</h3>
        ${mappingContent}
      </div>
    `;
  }

  // Step 3: 同期ボタン（マッピングがある場合のみ）
  let syncPanel = '';
  if (mappings.length > 0) {
    syncPanel = `
      <div class="integration-panel">
        <h3>取り込み</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="primary-btn" data-drive-action="backfill">フォルダの画像をすべて取り込む</button>
          <button class="ghost-btn" data-drive-action="sync">新着のみ同期</button>
        </div>
        <p class="muted" style="font-size:11px;margin-top:6px;">初回は「すべて取り込む」を押してください。</p>
      </div>
    `;
  }

  // Step 4: フォルダ内ファイル一覧（取り込み状況付き）
  const driveFiles = appState.driveFiles || [];
  let vouchersPanel = '';
  if (mappings.length > 0) {
    const formatSize = (bytes) => {
      if (!bytes) return '';
      if (bytes > 1024*1024) return ` (${(bytes/1024/1024).toFixed(1)}MB)`;
      return ` (${(bytes/1024).toFixed(0)}KB)`;
    };

    if (driveFiles.length > 0) {
      const rows = driveFiles.map(f => {
        let statusBadge, actionCell = '';
        if (f.importStatus === 'imported' && f.voucherId) {
          // 取り込み済み：OCR・MFステータスをdriveVouchersから取得
          const v = driveVouchers.find(v => v.id === f.voucherId);
          const ocrBadge = !v ? '' :
            v.ocrStatus === 'done' ? '<span style="color:var(--green);font-size:11px;">OCR済</span>' :
            v.ocrStatus === 'failed' ? '<span style="color:var(--red);font-size:11px;">OCR失敗</span>' :
            '<span style="color:var(--amber);font-size:11px;">OCR中</span>';
          const mfBadge = !v ? '' :
            v.mfWriteStatus === 'done' ? '<span style="color:var(--green);font-size:11px;">MF済</span>' :
            v.mfWriteStatus === 'failed' ? `<span style="color:var(--red);font-size:11px;" title="${escapeHtml(v.mfWriteError||'')}">MF失敗</span>` :
            v.mfWriteStatus === 'writing' || v.mfWriteStatus === 'pending' ? '<span style="color:var(--amber);font-size:11px;">MF中</span>' : '';
          const canMfWrite = v && v.journalStatus && v.journalStatus !== 'none'
            && v.mfWriteStatus !== 'done' && v.mfWriteStatus !== 'writing' && v.mfWriteStatus !== 'pending';
          statusBadge = '<span style="color:var(--green);font-size:11px;">✓ 取込済</span>';
          actionCell = `${ocrBadge} ${mfBadge} ${canMfWrite ? `<button class="primary-btn" style="font-size:11px;padding:2px 6px;" data-voucher-mf-write="${escapeHtml(f.voucherId)}">MFに登録</button>` : ''}`;
        } else if (f.importStatus === 'skipped_size') {
          statusBadge = `<span style="color:var(--red);font-size:11px;" title="10MB超のため取り込めません">容量超過</span>`;
          actionCell = '<span class="muted" style="font-size:11px;">10MB以内に圧縮してください</span>';
        } else if (f.importStatus === 'skipped_type') {
          statusBadge = `<span style="color:var(--amber);font-size:11px;">非対応形式</span>`;
          actionCell = '<span class="muted" style="font-size:11px;">JPEG/PNG/GIF/WebP/PDF のみ対応</span>';
        } else {
          statusBadge = '<span style="color:var(--muted);font-size:11px;">未取込</span>';
          actionCell = '<span class="muted" style="font-size:11px;">「取り込む」を押してください</span>';
        }
        const fname = escapeHtml(f.filename || f.fileId);
        const isPdf = (f.mimeType || '').includes('pdf');
        const imgLink = f.importStatus === 'imported' && f.voucherId
          ? (isPdf
            ? `<a href="/api/vouchers/${escapeHtml(f.voucherId)}/image" target="_blank" style="color:var(--blue);" title="PDFを開く">📄 ${fname}</a>`
            : `<a href="/api/vouchers/${escapeHtml(f.voucherId)}/image" target="_blank" style="color:var(--blue);">${fname}</a>`)
          : fname;
        return `<tr style="border-bottom:1px solid var(--line);">
          <td style="padding:7px 4px;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(f.filename||'')}">${imgLink}<span class="muted">${escapeHtml(formatSize(f.size))}</span></td>
          <td style="padding:7px 4px;">${statusBadge}</td>
          <td style="padding:7px 4px;">${actionCell}</td>
        </tr>`;
      }).join('');

      vouchersPanel = `
        <div class="integration-panel">
          <h3>フォルダ内のファイル <span class="muted" style="font-weight:normal;font-size:12px;">${driveFiles.length}件</span>
            <button class="ghost-btn" style="font-size:11px;margin-left:8px;" data-drive-action="refresh-files">更新</button>
          </h3>
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="font-size:11px;color:var(--muted);border-bottom:1px solid var(--line);">
              <th style="text-align:left;padding:4px;">ファイル名</th>
              <th style="padding:4px;">状態</th>
              <th style="padding:4px;text-align:left;">アクション</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    } else {
      vouchersPanel = `
        <div class="integration-panel">
          <p class="muted" style="font-size:13px;">フォルダにファイルが見つかりません。</p>
          <button class="ghost-btn" style="font-size:12px;" data-drive-action="refresh-files">フォルダを確認する</button>
        </div>
      `;
    }
  }

  return `
    <section class="integrations-drive">
      ${folderSettingsPanel}
      ${mappingPanel}
      ${syncPanel}
      ${vouchersPanel}
    </section>
  `;
}

// -----------------------------------------------------------------------------
// Spec 16: LINE integration view
// -----------------------------------------------------------------------------
function renderIntegrationsLine() {
  const integ = appState.lineIntegration;
  const users = appState.lineUsers || [];
  const verify = appState.lineVerifyResult;

  const connected = !!(integ && integ.connected);
  const statusBadgeClass = connected ? 'ok' : 'warn';
  const statusText = connected ? 'connected' : 'not configured';
  const webhookUrl = integ?.webhookUrl || '';
  const channelId = integ?.channelId || '';

  let verifyHtml = '';
  if (verify) {
    if (verify.ok) {
      const botName =
        verify.botInfo?.displayName || verify.botInfo?.basicId || '';
      verifyHtml = `
        <p class="muted" style="margin-top:8px; font-size:12px;">
          <span class="integration-status-badge ok">疎通 OK</span>
          ${botName ? escapeHtml(botName) : ''}
        </p>
      `;
    } else {
      verifyHtml = `
        <p class="muted" style="margin-top:8px; font-size:12px;">
          <span class="integration-status-badge error">疎通 NG</span>
          ${escapeHtml(verify.message || '不明なエラー')}
        </p>
      `;
    }
  }

  const flowPanel = `
    <div class="setup-guide-banner">
      <strong>LINEを使った証憑送信の流れ</strong>
      <div class="flow-steps">
        <div class="flow-step"><span class="flow-step-no">1</span>下の「検証する」ボタンでBot設定を確認</div>
        <div class="flow-arrow">→</div>
        <div class="flow-step"><span class="flow-step-no">2</span>LINE公式アカウントにQRコードでアクセス</div>
        <div class="flow-arrow">→</div>
        <div class="flow-step"><span class="flow-step-no">3</span>顧問先のLINEユーザーを「有効化」する</div>
        <div class="flow-arrow">→</div>
        <div class="flow-step"><span class="flow-step-no">4</span>顧問先がLINEで領収書写真を送信</div>
        <div class="flow-arrow">→</div>
        <div class="flow-step"><span class="flow-step-no">5</span>自動でOCR → 仕訳ドラフト作成 → MFに送信</div>
      </div>
    </div>
  `;

  const connectionPanel = `
    <div class="integration-panel integration-line-connection">
      <h3>接続状態</h3>
      <p>
        <span class="integration-status-badge ${statusBadgeClass}">${statusText}</span>
      </p>
      <p class="muted" style="font-size:12px;">
        Channel ID: <code>${escapeHtml(channelId || '未設定')}</code>
      </p>
      <p class="muted" style="font-size:12px;">
        友だち: <strong>${integ?.userCount ?? 0}</strong> 人 / 有効: <strong>${integ?.enabledUserCount ?? 0}</strong> 人
      </p>
      <div style="margin-top:8px;">
        <label style="display:block; font-size:12px; margin-bottom:4px;">Webhook URL</label>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="text" id="lineWebhookUrl" readonly value="${escapeHtml(webhookUrl || '(LINE_WEBHOOK_BASE_URL を設定してください)')}"
                 style="flex:1; padding:6px 8px; font-family:monospace; font-size:11px;" />
          <button class="ghost-btn" data-line-action="copy-webhook">コピー</button>
        </div>
      </div>
      <div style="margin-top:12px;">
        <button class="primary-btn" data-line-action="verify"${connected ? '' : ' disabled'}>検証する</button>
      </div>
      ${verifyHtml}
      <details style="margin-top:12px;">
        <summary style="cursor:pointer; font-size:12px; color:#374151;">LINE Developers Console での設定手順</summary>
        <ol style="font-size:12px; color:#4b5563; padding-left:18px; margin-top:8px;">
          <li>LINE Developers Console で Messaging API チャネルを作成し、Channel ID / secret / access token を取得</li>
          <li>取得した値を <code>.env</code> の <code>LINE_CHANNEL_ID</code> / <code>LINE_CHANNEL_SECRET</code> / <code>LINE_CHANNEL_ACCESS_TOKEN</code> に設定</li>
          <li>このページの Webhook URL を console の Webhook URL に貼り付けて検証</li>
          <li>「Webhook 送信」を ON、「応答メッセージ」を OFF にする</li>
        </ol>
      </details>
    </div>
  `;

  let usersPanel;
  if (users.length === 0) {
    usersPanel = `
      <div class="integration-panel line-user-mappings">
        <h3>LINE ユーザ</h3>
        <p class="muted">友だち追加されると自動で行が追加されます（最初は無効状態）。</p>
      </div>
    `;
  } else {
    const rows = users
      .map(
        (u) => `
          <tr>
            <td>
              ${escapeHtml(u.displayName || '(no name)')}
              <div class="muted" style="font-size:10px;">${escapeHtml(u.lineUserId || '')}</div>
            </td>
            <td>
              <input type="text" value="${escapeHtml(u.staffLabel || '')}"
                     data-line-user-staff-label="${escapeHtml(u.id)}"
                     placeholder="スタッフ名"
                     style="width:120px; padding:4px 6px; font-size:12px;" />
            </td>
            <td>
              ${
                u.enabled
                  ? `<button class="row-action" data-action="line-disable-user" data-user-id="${escapeHtml(u.id)}">無効にする</button>`
                  : `<button class="primary-action compact" data-action="line-enable-user" data-user-id="${escapeHtml(u.id)}">有効にする</button>`
              }
            </td>
            <td><button class="ghost-btn" data-line-user-delete="${escapeHtml(u.id)}">削除</button></td>
          </tr>
        `,
      )
      .join('');
    usersPanel = `
      <div class="integration-panel line-user-mappings">
        <h3>LINE ユーザ (${users.length} 人)</h3>
        <p class="muted">スタッフ名を編集し、有効にすると画像送信が受け付けられます。</p>
        <table class="line-users-table">
          <thead>
            <tr><th>表示名</th><th>スタッフ名</th><th>有効</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  return `
    <section class="integrations-line">
      ${flowPanel}
      ${connectionPanel}
      ${usersPanel}
    </section>
  `;
}

// ─────────────────────────────────────────────
// Training view state
// ─────────────────────────────────────────────
const trainingState = {
  cards: [],          // TrainingCard[]
  currentIdx: 0,
  showAnswer: false,
  loading: false,
  stats: null,
};

function renderTraining() {
  const s = trainingState;
  const stats = s.stats;
  const statsHtml = stats
    ? `<div class="training-stats-row">
        <div class="training-stat"><span class="training-stat-num">${stats.ruleCount}</span><span>学習ルール</span></div>
        <div class="training-stat"><span class="training-stat-num">${stats.correctionCount}</span><span>AI補正実績</span></div>
        <div class="training-stat"><span class="training-stat-num">${stats.cardCount}</span><span>生成可能カード数</span></div>
      </div>`
    : '<p class="training-loading">データを読み込み中…</p>';

  if (s.loading) {
    return `<section class="training-view"><div class="training-header">
      <p class="eyebrow">新人研修</p><h2>研修カード練習</h2></div>
      <div class="training-generating"><div class="spinner"></div><p>研修カードを生成中…</p></div></section>`;
  }

  if (s.cards.length === 0) {
    return `<section class="training-view">
      <div class="training-header">
        <div><p class="eyebrow">新人研修</p><h2>研修カード練習</h2></div>
      </div>
      <div class="training-intro">
        <p>事務所のルール・AIによる補正実績から、<strong>新人向け仕訳練習カード</strong>を自動生成します。<br>問題形式で答えを確認しながら、実務パターンを効率よく習得できます。</p>
        ${statsHtml}
        <div class="training-actions">
          <button class="primary-action" id="trainingGenBtn" ${!stats ? 'disabled' : ''}>
            研修カードを生成する
          </button>
          <button class="training-ai-btn" id="trainingGenAiBtn" ${!stats ? 'disabled' : ''} title="OpenAI APIキーが必要です">
            ✨ AIで問題を強化して生成
          </button>
        </div>
        <p class="training-note">事務所のデータがベースなので、汎用テキストより実務に直結した問題が作れます。</p>
      </div>
    </section>`;
  }

  const card = s.cards[s.currentIdx];
  const total = s.cards.length;
  const progress = Math.round(((s.currentIdx + 1) / total) * 100);
  const diffLabel = card.difficulty === 'hard' ? '難' : card.difficulty === 'medium' ? '中' : '易';
  const diffClass = card.difficulty === 'hard' ? 'diff-hard' : card.difficulty === 'medium' ? 'diff-medium' : 'diff-easy';
  const typeLabel = card.type === 'rule' ? 'ルール確認' : card.type === 'correction' ? 'AI補正実例' : '業種知識';

  return `<section class="training-view">
    <div class="training-header">
      <div><p class="eyebrow">新人研修</p><h2>研修カード練習</h2></div>
      <button class="training-reset-btn" id="trainingResetBtn">最初からやり直す</button>
    </div>
    <div class="training-progress-bar"><div class="training-progress-fill" style="width:${progress}%"></div></div>
    <p class="training-progress-label">${s.currentIdx + 1} / ${total} 問</p>

    <div class="training-card ${s.showAnswer ? 'flipped' : ''}">
      <div class="training-card-inner">
        <div class="training-card-front">
          <div class="training-card-meta">
            <span class="training-type-badge">${typeLabel}</span>
            <span class="training-diff-badge ${diffClass}">${diffLabel}</span>
            ${card.clientName ? `<span class="training-client-badge">${escapeHtml(card.clientName)}</span>` : ''}
          </div>
          <div class="training-question">${escapeHtml(card.question).replace(/\n/g, '<br>')}</div>
          <button class="primary-action training-flip-btn" id="trainingFlipBtn">答えを見る</button>
        </div>
        <div class="training-card-back">
          <p class="training-answer-label">答え</p>
          <div class="training-answer">${escapeHtml(card.answer).replace(/\n/g, '<br>')}</div>
          ${card.hint ? `<div class="training-hint">💡 ${escapeHtml(card.hint)}</div>` : ''}
          <div class="training-nav">
            <button class="training-prev-btn" id="trainingPrevBtn" ${s.currentIdx === 0 ? 'disabled' : ''}>← 前へ</button>
            <button class="primary-action training-next-btn" id="trainingNextBtn">
              ${s.currentIdx === total - 1 ? '完了 🎉' : '次の問題 →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

async function loadTrainingStats() {
  try {
    const res = await apiFetch('/api/training/stats');
    if (res.ok) {
      trainingState.stats = await res.json();
    }
  } catch (e) {
    console.warn('training stats failed', e);
  }
}

async function generateTrainingCards(useAI) {
  trainingState.loading = true;
  trainingState.cards = [];
  trainingState.currentIdx = 0;
  trainingState.showAnswer = false;
  render();
  try {
    const res = await apiFetch('/api/training/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ useAI: !!useAI, limit: 20 }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    trainingState.cards = body.cards || [];
    if (trainingState.cards.length === 0) {
      showToast('ルール・補正データがまだありません。仕訳を使い込んでから試してください。', 'info');
    }
  } catch (err) {
    showToast('生成に失敗しました: ' + String(err), 'error');
  } finally {
    trainingState.loading = false;
    render();
  }
}

function renderGuide() {
  return `
    <div class="guide-page">
      <div class="guide-header">
        <h1>使い方ガイド</h1>
        <p>経理丸ごとAIの基本的な使い方をご案内します</p>
      </div>

      <section class="guide-section">
        <h2>はじめてお使いの方へ</h2>
        <div class="guide-steps">
          <div class="guide-step">
            <div class="step-number">1</div>
            <div class="step-content">
              <strong>顧問先を選択</strong>
              <p>左上の顧問先チップをクリックして、作業対象の顧問先を選びます</p>
            </div>
          </div>
          <div class="guide-step">
            <div class="step-number">2</div>
            <div class="step-content">
              <strong>MoneyForwardと連携</strong>
              <p>「設定」からMoneyForward会計にOAuth連携します。仕訳の取得・送信に必要です</p>
              <button class="btn-sm btn-secondary" onclick="location.hash='#/settings'">設定を開く →</button>
            </div>
          </div>
          <div class="guide-step">
            <div class="step-number">3</div>
            <div class="step-content">
              <strong>LINEボットを設定（任意）</strong>
              <p>「LINE」設定からBotを有効化すると、顧問先がLINEで領収書を送れるようになります</p>
              <button class="btn-sm btn-secondary" onclick="location.hash='#/integrations-line'">LINE設定を開く →</button>
            </div>
          </div>
          <div class="guide-step">
            <div class="step-number">4</div>
            <div class="step-content">
              <strong>月次業務スタート</strong>
              <p>ToDoダッシュボードから今月やることを確認して業務を開始します</p>
              <button class="btn-sm btn-primary" onclick="location.hash='#/dashboard'">ダッシュボードへ →</button>
            </div>
          </div>
        </div>
      </section>

      <section class="guide-section">
        <h2>毎月の業務フロー</h2>
        <div class="guide-flow">
          <div class="flow-item" onclick="location.hash='#/dashboard'" style="cursor:pointer">
            <div class="flow-icon">📋</div>
            <div class="flow-label">ToDo確認</div>
            <div class="flow-desc">今月のタスクを確認</div>
          </div>
          <div class="flow-arrow">→</div>
          <div class="flow-item" onclick="location.hash='#/mf-review'" style="cursor:pointer">
            <div class="flow-icon">🤖</div>
            <div class="flow-label">AI摘要レビュー</div>
            <div class="flow-desc">空摘要をAIが自動補完</div>
          </div>
          <div class="flow-arrow">→</div>
          <div class="flow-item" onclick="location.hash='#/vouchers-register'" style="cursor:pointer">
            <div class="flow-icon">📄</div>
            <div class="flow-label">証憑登録</div>
            <div class="flow-desc">領収書・請求書をアップロード</div>
          </div>
          <div class="flow-arrow">→</div>
          <div class="flow-item" onclick="location.hash='#/matching-results'" style="cursor:pointer">
            <div class="flow-icon">🔍</div>
            <div class="flow-label">突合確認</div>
            <div class="flow-desc">仕訳と証憑を照合</div>
          </div>
          <div class="flow-arrow">→</div>
          <div class="flow-item" onclick="location.hash='#/jobs-journal'" style="cursor:pointer">
            <div class="flow-icon">📤</div>
            <div class="flow-label">CSV出力</div>
            <div class="flow-desc">弥生会計などへエクスポート</div>
          </div>
        </div>
      </section>

      <section class="guide-section">
        <h2>各機能の説明</h2>
        <div class="guide-cards">
          <div class="guide-card" onclick="location.hash='#/dashboard'">
            <div class="guide-card-icon">📋</div>
            <div class="guide-card-title">ToDoダッシュボード</div>
            <div class="guide-card-desc">今月やること一覧。AI摘要レビュー待ち・証憑不足・手動タスクを一画面で管理</div>
          </div>
          <div class="guide-card" onclick="location.hash='#/jobs-journal'">
            <div class="guide-card-icon">📒</div>
            <div class="guide-card-title">仕訳</div>
            <div class="guide-card-desc">MFから仕訳を取得して一覧表示。CSVで弥生会計などにエクスポートできます</div>
          </div>
          <div class="guide-card" onclick="location.hash='#/mf-review'">
            <div class="guide-card-icon">🤖</div>
            <div class="guide-card-title">AI摘要レビュー</div>
            <div class="guide-card-desc">摘要が空白の仕訳をAIが自動で補完。確認して承認するとMFに反映されます</div>
          </div>
          <div class="guide-card" onclick="location.hash='#/jobs-vouchers'">
            <div class="guide-card-icon">🧾</div>
            <div class="guide-card-title">証憑</div>
            <div class="guide-card-desc">領収書・請求書の一覧と仕訳との突合状況を確認</div>
          </div>
          <div class="guide-card" onclick="location.hash='#/integrations-line'">
            <div class="guide-card-icon">💬</div>
            <div class="guide-card-title">LINE連携</div>
            <div class="guide-card-desc">顧問先がLINEで領収書を送ると自動でOCR→仕訳ドラフトを作成</div>
          </div>
          <div class="guide-card" onclick="location.hash='#/integrations-drive'">
            <div class="guide-card-icon">📁</div>
            <div class="guide-card-title">Google Drive連携</div>
            <div class="guide-card-desc">スキャナーで取り込んだPDFをDriveから自動インポート</div>
          </div>
        </div>
      </section>

      <section class="guide-section">
        <h2>キーボードショートカット</h2>
        <div class="guide-shortcuts">
          <div class="shortcut-row">
            <kbd>?</kbd>
            <span>ヘルプモーダルを開く</span>
          </div>
          <div class="shortcut-row">
            <kbd>Esc</kbd>
            <span>開いているモーダルを閉じる</span>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderView() {
  const client = currentClient();
  // ToDo は role 切替で 税理士=所長確認待ち / スタッフ=作業中+差戻し が並ぶ。
  // 月次業務 は 仕訳 / 証憑 / 月次チェック の 3 サブビューに展開する。
  const views = {
    dashboard: () => renderDashboard(),            // 今日 > ToDo
    company: () => renderCompany(),                // 業務 > 顧問先
    crm: () => renderCrm(),                         // 業務 > 顧問先CRM
    "jobs-journal": () => renderJobsJournal(),     // 業務 > 月次業務 > 仕訳
    "jobs-vouchers": () => renderJobsVouchers(),   // 業務 > 月次業務 > 証憑
    "jobs-monthly-check": () => renderJobsMonthlyCheck(), // 業務 > 月次業務 > 月次チェック
    "vouchers-register": () => renderVoucherRegister(),
    "matching-results": () => renderMatchingResults(),
    portal: () => renderPortal(),                  // 業務 > メッセージ
    "integrations-drive": () => renderIntegrationsDrive(),
    "integrations-line": () => renderIntegrationsLine(),
    "mf-review": () => renderMfReview(),           // 業務 > 月次業務 > 摘要レビュー
    rules: () => renderRules(),                    // 学習・設定 > 学習
    "rag-db": () => '<div class="boot-loading"><div class="spinner"></div><p>読み込み中…</p></div>',
    training: () => renderTraining(),              // 学習・設定 > 新人研修
    settings: () => renderSettings(),              // 学習・設定 > 設定
    guide: () => renderGuide(),                    // サポート > 使い方
    "tax-suggestions": () => renderTaxSuggestions(), // コンサル > 節税提案
    cashflow: () => renderCashflow(),              // コンサル > CF予測
    "client-portal": () => renderClientPortal(),   // コンサル > 顧問先ポータル
    "fixed-assets": () => renderFixedAssets(),     // 会計分析 > 固定資産台帳
    accruals: () => renderAccruals(),              // 会計分析 > 期間配分チェック
    "ar-matching": () => renderArMatching(),       // 会計分析 > 売上突合
    "bank-statement": () => renderBankStatement(), // 会計分析 > 銀行明細
  };
  const renderer = views[appState.activeView] ?? views.dashboard;
  document.title = viewDocumentTitles[appState.activeView] || "経理丸ごとAI";
  viewContent.innerHTML = renderer();
  // Spec 01 F2: progress filter tab handlers
  viewContent.querySelectorAll("[data-progress-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.progressFilter = button.dataset.progressFilter;
      render();
    });
  });
  // 仕訳ビューの実現/未実現フィルタ
  viewContent.querySelectorAll("[data-journal-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.journalRealizedFilter = button.dataset.journalFilter;
      renderView();
    });
  });
  // 顧問先ビュー: サブタブ切替
  viewContent.querySelectorAll("[data-company-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.companyTab = button.dataset.companyTab;
      // 元帳ピッカーの選択はタブを変えたらリセット
      if (appState.companyTab !== "general-ledger") appState.companyAccountId = "";
      if (appState.companyTab !== "sub-ledger") appState.companySubAccountId = "";
      renderView();
    });
  });
  if (appState.activeView === "company") {
    loadAndRenderCompanyTab();
  }
  if (appState.activeView === "crm") {
    const addClientBtn = viewContent.querySelector('[data-action="crm-add-client"]');
    if (addClientBtn) {
      addClientBtn.addEventListener("click", () => {
        appState.activeView = "settings";
        location.hash = "#/settings";
        setTimeout(() => {
          const btn = document.querySelector('[data-action="settings-add-client"]');
          if (!btn) return;
          btn.click();
          document.getElementById("clientMgmtForm")?.scrollIntoView({ behavior: "smooth" });
        }, 300);
      });
    }
    const searchInput = viewContent.querySelector("#crmSearchInput");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        appState.crmSearch = searchInput.value;
        const cursor = searchInput.selectionStart;
        renderView();
        const nextInput = viewContent.querySelector("#crmSearchInput");
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(cursor, cursor);
        }
      });
    }
    viewContent.querySelectorAll("[data-crm-status-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        appState.crmStatusFilter = button.dataset.crmStatusFilter;
        renderView();
      });
    });
    viewContent.querySelectorAll("[data-crm-client-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const index = appState.clients.findIndex((item) => item.id === card.dataset.crmClientId);
        if (index < 0) return;
        appState.activeClient = index;
        updateClientContextBar();
        location.hash = "#/company";
      });
    });
  }
  // Spec 03 F2: portal channel tab handlers + initial threads load
  viewContent.querySelectorAll("[data-portal-channel]").forEach((button) => {
    button.addEventListener("click", () => {
      appState.portalChannel = button.dataset.portalChannel;
      renderView();
    });
  });
  if (appState.activeView === "portal") {
    // Guard against re-fetch loops when the view re-renders for unrelated
    // reasons (channel tab click, search input). Use the cached list if the
    // active client hasn't changed; otherwise pull a fresh timeline.
    const client = currentClient();
    if (client?.id) {
      const useCache = appState.threadsLoadedClient === client.id;
      loadAndRenderThreads({ useCache });
    }
  }
  if (appState.activeView === "rules") {
    loadAndRenderRules();
  }
  if (appState.activeView === "rag-db") {
    loadAndRenderRagDb();
  }
  if (appState.activeView === "training") {
    // Load stats if not yet loaded
    if (!trainingState.stats) {
      loadTrainingStats().then(() => render());
    }
    // Bind generate buttons
    const genBtn = viewContent.querySelector('#trainingGenBtn');
    const genAiBtn = viewContent.querySelector('#trainingGenAiBtn');
    const flipBtn = viewContent.querySelector('#trainingFlipBtn');
    const nextBtn = viewContent.querySelector('#trainingNextBtn');
    const prevBtn = viewContent.querySelector('#trainingPrevBtn');
    const resetBtn = viewContent.querySelector('#trainingResetBtn');

    if (genBtn) genBtn.addEventListener('click', () => generateTrainingCards(false));
    if (genAiBtn) genAiBtn.addEventListener('click', () => generateTrainingCards(true));
    if (flipBtn) flipBtn.addEventListener('click', () => {
      trainingState.showAnswer = true;
      render();
    });
    if (nextBtn) nextBtn.addEventListener('click', () => {
      if (trainingState.currentIdx >= trainingState.cards.length - 1) {
        showToast('全問完了！お疲れさまでした 🎉', 'success');
        trainingState.cards = [];
        trainingState.currentIdx = 0;
      } else {
        trainingState.currentIdx++;
        trainingState.showAnswer = false;
      }
      render();
    });
    if (prevBtn) prevBtn.addEventListener('click', () => {
      if (trainingState.currentIdx > 0) {
        trainingState.currentIdx--;
        trainingState.showAnswer = false;
        render();
      }
    });
    if (resetBtn) resetBtn.addEventListener('click', () => {
      trainingState.cards = [];
      trainingState.currentIdx = 0;
      trainingState.showAnswer = false;
      render();
    });
  }
  if (appState.activeView === "tax-suggestions") {
    const c = currentClient();
    if (c?.id) loadAndRenderTaxSuggestions(c.id);
  }
  if (appState.activeView === "cashflow") {
    const c = currentClient();
    if (c?.id) loadAndRenderCashflow(c.id);
  }
  if (appState.activeView === "client-portal") {
    const c = currentClient();
    if (c?.id) loadAndRenderClientPortal(c.id);
  }
  if (appState.activeView === "fixed-assets") {
    const c = currentClient();
    if (c?.id) loadAndRenderFixedAssets(c.id);
  }
  if (appState.activeView === "accruals") {
    const c = currentClient();
    if (c?.id) loadAndRenderAccruals(c.id);
  }
  if (appState.activeView === "ar-matching") {
    const c = currentClient();
    if (c?.id) loadAndRenderArMatching(c.id);
  }
  if (appState.activeView === "bank-statement") {
    initBankStatementUpload();
  }
  if (appState.activeView === "jobs-journal") {
    const c = currentClient();
    if (c?.id) loadApprovedDraftsIntoSlot(c.id);
  }
  if (appState.activeView === "jobs-vouchers") {
    loadAndRenderMissing();
    loadAndRenderJobsVouchers();
  }
  if (
    appState.activeView === "jobs-journal" ||
    appState.activeView === "jobs-vouchers"
  ) {
    const exportBtn = viewContent.querySelector('#exportCsvBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportVouchersCsv);
  }
  if (appState.activeView === "dashboard") {
    loadAndRenderYearend();
    const c = currentClient();
    if (c?.id) loadAndRenderDashboard(c.id);
    const addButton = viewContent.querySelector('[data-action="todo-add"]');
    const titleInput = viewContent.querySelector("#todoTitleInput");
    const noteInput = viewContent.querySelector("#todoNoteInput");
    const submitTodo = () => {
      const client = currentClient();
      if (!client?.id || !addButton) return;
      const title = (titleInput?.value || "").trim();
      const note = (noteInput?.value || "").trim();
      if (!title) {
        showToast("タイトルを入力してください", "error");
        return;
      }
      setButtonPending(addButton, true, "処理中...");
      addTodo(client.id, title, note)
        .then(() => {
          if (titleInput) titleInput.value = "";
          if (noteInput) noteInput.value = "";
          showToast("ToDoを追加しました", "success");
          return loadAndRenderDashboard(client.id);
        })
        .catch(() => {})
        .finally(() => {
          setButtonPending(addButton, false);
        });
    };
    if (addButton) {
      addButton.addEventListener("click", submitTodo);
    }
    [titleInput, noteInput].forEach((input) => {
      if (!input) return;
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submitTodo();
      });
    });

    // 不明出金照会フォームのイベント
    const withdrawalAddBtn = viewContent.querySelector('#withdrawalAddEntry');
    const withdrawalSendBtn = viewContent.querySelector('#withdrawalSendInquiry');
    const withdrawalEntries = viewContent.querySelector('#withdrawalEntries');

    if (withdrawalAddBtn && withdrawalEntries) {
      withdrawalAddBtn.addEventListener('click', () => {
        const entry = document.createElement('div');
        entry.className = 'withdrawal-entry';
        entry.innerHTML = `
          <input type="date" class="withdrawal-date" placeholder="日付" />
          <input type="number" class="withdrawal-amount" placeholder="金額（円）" min="1" />
          <input type="text" class="withdrawal-desc" placeholder="明細の摘要（例: 現金引出）" />
          <button class="withdrawal-remove-btn" title="削除">×</button>
        `;
        entry.querySelector('.withdrawal-remove-btn').addEventListener('click', () => entry.remove());
        withdrawalEntries.appendChild(entry);
      });
      // 最初の行の削除ボタン
      withdrawalEntries.querySelector('.withdrawal-remove-btn')?.addEventListener('click', function() {
        if (withdrawalEntries.querySelectorAll('.withdrawal-entry').length > 1) this.closest('.withdrawal-entry').remove();
      });
    }

    if (withdrawalSendBtn) {
      withdrawalSendBtn.addEventListener('click', async () => {
        const client = currentClient();
        if (!client?.id) { showToast('顧問先を選択してください', 'error'); return; }
        const rows = Array.from(viewContent.querySelectorAll('.withdrawal-entry')).map(row => ({
          date: row.querySelector('.withdrawal-date')?.value || '',
          amount: parseInt(row.querySelector('.withdrawal-amount')?.value || '0', 10) || 0,
          description: row.querySelector('.withdrawal-desc')?.value || '',
        })).filter(r => r.date && r.amount > 0);
        if (rows.length === 0) { showToast('日付と金額を入力してください', 'error'); return; }
        const resultEl = viewContent.querySelector('#withdrawalResult');
        setButtonPending(withdrawalSendBtn, true, '送信中...');
        try {
          const res = await apiFetch(`/api/clients/${encodeURIComponent(client.id)}/inquire-withdrawals`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entries: rows }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error?.message || '送信失敗');
          if (resultEl) {
            resultEl.hidden = false;
            resultEl.innerHTML = '<div class="withdrawal-sent"><strong>照会メッセージを送信しました</strong><pre class="withdrawal-preview">' + escapeHtml(body.body || '') + '</pre></div>';
          }
          showToast('照会メッセージを送信しました', 'success');
        } catch (err) {
          showToast(friendlyError(err), 'error');
        } finally {
          setButtonPending(withdrawalSendBtn, false, '照会メッセージを送信');
        }
      });
    }
  }
  if (appState.activeView === "mf-review") {
    const c = currentClient();
    if (c?.id) loadAndRenderMfReview(c.id);
  }
  if (appState.activeView === "vouchers-register") {
    if (appState.vouchersLoadedTab !== appState.voucherTab) {
      loadVouchers();
    }
    const ccInput = viewContent.querySelector("#ccCsvInput");
    const ccBtn = viewContent.querySelector("#ccCsvUploadBtn");
    const ccFilename = viewContent.querySelector("#ccCsvFilename");
    const ccResult = viewContent.querySelector("#ccCsvResult");
    if (ccInput && ccBtn && ccFilename && ccResult) {
      ccInput.addEventListener("change", () => {
        const file = ccInput.files && ccInput.files[0];
        ccFilename.textContent = file ? file.name : "";
        ccBtn.disabled = !file || !currentClient()?.id;
      });
      ccBtn.addEventListener("click", async () => {
        const file = ccInput.files && ccInput.files[0];
        if (!file) return;
        const client = currentClient();
        if (!client?.id) {
          showToast("顧問先を選択してください", "error");
          return;
        }

        setButtonPending(ccBtn, true, "処理中...");
        ccResult.innerHTML = "";
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await apiFetch(
            "/api/clients/" + encodeURIComponent(client.id) + "/cc-statement-import",
            { method: "POST", body: formData },
          );
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(body.error?.message || "HTTP " + res.status);
          }

          const total = Number(body.total) || 0;
          const created = Number(body.created) || 0;
          const skipped = Number(body.skipped) || 0;
          const errors = Array.isArray(body.errors) ? body.errors : [];
          let message = '<div class="cc-result-box">';
          message += '<p class="cc-result-success">✓ ' + created + '件の証憑を登録しました（全' + total + '行）</p>';
          if (skipped > 0) {
            message += '<p class="cc-result-warn">スキップ: ' + skipped + '件</p>';
          }
          if (errors.length > 0) {
            message += '<ul class="cc-result-errors">' +
              errors.slice(0, 5).map((error) => '<li>' + escapeHtml(String(error)) + '</li>').join('') +
              '</ul>';
          }
          message += '</div>';
          ccResult.innerHTML = message;
          showToast(created + "件の証憑を登録しました", "success");
          appState.vouchersLoadedTab = null;
          await loadVouchers();
        } catch (err) {
          ccResult.innerHTML = '<p class="cc-result-error">' + escapeHtml(String(err)) + '</p>';
          showToast("インポートに失敗しました", "error");
        } finally {
          setButtonPending(ccBtn, false, "アップロード");
          ccBtn.disabled = true;
          ccInput.value = "";
          ccFilename.textContent = "";
        }
      });
    }
    // 弥生CSVダウンロードボタン
    const yayoiBtn = viewContent.querySelector('#yayoiExportBtn');
    if (yayoiBtn) {
      yayoiBtn.addEventListener('click', async () => {
        const clientId = currentClient()?.id;
        if (!clientId) { showToast('顧問先を選択してください', 'error'); return; }
        const fromDate = viewContent.querySelector('#yayoiFromDate')?.value || '';
        const toDate = viewContent.querySelector('#yayoiToDate')?.value || '';
        let url = `/api/clients/${encodeURIComponent(clientId)}/vouchers/export-csv?format=yayoi&status=all`;
        if (fromDate) url += `&from=${encodeURIComponent(fromDate)}`;
        if (toDate) url += `&to=${encodeURIComponent(toDate)}`;
        try {
          setButtonPending(yayoiBtn, true, '出力中...');
          const res = await apiFetch(url);
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body?.error?.message || 'csv export failed');
          }
          const blob = await res.blob();
          const disposition = res.headers.get('content-disposition');
          const filename = filenameFromDisposition(disposition) || `yayoi-journals-${new Date().toISOString().slice(0, 10)}.csv`;
          const dlUrl = URL.createObjectURL(blob);
          try {
            const a = document.createElement('a');
            a.href = dlUrl; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
          } finally { URL.revokeObjectURL(dlUrl); }
          showToast('弥生CSVをダウンロードしました', 'success');
        } catch (err) {
          showToast(friendlyError(err), 'error');
        } finally {
          setButtonPending(yayoiBtn, false, '弥生CSVをダウンロード');
        }
      });
    }

    const dropzone = document.querySelector('#voucherDropzone');
    const fileInput = document.querySelector('#voucherFileInput');
    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length > 0) uploadVouchers(files);
      });
    }
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        if (files.length > 0) uploadVouchers(files);
        fileInput.value = '';
      });
    }
    viewContent.querySelectorAll('[data-voucher-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.voucherTab = btn.dataset.voucherTab;
        appState.vouchersLoadedTab = null;
        loadVouchers();
      });
    });
    viewContent.querySelectorAll('[data-voucher-assign]').forEach((sel) => {
      sel.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      sel.addEventListener('change', async () => {
        const voucherId = sel.dataset.voucherAssign;
        const clientId = sel.value || null;
        if (!clientId) return;
        sel.disabled = true;
        try {
          const res = await apiFetch(`/api/vouchers/${voucherId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId }),
          });
          if (!res.ok) throw new Error('assign failed');
          showToast('顧問先を割り当てました');
          appState.vouchersLoadedTab = null;
          await loadVouchers();
        } catch (err) {
          showToast(friendlyError(err));
          sel.disabled = false;
        }
      });
    });
    viewContent.querySelectorAll('[data-voucher-delete]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteVoucherById(btn.dataset.voucherDelete);
      });
    });
    viewContent.querySelectorAll('[data-voucher-retry-ocr]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.voucherRetryOcr;
        try {
          const res = await apiFetch(`/api/vouchers/${id}/ocr`, { method: 'POST' });
          if (!res.ok) throw new Error('retry failed');
          appState.vouchersLoadedTab = null;
          await loadVouchers();
        } catch (err) {
          showToast(friendlyError(err));
        }
      });
    });
    viewContent.querySelectorAll('[data-voucher-rematch]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.voucherRematch;
        try {
          const res = await apiFetch(`/api/vouchers/${id}/match`, { method: 'POST' });
          if (!res.ok) throw new Error('rematch failed');
          appState.vouchersLoadedTab = null;
          setTimeout(() => loadVouchers(), 800);
        } catch (err) {
          showToast(friendlyError(err));
        }
      });
    });
    viewContent.querySelectorAll('[data-voucher-mfwrite]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        writeMfJournal(btn.dataset.voucherMfwrite);
      });
    });
    viewContent.querySelectorAll('[data-voucher-mfretry]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        retryMfWrite(btn.dataset.voucherClientId, btn.dataset.voucherMfretry);
      });
    });
    viewContent.querySelectorAll('.voucher-card').forEach((card) => {
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', card.dataset.voucherId);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
      });
    });
    viewContent.querySelectorAll('.voucher-tab').forEach((tab) => {
      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        tab.classList.add('drop-target');
      });
      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drop-target');
      });
      tab.addEventListener('drop', async (e) => {
        e.preventDefault();
        tab.classList.remove('drop-target');
        const voucherId = e.dataTransfer.getData('text/plain');
        if (!voucherId) return;
        const targetTab = tab.dataset.voucherTab;
        const newClientId = targetTab === 'unassigned' ? null : targetTab;
        try {
          const res = await apiFetch(`/api/vouchers/${voucherId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: newClientId }),
          });
          if (!res.ok) throw new Error('reassign failed');
          appState.vouchersLoadedTab = null;
          await loadVouchers();
        } catch (err) {
          showToast(friendlyError(err));
        }
      });
    });
    viewContent.querySelectorAll('[data-voucher-id]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (
          e.target.closest('[data-voucher-delete]') ||
          e.target.closest('[data-voucher-mfwrite]') ||
          e.target.closest('[data-voucher-mfretry]') ||
          e.target.closest('summary')
        ) return;
        const id = card.dataset.voucherId;
        openVoucherPreview(id, card.dataset.mimeType);
      });
    });
    const closeBtn = document.querySelector('#voucherModalClose');
    const backdrop = document.querySelector('.voucher-modal-backdrop');
    const closeModal = () => {
      const m = document.querySelector('#voucherModal');
      if (m) m.hidden = true;
    };
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (backdrop) backdrop.addEventListener('click', closeModal);
    hydrateVoucherImages();

    if (appState.voucherPollTimer) {
      clearInterval(appState.voucherPollTimer);
      appState.voucherPollTimer = null;
    }
    const hasPending = (appState.vouchers || []).some(
      (v) =>
        v.ocrStatus === 'pending' ||
        v.ocrStatus === 'processing' ||
        (v.ocrStatus === 'done' && !v.matchedAt),
    );
    if (hasPending) {
      appState.voucherPollTimer = setInterval(() => {
        if (appState.activeView !== 'vouchers-register') {
          clearInterval(appState.voucherPollTimer);
          appState.voucherPollTimer = null;
          return;
        }
        appState.vouchersLoadedTab = null;
        loadVouchers();
      }, 5000);
    }
  }
  if (appState.activeView === "matching-results") {
    if (appState.matchingLoadedTab !== appState.matchingTab) {
      loadMatchingData();
    }
    viewContent.querySelectorAll('[data-matching-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        appState.matchingTab = btn.dataset.matchingTab;
        appState.matchingLoadedTab = null;
        loadMatchingData();
      });
    });
    viewContent.querySelectorAll('[data-matching-rematch]').forEach((btn) => {
      btn.addEventListener('click', () => {
        rematchVoucher(btn.dataset.matchingRematch);
      });
    });
    viewContent.querySelectorAll('[data-matching-reassign]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const id = sel.dataset.matchingReassign;
        const newClientId = sel.value || null;
        reassignVoucherClient(id, newClientId);
      });
    });
    viewContent.querySelectorAll('[data-matching-redraft]').forEach((btn) => {
      btn.addEventListener('click', () => {
        redraftVoucherJournal(btn.dataset.matchingRedraft);
      });
    });
    viewContent.querySelectorAll('[data-matching-inquire]').forEach((btn) => {
      btn.addEventListener('click', () => {
        inquireVoucherClient(btn.dataset.matchingInquire);
      });
    });
    viewContent.querySelectorAll('[data-voucher-reply]').forEach((btn) => {
      btn.addEventListener('click', () => {
        submitVoucherReply(btn.dataset.voucherReply, btn);
      });
    });
    viewContent.querySelectorAll('[data-matching-approve]').forEach((btn) => {
      btn.addEventListener('click', () => {
        approveVoucherJournal(btn.dataset.matchingApprove);
      });
    });
    viewContent.querySelectorAll('[data-matching-mfwrite]').forEach((btn) => {
      btn.addEventListener('click', () => {
        writeMfJournal(btn.dataset.matchingMfwrite);
      });
    });
    viewContent.querySelectorAll('[data-matching-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const text = decodeDataToken(btn.dataset.copyText);
        navigator.clipboard.writeText(text).then(() => {
          showToast('仕訳テキストをコピーしました', 'success');
        }).catch(() => {
          showToast('コピーに失敗しました', 'error');
        });
      });
    });
    hydrateVoucherImages();
  }
  if (appState.activeView === 'integrations-drive') {
    // Initial load: fetch status, then (if connected) folders + mappings.
    if (!appState.driveLoadedAt) {
      appState.driveLoadedAt = Date.now();
      (async () => {
        await loadDriveStatus();
        if (appState.driveIntegration?.connected) {
          await Promise.all([loadDriveMappings(), loadDriveFolders()]);
          await Promise.all([loadDriveVouchers(), loadDriveFiles()]);
        }
        renderView();
      })();
    }
    // Wire connection panel actions
    viewContent.querySelectorAll('[data-drive-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.driveAction;
        if (action === 'sync') {
          triggerDriveSync();
        } else if (action === 'backfill') {
          triggerDriveBackfill();
        } else if (action === 'disconnect') {
          disconnectDrive();
        } else if (action === 'save-settings') {
          const urlEl = document.getElementById('driveRootFolderUrl');
          saveDriveSettings(urlEl?.value || '');
        } else if (action === 'refresh-files') {
          loadDriveFiles().then(() => renderView());
        } else if (action === 'map-root-folder') {
          const sel = document.getElementById('driveRootClientSelect');
          const clientId = sel?.value || '';
          const rootId = (appState.driveIntegration?.settings || {}).rootFolderId || '';
          if (!clientId) { showToast('顧問先を選んでください'); return; }
          if (!rootId) { showToast('フォルダIDが未設定です'); return; }
          saveDriveMapping(rootId, 'メインフォルダ', clientId);
        }
      });
    });
    // Mapping save buttons (subfolder mode)
    viewContent.querySelectorAll('[data-drive-mapping-save]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const folderId = btn.dataset.driveMappingSave;
        const sel = viewContent.querySelector(
          `[data-drive-mapping-select="${CSS.escape(folderId)}"]`,
        );
        const clientId = sel?.value || '';
        const folderName = sel?.dataset.driveFolderName || folderId;
        if (!clientId) { showToast('顧問先を選んでください'); return; }
        saveDriveMapping(folderId, folderName, clientId);
      });
    });
    // Mapping delete buttons
    viewContent.querySelectorAll('[data-drive-mapping-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteDriveMapping(btn.dataset.driveMappingDelete);
      });
    });
    // MF write buttons on drive voucher list
    viewContent.querySelectorAll('[data-voucher-mf-write]').forEach((btn) => {
      btn.addEventListener('click', () => {
        writeMfJournal(btn.dataset.voucherMfWrite);
      });
    });
  }
  if (appState.activeView === 'integrations-line') {
    // Initial load: fetch status + users.
    if (!appState.lineLoadedAt) {
      appState.lineLoadedAt = Date.now();
      (async () => {
        await Promise.all([loadLineStatus(), loadLineUsers()]);
        renderView();
      })();
    }
    // Wire connection panel actions
    viewContent.querySelectorAll('[data-line-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.lineAction;
        if (action === 'verify') {
          verifyLine();
        } else if (action === 'copy-webhook') {
          const webhook = appState.lineIntegration?.webhookUrl ?? '';
          if (!webhook) {
            showToast('Webhook URL が未設定です');
            return;
          }
          if (navigator.clipboard?.writeText) {
            navigator.clipboard
              .writeText(webhook)
              .then(() => showToast('コピーしました'))
              .catch(() => showToast('コピーできませんでした'));
          } else {
            const input = document.getElementById('lineWebhookUrl');
            if (input) {
              input.select();
              document.execCommand('copy');
              showToast('コピーしました');
            }
          }
        }
      });
    });
    // User rows: staffLabel change
    viewContent
      .querySelectorAll('[data-line-user-staff-label]')
      .forEach((inp) => {
        inp.addEventListener('change', () => {
          updateLineUser(inp.dataset.lineUserStaffLabel, {
            staffLabel: inp.value || null,
          });
        });
      });
    // User rows: enable/disable actions
    viewContent
      .querySelectorAll('[data-action="line-enable-user"]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          updateLineUser(btn.dataset.userId, {
            enabled: true,
          });
        });
      });
    viewContent
      .querySelectorAll('[data-action="line-disable-user"]')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          updateLineUser(btn.dataset.userId, {
            enabled: false,
          });
        });
      });
    // User rows: delete
    viewContent.querySelectorAll('[data-line-user-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteLineUser(btn.dataset.lineUserDelete);
      });
    });
  }
  viewContent.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const taskIndex = button.dataset.task === undefined ? null : Number(button.dataset.task);
      if (action === "open-client") {
        appState.activeClient = Number(button.dataset.clientTarget);
        location.hash = "#/dashboard";
        showToast("レビュー対象の顧問先を開きました。");
        return;
      }
      if (action === "company-crm-save") {
        saveCompanyCrm(button);
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
        location.hash = "#/feedback";
        return;
      }
      if (action === "ask" && taskIndex !== null) {
        const task = client.tasks[taskIndex];
        const draft = client.name + " ご担当者様\n\nいつもお世話になっております。月次確認のため、以下の件について資料または補足をご共有ください。\n\n・" + task[0] + "\n\n確認後、月次処理を進めます。よろしくお願いいたします。";
        appState.portalChannel = client.contactPrimary || "email";
        location.hash = "#/portal";
        const portalDraft = $("#portalDraft");
        if (portalDraft) portalDraft.value = formatBodyForChannel(draft, appState.portalChannel);
        showToast("メッセージ画面に依頼文を作成しました。");
        return;
      }
      if (action === "send-feedback") showToast("担当者に差戻し内容を送信しました。");
      if (action === "apply-validation") {
        showToast("議事録の方針をレビューセンターに反映しました。");
        location.hash = "#/dashboard";
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
      if (action === "portal-reminder-draft") {
        const client = currentClient();
        if (!client) return;
        button.disabled = true;
        button.textContent = "生成中…";
        apiFetch("/api/clients/" + encodeURIComponent(client.id) + "/reminder-draft?type=receipt")
          .then((res) => res.json())
          .then((draft) => {
            const subjectInput = $("#portalSubject");
            const bodyTextarea = $("#portalDraft");
            if (subjectInput) subjectInput.value = draft.subject || "";
            if (bodyTextarea) bodyTextarea.value = formatBodyForChannel(draft.body || "", appState.portalChannel);
            showToast("リマインド文を作成しました。確認後に送信してください。");
          })
          .catch(() => {
            showToast("文面の生成に失敗しました");
          })
          .finally(() => {
            button.disabled = false;
            button.textContent = "証憑リマインドを作成";
          });
        return;
      }
      if (action === "portal-send-now") {
        const draft = $("#portalDraft").value;
        const subjectEl = $("#portalSubject");
        const client = currentClient();
        sendMessage({
          clientId: client.id,
          channel: appState.portalChannel,
          subject:
            appState.portalChannel === "email"
              ? (subjectEl && subjectEl.value.trim()) || "月次のご確認のお願い"
              : undefined,
          body: draft,
        })
          .then((t) => {
            if (t.status === "sent") {
              showToast("送信しました");
            } else {
              showToast(
                "送信に失敗しました: " + (t.errorMsg || ""),
              );
            }
            // Invalidate the timeline cache so the newly-sent message shows.
            appState.threadsLoadedClient = null;
            loadAndRenderThreads();
          })
          .catch(() => {});
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
        updateContact({ primary, endpoints })
          .then(() => {
            client.contactPrimary = primary;
            client.contactEndpoints = endpoints;
            showToast("連絡先を更新しました");
            render();
          })
          .catch(() => {});
      }
      if (action === "company-contact-save") {
        const client = currentClient();
        const endpoints = {};
        document.querySelectorAll("[data-contact-channel]").forEach((inp) => {
          endpoints[inp.dataset.contactChannel] = inp.value.trim() || null;
        });
        const primary = (document.getElementById("companyPrimaryChannelSelect") || {}).value;
        updateContact({ primary, endpoints })
          .then(() => {
            client.contactPrimary = primary;
            client.contactEndpoints = endpoints;
            showToast("連絡先を更新しました");
          })
          .catch(() => showToast("保存に失敗しました"));
      }
      if (action === "resend-thread") {
        // Legacy data-action path; data-portal-resend is the modern form
        // (wired in loadAndRenderThreads above).
        resendMessage(button.dataset.threadId)
          .then((t) => {
            showToast(t.status === "sent" ? "再送しました" : "失敗: " + (t.errorMsg || ""));
            loadAndRenderThreads();
          })
          .catch(() => {});
      }
      // Spec 02 F3: task workflow transitions
      if (action === "task-transition") {
        const id = button.dataset.taskId;
        const a = button.dataset.taskAction;
        let comment;
        if (a === "reject") {
          comment = window.prompt("差戻しの理由（スタッフに伝わります）", "");
          if (comment === null) return;
        }
        transitionTask(id, a, comment)
          .then(() => {
            const labels = { staff_complete: "確認依頼に出しました", approve: "承認しました", reject: "差戻しを記録しました", resubmit: "再提出しました" };
            showToast(labels[a] || "更新しました");
            // Re-fetch the full client list so cached derived counters refresh.
            return loadClientsFromApi();
          })
          .then(() => loadTasksForCurrentClient())
          .finally(render)
          .catch(() => {});
      }
      if (action === "toggle-history") {
        const id = button.dataset.taskId;
        appState.expandedHistory[id] = !appState.expandedHistory[id];
        render();
        if (appState.expandedHistory[id]) {
          loadTaskHistory(id).then((rows) => {
            const slot = document.querySelector('[data-history-for="' + id + '"] ol');
            if (!slot) return;
            if (!Array.isArray(rows) || rows.length === 0) {
              slot.innerHTML = '<li>履歴はありません</li>';
              return;
            }
            const labelMap = { staff_complete: "記帳完了", approve: "承認", reject: "差戻し", resubmit: "再提出" };
            slot.innerHTML = rows
              .map(
                (h) =>
                  '<li><span class="ts">' +
                  new Date(h.at).toLocaleString("ja-JP") +
                  '</span> ' +
                  escapeHtml(h.by) +
                  ' が ' +
                  (labelMap[h.action] || h.action) +
                  (h.comment ? ' — ' + escapeHtml(h.comment) : '') +
                  '</li>',
              )
              .join('');
          });
        }
      }
      if (action === "ask-thread") {
        const id = button.dataset.taskId;
        const client = currentClient();
        const t = (client.rawTasks || []).find((x) => x.id === id);
        if (!t) return;
        const draft = client.name + " ご担当者様\n\n" +
          "下記の件についてご確認ください。\n\n・" + t.title + "\n  " + t.note + "\n\n" +
          "確認後、月次処理を進めます。よろしくお願いいたします。";
        appState.portalChannel = client.contactPrimary || "email";
        location.hash = "#/portal";
        const portalDraft = $("#portalDraft");
        if (portalDraft) portalDraft.value = formatBodyForChannel(draft, appState.portalChannel);
        showToast("顧問先連絡に依頼文を作成しました");
      }
      if (action === "settings-invite-member") {
        const emailInput = document.getElementById('inviteEmail');
        const email = emailInput ? emailInput.value.trim() : '';
        if (!email) { showToast('メールアドレスを入力してください'); return; }
        apiFetch('/api/firms/current/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        }).then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast('招待失敗: ' + (body.message || res.status));
            return;
          }
          showToast(email + ' に招待メールを送信しました');
          if (emailInput) emailInput.value = '';
          loadMemberList();
        }).catch(() => showToast('招待に失敗しました'));
      }
      if (action === "settings-remove-member") {
        const mid = button.dataset.memberId;
        if (!mid) return;
        apiFetch('/api/firms/current/members/' + mid, { method: 'DELETE' })
          .then(async (res) => {
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              showToast('削除失敗: ' + (body.message || res.status));
              return;
            }
            showToast('メンバーを削除しました');
            loadMemberList();
          }).catch(() => showToast('削除に失敗しました'));
      }
      if (action === "settings-add-client") {
        const form = document.getElementById('clientMgmtForm');
        const editId = document.getElementById('clientMgmtEditId');
        if (form && editId) {
          editId.value = '';
          document.getElementById('clientMgmtName').value = '';
          document.getElementById('clientMgmtIndustry').value = 'その他';
          document.getElementById('clientMgmtVendor').value = 'mf';
          document.getElementById('clientMgmtMode').value = 'monthly';
          document.getElementById('clientMgmtFyStart').value = '';
          document.getElementById('clientMgmtFyEnd').value = '';
          form.hidden = false;
        }
      }
      if (action === "settings-cancel-client") {
        const form = document.getElementById('clientMgmtForm');
        if (form) form.hidden = true;
      }
      if (action === "settings-edit-client") {
        const cid = button.dataset.clientId;
        if (!cid) return;
        apiFetch('/api/clients/' + cid).then(async (res) => {
          if (!res.ok) { showToast('読み込みに失敗しました'); return; }
          const c = await res.json();
          const form = document.getElementById('clientMgmtForm');
          if (!form) return;
          document.getElementById('clientMgmtEditId').value = c.id;
          document.getElementById('clientMgmtName').value = c.name || '';
          document.getElementById('clientMgmtIndustry').value = c.industry || 'その他';
          document.getElementById('clientMgmtVendor').value = c.vendor || 'mf';
          document.getElementById('clientMgmtMode').value = c.mode || 'monthly';
          document.getElementById('clientMgmtFyStart').value = c.fiscalYearStart ? c.fiscalYearStart.slice(0, 10) : '';
          document.getElementById('clientMgmtFyEnd').value = c.fiscalYearEnd ? c.fiscalYearEnd.slice(0, 10) : '';
          form.hidden = false;
        }).catch(() => showToast('読み込みに失敗しました'));
      }
      if (action === "settings-save-client") {
        const editId = document.getElementById('clientMgmtEditId');
        const name = document.getElementById('clientMgmtName').value.trim();
        const industry = document.getElementById('clientMgmtIndustry').value;
        const vendor = document.getElementById('clientMgmtVendor').value;
        const mode = document.getElementById('clientMgmtMode').value;
        const fiscalYearStart = document.getElementById('clientMgmtFyStart').value;
        const fiscalYearEnd = document.getElementById('clientMgmtFyEnd').value;
        if (!name) { showToast('顧問先名を入力してください'); return; }
        if (!fiscalYearStart || !fiscalYearEnd) { showToast('事業年度を入力してください'); return; }
        const cid = editId ? editId.value : '';
        const payload = { name, industry, vendor, mode, fiscalYearStart, fiscalYearEnd };
        const url = cid ? '/api/clients/' + cid : '/api/clients';
        const method = cid ? 'PATCH' : 'POST';
        apiFetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast('保存失敗: ' + ((body.error && body.error.message) || res.status));
            return;
          }
          showToast(cid ? '顧問先を更新しました' : '顧問先を追加しました');
          const form = document.getElementById('clientMgmtForm');
          if (form) form.hidden = true;
          loadClientList();
          loadClientsFromApi();
        }).catch(() => showToast('保存に失敗しました'));
      }
      if (action === "settings-delete-client") {
        const cid = button.dataset.clientId;
        const cname = button.dataset.clientName || '顧問先';
        if (!cid) return;
        if (!confirm(cname + ' を削除しますか？\nこの操作は元に戻せません。')) return;
        apiFetch('/api/clients/' + cid, { method: 'DELETE' }).then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showToast('削除失敗: ' + ((body.error && body.error.message) || res.status));
            return;
          }
          showToast(cname + ' を削除しました');
          loadClientList();
          loadClientsFromApi();
        }).catch(() => showToast('削除に失敗しました'));
      }
    });
  });
  // settings view: load member list if owner
  if (appState.activeView === 'settings' && appState.user && appState.user.role === 'owner') {
    loadMemberList();
  }
  // settings view: always load client management list
  if (appState.activeView === 'settings') {
    loadClientList();
  }
}

function renderAiPanel() {
  const client = currentClient();

  // bookmeeくんチャット
  let chatHtml = '<div class="chat-bubble-z"><strong>bookmeeくん</strong>' + client.chatMessage + "</div>";
  if (appState.activeView === "trends") {
    const alertCount = client.trendData.filter((d) => d.flag === "alert").length;
    chatHtml += '<div class="chat-bubble-z"><strong>bookmeeくん</strong>' + alertCount + '科目で前月比の大きな変動を検出しました。スパークバーで3ヶ月トレンドが一目で分かります！</div>';
  }
  if (appState.activeView === "validation") {
    chatHtml += '<div class="chat-bubble-z"><strong>bookmeeくん</strong>今日の議事録では、税理士向けは「資料不足・進捗・レビュー」、監査向けは「PBC・調書・不正検知」に分ける方針が見えました。bookmeeは前者に集中します。</div>';
  }
  $("#bookmeeChat").innerHTML = chatHtml;

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
    const filter = button.dataset.filter;
    const isMfReview = appState.activeView === "mf-review";
    if (isMfReview) {
      button.style.display = "";
      if (filter === 'all') button.textContent = '確認待ち';
      if (filter === 'urgent') button.textContent = '判断困難';
      if (filter === 'done') button.textContent = '完了';
      let currentFilter = 'all';
      if (appState.mfReviewStatus === 'difficult') currentFilter = 'urgent';
      if (appState.mfReviewStatus === 'approved') currentFilter = 'done';
      button.classList.toggle("active", filter === currentFilter);
      return;
    }
    button.style.display = "";
    if (filter === 'all') button.textContent = 'すべて';
    if (filter === 'urgent') button.textContent = '要確認';
    if (filter === 'done') button.textContent = '完了';
    button.classList.toggle("active", filter === appState.activeFilter);
  });
}

function render() {
  const simpleRoot = document.getElementById('simpleRoot');
  const appShell = document.querySelector('.app-shell');
  if (appState.simpleMode) {
    if (simpleRoot) { simpleRoot.hidden = false; simpleRoot.innerHTML = renderSimpleApp(); bindSimpleEvents(); }
    if (appShell) appShell.style.display = 'none';
    return;
  }
  if (simpleRoot) simpleRoot.hidden = true;
  if (appShell) appShell.style.display = '';
  renderClients();
  renderSummary();
  renderNav();
  renderView();
  syncModeToggleActive();
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    // nav-parent buttons (e.g. 月次業務) have data-view-group but no data-view,
    // and are handled by their dedicated toggle handler below. Skip them here
    // so we don't clobber appState.activeView with undefined.
    if (!button.dataset.view) return;
    const newHash = hashFromView(button.dataset.view);
    if (location.hash === newHash) {
      // Same hash — force re-apply (re-fetch loaders, etc.).
      applyHashRoute(true);
    } else {
      location.hash = newHash; // triggers 'hashchange' → applyHashRoute
    }
  });
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    const selectedFilter = button.dataset.filter;
    if (appState.activeView === "mf-review") {
      appState.mfReviewStatus = selectedFilter === 'done'
        ? 'approved'
        : selectedFilter === 'urgent'
          ? 'difficult'
          : 'pending';
      renderNav();
      const c = currentClient();
      if (c?.id) loadAndRenderMfReview(c.id);
      return;
    }
    appState.activeFilter = selectedFilter;
    render();
  });
});

$("#searchInput").addEventListener("input", (event) => {
  appState.search = event.target.value.trim();
  renderView();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (closeOpenModal()) {
      event.preventDefault();
    }
    return;
  }
  const isQuestionKey = event.key === "?" || (event.key === "/" && event.shiftKey);
  if (!isQuestionKey) return;
  if (hasEditableFocus(event.target)) return;
  event.preventDefault();
  openHelpModal();
});

// Hash routing — the single source of truth for which view is active.
// URL ↔ view mapping:
//   #/dashboard         dashboard (default when hash is empty)
//   #/company           company
//   #/jobs-journal      jobs-journal
//   #/jobs-vouchers     jobs-vouchers
//   #/jobs-monthly-check jobs-monthly-check
//   #/vouchers-register vouchers-register
//   #/matching-results  matching-results
//   #/portal            portal
//   #/rules             rules
//   #/settings          settings
//   #/integrations/drive  integrations-drive
//   #/integrations/line   integrations-line
function viewFromHash(h) {
  const s = (h || "").replace(/^#\/?/, "");
  if (!s) return null;
  if (s === "integrations/drive") return "integrations-drive";
  if (s === "integrations/line") return "integrations-line";
  return s;
}

function hashFromView(view) {
  if (!view || view === "dashboard") return "#/dashboard";
  if (view === "integrations-drive") return "#/integrations/drive";
  if (view === "integrations-line") return "#/integrations/line";
  return "#/" + view;
}

function applyHashRoute(force) {
  const target = viewFromHash(location.hash) || "dashboard";
  if (!force && appState.activeView === target) return;
  appState.activeView = target;
  appState.activeFilter = "all";
  // Reset per-view load guards so re-navigating refetches.
  if (target === "integrations-drive") appState.driveLoadedAt = null;
  if (target === "integrations-line") appState.lineLoadedAt = null;
  // 証憑ビューを開いたらバッジをクリア
  if (target === "jobs-vouchers") {
    const badge = document.getElementById('badge-vouchers');
    if (badge) badge.style.display = 'none';
  }
  render();
}
window.addEventListener("hashchange", () => applyHashRoute(false));
// Normalize the URL on first load so bookmarks land on /#/dashboard rather
// than /. The actual route application happens after loadClientsFromApi
// resolves (see bottom of file) so renderers that depend on a loaded client
// (renderPortal, renderJobsJournal, etc.) don't crash on first paint.
if (!location.hash) {
  history.replaceState(null, "", "#/dashboard");
}
// Sync activeView with URL without rendering — render fires after clients load.
appState.activeView = viewFromHash(location.hash) || "dashboard";

// Spec 05 F1: mode toggle
document.querySelectorAll("#modeToggle .mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const client = currentClient();
    if (!client?.id) return;
    const mode = btn.dataset.mode;
    updateClientMode(mode)
      .then(() => {
        client.mode = mode;
        // Invalidate yearend cache so the checklist refetches if needed.
        appState.yearendLoadedClient = null;
        showToast(mode === "yearend" ? "期末モードに切り替えました" : "月次モードに戻しました");
        loadClientsFromApi().finally(render);
      })
      .catch(() => {});
  });
});

function syncModeToggleActive() {
  const client = currentClient();
  document.querySelectorAll("#modeToggle .mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === client?.mode);
  });
}

// Spec 02 F1: role selector
const roleSel = $("#roleSelector");
if (roleSel) {
  roleSel.value = appState.currentRole;
  roleSel.addEventListener("change", () => {
    appState.currentRole = roleSel.value;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("bookmee.role", appState.currentRole);
    }
    // Force the task cache to refetch for the new role.
    appState.tasksLoadedClient = null;
    loadTasksForCurrentClient().finally(render);
  });
}

// Simple mode toggle
// ══════════════════════════════════════════════════════════
//  かんたんモード v2 — 蓄積型UI
//  証憑リスト + Drive連携 + 参照元モーダル
// ══════════════════════════════════════════════════════════
const simpleApp = {
  clientId: null,
  drawerOpen: false,
  driveConnected: false,
  drivePanel: false,
  driveFiles: [],
  driveLoading: false,
  vouchers: [],
  vouchersLoading: false,
  vouchersLoadedFor: null,
  uploadingFiles: [],
  sourceModalVoucherId: null,
  _pollTimers: {},
};

function renderSimpleRoot() {
  const root = document.getElementById('simpleRoot');
  if (!root) return;
  root.innerHTML = renderSimpleApp();
  bindSimpleEvents();
}

function renderSimpleApp() {
  const s = simpleApp;

  const headerBar = `
  <div class="sa2-header-bar">
    <button class="sa2-hamburger" id="sa2Hamburger" aria-label="メニュー">
      <span></span><span></span><span></span>
    </button>
    <span class="sa2-header-title">かんたんモード</span>
  </div>`;

  // 顧問先セレクト
  const clientOpts = (clients || []).map((c) =>
    `<option value="${escapeAttribute(c.id)}"${c.id === s.clientId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');
  const clientBar = `
    <div class="sa2-client-bar">
      <select id="sa2ClientSelect" class="sa2-client-select">
        <option value="">顧問先を選ぶ</option>
        ${clientOpts}
      </select>
    </div>`;

  // 黄色TODOバナー（needs_info件数）
  const needsInfoVouchers = s.vouchers.filter((v) => v.journalStatus === 'needs_info');
  const allMissingFields = [];
  needsInfoVouchers.forEach((v) => {
    const mf = (v.draftJournalJson && v.draftJournalJson.missingFields) || [];
    mf.forEach((f) => { if (!allMissingFields.includes(f)) allMissingFields.push(f); });
  });
  const todoBanner = needsInfoVouchers.length > 0 ? `
    <div class="sa2-todo-banner">
      <p class="sa2-todo-banner-title">確認が必要な証憑が ${needsInfoVouchers.length} 件あります</p>
      <div class="sa2-todo-tags">
        ${allMissingFields.map((f) => `<span class="sa2-todo-tag">${escapeHtml(f)}</span>`).join('')}
      </div>
    </div>` : '';

  // アップロードゾーン + Driveボタン
  const uploadSection = `
    <div class="sa2-upload-section">
      <div class="sa2-upload-row">
        <label class="sa2-upload-zone" for="sa2FileInput" id="sa2UploadZone">
          <span class="sa2-upload-zone-icon">📎</span>
          <span class="sa2-upload-zone-label">領収書・請求書を追加</span>
          <span class="sa2-upload-zone-sub">PDF / 画像をドロップまたはクリック</span>
        </label>
        <input type="file" id="sa2FileInput" accept="image/*,application/pdf" hidden multiple>
        ${s.driveConnected ? `
        <button class="sa2-drive-btn" id="sa2DriveToggle">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 12c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2s10 4.48 10 10z"/><path d="M8 12l2.5 2.5L16 9"/></svg>
          Driveから選ぶ
        </button>` : `
        <button class="sa2-drive-btn" id="sa2DriveConnect">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 12c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2s10 4.48 10 10z"/><path d="M12 8v8M8 12h8"/></svg>
          Drive連携
        </button>`}
      </div>
      ${s.drivePanel && s.driveConnected ? renderSaDrivePanel() : ''}
      ${s.uploadingFiles.length > 0 ? `
      <div class="sa2-uploading-items">
        ${s.uploadingFiles.map((f) => `
        <div class="sa2-uploading-item">
          <div class="sa2-uploading-spinner"></div>
          <span>${escapeHtml(f.name)}</span>
          <span style="color:var(--muted);margin-left:auto;font-size:.75rem">処理中…</span>
        </div>`).join('')}
      </div>` : ''}
    </div>`;

  // 証憑カードリスト
  let voucherList = '';
  if (!s.clientId) {
    voucherList = `<div class="sa2-empty"><div class="sa2-empty-icon">📋</div><p>顧問先を選んでください</p></div>`;
  } else if (s.vouchersLoading) {
    voucherList = `<div class="sa2-empty"><div class="sa2-uploading-spinner" style="width:24px;height:24px;margin:0 auto 1rem"></div><p>読み込み中…</p></div>`;
  } else if (s.vouchers.length === 0) {
    voucherList = `<div class="sa2-empty"><div class="sa2-empty-icon">📂</div><p>証憑がまだありません<br>上からアップロードしてください</p></div>`;
  } else {
    voucherList = `
      <div class="sa2-voucher-list">
        <p class="sa2-voucher-list-title">証憑一覧（${s.vouchers.length}件）</p>
        ${s.vouchers.map((v) => renderSaVoucherCard(v)).join('')}
      </div>`;
  }

  // モーダル
  const modal = s.sourceModalVoucherId ? renderSaSourceModal(s.sourceModalVoucherId) : '';
  const drawer = simpleApp.drawerOpen ? `
  <div class="sa2-drawer-overlay" id="sa2DrawerOverlay">
    <nav class="sa2-drawer">
      <div class="sa2-drawer-header">
        <span>メニュー</span>
        <button class="sa2-drawer-close" id="sa2DrawerClose">✕</button>
      </div>
      <button class="sa2-drawer-item" data-view="dashboard">📋 ToDo</button>
      <button class="sa2-drawer-item" data-view="company">🏢 顧問先</button>
      <button class="sa2-drawer-item" data-view="jobs-journal">📒 仕訳</button>
      <button class="sa2-drawer-item" data-view="vouchers-register">🧾 証憑登録</button>
      <button class="sa2-drawer-item" data-view="settings">⚙️ 設定</button>
      <hr style="border:none;border-top:1px solid var(--line);margin:.5rem 0">
      <button class="sa2-drawer-item sa2-drawer-normal" id="sa2DrawerNormal">通常モードへ</button>
    </nav>
  </div>` : '';

  return `<div class="sa2-root">
    ${headerBar}
    ${clientBar}
    ${todoBanner}
    ${uploadSection}
    ${voucherList}
  </div>${modal}${drawer}`;
}

function renderSaDrivePanel() {
  const s = simpleApp;
  if (s.driveLoading) {
    return `<div class="sa2-drive-panel">
      <div class="sa2-drive-panel-header"><span>Google Drive</span></div>
      <div class="sa2-drive-empty">読み込み中…</div>
    </div>`;
  }
  if (!s.driveFiles.length) {
    return `<div class="sa2-drive-panel">
      <div class="sa2-drive-panel-header"><span>Google Drive</span></div>
      <div class="sa2-drive-empty">ファイルが見つかりません</div>
    </div>`;
  }
  return `<div class="sa2-drive-panel">
    <div class="sa2-drive-panel-header">
      <span>Google Drive（${s.driveFiles.length}件）</span>
      <button class="sa2-drive-import-all" id="sa2DriveImportAll">すべて取り込む</button>
    </div>
    <div class="sa2-drive-thumbs">
      ${s.driveFiles.map((f) => `
      <div class="sa2-drive-thumb" data-drive-file-id="${escapeAttribute(f.id)}">
        ${f.thumbnailLink
          ? `<img src="${escapeAttribute(f.thumbnailLink)}" alt="${escapeAttribute(f.name)}">`
          : `<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:1.4rem">📄</div>`}
        <div class="sa2-drive-thumb-name">${escapeHtml(f.name)}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function renderSaVoucherCard(v) {
  const d = v.draftJournalJson || {};
  const ocr = v.ocrJson || {};
  const date = d.transactionDate || ocr.issue_date || '—';
  const vendor = ocr.vendor_name || d.description || '不明';
  const amount = d.debit && d.debit.amount != null
    ? `¥${Number(d.debit.amount).toLocaleString('ja-JP')}`
    : '—';
  const debitAcc = (d.debit && d.debit.account) || '';
  const creditAcc = (d.credit && d.credit.account) || '';
  const journalText = debitAcc ? `${debitAcc} → ${creditAcc}` : '—';
  const status = v.journalStatus || 'none';
  const needsInfo = status === 'needs_info';
  const isApproved = status === 'approved';
  const isDrafting = status === 'drafting' || status === 'none';

  const statusBadgeMap = {
    drafting: ['sa2-status-badge--drafting', 'AI解析中'],
    none: ['sa2-status-badge--drafting', 'AI解析中'],
    drafted: ['sa2-status-badge--drafted', '仕訳あり'],
    needs_info: ['sa2-status-badge--needs-info', '要確認'],
    inquired: ['sa2-status-badge--needs-info', '問合せ中'],
    approved: ['sa2-status-badge--approved', '承認済'],
    skipped: ['sa2-status-badge--none', 'スキップ'],
  };
  const [badgeCls, badgeTxt] = statusBadgeMap[status] || ['sa2-status-badge--none', status];

  return `<div class="sa2-voucher-card${needsInfo ? ' sa2-voucher-card--needs-info' : ''}" data-voucher-id="${escapeAttribute(v.id)}">
    <div class="sa2-voucher-thumb-placeholder" id="thumb-${escapeAttribute(v.id)}">📄</div>
    <div class="sa2-voucher-body">
      <div class="sa2-voucher-meta">${escapeHtml(String(date))} <span class="sa2-status-badge ${badgeCls}">${badgeTxt}</span></div>
      <div class="sa2-voucher-title">${escapeHtml(String(vendor))}</div>
      <div class="sa2-voucher-journal">${escapeHtml(journalText)} <span style="margin-left:.4rem">${amount}</span></div>
    </div>
    <div class="sa2-voucher-actions">
      <button class="sa2-card-source-btn" data-source-id="${escapeAttribute(v.id)}">参照元</button>
      ${!isApproved ? `<button class="sa2-card-approve-btn" data-approve-id="${escapeAttribute(v.id)}"${isDrafting ? ' disabled' : ''}>承認</button>` : '<span style="font-size:.75rem;color:var(--green)">✓ 承認済</span>'}
    </div>
  </div>`;
}

function renderSaSourceModal(voucherId) {
  const v = simpleApp.vouchers.find((x) => x.id === voucherId);
  if (!v) return '';
  const d = v.draftJournalJson || {};
  const ocr = v.ocrJson || {};
  const reasoning = d.reasoning || '（推論情報なし）';
  const missingFields = d.missingFields || [];
  const sources = d.sources || [];

  const ocrRows = Object.entries(ocr)
    .filter(([, val]) => val != null && val !== '')
    .map(([key, val]) => `<span class="sa2-modal-ocr-key">${escapeHtml(key)}</span><span class="sa2-modal-ocr-val">${escapeHtml(String(val))}</span>`)
    .join('');

  const patternSources = sources.filter((s) => s.type === 'pattern');
  const knowledgeSources = sources.filter((s) => s.type === 'knowledge');

  const renderPatternCard = (p) => `
    <div class="sa2-source-card sa2-source-card--pattern">
      <div class="sa2-source-card-header">
        <span class="sa2-source-badge sa2-source-badge--pattern">仕訳パターン</span>
        <span class="sa2-source-acc">${escapeHtml(p.debit || '')} → ${escapeHtml(p.credit || '')}</span>
      </div>
      <div class="sa2-source-scenario">${escapeHtml(p.scenario || '')}</div>
      ${(p.examples || []).length ? `<div class="sa2-source-examples">${(p.examples || []).map((e) => `<span class="sa2-source-example">「${escapeHtml(e)}」</span>`).join('')}</div>` : ''}
      ${(p.tags || []).length ? `<div class="sa2-source-tags">${(p.tags || []).map((t) => `<span class="sa2-todo-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    </div>`;

  const renderKnowledgeCard = (k) => `
    <div class="sa2-source-card sa2-source-card--knowledge">
      <div class="sa2-source-card-header">
        <span class="sa2-source-badge sa2-source-badge--knowledge">会計事典</span>
        <span class="sa2-source-origin">${escapeHtml(k.source || '')}</span>
      </div>
      <div class="sa2-source-title">${escapeHtml(k.title || '')}</div>
      <div class="sa2-source-snippet">${escapeHtml(k.snippet || '')}</div>
    </div>`;

  return `<div class="sa2-modal-overlay" id="sa2ModalOverlay">
    <div class="sa2-modal-sheet">
      <div class="sa2-modal-handle"></div>
      <h3 class="sa2-modal-title">仕訳の参照元</h3>

      ${sources.length > 0 ? `
      <div class="sa2-modal-section">
        <div class="sa2-modal-section-label">参照した資料（${sources.length}件）</div>
        <div class="sa2-source-list">
          ${patternSources.map(renderPatternCard).join('')}
          ${knowledgeSources.map(renderKnowledgeCard).join('')}
        </div>
      </div>` : ''}

      <div class="sa2-modal-section">
        <div class="sa2-modal-section-label">AIの判断理由</div>
        <div class="sa2-modal-reasoning">${escapeHtml(reasoning)}</div>
      </div>

      ${ocrRows ? `<div class="sa2-modal-section">
        <div class="sa2-modal-section-label">OCR読み取り結果</div>
        <div class="sa2-modal-ocr-grid">${ocrRows}</div>
      </div>` : ''}

      ${missingFields.length ? `<div class="sa2-modal-section">
        <div class="sa2-modal-section-label">不足情報</div>
        <ul class="sa2-modal-missing-list">
          ${missingFields.map((f) => `<li class="sa2-modal-missing-item">${escapeHtml(f)}</li>`).join('')}
        </ul>
      </div>` : ''}

      <button class="sa2-modal-close" id="sa2ModalClose">閉じる</button>
    </div>
  </div>`;
}

function bindSimpleEvents() {
  // ハンバーガーメニュー
  const hamburger = document.getElementById('sa2Hamburger');
  if (hamburger) hamburger.addEventListener('click', () => {
    simpleApp.drawerOpen = true;
    renderSimpleRoot();
  });
  const drawerClose = document.getElementById('sa2DrawerClose');
  if (drawerClose) drawerClose.addEventListener('click', () => {
    simpleApp.drawerOpen = false;
    renderSimpleRoot();
  });
  const drawerOverlay = document.getElementById('sa2DrawerOverlay');
  if (drawerOverlay) drawerOverlay.addEventListener('click', (e) => {
    if (e.target === drawerOverlay) { simpleApp.drawerOpen = false; renderSimpleRoot(); }
  });
  const drawerNormal = document.getElementById('sa2DrawerNormal');
  if (drawerNormal) drawerNormal.addEventListener('click', () => setSimpleMode(false));
  document.querySelectorAll('.sa2-drawer-item[data-view]').forEach((el) => {
    el.addEventListener('click', () => {
      const view = el.dataset.view;
      simpleApp.drawerOpen = false;
      setSimpleMode(false);
      location.hash = '#/' + view;
    });
  });

  // 顧問先セレクト
  const clientSelect = document.getElementById('sa2ClientSelect');
  if (clientSelect) {
    clientSelect.addEventListener('change', () => {
      simpleApp.clientId = clientSelect.value || null;
      saLoadVouchers();
    });
  }

  // ファイルアップロード
  const fileInput = document.getElementById('sa2FileInput');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      files.forEach((f) => saUploadFile(f));
      fileInput.value = '';
    });
  }

  // ドラッグ&ドロップ
  const uploadZone = document.getElementById('sa2UploadZone');
  if (uploadZone) {
    uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
    uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadZone.classList.remove('drag-over');
      Array.from(e.dataTransfer.files || []).forEach((f) => saUploadFile(f));
    });
  }

  // Drive連携 / 開閉
  const driveToggle = document.getElementById('sa2DriveToggle');
  if (driveToggle) driveToggle.addEventListener('click', saToggleDrivePanel);
  const driveConnect = document.getElementById('sa2DriveConnect');
  if (driveConnect) driveConnect.addEventListener('click', () => {
    window.location.href = '#/integrations-drive';
    setSimpleMode(false);
  });

  // Drive一括取り込み
  const importAll = document.getElementById('sa2DriveImportAll');
  if (importAll) importAll.addEventListener('click', saDriveImportAll);

  // Drive サムネイルクリック
  document.querySelectorAll('.sa2-drive-thumb').forEach((el) => {
    el.addEventListener('click', () => {
      const fileId = el.dataset.driveFileId;
      if (!fileId || !simpleApp.clientId) return;
      saDriveImportFile(fileId);
    });
  });

  // 承認ボタン
  document.querySelectorAll('[data-approve-id]').forEach((el) => {
    el.addEventListener('click', () => saApproveVoucher(el.dataset.approveId));
  });

  // 参照元ボタン
  document.querySelectorAll('[data-source-id]').forEach((el) => {
    el.addEventListener('click', () => saOpenSourceModal(el.dataset.sourceId));
  });

  // モーダル閉じる
  const modalClose = document.getElementById('sa2ModalClose');
  if (modalClose) modalClose.addEventListener('click', saCloseSourceModal);
  const modalOverlay = document.getElementById('sa2ModalOverlay');
  if (modalOverlay) modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) saCloseSourceModal();
  });
}

async function saLoadVouchers() {
  if (!simpleApp.clientId) {
    simpleApp.vouchers = [];
    simpleApp.vouchersLoadedFor = null;
    renderSimpleRoot();
    return;
  }
  simpleApp.vouchersLoading = true;
  simpleApp.vouchersLoadedFor = simpleApp.clientId;
  renderSimpleRoot();
  try {
    const res = await apiFetch(`/api/vouchers?clientId=${encodeURIComponent(simpleApp.clientId)}`);
    if (res.ok) {
      const list = await res.json();
      simpleApp.vouchers = (Array.isArray(list) ? list : []).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      saLoadThumbnails();
      saStartPollForPending();
    }
  } catch (_) {}
  simpleApp.vouchersLoading = false;
  renderSimpleRoot();
}

async function saLoadThumbnails() {
  const vouchers = simpleApp.vouchers.filter((v) => v.id);
  const BATCH = 5;
  for (let i = 0; i < vouchers.length; i += BATCH) {
    const batch = vouchers.slice(i, i + BATCH);
    await Promise.all(batch.map(async (v) => {
      try {
        const res = await apiFetch(`/api/vouchers/${v.id}/image`);
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const el = document.getElementById(`thumb-${v.id}`);
        if (el) el.outerHTML = `<img class="sa2-voucher-thumb" src="${url}" alt="証憑" id="thumb-${v.id}">`;
      } catch (_) {}
    }));
  }
}

async function saUploadFile(file) {
  if (!simpleApp.clientId) { showToast('顧問先を選んでください', 'error'); return; }
  simpleApp.uploadingFiles.push(file);
  renderSimpleRoot();
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('clientId', simpleApp.clientId);
    const upRes = await apiFetch('/api/vouchers', { method: 'POST', body: fd });
    if (!upRes.ok) throw new Error('アップロード失敗');
    const v = await upRes.json();
    apiFetch(`/api/vouchers/${v.id}/draft-journal`, { method: 'POST' }).catch(() => {});
    simpleApp.uploadingFiles = simpleApp.uploadingFiles.filter((f) => f !== file);
    await saLoadVouchers();
  } catch (err) {
    simpleApp.uploadingFiles = simpleApp.uploadingFiles.filter((f) => f !== file);
    showToast('アップロードに失敗しました', 'error');
    renderSimpleRoot();
  }
}

function saStartPollForPending() {
  const clientId = simpleApp.clientId;
  if (!clientId) return;
  if (simpleApp._pollTimers[clientId]) return;
  const pending = simpleApp.vouchers.filter((v) => v.journalStatus === 'drafting' || v.journalStatus === 'none');
  if (!pending.length) return;
  let count = 0;
  const MAX = 20;
  const timer = setInterval(async () => {
    count++;
    if (count > MAX || simpleApp.clientId !== clientId) {
      clearInterval(timer);
      delete simpleApp._pollTimers[clientId];
      return;
    }
    try {
      const res = await apiFetch(`/api/vouchers?clientId=${encodeURIComponent(clientId)}`);
      if (!res.ok) return;
      const list = await res.json();
      if (simpleApp.clientId !== clientId) return;
      simpleApp.vouchers = (Array.isArray(list) ? list : []).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const stillPending = simpleApp.vouchers.filter((v) => v.journalStatus === 'drafting' || v.journalStatus === 'none');
      renderSimpleRoot();
      saLoadThumbnails();
      if (!stillPending.length) {
        clearInterval(timer);
        delete simpleApp._pollTimers[clientId];
      }
    } catch (_) {}
  }, 3000);
  simpleApp._pollTimers[clientId] = timer;
}

async function saApproveVoucher(voucherId) {
  try {
    await apiFetch(`/api/vouchers/${voucherId}/journal`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    const v = simpleApp.vouchers.find((x) => x.id === voucherId);
    if (v) v.journalStatus = 'approved';
    renderSimpleRoot();
    saLoadThumbnails();
  } catch (_) { showToast('保存に失敗しました', 'error'); }
}

async function saCheckDriveStatus() {
  try {
    const res = await apiFetch('/api/integrations/drive');
    if (res.ok) {
      const data = await res.json();
      simpleApp.driveConnected = !!(data && data.connected);
    }
  } catch (_) {}
}

async function saToggleDrivePanel() {
  simpleApp.drivePanel = !simpleApp.drivePanel;
  if (simpleApp.drivePanel) {
    simpleApp.driveLoading = true;
    renderSimpleRoot();
    try {
      const res = await apiFetch('/api/integrations/drive/files');
      if (res.ok) {
        const data = await res.json();
        simpleApp.driveFiles = Array.isArray(data) ? data : (data.files || []);
      }
    } catch (_) {}
    simpleApp.driveLoading = false;
  }
  renderSimpleRoot();
}

async function saDriveImportFile(fileId) {
  if (!simpleApp.clientId) { showToast('顧問先を選んでください', 'error'); return; }
  try {
    await apiFetch('/api/integrations/drive/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: simpleApp.clientId, fileIds: [fileId] }),
    });
    showToast('取り込みを開始しました', 'success');
    await saLoadVouchers();
  } catch (_) { showToast('取り込みに失敗しました', 'error'); }
}

async function saDriveImportAll() {
  if (!simpleApp.clientId) { showToast('顧問先を選んでください', 'error'); return; }
  const importBtn = document.getElementById('sa2DriveImportAll');
  if (importBtn) { importBtn.disabled = true; importBtn.textContent = '取り込み中…'; }
  try {
    await apiFetch('/api/integrations/drive/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: simpleApp.clientId }),
    });
    showToast('一括取り込みを開始しました', 'success');
    simpleApp.drivePanel = false;
    await saLoadVouchers();
  } catch (_) { showToast('取り込みに失敗しました', 'error'); }
  if (importBtn) { importBtn.disabled = false; importBtn.textContent = 'すべて取り込む'; }
}

function saOpenSourceModal(voucherId) {
  simpleApp.sourceModalVoucherId = voucherId;
  renderSimpleRoot();
}

function saCloseSourceModal() {
  simpleApp.sourceModalVoucherId = null;
  renderSimpleRoot();
}

function setSimpleMode(enabled) {
  appState.simpleMode = enabled;
  try { localStorage.setItem('bookmee.simpleMode', String(enabled)); } catch (e) {}
  document.body.classList.toggle('simple-mode', enabled);
  const btnSimple = document.getElementById('modeBtnSimple');
  const btnNormal = document.getElementById('modeBtnNormal');
  if (btnSimple) btnSimple.classList.toggle('active', enabled);
  if (btnNormal) btnNormal.classList.toggle('active', !enabled);

  if (enabled) {
    // simpleRootを表示
    const root = document.getElementById('simpleRoot');
    if (root) root.removeAttribute('hidden');
    simpleApp.clientId = currentClient() ? currentClient().id : null;
    saCheckDriveStatus().then(() => {
      if (simpleApp.clientId) saLoadVouchers();
      else renderSimpleRoot();
    });
  } else {
    // polling全停止
    Object.values(simpleApp._pollTimers).forEach((t) => clearInterval(t));
    simpleApp._pollTimers = {};
    const root = document.getElementById('simpleRoot');
    if (root) root.setAttribute('hidden', '');
  }
}

const modeBtnSimple = document.getElementById('modeBtnSimple');
const modeBtnNormal = document.getElementById('modeBtnNormal');
if (modeBtnSimple) modeBtnSimple.addEventListener("click", () => setSimpleMode(true));
if (modeBtnNormal) modeBtnNormal.addEventListener("click", () => setSimpleMode(false));

// Apply saved mode on load
document.body.classList.toggle('simple-mode', appState.simpleMode);
if (appState.simpleMode) {
  const s = document.getElementById('modeBtnSimple');
  const n = document.getElementById('modeBtnNormal');
  if (s) s.classList.add('active');
  if (n) n.classList.remove('active');
}

// ══════════════════════════════════════════════════════════
//  RAG知識DB管理ビュー
// ══════════════════════════════════════════════════════════
let ragDbState = {
  tab: 'patterns', // 'patterns' | 'knowledge'
  patterns: [],
  knowledge: [],
  patternSearch: '',
  loading: false,
};

async function loadAndRenderRagDb() {
  const el = document.getElementById('viewContent');
  if (!el) return;
  ragDbState.loading = true;
  el.innerHTML = '<div class="boot-loading"><div class="spinner"></div><p>読み込み中…</p></div>';

  try {
    const [pRes, kRes] = await Promise.all([
      apiFetch('/api/journals/patterns?topK=500'),
      apiFetch('/api/knowledge'),
    ]);
    if (pRes.ok) {
      const d = await pRes.json();
      ragDbState.patterns = d.patterns || d || [];
    }
    if (kRes.ok) {
      ragDbState.knowledge = await kRes.json();
    }
  } catch (_) {}

  ragDbState.loading = false;
  renderRagDb();
}

function renderRagDb() {
  const el = document.getElementById('viewContent');
  if (!el) return;

  const { tab, patterns, knowledge, patternSearch } = ragDbState;
  const filtered = patterns.filter((p) =>
    !patternSearch ||
    p.debit?.includes(patternSearch) ||
    p.credit?.includes(patternSearch) ||
    p.scenario?.includes(patternSearch) ||
    (p.tags || []).some((t) => t.includes(patternSearch))
  );

  el.innerHTML = `
    <div style="display:flex;gap:.5rem;margin-bottom:1rem">
      <button class="segment${tab === 'patterns' ? ' active' : ''}" id="ragTabPatterns">仕訳パターン辞書（${patterns.length}）</button>
      <button class="segment${tab === 'knowledge' ? ' active' : ''}" id="ragTabKnowledge">会計事典（${knowledge.length}）</button>
    </div>

    ${tab === 'patterns' ? `
      <div style="display:flex;gap:.75rem;margin-bottom:1rem;align-items:center">
        <input type="text" id="ragPatternSearch" class="search-box" placeholder="勘定科目・キーワードで検索" value="${escapeAttribute(patternSearch)}" style="flex:1;padding:.45rem .75rem;border:1px solid var(--line);border-radius:8px">
        <button class="primary-action" id="ragAddPatternBtn" style="white-space:nowrap">+ 追加</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:.5rem" id="ragPatternList">
        ${filtered.length === 0 ? '<p style="color:var(--muted);text-align:center;padding:2rem">該当なし</p>' :
          filtered.map((p) => `
          <div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.75rem 1rem;display:flex;gap:.75rem;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div style="font-size:.78rem;color:var(--muted);margin-bottom:.2rem">${escapeHtml(p.debit || '')} → ${escapeHtml(p.credit || '')} ${(p.tags || []).map((t) => `<span style="background:var(--bg);border:1px solid var(--line);border-radius:20px;padding:.1rem .4rem;font-size:.7rem">${escapeHtml(t)}</span>`).join('')}</div>
              <div style="font-size:.88rem;font-weight:600">${escapeHtml(p.scenario || '')}</div>
              <div style="font-size:.75rem;color:var(--muted);margin-top:.3rem">${(p.memoExamples || []).slice(0, 3).map((m) => `「${escapeHtml(m)}」`).join('　')}</div>
            </div>
            <button class="ghost-btn" data-delete-pattern="${escapeAttribute(p.id)}" style="font-size:.75rem;color:var(--red);flex-shrink:0">削除</button>
          </div>`).join('')}
      </div>
    ` : `
      <div style="display:flex;justify-content:flex-end;margin-bottom:1rem">
        <button class="primary-action" id="ragAddKnowledgeBtn">+ 追加</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:.5rem">
        ${knowledge.length === 0 ? '<p style="color:var(--muted);text-align:center;padding:2rem">エントリなし</p>' :
          knowledge.map((k) => `
          <div style="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.75rem 1rem;display:flex;gap:.75rem;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div style="font-size:.75rem;color:var(--muted);margin-bottom:.2rem">${escapeHtml(k.source || '')} / ${escapeHtml(k.page || '')}</div>
              <div style="font-size:.88rem;font-weight:600">${escapeHtml(k.title || '')}</div>
              <div style="font-size:.75rem;color:var(--muted);margin-top:.3rem;white-space:pre-wrap;max-height:60px;overflow:hidden">${escapeHtml((k.content || '').slice(0, 120))}${(k.content || '').length > 120 ? '…' : ''}</div>
            </div>
            <button class="ghost-btn" data-delete-knowledge="${escapeAttribute(k.id)}" style="font-size:.75rem;color:var(--red);flex-shrink:0">削除</button>
          </div>`).join('')}
      </div>
    `}
  `;

  const tabP = document.getElementById('ragTabPatterns');
  const tabK = document.getElementById('ragTabKnowledge');
  if (tabP) tabP.addEventListener('click', () => { ragDbState.tab = 'patterns'; renderRagDb(); });
  if (tabK) tabK.addEventListener('click', () => { ragDbState.tab = 'knowledge'; renderRagDb(); });

  const searchInput = document.getElementById('ragPatternSearch');
  if (searchInput) searchInput.addEventListener('input', () => {
    ragDbState.patternSearch = searchInput.value;
    renderRagDb();
  });

  const addPatternBtn = document.getElementById('ragAddPatternBtn');
  if (addPatternBtn) addPatternBtn.addEventListener('click', () => showAddPatternModal());

  const addKnowledgeBtn = document.getElementById('ragAddKnowledgeBtn');
  if (addKnowledgeBtn) addKnowledgeBtn.addEventListener('click', () => showAddKnowledgeModal());

  document.querySelectorAll('[data-delete-pattern]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('このパターンを削除しますか？')) return;
      const id = btn.dataset.deletePattern;
      try {
        await apiFetch(`/api/journals/patterns/${id}`, { method: 'DELETE' });
        ragDbState.patterns = ragDbState.patterns.filter((p) => p.id !== id);
        renderRagDb();
        showToast('削除しました', 'success');
      } catch (_) { showToast('削除に失敗しました', 'error'); }
    });
  });

  document.querySelectorAll('[data-delete-knowledge]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('このエントリを削除しますか？')) return;
      const id = btn.dataset.deleteKnowledge;
      try {
        await apiFetch(`/api/knowledge/${id}`, { method: 'DELETE' });
        ragDbState.knowledge = ragDbState.knowledge.filter((k) => k.id !== id);
        renderRagDb();
        showToast('削除しました', 'success');
      } catch (_) { showToast('削除に失敗しました', 'error'); }
    });
  });
}

function showAddPatternModal() {
  const overlay = document.createElement('div');
  overlay.className = 'feedback-modal';
  overlay.style.display = '';
  overlay.innerHTML = `
    <div class="feedback-backdrop"></div>
    <div class="feedback-content" style="max-width:520px">
      <h3 class="feedback-title">仕訳パターンを追加</h3>
      <label class="feedback-label">借方勘定科目</label>
      <input id="ragAddDebit" class="feedback-input" placeholder="例: 消耗品費">
      <label class="feedback-label">貸方勘定科目</label>
      <input id="ragAddCredit" class="feedback-input" placeholder="例: 現金">
      <label class="feedback-label">シナリオ（説明）</label>
      <input id="ragAddScenario" class="feedback-input" placeholder="例: 事務用品を現金購入">
      <label class="feedback-label">摘要例（1行1件）</label>
      <textarea id="ragAddMemos" class="feedback-textarea" rows="4" placeholder="コピー用紙 A4 500枚&#10;ボールペン 10本&#10;クリアファイル 購入"></textarea>
      <label class="feedback-label">タグ（カンマ区切り）</label>
      <input id="ragAddTags" class="feedback-input" placeholder="例: 消耗品,事務用品">
      <div class="feedback-actions">
        <button class="ghost-btn" id="ragAddPatternCancel">キャンセル</button>
        <button class="primary-action" id="ragAddPatternSubmit">追加する</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.feedback-backdrop').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ragAddPatternCancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ragAddPatternSubmit').addEventListener('click', async () => {
    const debit = overlay.querySelector('#ragAddDebit').value.trim();
    const credit = overlay.querySelector('#ragAddCredit').value.trim();
    const scenario = overlay.querySelector('#ragAddScenario').value.trim();
    const memos = overlay.querySelector('#ragAddMemos').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const tags = overlay.querySelector('#ragAddTags').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!debit || !credit || !scenario || !memos.length) { showToast('必須項目を入力してください', 'error'); return; }
    try {
      const res = await apiFetch('/api/journals/patterns/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ debit, credit, scenario, memoExamples: memos, tags }),
      });
      if (!res.ok) throw new Error();
      const d = await res.json();
      ragDbState.patterns.unshift(d.pattern);
      overlay.remove();
      renderRagDb();
      showToast('追加しました', 'success');
    } catch (_) { showToast('追加に失敗しました', 'error'); }
  });
}

function showAddKnowledgeModal() {
  const overlay = document.createElement('div');
  overlay.className = 'feedback-modal';
  overlay.style.display = '';
  overlay.innerHTML = `
    <div class="feedback-backdrop"></div>
    <div class="feedback-content" style="max-width:520px">
      <h3 class="feedback-title">会計事典エントリを追加</h3>
      <label class="feedback-label">出典（source）</label>
      <input id="ragKSource" class="feedback-input" placeholder="例: 法人税法, 会計基準">
      <label class="feedback-label">タイトル</label>
      <input id="ragKTitle" class="feedback-input" placeholder="例: 少額減価償却資産の特例">
      <label class="feedback-label">内容</label>
      <textarea id="ragKContent" class="feedback-textarea" rows="5" placeholder="会計基準・仕訳ルールなどを記載"></textarea>
      <label class="feedback-label">関連勘定科目（カンマ区切り）</label>
      <input id="ragKAccounts" class="feedback-input" placeholder="例: 工具器具備品,消耗品費">
      <label class="feedback-label">タグ（カンマ区切り）</label>
      <input id="ragKTags" class="feedback-input" placeholder="例: 固定資産,減価償却">
      <div class="feedback-actions">
        <button class="ghost-btn" id="ragAddKnowledgeCancel">キャンセル</button>
        <button class="primary-action" id="ragAddKnowledgeSubmit">追加する</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.feedback-backdrop').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ragAddKnowledgeCancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ragAddKnowledgeSubmit').addEventListener('click', async () => {
    const source = overlay.querySelector('#ragKSource').value.trim();
    const title = overlay.querySelector('#ragKTitle').value.trim();
    const content = overlay.querySelector('#ragKContent').value.trim();
    const accounts = overlay.querySelector('#ragKAccounts').value.split(',').map((s) => s.trim()).filter(Boolean);
    const tags = overlay.querySelector('#ragKTags').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!title || !content) { showToast('タイトルと内容は必須です', 'error'); return; }
    try {
      const res = await apiFetch('/api/knowledge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source, title, content, accounts, tags }),
      });
      if (!res.ok) throw new Error();
      const d = await res.json();
      ragDbState.knowledge.unshift(d.chunk);
      overlay.remove();
      renderRagDb();
      showToast('追加しました', 'success');
    } catch (_) { showToast('追加に失敗しました', 'error'); }
  });
}

// Logout
const logoutBtn = $("#logoutButton");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    if (window.__bookmeeSignOut) {
      window.__bookmeeSignOut().catch(() => { window.location.href = '/login.html'; });
    } else {
      window.location.href = '/login.html';
    }
  });
}

const clientContextClear = $("#clientContextClear");
if (clientContextClear) {
  clientContextClear.addEventListener("click", () => {
    appState.activeClient = 0;
    updateClientContextBar();
    render();
  });
}

// Sidebar accordion: 月次業務 parent toggles its sub-items, then jumps to 仕訳.
const jobsSub = $("#jobsSub");
document.querySelectorAll('[data-view-group="jobs"]').forEach((btn) => {
  btn.addEventListener("click", () => {
    if (jobsSub) jobsSub.classList.toggle("expanded");
    btn.classList.toggle("expanded");
    const av = appState.activeView || "";
    if (jobsSub?.classList.contains("expanded") && !av.startsWith("jobs-")) {
      location.hash = "#/jobs-journal";
    }
  });
});

// =============================================================================
// Spec 23: AI節税提案ビュー
// =============================================================================

function renderTaxSuggestions() {
  const client = currentClient();
  if (!client) return '<div class="view-placeholder">顧問先を選択してください</div>';
  return `
    <div class="view-header">
      <h2>節税提案</h2>
      <p class="view-desc">${labels.helper['tax-suggestions']}</p>
    </div>
    <div style="margin-bottom:16px">
      <button id="taxAnalyzeBtn" class="btn btn-primary" style="margin-right:8px">AIで分析する</button>
      <span id="taxAnalyzeStatus" style="font-size:13px;color:#6b7280"></span>
    </div>
    <div id="taxSuggestionsList"><div class="loading-text">読み込み中…</div></div>
  `;
}

function renderTaxSuggestionCards(suggestions) {
  if (!suggestions || suggestions.length === 0) {
    return '<div class="empty-state">提案がありません。「AIで分析する」を押してください。</div>';
  }
  const priorityBadge = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' };
  const statusLabel = { open: '未対応', implemented: '実施済み', dismissed: '見送り' };
  const categoryLabel = {
    entertainment: '交際費', depreciation: '減価償却', timing: '計上タイミング',
    officer_salary: '役員報酬', tax_method: '税務方式', other: 'その他',
  };
  return suggestions.map(s => `
    <div class="card" style="margin-bottom:12px;padding:16px;border-left:4px solid ${s.priority === 'high' ? '#dc2626' : s.priority === 'medium' ? '#d97706' : '#16a34a'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div>
          <span style="font-size:11px;background:#f3f4f6;padding:2px 8px;border-radius:99px;margin-right:6px">${escapeHtml(categoryLabel[s.category] || s.category)}</span>
          <span style="font-size:11px;color:#6b7280">${priorityBadge[s.priority] || s.priority}</span>
        </div>
        <select class="tax-status-select" data-id="${s.id}" style="font-size:12px;border:1px solid #e5e7eb;border-radius:4px;padding:2px 6px">
          <option value="open" ${s.status === 'open' ? 'selected' : ''}>未対応</option>
          <option value="implemented" ${s.status === 'implemented' ? 'selected' : ''}>実施済み</option>
          <option value="dismissed" ${s.status === 'dismissed' ? 'selected' : ''}>見送り</option>
        </select>
      </div>
      <div style="font-weight:600;margin-bottom:6px">${escapeHtml(s.title)}</div>
      <div style="font-size:13px;color:#374151;margin-bottom:8px">${escapeHtml(s.detail)}</div>
      ${s.estimatedSaving ? `<div style="font-size:12px;color:#16a34a;font-weight:600">推定節税額: ¥${s.estimatedSaving.toLocaleString('ja-JP')}/年</div>` : ''}
    </div>
  `).join('');
}

async function loadAndRenderTaxSuggestions(clientId) {
  const listEl = document.getElementById('taxSuggestionsList');
  if (!listEl) return;
  try {
    const res = await apiFetch(`/api/clients/${clientId}/tax-suggestions`);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    listEl.innerHTML = renderTaxSuggestionCards(data.suggestions || []);
    // ステータス変更ハンドラ
    listEl.querySelectorAll('.tax-status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const r = await apiFetch(`/api/tax-suggestions/${sel.dataset.id}`, {
          method: 'PATCH', body: JSON.stringify({ status: sel.value }),
        });
        if (!r.ok) sel.value = sel.value === 'open' ? 'implemented' : 'open'; // rollback
      });
    });
  } catch (e) {
    listEl.innerHTML = '<div class="error-text">取得に失敗しました</div>';
  }
  // 分析ボタン
  const analyzeBtn = document.getElementById('taxAnalyzeBtn');
  const statusEl = document.getElementById('taxAnalyzeStatus');
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', async () => {
      analyzeBtn.disabled = true;
      if (statusEl) statusEl.textContent = '分析中…';
      try {
        const res = await apiFetch(`/api/clients/${clientId}/tax-suggestions/analyze`, { method: 'POST' });
        if (!res.ok) throw new Error('analyze failed');
        const data = await res.json();
        if (statusEl) statusEl.textContent = `${data.generated}件の提案を生成しました`;
        await loadAndRenderTaxSuggestions(clientId);
      } catch (e) {
        if (statusEl) statusEl.textContent = '分析に失敗しました';
      } finally {
        analyzeBtn.disabled = false;
      }
    });
  }
}

// =============================================================================
// Spec 24: キャッシュフロー予測ビュー
// =============================================================================

function renderCashflow() {
  const client = currentClient();
  if (!client) return '<div class="view-placeholder">顧問先を選択してください</div>';
  return `
    <div class="view-header">
      <h2>キャッシュフロー予測</h2>
      <p class="view-desc">${labels.helper['cashflow']}</p>
    </div>
    <div style="margin-bottom:16px">
      <button id="cfRefreshBtn" class="btn btn-secondary">再計算</button>
    </div>
    <div id="cfContent"><div class="loading-text">読み込み中…</div></div>
  `;
}

function renderCashflowContent(data) {
  const all = [...(data.actual || []), ...(data.forecast || [])];
  if (all.length === 0) return '<div class="empty-state">仕訳データがありません。MFと連携してください。</div>';

  const fmt = n => n === undefined || n === null ? '—' : (n >= 0 ? '+' : '') + '¥' + Math.abs(n).toLocaleString('ja-JP');
  const fmtAbs = n => '¥' + Math.abs(n || 0).toLocaleString('ja-JP');
  const actualMonths = new Set((data.actual || []).map(m => m.month));

  const rows = all.map(m => {
    const isForecast = !actualMonths.has(m.month);
    const netClass = m.net >= 0 ? 'color:#16a34a' : 'color:#dc2626';
    const badge = isForecast
      ? '<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:99px;margin-left:6px">予測</span>'
      : '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:1px 6px;border-radius:99px;margin-left:6px">実績</span>';
    return `<tr>
      <td>${m.month.replace(/^(\d{4})-(\d{2})$/, '$1年$2月')}${badge}</td>
      <td style="text-align:right">${fmtAbs(m.inflow)}</td>
      <td style="text-align:right">${fmtAbs(m.outflow)}</td>
      <td style="text-align:right;font-weight:600;${netClass}">${fmt(m.net)}</td>
    </tr>`;
  }).reverse().join('');

  const comment = data.aiComment ? `
    <div style="background:#eff6ff;border-left:3px solid #2563eb;padding:12px 16px;border-radius:0 8px 8px 0;font-size:14px;color:#1e40af;margin-bottom:20px">
      ${escapeHtml(data.aiComment)}
    </div>` : '';

  return `${comment}
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f9fafb">
          <th style="padding:10px 12px;text-align:left;font-size:12px;color:#6b7280">期間</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280">収入</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280">支出</th>
          <th style="padding:10px 12px;text-align:right;font-size:12px;color:#6b7280">純CF</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function loadAndRenderCashflow(clientId) {
  const contentEl = document.getElementById('cfContent');
  if (!contentEl) return;
  try {
    const res = await apiFetch(`/api/clients/${clientId}/cashflow`);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    contentEl.innerHTML = renderCashflowContent(data);
  } catch (e) {
    contentEl.innerHTML = '<div class="error-text">取得に失敗しました</div>';
  }
  const refreshBtn = document.getElementById('cfRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '計算中…';
      if (contentEl) contentEl.innerHTML = '<div class="loading-text">再計算中…</div>';
      try {
        const res = await apiFetch(`/api/clients/${clientId}/cashflow/refresh`, { method: 'POST' });
        if (!res.ok) throw new Error('refresh failed');
        const data = await res.json();
        contentEl.innerHTML = renderCashflowContent(data);
      } catch (e) {
        contentEl.innerHTML = '<div class="error-text">再計算に失敗しました</div>';
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '再計算';
      }
    });
  }
}

// =============================================================================
// Spec 25: 顧問先ポータルビュー
// =============================================================================

function renderClientPortal() {
  const client = currentClient();
  if (!client) return '<div class="view-placeholder">顧問先を選択してください</div>';
  return `
    <div class="view-header">
      <h2>顧問先ポータル</h2>
      <p class="view-desc">${labels.helper['client-portal']}</p>
    </div>
    <div id="portalContent"><div class="loading-text">読み込み中…</div></div>
  `;
}

async function loadAndRenderClientPortal(clientId) {
  const el = document.getElementById('portalContent');
  if (!el) return;

  const renderPortalSection = (token) => {
    const portalUrl = `${location.protocol}//${location.host}/portal.html?token=${token}`;
    el.innerHTML = `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;max-width:600px">
        <div style="font-weight:600;margin-bottom:12px">ポータルURL</div>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;font-size:13px;word-break:break-all;margin-bottom:12px">
          <a href="${portalUrl}" target="_blank" style="color:#2563eb">${escapeHtml(portalUrl)}</a>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:20px">
          <button id="portalCopyBtn" class="btn btn-secondary">URLをコピー</button>
          <button id="portalOpenBtn" class="btn btn-secondary">プレビュー</button>
          <button id="portalDisableBtn" class="btn" style="color:#dc2626;border-color:#dc2626">URL無効化</button>
        </div>
        <div style="font-size:12px;color:#6b7280">
          このURLを顧問先に共有すると、ログイン不要で月次レポートを閲覧できます。<br>
          URLを無効化するといつでもアクセスを停止できます。
        </div>
      </div>
    `;
    document.getElementById('portalCopyBtn')?.addEventListener('click', () => {
      navigator.clipboard.writeText(portalUrl).then(() => {
        const btn = document.getElementById('portalCopyBtn');
        if (btn) { btn.textContent = 'コピーしました'; setTimeout(() => { btn.textContent = 'URLをコピー'; }, 2000); }
      });
    });
    document.getElementById('portalOpenBtn')?.addEventListener('click', () => {
      window.open(portalUrl, '_blank');
    });
    document.getElementById('portalDisableBtn')?.addEventListener('click', async () => {
      if (!confirm('このURLを無効化しますか？顧問先はアクセスできなくなります。')) return;
      const r = await apiFetch(`/api/clients/${clientId}/portal-token`, { method: 'DELETE' });
      if (r.ok) loadAndRenderClientPortal(clientId);
    });
  };

  try {
    // まず既存トークンを取得しようと試みる（POST で取得or作成）
    const res = await apiFetch(`/api/clients/${clientId}/portal-token`, { method: 'POST' });
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    renderPortalSection(data.token);
  } catch (e) {
    el.innerHTML = `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;max-width:600px">
        <div style="margin-bottom:16px;color:#374151">顧問先向けの月次レポートURLを発行します。</div>
        <button id="portalCreateBtn" class="btn btn-primary">ポータルURLを発行する</button>
      </div>
    `;
    document.getElementById('portalCreateBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('portalCreateBtn');
      if (btn) { btn.disabled = true; btn.textContent = '発行中…'; }
      try {
        const r = await apiFetch(`/api/clients/${clientId}/portal-token`, { method: 'POST' });
        if (!r.ok) throw new Error('create failed');
        const d = await r.json();
        renderPortalSection(d.token);
      } catch (err) {
        el.innerHTML = '<div class="error-text">発行に失敗しました</div>';
      }
    });
  }
}

// ---- 固定資産台帳 -------------------------------------------------------
function renderFixedAssets() {
  const client = currentClient();
  if (!client) return '<div class="view-placeholder">顧問先を選択してください</div>';
  return `
    <div class="view-header">
      <h2>固定資産台帳</h2>
      <p class="view-desc">${labels.helper['fixed-assets']}</p>
    </div>
    <div id="fixedAssetsList"><div class="loading-text">読み込み中…</div></div>
  `;
}

async function loadAndRenderFixedAssets(clientId) {
  const el = document.getElementById('fixedAssetsList');
  if (!el) return;
  try {
    const res = await apiFetch(`/api/clients/${clientId}/fixed-assets`);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) {
      el.innerHTML = '<div class="empty-state">固定資産の仕訳が見つかりませんでした。</div>';
      return;
    }
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 12px">日付</th>
            <th style="padding:8px 12px">摘要</th>
            <th style="padding:8px 12px">勘定科目</th>
            <th style="padding:8px 12px;text-align:right">取得価額</th>
            <th style="padding:8px 12px;text-align:center">耐用年数</th>
            <th style="padding:8px 12px;text-align:right">年間償却額</th>
            <th style="padding:8px 12px;text-align:center">確認事項</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(item => `
            <tr style="border-top:1px solid #e5e7eb">
              <td style="padding:8px 12px">${escapeHtml(item.date)}</td>
              <td style="padding:8px 12px">${escapeHtml(item.description)}</td>
              <td style="padding:8px 12px">${escapeHtml(item.account)}</td>
              <td style="padding:8px 12px;text-align:right">¥${item.amount.toLocaleString('ja-JP')}</td>
              <td style="padding:8px 12px;text-align:center">${item.usefulLifeYears ? item.usefulLifeYears + '年' : '—'}</td>
              <td style="padding:8px 12px;text-align:right">${item.depreciationPerYear ? '¥' + item.depreciationPerYear.toLocaleString('ja-JP') : '—'}</td>
              <td style="padding:8px 12px;text-align:center">${item.requiresContract ? '<span style="color:#dc2626;font-weight:600">📄 契約書要確認</span>' : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    el.innerHTML = '<div class="error-text">取得に失敗しました</div>';
  }
}

// ---- 期間配分チェック ---------------------------------------------------
function renderAccruals() {
  const client = currentClient();
  if (!client) return '<div class="view-placeholder">顧問先を選択してください</div>';
  return `
    <div class="view-header">
      <h2>期間配分チェック</h2>
      <p class="view-desc">${labels.helper['accruals']}</p>
    </div>
    <div id="accrualsList"><div class="loading-text">読み込み中…</div></div>
  `;
}

async function loadAndRenderAccruals(clientId) {
  const el = document.getElementById('accrualsList');
  if (!el) return;
  try {
    const res = await apiFetch(`/api/clients/${clientId}/accruals`);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const candidates = data.candidates || [];
    if (!candidates.length) {
      el.innerHTML = '<div class="empty-state">計上漏れ候補はありません。</div>';
      return;
    }
    const typeLabel = { unpaid: '未払費用', prepaid: '前払費用' };
    const typeColor = { unpaid: '#dc2626', prepaid: '#2563eb' };
    el.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:#6b7280">${candidates.length}件の計上漏れ候補が見つかりました</div>
      ${candidates.map(c => `
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:10px;border-left:4px solid ${typeColor[c.type] || '#6b7280'}">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:11px;font-weight:600;color:${typeColor[c.type] || '#6b7280'}">${typeLabel[c.type] || c.type}</span>
            <span style="font-size:13px;font-weight:600">¥${c.amount.toLocaleString('ja-JP')}</span>
          </div>
          <div style="font-weight:500;margin-bottom:4px">${escapeHtml(c.description)}</div>
          <div style="font-size:12px;color:#6b7280;margin-bottom:4px">元の取引日: ${escapeHtml(c.originalDate)} → 提案勘定科目: ${escapeHtml(c.suggestedAccount)}</div>
          <div style="font-size:12px;color:#374151">${escapeHtml(c.reason)}</div>
        </div>
      `).join('')}
    `;
  } catch (e) {
    el.innerHTML = '<div class="error-text">取得に失敗しました</div>';
  }
}

// ---- 売上突合 -----------------------------------------------------------
function renderArMatching() {
  const client = currentClient();
  if (!client) return '<div class="view-placeholder">顧問先を選択してください</div>';
  return `
    <div class="view-header">
      <h2>売上突合（売掛金管理）</h2>
      <p class="view-desc">${labels.helper['ar-matching']}</p>
    </div>
    <div id="arMatchingContent"><div class="loading-text">読み込み中…</div></div>
  `;
}

async function loadAndRenderArMatching(clientId) {
  const el = document.getElementById('arMatchingContent');
  if (!el) return;
  try {
    const res = await apiFetch(`/api/clients/${clientId}/ar-matching`);
    if (!res.ok) throw new Error('fetch failed');
    const data = await res.json();
    const { unmatched = [], matched = [], summary = {} } = data;
    const agingColor = { current: '#16a34a', '30days': '#d97706', '60days': '#ea580c', '90days+': '#dc2626' };
    const agingLabel = { current: '30日以内', '30days': '31〜60日', '60days': '61〜90日', '90days+': '91日以上' };
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#dc2626">¥${(summary.totalUnmatchedAmount || 0).toLocaleString('ja-JP')}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">未回収合計</div>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#dc2626">${summary.unmatchedCount || 0}件</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">未回収件数</div>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center">
          <div style="font-size:24px;font-weight:700;color:#16a34a">¥${(summary.totalMatchedAmount || 0).toLocaleString('ja-JP')}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">回収済合計</div>
        </div>
      </div>
      ${unmatched.length ? `
        <h3 style="font-size:14px;font-weight:600;margin-bottom:10px">未回収売掛金 (${unmatched.length}件)</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
          <thead>
            <tr style="background:#fef2f2;text-align:left">
              <th style="padding:8px 12px">発生日</th>
              <th style="padding:8px 12px">取引先</th>
              <th style="padding:8px 12px">摘要</th>
              <th style="padding:8px 12px;text-align:right">金額</th>
              <th style="padding:8px 12px;text-align:center">経過日数</th>
              <th style="padding:8px 12px;text-align:center">エイジング</th>
            </tr>
          </thead>
          <tbody>
            ${unmatched.map(u => `
              <tr style="border-top:1px solid #e5e7eb">
                <td style="padding:8px 12px">${escapeHtml(u.date)}</td>
                <td style="padding:8px 12px">${escapeHtml(u.partner || '—')}</td>
                <td style="padding:8px 12px">${escapeHtml(u.description)}</td>
                <td style="padding:8px 12px;text-align:right">¥${u.amount.toLocaleString('ja-JP')}</td>
                <td style="padding:8px 12px;text-align:center">${u.agingDays}日</td>
                <td style="padding:8px 12px;text-align:center"><span style="color:${agingColor[u.agingCategory] || '#6b7280'};font-weight:600">${agingLabel[u.agingCategory] || u.agingCategory}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div class="empty-state" style="margin-bottom:20px">未回収売掛金はありません</div>'}
    `;
  } catch (e) {
    el.innerHTML = '<div class="error-text">取得に失敗しました</div>';
  }
}

// ---- 銀行明細 -----------------------------------------------------------
function renderBankStatement() {
  const client = currentClient();
  if (!client) return '<div class="view-placeholder">顧問先を選択してください</div>';
  return `
    <div class="view-header">
      <h2>銀行明細インポート</h2>
      <p class="view-desc">${labels.helper['bank-statement']}</p>
    </div>
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;max-width:560px;margin-bottom:20px">
      <div style="margin-bottom:12px;font-size:13px;color:#374151">ネットバンキングからダウンロードした明細CSVをアップロードしてください（UTF-8 または Shift-JIS）</div>
      <input type="file" id="bankCsvInput" accept=".csv,text/csv" style="font-size:13px;margin-bottom:12px;display:block">
      <button id="bankImportBtn" class="btn btn-primary">インポート</button>
      <span id="bankImportStatus" style="font-size:13px;color:#6b7280;margin-left:12px"></span>
    </div>
    <div id="bankStatementResult"></div>
  `;
}

function initBankStatementUpload() {
  const client = currentClient();
  if (!client) return;
  const btn = document.getElementById('bankImportBtn');
  const input = document.getElementById('bankCsvInput');
  const statusEl = document.getElementById('bankImportStatus');
  const resultEl = document.getElementById('bankStatementResult');
  if (!btn || !input || !resultEl) return;

  btn.addEventListener('click', async () => {
    const file = input.files?.[0];
    if (!file) { if (statusEl) statusEl.textContent = 'ファイルを選択してください'; return; }
    btn.disabled = true;
    if (statusEl) statusEl.textContent = 'インポート中…';
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch(`/api/clients/${client.id}/bank-statement-import`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || 'インポートに失敗しました');
      }
      const data = await res.json();
      const { rows = [], unknowns = [], summary = {} } = data;
      if (statusEl) statusEl.textContent = `${summary.totalRows || rows.length}件を取り込みました`;
      resultEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:700">¥${(summary.totalWithdrawal || 0).toLocaleString('ja-JP')}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px">出金合計</div>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:700">¥${(summary.totalDeposit || 0).toLocaleString('ja-JP')}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px">入金合計</div>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:${summary.unknownCount > 0 ? '#dc2626' : '#16a34a'}">${summary.unknownCount || 0}件</div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px">不明出金</div>
          </div>
        </div>
        ${unknowns.length ? `
          <h3 style="font-size:14px;font-weight:600;margin-bottom:10px;color:#dc2626">不明出金 (${unknowns.length}件) — 要確認</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">
            <thead>
              <tr style="background:#fef2f2;text-align:left">
                <th style="padding:8px 12px">日付</th>
                <th style="padding:8px 12px">摘要</th>
                <th style="padding:8px 12px;text-align:right">出金額</th>
                <th style="padding:8px 12px">判定理由</th>
              </tr>
            </thead>
            <tbody>
              ${unknowns.map(u => `
                <tr style="border-top:1px solid #e5e7eb">
                  <td style="padding:8px 12px">${escapeHtml(u.date)}</td>
                  <td style="padding:8px 12px">${escapeHtml(u.description || '（空白）')}</td>
                  <td style="padding:8px 12px;text-align:right;color:#dc2626;font-weight:600">¥${u.amount.toLocaleString('ja-JP')}</td>
                  <td style="padding:8px 12px;font-size:12px;color:#6b7280">${escapeHtml(u.reason)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<div style="color:#16a34a;font-weight:600;margin-bottom:16px">不明な出金はありませんでした</div>'}
        <h3 style="font-size:14px;font-weight:600;margin-bottom:10px">全明細 (${rows.length}件)</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:#f1f5f9;text-align:left">
              <th style="padding:6px 10px">日付</th>
              <th style="padding:6px 10px">摘要</th>
              <th style="padding:6px 10px;text-align:right">出金</th>
              <th style="padding:6px 10px;text-align:right">入金</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr style="border-top:1px solid #f3f4f6">
                <td style="padding:6px 10px">${escapeHtml(r.date)}</td>
                <td style="padding:6px 10px">${escapeHtml(r.description)}</td>
                <td style="padding:6px 10px;text-align:right;color:${r.withdrawal > 0 ? '#dc2626' : '#9ca3af'}">${r.withdrawal > 0 ? '¥' + r.withdrawal.toLocaleString('ja-JP') : '—'}</td>
                <td style="padding:6px 10px;text-align:right;color:${r.deposit > 0 ? '#16a34a' : '#9ca3af'}">${r.deposit > 0 ? '¥' + r.deposit.toLocaleString('ja-JP') : '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message || 'エラーが発生しました';
      resultEl.innerHTML = '';
    } finally {
      btn.disabled = false;
    }
  });
}

// ---- 赤バッジ: LINE新着証憑カウント ----------------------------------------
async function refreshVoucherBadge() {
  const badge = document.getElementById('badge-vouchers');
  if (!badge) return;
  try {
    const res = await apiFetch('/api/vouchers/new-count');
    if (!res.ok) return;
    const { count } = await res.json();
    const prev = parseInt(badge.dataset.prevCount || '0', 10);
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
    // 件数が増えた場合にトースト通知
    if (count > prev && prev >= 0 && document.visibilityState === 'visible') {
      showToast(`💬 LINE新着 ${count}件`, 'info');
    }
    badge.dataset.prevCount = String(count);
  } catch (e) { /* ignore */ }
}

// 15秒ごとにバッジ更新
setInterval(refreshVoucherBadge, 15000);

// フォーカス復帰時に即時更新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshVoucherBadge();
  }
});

function renderCrm() {
  const query = (appState.crmSearch || "").trim().toLocaleLowerCase("ja-JP");
  const statusFilter = appState.crmStatusFilter || "all";
  const filteredClients = appState.clients.filter((client) => {
    const nameMatches = !query || String(client.name || "").toLocaleLowerCase("ja-JP").includes(query);
    const status = client.crmStatus || "active";
    const statusMatches = statusFilter === "all" || status === statusFilter;
    return nameMatches && statusMatches;
  });
  const filters = [
    ["all", "全件"],
    ["active", "対応中"],
    ["pending", "確認待ち"],
    ["inactive", "完了"],
  ];

  let html = '<section class="dashboard-section-card">';
  html += '<div class="dashboard-section-head">';
  html += '<div><p class="eyebrow">顧問先CRM</p><h2>顧問先一覧</h2></div>';
  html += '<div style="display:flex;align-items:center;gap:.75rem">';
  html += '<span class="status-chip">' + filteredClients.length + '件</span>';
  html += '<button class="primary-action" data-action="crm-add-client">+ 新規顧問先</button>';
  html += '</div>';
  html += '</div>';
  html += '<div class="crm-toolbar">';
  html += '<input id="crmSearchInput" class="crm-search" type="search" value="' + escapeAttribute(appState.crmSearch || "") + '" placeholder="顧問先名で検索">';
  html += '<div class="crm-filter-row">';
  for (const [value, label] of filters) {
    html += '<button class="segment' + (statusFilter === value ? " active" : "") + '" data-crm-status-filter="' + value + '">' + label + '</button>';
  }
  html += '</div></div>';

  if (filteredClients.length === 0) {
    html += '<div class="empty-state">条件に一致する顧問先はありません。</div>';
  } else {
    html += '<div class="crm-card-grid">';
    for (const client of filteredClients) {
      const status = ["active", "pending", "inactive"].includes(client.crmStatus)
        ? client.crmStatus
        : "active";
      const badgeClass = status === "active" ? " complete" : status === "pending" ? " pending" : "";
      const statusLabel = status === "active" ? "対応中" : status === "pending" ? "確認待ち" : "完了";
      const lastContactDate = client.lastContactAt ? new Date(client.lastContactAt) : null;
      const lastContact = lastContactDate && !Number.isNaN(lastContactDate.getTime())
        ? lastContactDate.toLocaleDateString("ja-JP")
        : "未連絡";
      const tasksOpen = Number(client.tasksOpen) || 0;
      const endpoints = client.contactEndpoints || {};
      const hasContact = !!(endpoints.email || endpoints.chatwork || endpoints.line || endpoints.line_works || endpoints.slack);
      const contactBadge = hasContact
        ? '<span class="crm-contact-badge configured">連絡先設定済み</span>'
        : '<span class="crm-contact-badge missing">連絡先未設定</span>';
      const vendorText = client.vendor === 'mf' ? 'MF' : client.vendor === 'freee' ? 'freee' : client.vendor === 'yayoi' ? '弥生' : '未設定';
      const vendorBadgeClass = client.vendor === 'mf' ? 'crm-vendor-badge mf' : client.vendor === 'freee' ? 'crm-vendor-badge freee' : client.vendor === 'yayoi' ? 'crm-vendor-badge yayoi' : 'crm-vendor-badge';
      html += '<button class="crm-client-card" data-crm-client-id="' + escapeAttribute(client.id) + '">';
      html += '<div class="dashboard-section-head">';
      html += '<div><h3>' + escapeHtml(client.name || "名称未設定") + '</h3><p>' + escapeHtml(client.industry || "業種未設定") + '</p></div>';
      html += '<div style="display:flex;gap:.4rem;align-items:center"><span class="' + vendorBadgeClass + '">' + vendorText + '</span><span class="status-chip' + badgeClass + '">' + statusLabel + '</span></div>';
      html += '</div>';
      html += '<div class="crm-card-meta"><span>最終連絡: ' + lastContact + '</span><span>未処理 ' + tasksOpen + '件</span>' + contactBadge + '</div>';
      if (client.memo && client.memo.trim()) {
        const memo = client.memo.trim();
        const preview = memo.slice(0, 50) + (memo.length > 50 ? "…" : "");
        html += '<p class="crm-card-memo">' + escapeHtml(preview) + '</p>';
      }
      if (client.tags && client.tags.length > 0) {
        html += '<div class="crm-card-tags">';
        for (const tag of client.tags.slice(0, 4)) {
          html += '<span class="crm-tag">' + escapeHtml(tag) + '</span>';
        }
        html += '</div>';
      }
      html += '</button>';
    }
    html += '</div>';
  }
  html += '</section>';
  return html;
}

// ── フィードバック FAB / モーダル ──
(function () {
  const trigger = document.getElementById('feedbackTrigger');
  const modal = document.getElementById('feedbackModal');
  const backdrop = document.getElementById('feedbackBackdrop');
  const closeBtn = document.getElementById('feedbackClose');
  const submitBtn = document.getElementById('feedbackSubmit');
  const titleInput = document.getElementById('feedbackTitleInput');
  const bodyInput = document.getElementById('feedbackBodyInput');
  if (!trigger || !modal) return;

  function openModal() { modal.hidden = false; titleInput.focus(); }
  function closeModal() { modal.hidden = true; titleInput.value = ''; bodyInput.value = ''; }

  trigger.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);

  submitBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const message = bodyInput.value.trim();
    if (!title || !message) { showToast('タイトルと詳細を入力してください', 'error'); return; }
    submitBtn.disabled = true;
    try {
      const res = await apiFetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message }),
      });
      if (res.ok) {
        showToast('送信しました。ありがとうございます！', 'success');
        closeModal();
      } else {
        showToast('送信に失敗しました。しばらくしてから再試行してください。', 'error');
      }
    } catch (_e) {
      showToast('送信に失敗しました。', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
})();

function showBootBanner(message, detail) {
  const banner = document.getElementById('bootBanner');
  if (!banner) return;
  banner.hidden = false;
  banner.innerHTML =
    '<strong>' + escapeHtml(message) + '</strong>' +
    (detail ? '<p>' + escapeHtml(detail) + '</p>' : '');
}

// Startup: await auth session, fetch user info, then load clients.
(async () => {
  const session = await (window.__sessionPromise || Promise.resolve(null));
  if (!session) {
    showBootBanner('ログインが必要です', 'ログインページへ移動しています…');
    return;
  }

  let bootError = null;
  try {
    const meRes = await apiFetch('/api/auth/me');
    if (meRes.ok) {
      appState.user = await meRes.json();
      const navUserInfo = $('#navUserInfo');
      if (navUserInfo && appState.user) {
        navUserInfo.innerHTML =
          '<span class="nav-user-firm">' + escapeHtml(appState.user.firmName || '') + '</span>' +
          '<span class="nav-user-email">' + escapeHtml(appState.user.email || '') + '</span>';
      }
    } else {
      const body = await meRes.json().catch(() => ({}));
      const code = body?.error?.code;
      if (meRes.status === 503 && code === 'AUTH_NOT_CONFIGURED') {
        bootError = {
          message: 'サーバー認証が未設定です',
          detail: 'Railway の Variables に SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定して再デプロイしてください。',
        };
      } else if (meRes.status === 403 && code === 'NO_FIRM') {
        bootError = {
          message: '事務所が未登録です',
          detail: 'ログアウトして、ログイン画面の「新規登録」から事務所を作成してください。',
        };
      } else if (meRes.status === 401) {
        if (typeof window.__bookmeeSignOut === 'function') {
          await window.__bookmeeSignOut();
          return;
        }
        bootError = {
          message: '認証に失敗しました',
          detail: 'セッションをクリアして再ログインしてください。',
        };
      }
    }
  } catch (e) {
    bootError = {
      message: 'サーバーに接続できません',
      detail: 'Railway のデプロイ状態と /api/health を確認してください。',
    };
    console.warn('Failed to fetch /api/auth/me', e);
  }

  const loadingMsg = document.getElementById('bootLoadingMsg');
  if (loadingMsg) loadingMsg.textContent = '顧問先データを読み込んでいます…';
  await loadClientsFromApi();
  updateClientContextBar();
  applyHashRoute(true);
  refreshVoucherBadge();
  setupNotifications();
  startInboundPolling();

  // ページ初期化スピナーを非表示にする（白い画面フラッシュ防止のインラインオーバーレイ）
  const pageInit = document.getElementById('__pageInit');
  if (pageInit) {
    pageInit.style.opacity = '0';
    pageInit.style.transition = 'opacity .2s';
    setTimeout(() => { pageInit.remove(); }, 200);
  }

  if (bootError) showBootBanner(bootError.message, bootError.detail);
})();
