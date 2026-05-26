const appState = {
  activeClient: 0,
  activeView: "dashboard",
  activeFilter: "all",
  search: "",
  currentRole: (typeof localStorage !== "undefined" && localStorage.getItem("bookmee.role")) || "tax_accountant",
  expandedHistory: {}, // taskId -> bool
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
  driveLoadedAt: null,
  lineIntegration: null,
  lineUsers: [],
  lineVerifyResult: null,
  lineLoadedAt: null,
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

// Loaded from /api/clients on startup. Empty until the first fetch resolves.
let clients = [];

// 中央集約 labels: API は英語コード (e.g. "awaiting_approval") を返す。
// UI は常に labels.* を経由して日本語化する。
const labels = {
  // View titles (eyebrow)
  dashboard: "ToDo",
  company: "顧問先",
  "jobs-journal": "月次業務 / 仕訳",
  "jobs-vouchers": "月次業務 / 証憑",
  "jobs-monthly-check": "月次業務 / 月次チェック",
  "vouchers-register": "証憑登録",
  "matching-results": "突合結果",
  portal: "メッセージ",
  "integrations-drive": "連携 / Google Drive",
  "integrations-line": "連携 / LINE",
  rules: "学習",
  settings: "設定",

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
    "jobs-journal": "マネーフォワードから取り込んだ仕訳一覧です。",
    "jobs-vouchers": "領収書が足りていない取引と、依頼文の作成。",
    "jobs-monthly-check": "前月比や残高チェックなど月次レビューの観点。",
    "vouchers-register": "領収書・請求書などの画像をまとめてアップロードします。未分類プールに入り、後で OCR で振り分けます。",
    "matching-results": "アップロード済み証憑と MF 仕訳の突合結果を顧問先ごとに確認します。",
    portal: "お客さまにメールやSlackなどで連絡できます。届かなかったら再送できます。",
    "integrations-drive": "Google Drive にあるレシート画像を自動取り込みします。スタッフ用の事務所共通アカウントを 1 つ接続して、サブフォルダを顧問先に割り当ててください。",
    "integrations-line": "公式 LINE アカウントに送られた画像を自動取り込みします。スタッフが LINE で画像を送るだけで Voucher になります。",
    rules: "この顧問先で過去にミスしやすかった点を、企業ごとのチェック項目として保存します。",
    settings: "事務所全体の運用設定。",
  },
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
    if (filtered.length > 0) clients = filtered;
  } catch (err) {
    console.warn("Failed to load clients from API; using inline fallback", err);
  }
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
    const requests = [fetch(voucherUrl).then((r) => r.json())];
    if (tab !== 'unassigned') {
      requests.push(
        fetch(`/api/clients/${encodeURIComponent(tab)}`).then((r) => r.json()),
      );
    }
    const [vouchers, client] = await Promise.all(requests);
    appState.matchingVouchers = vouchers;
    appState.matchingEntries = client?.entries || [];
    appState.matchingLoadedTab = tab;
    renderView();
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
    showToast('MoneyForwardへの入力を開始しました。');
    appState.matchingLoadedTab = null;
    appState.vouchersLoadedTab = null;
    if (appState.activeView === 'vouchers-register') {
      await loadVouchers();
    } else {
      await loadMatchingData();
    }
  } catch (err) {
    showToast(friendlyError(err));
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

async function triggerDriveSync() {
  try {
    const res = await apiFetch('/api/integrations/drive/sync', { method: 'POST' });
    if (!res.ok) throw new Error('sync failed');
    appState.driveLastSync = await res.json();
    const s = appState.driveLastSync || {};
    showToast(
      `同期完了: imported=${s.imported ?? 0} skipped=${s.skipped ?? 0} failed=${s.failed ?? 0}`,
    );
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
    showToast(
      `既存ファイル取込完了: imported=${s.imported ?? 0} skipped=${s.skipped ?? 0} failed=${s.failed ?? 0}`,
    );
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

async function saveDriveSettings(rootFolderId, importedSubfolderName) {
  try {
    const res = await apiFetch('/api/integrations/drive/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootFolderId, importedSubfolderName }),
    });
    if (!res.ok) throw new Error('save settings failed');
    await loadDriveStatus();
    await loadDriveFolders();
    renderView();
    showToast('Drive 設定を保存しました');
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

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
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
  let html = "";
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const active = i === appState.activeClient ? " active" : "";
    html += '<button class="chip' + active + '" data-client="' + i + '">';
    html += escapeHtml(c.name);
    html += " " + vendorBadgeHtml(c.vendor);
    html += "</button>";
  }
  clientChips.innerHTML = html;
  clientChips.querySelectorAll("[data-client]").forEach((btn) => {
    btn.addEventListener("click", () => {
      appState.activeClient = Number(btn.dataset.client);
      render();
    });
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
  // Spec 05 F3: yearend mode shows yearend checklist instead of tasks.
  if (client.mode === "yearend") {
    return renderYearendDashboard();
  }
  const [stage, stageClass] = progressStatus(client);
  const role = appState.currentRole;
  const rawTasks = client.rawTasks || [];

  // Spec 02 F2: filter tasks by role + stage
  const filtered = rawTasks
    .map((t, index) => ({ task: t, index }))
    .filter(({ task }) => {
      if (role === "tax_accountant") return task.stage === "awaiting_approval";
      // staff sees their own work-in-progress + things sent back
      return task.stage === "staff_doing" || task.stage === "rejected";
    })
    .filter(({ task }) => matchesSearch([task.title, task.note, task.category]))
    .sort((a, b) => b.task.score - a.task.score);

  const heroTitle = role === "tax_accountant"
    ? "今日確認すべきレビュー"
    : "あなたが今やる作業";
  const heroDesc = role === "tax_accountant"
    ? "スタッフが完了して所長確認待ちになった件だけを表示しています。"
    : "あなたが進行中の作業と、所長から戻ってきた差戻しが見えます。";

  let html = '<div class="review-hero">';
  html += '<div><p class="eyebrow">' + (role === "tax_accountant" ? "所長確認" : "あなたの作業") + '</p><h3>' + heroTitle + '</h3>';
  html += '<p>' + heroDesc + '</p></div>';
  html += '<div class="review-run-card"><span class="pill ' + stageClass + '">' + stage + '</span><strong>' + filtered.length + '件</strong><small>あなたに来ている件数</small></div>';
  html += "</div>";

  html += '<div class="review-list">';
  if (!filtered.length) {
    html += '<div class="empty-state">' + (role === "tax_accountant" ? "今日はありません。スタッフからの確認依頼を待ちましょう。" : "あなたの作業はありません。お疲れさまでした！") + '</div>';
  }
  for (const item of filtered) {
    const t = item.task;
    html += '<article class="review-card ' + t.status + '">';
    html += '<div class="review-main"><div class="review-title-row">';
    html += '<span class="pill ' + t.status + '">' + t.category + '</span>';
    html += '<span class="pill stage-' + t.stage + '">' + stageJpLabel(t.stage) + '</span>';
    html += '<strong>' + escapeHtml(t.title) + '</strong></div>';
    html += '<p>' + escapeHtml(t.note) + '</p>';
    html += '<div class="review-evidence">';
    html += '<span><b>担当</b>' + (t.assignee || "—") + '</span>';
    html += '<span><b>承認者</b>' + (t.approver || "—") + '</span>';
    html += '<span><b>優先度</b>' + t.score + '%</span>';
    html += '</div>';
    if (appState.expandedHistory[t.id]) {
      html += '<div data-history-for="' + t.id + '"><ol class="task-history"><li>読み込み中…</li></ol></div>';
    } else {
      html += '<button class="vendor-link" data-action="toggle-history" data-task-id="' + t.id + '" style="margin-top:6px">履歴を見る</button>';
    }
    html += '</div>';
    html += '<div class="review-score">' + makeConfidence(t.score) + '</div>';
    html += '<div class="review-actions">';
    if (role === "staff") {
      html += '<button class="row-action" data-action="task-transition" data-task-id="' + t.id + '" data-task-action="staff_complete">記帳完了 → 確認依頼</button>';
    } else {
      html += '<button class="row-action" data-action="task-transition" data-task-id="' + t.id + '" data-task-action="approve">承認</button>';
      html += '<button class="row-action reject" data-action="task-transition" data-task-id="' + t.id + '" data-task-action="reject">差戻し</button>';
      html += '<button class="row-action" data-action="ask-thread" data-task-id="' + t.id + '">依頼文</button>';
    }
    html += '</div></article>';
  }
  html += "</div>";
  return html;
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
    html += '<h3 style="font-size:.95rem;margin-bottom:1rem;color:#1e293b">メンバー管理</h3>';
    html += '<div id="memberList" style="margin-bottom:1rem"><p style="color:#999;font-size:.85rem">読み込み中…</p></div>';
    html += '<div class="setting-row" style="align-items:flex-end">';
    html += '<div style="flex:1"><strong>メンバーを招待</strong><p>メールアドレスを入力してください</p>';
    html += '<input id="inviteEmail" type="email" placeholder="staff@example.com" style="width:100%;padding:.5rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem;box-sizing:border-box;margin-top:.5rem" /></div>';
    html += '<button class="primary-action compact" data-action="settings-invite-member" style="margin-left:.75rem;flex-shrink:0">招待送信</button>';
    html += '</div>';
    html += '</section>';
  }

  // Client management section
  html += '<section class="settings-card" id="clientMgmtSection">';
  html += '<h3 style="font-size:.95rem;margin-bottom:1rem;color:#1e293b">顧問先管理</h3>';
  html += '<div id="clientMgmtList" style="margin-bottom:1rem"><p style="color:#999;font-size:.85rem">読み込み中…</p></div>';
  html += '<div id="clientMgmtForm" style="display:none;background:#f8fafc;border:1px solid #e3e7ee;border-radius:8px;padding:1rem;margin-bottom:1rem">';
  html += '<input type="hidden" id="clientMgmtEditId" value="" />';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-bottom:.75rem">';
  html += '<div><label style="font-size:.8rem;color:#64748b">顧問先名 *</label><input id="clientMgmtName" type="text" placeholder="○○株式会社" style="width:100%;padding:.45rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem;box-sizing:border-box;margin-top:.25rem" /></div>';
  html += '<div><label style="font-size:.8rem;color:#64748b">業種</label><select id="clientMgmtIndustry" style="width:100%;padding:.45rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem;margin-top:.25rem">';
  html += '<option value="その他">その他</option><option value="製造業">製造業</option><option value="小売業">小売業</option><option value="サービス業">サービス業</option><option value="飲食業">飲食業</option><option value="医療・介護">医療・介護</option><option value="不動産">不動産</option><option value="建設業">建設業</option>';
  html += '</select></div>';
  html += '<div><label style="font-size:.8rem;color:#64748b">会計ソフト</label><select id="clientMgmtVendor" style="width:100%;padding:.45rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem;margin-top:.25rem"><option value="mf">MoneyForward</option><option value="freee">freee</option></select></div>';
  html += '<div><label style="font-size:.8rem;color:#64748b">モード</label><select id="clientMgmtMode" style="width:100%;padding:.45rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem;margin-top:.25rem"><option value="monthly">月次</option><option value="yearend">期末</option></select></div>';
  html += '<div><label style="font-size:.8rem;color:#64748b">事業年度開始日 *</label><input id="clientMgmtFyStart" type="date" style="width:100%;padding:.45rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem;box-sizing:border-box;margin-top:.25rem" /></div>';
  html += '<div><label style="font-size:.8rem;color:#64748b">事業年度終了日 *</label><input id="clientMgmtFyEnd" type="date" style="width:100%;padding:.45rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem;box-sizing:border-box;margin-top:.25rem" /></div>';
  html += '</div>';
  html += '<div style="display:flex;gap:.5rem">';
  html += '<button class="primary-action compact" data-action="settings-save-client">保存</button>';
  html += '<button class="row-action" data-action="settings-cancel-client">キャンセル</button>';
  html += '</div>';
  html += '</div>';
  html += '<button class="row-action" data-action="settings-add-client" style="font-size:.85rem">+ 顧問先を追加</button>';
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
      '<div style="display:flex;gap:.5rem">' +
      '<button class="row-action" data-action="settings-edit-client" data-client-id="' + escapeHtml(c.id) + '">編集</button>' +
      '<button class="row-action" data-action="settings-delete-client" data-client-id="' + escapeHtml(c.id) + '" data-client-name="' + escapeHtml(c.name) + '" style="color:#dc2626">削除</button>' +
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

// Spec 04 F1: AIルールビュー 2-column redesign
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
  if (!c) return '<div class="empty-state">顧問先を選んでください。</div>';
  const tab = appState.companyTab || "info";
  const tabs = [
    { key: "info", label: "基本情報" },
    { key: "journal", label: "仕訳帳" },
    { key: "cash", label: "現金出納帳" },
    { key: "general-ledger", label: "総勘定元帳" },
    { key: "sub-ledger", label: "補助元帳" },
    { key: "trial-bs", label: "残高試算表 BS" },
    { key: "trial-pl", label: "残高試算表 PL" },
  ];
  let html = '<div class="company-tabs">';
  for (const t of tabs) {
    html += '<button class="company-tab' + (t.key === tab ? " active" : "") + '" data-company-tab="' + t.key + '">' + t.label + '</button>';
  }
  html += '</div>';

  if (tab === "info") {
    html += renderCompanyInfo(c);
  } else if (!c.mfConnected) {
    html += '<div class="empty-state">MF クラウド会計と連携してください。<br><small>OAuth 開始: <code>/api/mf/oauth/start?clientId=' + escapeHtml(c.id) + '</code></small></div>';
  } else {
    html += '<div id="companyTabBody"><div class="empty-state">読み込み中…</div></div>';
  }
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
  html += '</section>';
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
function renderJobsJournal() {
  const c = currentClient();
  if (!c) return '<div class="empty-state">顧問先を選んでください。</div>';
  const entries = (c.entries || []).filter((e) => {
    // live MF entries or DB MF/freee entries depending on connection
    if (c.mfConnected) return (e.id || "").toString().startsWith("live-");
    return true;
  });
  let html = '<section>';
  html += '<p class="eyebrow">仕訳一覧</p>';
  if (entries.length === 0) {
    html += '<div class="empty-state">仕訳がありません。マネフォと連携すると自動で取り込まれます。</div>';
  } else {
    html += '<div class="table-wrap"><table><thead><tr>';
    html += '<th>日付</th><th>科目</th><th>摘要</th><th>金額</th><th>税区分</th><th>証憑</th><th>操作</th>';
    html += '</tr></thead><tbody>';
    for (const e of entries) {
      const dateStr = new Date(e.occurredAt).toISOString().slice(0, 10);
      const receiptLabel = e.receiptStatus === "matched" ? "✓ 添付済" : e.receiptStatus === "missing" ? '<span style="color:#9a3040">未添付</span>' : e.receiptStatus === "partial" ? "一部" : "-";
      html += '<tr>';
      html += '<td>' + dateStr + '</td>';
      html += '<td><strong>' + escapeHtml(e.account) + '</strong></td>';
      html += '<td>' + escapeHtml((e.description || "").slice(0, 50)) + '</td>';
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
        '<td><a href="/api/vouchers/' + v.id + '/image" target="_blank">画像</a></td>';
      html += '</tr>';
      no += 1;
    }
    html += '</tbody></table></div>';
    html +=
      '<small class="sync-fresh">bookmee で生成・承認されたドラフト。MF にはまだ転記されていません（手動入力してください）。</small>';
    html += '</section>';
    slot.innerHTML = html;
  } catch (_err) {
    // best-effort
  }
}

// ===== 業務 > 月次業務 > 証憑 (=旧 receipts) =====
function renderJobsVouchers() {
  let html = '';
  html += '<div id="missingAlertSlot"></div>';
  html += '<div id="missingTableSlot"></div>';
  return html;
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

function renderVoucherRegister() {
  const tab = appState.voucherTab;
  const counts = appState.voucherCounts || {};
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
      } else if (ocr === 'done' && v.ocrJson) {
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

      const sourceBadge =
        v.source === 'drive'
          ? '<span class="voucher-source-badge src-drive">Drive</span>'
          : v.source === 'line'
            ? '<span class="voucher-source-badge src-line">LINE</span>'
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
              ? `<span class="voucher-mf-badge mf-failed" title="${escapeHtml(v.mfWriteError || '')}">MF失敗</span>`
              : '';
        const mfBtn = mfStatus !== 'done' && mfStatus !== 'writing' && mfStatus !== 'pending'
          ? `<button class="voucher-mfwrite-btn" data-voucher-mfwrite="${v.id}">MFに登録</button>`
          : '';
        if (mfBadge || mfBtn) {
          mfHtml = `<div class="voucher-mf-row">${mfBadge}${mfBtn}</div>`;
        }
      }

      return `
      <div class="voucher-card" data-voucher-id="${v.id}" draggable="true">
        <img src="/api/vouchers/${v.id}/image" alt="${escapeHtml(v.filename)}" />
        <button class="voucher-delete" data-voucher-delete="${v.id}" aria-label="削除">×</button>
        <div class="voucher-meta">
          <div class="voucher-filename">${escapeHtml(v.filename)}${sourceBadge}</div>
          <div class="voucher-date">${new Date(v.uploadedAt).toLocaleString('ja-JP')}</div>
        </div>
        ${captionHtml}
        ${ocrHtml}
        ${matchHtml}
        ${mfHtml}
      </div>
    `;
    })
    .join('');

  return `
    <section class="voucher-register">
      <div class="voucher-dropzone" id="voucherDropzone">
        <p class="voucher-dropzone-label">画像をここにドロップ または</p>
        <label class="voucher-pick-btn">
          ファイルを選択
          <input type="file" id="voucherFileInput" multiple
                 accept="image/jpeg,image/png,image/gif,image/webp" hidden />
        </label>
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
        <img src="/api/vouchers/${v.id}/image" alt="${escapeHtml(v.filename)}" />
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
            ? '<span class="matching-draft-badge badge-approved">承認済</span>'
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
            </div>
          </div>`;
      } else if (status === 'unmatched' && v.ocrStatus === 'done') {
        draftHtml = `<div class="matching-draft matching-draft-empty">
          <button class="matching-redraft-btn" data-matching-redraft="${v.id}">仕訳ドラフトを生成</button>
        </div>`;
      }

      return `
      <div class="matching-card-pending">
        <img src="/api/vouchers/${v.id}/image" alt="${escapeHtml(v.filename)}" />
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
  const last = appState.driveLastSync;

  let connectionPanel;
  if (!integ || !integ.connected) {
    connectionPanel = `
      <div class="integration-panel integration-drive-connection">
        <h3>接続</h3>
        <p class="muted">Google Drive と連携すると、指定したフォルダの画像が自動で Voucher として取り込まれます。</p>
        <p><a class="primary-btn" href="/api/integrations/drive/oauth/authorize">Google と連携</a></p>
      </div>
    `;
  } else {
    const settings = integ.settings || {};
    const expires = integ.watchExpiresAt
      ? new Date(integ.watchExpiresAt).toLocaleString('ja-JP')
      : '未登録';
    const statusBadgeClass =
      integ.status === 'ok'
        ? 'ok'
        : integ.status === 'reauth_required' || integ.status === 'watch_failed'
          ? 'error'
          : 'warn';
    connectionPanel = `
      <div class="integration-panel integration-drive-connection">
        <h3>接続</h3>
        <p>
          <span class="muted">アカウント:</span> <strong>${escapeHtml(integ.email || '—')}</strong>
          <span class="integration-status-badge ${statusBadgeClass}">${escapeHtml(integ.status || 'ok')}</span>
        </p>
        <p class="muted">watch channel 期限: ${escapeHtml(expires)}</p>
        <div style="margin-top: 12px;">
          <label style="display:block; font-size:12px; margin-bottom:4px;">ルートフォルダ ID</label>
          <input type="text" id="driveRootFolderId" value="${escapeHtml(settings.rootFolderId || '')}"
                 placeholder="folder id (空欄なら My Drive ルート)"
                 style="width:100%; padding:6px 8px; font-family:monospace; font-size:12px;" />
        </div>
        <div style="margin-top: 8px;">
          <label style="display:block; font-size:12px; margin-bottom:4px;">取り込み済みフォルダ名</label>
          <input type="text" id="driveImportedSubfolderName"
                 value="${escapeHtml(settings.importedSubfolderName || '')}"
                 placeholder="例: 取り込み済"
                 style="width:100%; padding:6px 8px; font-size:12px;" />
        </div>
        <div style="margin-top: 12px; display:flex; gap:8px;">
          <button class="primary-btn" data-drive-action="save-settings">保存</button>
          <button class="ghost-btn" data-drive-action="disconnect">切断</button>
        </div>
      </div>
    `;
  }

  let mappingsPanel = '';
  if (integ && integ.connected) {
    const mappingByFolderId = Object.fromEntries(
      mappings.map((m) => [m.driveFolderId, m]),
    );
    const clientOptionsHtml = (selectedId) => {
      const head = `<option value="">— 顧問先を選択 —</option>`;
      const rest = (clients || [])
        .map(
          (c) =>
            `<option value="${escapeHtml(c.id)}"${c.id === selectedId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`,
        )
        .join('');
      return head + rest;
    };

    const folderRows = folders
      .map((f) => {
        const existing = mappingByFolderId[f.id];
        return `
        <tr>
          <td>${escapeHtml(f.name)}</td>
          <td><code style="font-size:11px;">${escapeHtml(f.id)}</code></td>
          <td>
            <select data-drive-mapping-select="${escapeHtml(f.id)}" data-drive-folder-name="${escapeHtml(f.name)}">
              ${clientOptionsHtml(existing?.clientId)}
            </select>
          </td>
          <td>
            <button class="primary-btn" data-drive-mapping-save="${escapeHtml(f.id)}">保存</button>
            ${existing ? `<button class="ghost-btn" data-drive-mapping-delete="${escapeHtml(existing.id)}" title="解除">×</button>` : ''}
          </td>
        </tr>
      `;
      })
      .join('');

    const orphanRows = mappings
      .filter((m) => !folders.find((f) => f.id === m.driveFolderId))
      .map(
        (m) => `
          <tr>
            <td>${escapeHtml(m.folderName)} <span class="muted">(未表示)</span></td>
            <td><code style="font-size:11px;">${escapeHtml(m.driveFolderId)}</code></td>
            <td>${escapeHtml((clients || []).find((c) => c.id === m.clientId)?.name || m.clientId)}</td>
            <td><button class="ghost-btn" data-drive-mapping-delete="${escapeHtml(m.id)}">×</button></td>
          </tr>
        `,
      )
      .join('');

    mappingsPanel = `
      <div class="integration-panel drive-folder-mappings">
        <h3>フォルダ → 顧問先 mapping</h3>
        <p class="muted">ルートフォルダ直下のサブフォルダを bookmee の顧問先に割り当てます。割当てたフォルダに画像を入れると Voucher として取り込まれます。</p>
        ${
          folders.length === 0 && orphanRows.length === 0
            ? '<p class="muted">サブフォルダが見つかりません。ルートフォルダ ID を確認してください。</p>'
            : `<table class="drive-mappings-table">
              <thead>
                <tr><th>フォルダ名</th><th>Drive ID</th><th>顧問先</th><th></th></tr>
              </thead>
              <tbody>${folderRows}${orphanRows}</tbody>
            </table>`
        }
      </div>
    `;
  }

  let syncPanel = '';
  if (integ && integ.connected) {
    const lastHtml = last
      ? `<ul class="muted" style="margin:8px 0 0; padding-left:16px; font-size:12px;">
          <li>imported: <strong>${last.imported ?? 0}</strong></li>
          <li>skipped: <strong>${last.skipped ?? 0}</strong></li>
          <li>failed: <strong>${last.failed ?? 0}</strong></li>
          <li>pageToken: <code>${escapeHtml(last.lastPageToken || last.pageToken || '—')}</code></li>
        </ul>`
      : '<p class="muted" style="font-size:12px;">まだ同期されていません。</p>';
    syncPanel = `
      <div class="integration-panel drive-sync">
        <h3>同期</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="primary-btn" data-drive-action="sync">今すぐ同期</button>
          <button class="secondary-btn" data-drive-action="backfill">既存ファイルを取り込む</button>
        </div>
        <p class="muted" style="font-size:11px;margin-top:6px;">「今すぐ同期」は連携後の新着のみ。「既存ファイルを取り込む」は連携前からあるファイルを対象にします。</p>
        ${lastHtml}
      </div>
    `;
  }

  return `
    <section class="integrations-drive">
      ${connectionPanel}
      ${mappingsPanel}
      ${syncPanel}
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
        <button class="primary-btn" data-line-action="verify"${connected ? '' : ' disabled'}>接続テスト</button>
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
              <label style="display:inline-flex; align-items:center; gap:4px;">
                <input type="checkbox" data-line-user-enabled="${escapeHtml(u.id)}" ${u.enabled ? 'checked' : ''} />
                <span style="font-size:11px;">${u.enabled ? '有効' : '無効'}</span>
              </label>
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
      ${connectionPanel}
      ${usersPanel}
    </section>
  `;
}

function renderView() {
  const client = currentClient();
  // ToDo は role 切替で 税理士=所長確認待ち / スタッフ=作業中+差戻し が並ぶ。
  // 月次業務 は 仕訳 / 証憑 / 月次チェック の 3 サブビューに展開する。
  const views = {
    dashboard: () => renderDashboard(),            // 今日 > ToDo
    company: () => renderCompany(),                // 業務 > 顧問先
    "jobs-journal": () => renderJobsJournal(),     // 業務 > 月次業務 > 仕訳
    "jobs-vouchers": () => renderJobsVouchers(),   // 業務 > 月次業務 > 証憑
    "jobs-monthly-check": () => renderJobsMonthlyCheck(), // 業務 > 月次業務 > 月次チェック
    "vouchers-register": () => renderVoucherRegister(),
    "matching-results": () => renderMatchingResults(),
    portal: () => renderPortal(),                  // 業務 > メッセージ
    "integrations-drive": () => renderIntegrationsDrive(),
    "integrations-line": () => renderIntegrationsLine(),
    rules: () => renderRules(),                    // 学習・設定 > 学習
    settings: () => renderSettings(),              // 学習・設定 > 設定
  };
  const renderer = views[appState.activeView] ?? views.dashboard;
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
  if (appState.activeView === "jobs-journal") {
    const c = currentClient();
    if (c?.id) loadApprovedDraftsIntoSlot(c.id);
  }
  if (appState.activeView === "jobs-vouchers") {
    loadAndRenderMissing();
  }
  if (appState.activeView === "dashboard") {
    loadAndRenderYearend();
  }
  if (appState.activeView === "vouchers-register") {
    if (appState.vouchersLoadedTab !== appState.voucherTab) {
      loadVouchers();
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
        if (e.target.closest('[data-voucher-delete]')) return;
        const id = card.dataset.voucherId;
        const modal = document.querySelector('#voucherModal');
        const img = document.querySelector('#voucherModalImg');
        if (modal && img) {
          img.src = `/api/vouchers/${id}/image`;
          modal.hidden = false;
        }
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
  }
  if (appState.activeView === 'integrations-drive') {
    // Initial load: fetch status, then (if connected) folders + mappings.
    if (!appState.driveLoadedAt) {
      appState.driveLoadedAt = Date.now();
      (async () => {
        await loadDriveStatus();
        if (appState.driveIntegration?.connected) {
          await Promise.all([loadDriveMappings(), loadDriveFolders()]);
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
          const rootEl = document.getElementById('driveRootFolderId');
          const impEl = document.getElementById('driveImportedSubfolderName');
          saveDriveSettings(rootEl?.value || '', impEl?.value || '');
        }
      });
    });
    // Mapping save buttons
    viewContent.querySelectorAll('[data-drive-mapping-save]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const folderId = btn.dataset.driveMappingSave;
        const sel = viewContent.querySelector(
          `[data-drive-mapping-select="${CSS.escape(folderId)}"]`,
        );
        const clientId = sel?.value || '';
        const folderName = sel?.dataset.driveFolderName || folderId;
        if (!clientId) {
          showToast('顧問先を選んでください');
          return;
        }
        saveDriveMapping(folderId, folderName, clientId);
      });
    });
    // Mapping delete buttons
    viewContent.querySelectorAll('[data-drive-mapping-delete]').forEach((btn) => {
      btn.addEventListener('click', () => {
        deleteDriveMapping(btn.dataset.driveMappingDelete);
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
    // User rows: enabled toggle
    viewContent
      .querySelectorAll('[data-line-user-enabled]')
      .forEach((cb) => {
        cb.addEventListener('change', () => {
          updateLineUser(cb.dataset.lineUserEnabled, {
            enabled: cb.checked,
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
      if (action === "portal-send-now") {
        const draft = $("#portalDraft").value;
        const client = currentClient();
        sendMessage({
          clientId: client.id,
          channel: appState.portalChannel,
          subject:
            appState.portalChannel === "email"
              ? "月次のご確認のお願い"
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
          form.style.display = 'block';
        }
      }
      if (action === "settings-cancel-client") {
        const form = document.getElementById('clientMgmtForm');
        if (form) form.style.display = 'none';
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
          form.style.display = 'block';
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
          if (form) form.style.display = 'none';
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
    button.classList.toggle("active", button.dataset.filter === appState.activeFilter);
  });
}

function render() {
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
  button.addEventListener("click", () => { appState.activeFilter = button.dataset.filter; render(); });
});

$("#searchInput").addEventListener("input", (event) => {
  appState.search = event.target.value.trim();
  renderView();
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

// Startup: await auth session, fetch user info, then load clients.
(async () => {
  const session = await (window.__sessionPromise || Promise.resolve(null));
  if (!session) return; // index.html is redirecting to /login.html

  // Fetch current user's firm/role info.
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
    }
  } catch (e) {
    console.warn('Failed to fetch /api/auth/me', e);
  }

  loadClientsFromApi().finally(() => applyHashRoute(true));
})();
