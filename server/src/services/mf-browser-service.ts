/**
 * mf-browser-service.ts — Spec 20
 *
 * Playwright headless Chrome + GPT-4 Vision を使って MoneyForward Cloud Accounting
 * の仕訳帳に自動入力する。
 *
 * 処理フロー:
 *   1. Playwright で Chromium を起動
 *   2. MF にメールアドレス / パスワードでログイン
 *   3. 仕訳帳の新規作成フォームへ遷移
 *   4. GPT-4 Vision でスクリーンショットを解析し、操作手順を生成
 *   5. 操作を順次実行
 *   6. Voucher.mfWriteStatus を更新し、LINE で完了 / 失敗を通知
 */

import { chromium, type Page } from 'playwright';
import OpenAI from 'openai';
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import * as lineService from './line-service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DraftJournal {
  transactionDate?: string;
  debit?: { account?: string; subAccount?: string; amount?: number; taxClass?: string };
  credit?: { account?: string; subAccount?: string; amount?: number; taxClass?: string };
  description?: string;
  amount?: number;
  account?: string;
}

interface GptAction {
  type: 'click' | 'fill' | 'select' | 'submit' | 'wait' | 'navigate';
  selector?: string;
  value?: string;
  url?: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MF_LOGIN_URL = 'https://id.moneyforward.com/sign_in';
const MF_ACCOUNTING_HOME = 'https://accounting.moneyforward.com/';

// ---------------------------------------------------------------------------
// OpenAI helper
// ---------------------------------------------------------------------------

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return _openai;
}

/**
 * スクリーンショットを GPT-4 Vision に送り、次に取るべきアクション列を JSON で受け取る。
 */
async function askGptForActions(
  screenshotBuffer: Buffer,
  task: string,
  data: Record<string, string>,
): Promise<GptAction[]> {
  const base64 = screenshotBuffer.toString('base64');
  const openai = getOpenAI();

  const systemPrompt = `You are a browser automation assistant for MoneyForward Cloud Accounting (マネーフォワードクラウド会計).
Your job is to analyze a screenshot and return the exact sequence of browser actions needed to complete a task.
Return ONLY a JSON array of action objects. Each object must have:
- type: "click" | "fill" | "select" | "submit" | "wait" | "navigate"
- selector: CSS selector or XPath (for click/fill/select/submit)
- value: text to type or option to select (for fill/select)
- url: URL to navigate to (for navigate)
- description: brief description of the action

Use the most specific, stable selectors possible (IDs, data attributes, aria labels).
If the page shows an error or unexpected state, return a single action: { type: "wait", description: "unexpected state: <describe what you see>" }`;

  const userPrompt = `Task: ${task}
Data to enter: ${JSON.stringify(data, null, 2)}

Look at the screenshot and return the JSON array of actions to perform.`;

  try {
    const response = await openai.chat.completions.create({
      model: env.OPENAI_VISION_MODEL || 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' },
            },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
      max_tokens: 1500,
    });

    const content = response.choices[0].message.content ?? '[]';
    // Strip markdown code fences if GPT wraps in ```json
    const cleaned = content.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned) as GptAction[];
  } catch (err) {
    logger.warn({ err }, 'mf-browser: GPT action generation failed');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Page interaction helpers
// ---------------------------------------------------------------------------

async function executeAction(page: Page, action: GptAction): Promise<void> {
  logger.info({ action }, 'mf-browser: executing action');

  switch (action.type) {
    case 'navigate':
      if (action.url) await page.goto(action.url, { waitUntil: 'networkidle', timeout: 30_000 });
      break;
    case 'click':
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: 10_000 });
        await page.click(action.selector);
      }
      break;
    case 'fill':
      if (action.selector && action.value !== undefined) {
        await page.waitForSelector(action.selector, { timeout: 10_000 });
        await page.fill(action.selector, action.value);
      }
      break;
    case 'select':
      if (action.selector && action.value !== undefined) {
        await page.waitForSelector(action.selector, { timeout: 10_000 });
        await page.selectOption(action.selector, { label: action.value });
      }
      break;
    case 'submit':
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: 10_000 });
        await page.click(action.selector);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      }
      break;
    case 'wait':
      // GPT indicated unexpected state — pause briefly
      await page.waitForTimeout(2_000);
      break;
    default:
      logger.warn({ action }, 'mf-browser: unknown action type');
  }
}

// ---------------------------------------------------------------------------
// MF login
// ---------------------------------------------------------------------------

async function loginToMf(page: Page): Promise<void> {
  await page.goto(MF_LOGIN_URL, { waitUntil: 'networkidle', timeout: 30_000 });

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
  const actions = await askGptForActions(
    screenshot,
    'Log in to MoneyForward with email and password',
    { email: env.MF_EMAIL, password: env.MF_PASSWORD },
  );

  for (const action of actions) {
    await executeAction(page, action);
    await page.waitForTimeout(800);
  }

  // Wait for navigation away from login page
  await page.waitForURL((url) => !url.toString().includes('sign_in'), {
    timeout: 30_000,
  }).catch(() => {
    throw new Error('MF login failed — still on sign_in page after actions');
  });
}

// ---------------------------------------------------------------------------
// Journal entry
// ---------------------------------------------------------------------------

async function enterJournal(page: Page, draft: DraftJournal): Promise<void> {
  // Navigate to accounting app home first
  await page.goto(MF_ACCOUNTING_HOME, { waitUntil: 'networkidle', timeout: 30_000 });

  // Build the data dict for GPT
  const journalData: Record<string, string> = {
    date: draft.transactionDate ?? new Date().toISOString().slice(0, 10),
    debit_account: draft.debit?.account ?? draft.account ?? '',
    credit_account: draft.credit?.account ?? '現金',
    amount: String(draft.debit?.amount ?? draft.amount ?? 0),
    description: draft.description ?? '',
  };
  if (draft.debit?.subAccount) journalData.debit_sub_account = draft.debit.subAccount;
  if (draft.credit?.subAccount) journalData.credit_sub_account = draft.credit.subAccount;
  if (draft.debit?.taxClass) journalData.tax_class = draft.debit.taxClass;

  // Step 1: find and click "新規作成" / "仕訳を追加" button
  const homeScreenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
  const navActions = await askGptForActions(
    homeScreenshot,
    'Navigate to the journal entry creation form. Click the button to create a new manual journal entry (手動仕訳 or 仕訳を追加 or 新規作成).',
    journalData,
  );
  for (const action of navActions) {
    await executeAction(page, action);
    await page.waitForTimeout(800);
  }

  // Step 2: fill the form
  await page.waitForTimeout(1_500);
  const formScreenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
  const fillActions = await askGptForActions(
    formScreenshot,
    'Fill in the journal entry form with the provided data and submit it.',
    journalData,
  );
  for (const action of fillActions) {
    await executeAction(page, action);
    await page.waitForTimeout(500);
  }

  // Step 3: verify success
  await page.waitForTimeout(2_000);
  const resultScreenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
  const verifyActions = await askGptForActions(
    resultScreenshot,
    'Check if the journal entry was successfully saved. If there is a success message or the form was cleared, it was successful. If there is an error, describe it.',
    {},
  );

  const hasError = verifyActions.some(
    (a) => a.type === 'wait' && a.description.toLowerCase().includes('error'),
  );
  if (hasError) {
    const errorDesc = verifyActions.find((a) => a.type === 'wait')?.description ?? 'unknown error';
    throw new Error(`MF journal entry verification failed: ${errorDesc}`);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * MoneyForward に仕訳を自動入力する。
 * LINE の postback で "はい" を受けた後、setImmediate 経由で呼ばれる。
 */
export async function writeJournalToMf(voucherId: string): Promise<void> {
  if (!env.MF_EMAIL || !env.MF_PASSWORD) {
    await prisma.voucher.update({
      where: { id: voucherId },
      data: {
        mfWriteStatus: 'failed',
        mfWriteError: 'MF_EMAIL / MF_PASSWORD が設定されていません。',
        mfWriteAt: new Date(),
      },
    });
    await sendLineResult(voucherId, false, 'MF_EMAIL / MF_PASSWORD が未設定です。');
    return;
  }

  const voucher = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { id: true, lineUserId: true, draftJournalJson: true },
  });
  if (!voucher) return;

  await prisma.voucher.update({
    where: { id: voucherId },
    data: { mfWriteStatus: 'writing', mfWriteAt: new Date() },
  });

  const draft = (voucher.draftJournalJson ?? {}) as DraftJournal;

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'ja-JP',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await loginToMf(page);
    await enterJournal(page, draft);

    await prisma.voucher.update({
      where: { id: voucherId },
      data: { mfWriteStatus: 'done', mfWriteAt: new Date(), mfWriteError: null },
    });
    await sendLineResult(voucherId, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, voucherId }, 'mf-browser: writeJournalToMf failed');
    await prisma.voucher.update({
      where: { id: voucherId },
      data: { mfWriteStatus: 'failed', mfWriteError: msg.slice(0, 500), mfWriteAt: new Date() },
    });
    await sendLineResult(voucherId, false, msg.slice(0, 100));
  } finally {
    await browser.close();
  }
}

async function sendLineResult(
  voucherId: string,
  success: boolean,
  errorMsg?: string,
): Promise<void> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  const v = await prisma.voucher.findUnique({
    where: { id: voucherId },
    select: { lineUserId: true },
  });
  if (!v?.lineUserId) return;

  const text = success
    ? 'MoneyForwardへの仕訳入力が完了しました ✅'
    : `MoneyForwardへの入力に失敗しました ❌${errorMsg ? `\n${errorMsg}` : ''}`;

  await lineService.pushMessage(v.lineUserId, [{ type: 'text', text }]);
}
