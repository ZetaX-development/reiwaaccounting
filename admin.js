/* admin.js — 経理丸投げAI 管理画面 */
'use strict';

// ── Helpers ──────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let _toastTimer = null;
function toast(msg, type = '') {
  const el = document.getElementById('adminToast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'admin-toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'admin-toast'; }, 3000);
}

async function apiFetch(path, opts = {}) {
  const session = window.__bookmeeSession;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (session && session.access_token && session.access_token !== 'dev-token') {
    headers['Authorization'] = 'Bearer ' + session.access_token;
  }
  return fetch(path, { ...opts, headers });
}

// ── Auth check & init ─────────────────────────────────────────────────
(async () => {
  const session = await (window.__sessionPromise || Promise.resolve(null));
  if (!session) return;

  // Fetch /api/auth/me to verify role
  let me = null;
  try {
    const res = await apiFetch('/api/auth/me');
    if (res.ok) me = await res.json();
  } catch (_e) {}

  const isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const DEV_BYPASS = isLocalDev; // same flag as backend

  if (!DEV_BYPASS && (!me || me.role !== 'owner')) {
    toast('管理者権限が必要です', 'error');
    setTimeout(() => { window.location.href = '/'; }, 1500);
    return;
  }

  // Show user info
  const userInfoEl = document.getElementById('adminUserInfo');
  if (userInfoEl && me) {
    userInfoEl.textContent = (me.firmName || '') + '  ' + (me.email || '');
  }

  // Logout
  document.getElementById('adminLogout')?.addEventListener('click', () => {
    if (window.__bookmeeSignOut) window.__bookmeeSignOut();
  });

  // Profile section
  const displayNameInput = document.getElementById('displayNameInput');
  const profileEmail = document.getElementById('profileEmail');
  if (me) {
    if (displayNameInput) displayNameInput.value = me.displayName || '';
    if (profileEmail) profileEmail.textContent = me.email || '';
  }
  document.getElementById('saveProfileBtn')?.addEventListener('click', async () => {
    const displayName = displayNameInput?.value?.trim() ?? '';
    const res = await apiFetch('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    });
    if (res.ok) { toast('プロフィールを保存しました', 'success'); }
    else { toast('保存に失敗しました', 'error'); }
  });

  // Load firm settings (email from)
  try {
    const res = await apiFetch('/api/firms/current');
    if (res.ok) {
      const firm = await res.json();
      const settings = firm.settings || {};
      const emailFromInput = document.getElementById('emailFromInput');
      if (emailFromInput) emailFromInput.value = settings.outreachEmailFrom || '';
    }
  } catch (_e) {}

  document.getElementById('saveSettingsBtn')?.addEventListener('click', async () => {
    const emailFrom = document.getElementById('emailFromInput')?.value?.trim() ?? '';
    const res = await apiFetch('/api/firms/current', {
      method: 'PATCH',
      body: JSON.stringify({ settings: { outreachEmailFrom: emailFrom } }),
    });
    if (res.ok) { toast('設定を保存しました', 'success'); }
    else { toast('保存に失敗しました', 'error'); }
  });

  // Load members
  await loadMembers();

  // Load activity
  await loadActivity();
})();

// ── Members ───────────────────────────────────────────────────────────
async function loadMembers() {
  const wrap = document.getElementById('memberTableWrap');
  const countEl = document.getElementById('memberCount');
  try {
    const res = await apiFetch('/api/firms/current/members');
    if (!res.ok) {
      if (wrap) wrap.innerHTML = '<p class="empty-msg">メンバー一覧の取得に失敗しました</p>';
      return;
    }
    const members = await res.json();
    if (countEl) countEl.textContent = members.length + '名';
    if (!wrap) return;
    if (members.length === 0) {
      wrap.innerHTML = '<p class="empty-msg">メンバーがいません</p>';
      return;
    }
    let html = '<table class="member-table">';
    html += '<thead><tr><th>メールアドレス</th><th>表示名</th><th>ロール</th><th>ステータス</th><th></th></tr></thead><tbody>';
    for (const m of members) {
      const roleLabel = m.role === 'owner' ? 'owner' : 'member';
      const statusLabel = m.status === 'active' ? '有効' : m.status === 'invited' ? '招待中' : '削除済';
      html += '<tr>';
      html += '<td>' + esc(m.email) + '</td>';
      html += '<td>' + esc(m.displayName || '—') + '</td>';
      html += '<td><span class="role-badge ' + esc(roleLabel) + '">' + esc(roleLabel) + '</span></td>';
      html += '<td>' + esc(statusLabel) + '</td>';
      html += '<td>';
      if (m.status !== 'removed') {
        html += '<button class="btn-danger" data-remove-mid="' + esc(m.id) + '">削除</button>';
      }
      html += '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('[data-remove-mid]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('このメンバーを削除しますか？')) return;
        const mid = btn.dataset.removeMid;
        const r = await apiFetch('/api/firms/current/members/' + mid, { method: 'DELETE' });
        if (r.ok || r.status === 204) {
          toast('メンバーを削除しました', 'success');
          await loadMembers();
        } else {
          toast('削除に失敗しました', 'error');
        }
      });
    });
  } catch (_e) {
    if (wrap) wrap.innerHTML = '<p class="empty-msg">読み込みエラーが発生しました</p>';
  }
}

// Invite
document.getElementById('inviteBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('inviteEmail')?.value?.trim() ?? '';
  if (!email) { toast('メールアドレスを入力してください', 'error'); return; }
  const btn = document.getElementById('inviteBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await apiFetch('/api/firms/current/invite', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (res.ok || res.status === 201) {
      toast(email + ' を招待しました', 'success');
      const input = document.getElementById('inviteEmail');
      if (input) input.value = '';
      await loadMembers();
    } else {
      const body = await res.json().catch(() => ({}));
      toast('招待に失敗しました: ' + (body?.error?.code || res.status), 'error');
    }
  } catch (_e) {
    toast('招待に失敗しました', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ── Activity log ──────────────────────────────────────────────────────
async function loadActivity() {
  const listEl = document.getElementById('activityList');
  try {
    const res = await apiFetch('/api/firms/current/activity');
    if (!res.ok) {
      if (listEl) listEl.innerHTML = '<p class="empty-msg">アクティビティの取得に失敗しました</p>';
      return;
    }
    const threads = await res.json();
    if (!listEl) return;
    if (threads.length === 0) {
      listEl.innerHTML = '<p class="empty-msg">まだ顧問先への連絡はありません</p>';
      return;
    }
    let html = '<div class="activity-list">';
    for (const t of threads) {
      const dateStr = t.sentAt
        ? new Date(t.sentAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : t.createdAt
          ? new Date(t.createdAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })
          : '';
      const channelLabel = t.channel === 'email' ? 'メール' : t.channel === 'line' ? 'LINE' : t.channel === 'chatwork' ? 'CW' : t.channel;
      const statusLabel = t.status === 'sent' ? '送信済' : t.status === 'replied' ? '返信あり' : t.status === 'pending' ? '未送信' : t.status;
      html += '<div class="activity-item">';
      html += '<div class="activity-dot"></div>';
      html += '<div class="activity-main">';
      html += '<div class="activity-subject">';
      html += '<span class="channel-badge">' + esc(channelLabel) + '</span>';
      html += esc(t.subject || t.preview || '（件名なし）');
      html += '</div>';
      html += '<div class="activity-meta">' + esc(statusLabel) + ' · ' + esc(dateStr) + '</div>';
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
    listEl.innerHTML = html;
  } catch (_e) {
    if (listEl) listEl.innerHTML = '<p class="empty-msg">読み込みエラーが発生しました</p>';
  }
}
