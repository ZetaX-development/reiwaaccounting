import { describe, expect, it } from 'vitest';
import { chunkKnowledgeMarkdown } from '../../src/services/knowledge-chunker.js';

const SAMPLE = `# 20260520_004

> 文字起こし

---

## p.3 ｜ はじめに

本書の説明文。

---

## p.5-? ｜ 目次

目次の中身。

---

## p.32 ｜ 1-01 租税公課（そぜいこうか）［個人／法人］

> 消費税区分：**対象外**（課税／非課税）

税金の支払い。

| 借方 | 金額 | 貸方 | 金額 |
|------|------|------|------|
| 租税公課 | 50,000 | 現金 | 50,000 |

（次頁に続く）

---

## p.33

| 借方 | 金額 | 貸方 | 金額 |
|------|------|------|------|
| 貯蔵品 | 30,000 | 租税公課 | 30,000 |
`;

describe('chunkKnowledgeMarkdown', () => {
  it('excludes front matter (はじめに / 目次) and keeps account sections', () => {
    const chunks = chunkKnowledgeMarkdown(SAMPLE, 'siwake-jiten');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.title).toBe('1-01 租税公課（そぜいこうか）［個人／法人］');
  });

  it('merges continuation pages and records a page range', () => {
    const chunk = chunkKnowledgeMarkdown(SAMPLE, 'siwake-jiten')[0]!;
    expect(chunk.page).toBe('p.32-33');
    expect(chunk.content).toContain('租税公課');
    expect(chunk.content).toContain('貯蔵品'); // p.33 本文も結合
  });

  it('excludes table headers and date cells from accounts', () => {
    const md = `## p.16 ｜ クレジットカードで購入したとき ［個人／法人］

| 日付 | 借方 | Aの金額 | 貸方 |
|------|------|---------|------|
| 4/5 | 消耗品費 | 3,000 | 未払金 |
`;
    const chunk = chunkKnowledgeMarkdown(md, 'siwake-jiten')[0]!;
    expect(chunk.accounts).not.toContain('日付');
    expect(chunk.accounts).not.toContain('4/5');
    expect(chunk.accounts).not.toContain('Aの金額');
  });

  it('extracts accounts, taxClass and 個人/法人 tags', () => {
    const chunk = chunkKnowledgeMarkdown(SAMPLE, 'siwake-jiten')[0]!;
    expect(chunk.accounts).toContain('租税公課'); // タイトル由来
    expect(chunk.accounts).toContain('現金'); // 表セル由来
    expect(chunk.accounts).toContain('貯蔵品');
    expect(chunk.taxClass).toBe('対象外');
    expect(chunk.tags).toEqual(expect.arrayContaining(['個人', '法人']));
    expect(chunk.source).toBe('siwake-jiten');
  });
});
