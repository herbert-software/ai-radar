/**
 * 快照安全存储单测（task 7.5，design D13）。用临时目录，不入 mr_*。
 * 覆盖：源标识含 ../ 仍落隔离 base-dir（安全派生 id）+ 原子写可读回 + janitor 删过期 + 字节上限拒新写。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.DATABASE_URL ||= 'postgres://u:p@localhost:5432/test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token';
process.env.TELEGRAM_CHAT_ID ||= 'test-chat';
process.env.LLM_API_KEY ||= 'test-key';
process.env.LLM_MODEL ||= 'openai/gpt-4o-mini';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.PRODUCT_HUNT_TOKEN ||= 'test-ph-token';

const { writeSnapshot, readSnapshot, janitorSnapshots, snapshotId } = await import('../snapshot.js');

let baseDir: string;

beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-snap-'));
});
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

describe('writeSnapshot / readSnapshot', () => {
  it('源标识含 ../ 仍落隔离 base-dir（安全派生 id）', async () => {
    const evilId = '../../etc/passwd';
    const ok = await writeSnapshot(evilId, 'price content', { baseDir });
    expect(ok).toBe(true);

    // 落盘文件名是 sha256(id) 纯 hex，不含路径分隔。
    const files = await fs.readdir(baseDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(snapshotId(evilId));
    expect(files[0]).toMatch(/^[0-9a-f]{64}$/);

    // 读回一致；base-dir 外无逃逸文件。
    expect(await readSnapshot(evilId, { baseDir })).toBe('price content');
  });

  it('原子写覆盖（last-writer-wins），无 .tmp 残留', async () => {
    await writeSnapshot('s1', 'v1', { baseDir });
    await writeSnapshot('s1', 'v2', { baseDir });
    expect(await readSnapshot('s1', { baseDir })).toBe('v2');
    const files = await fs.readdir(baseDir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});

describe('janitor', () => {
  it('删超 TTL 的快照', async () => {
    await writeSnapshot('old', 'x', { baseDir });
    // now 推到远未来 → 视作过期。
    const deleted = await janitorSnapshots({ baseDir, ttlMs: 1000, now: Date.now() + 10_000_000 });
    expect(deleted).toBe(1);
    expect(await readSnapshot('old', { baseDir })).toBeNull();
  });

  it('未过期不删', async () => {
    await writeSnapshot('fresh', 'x', { baseDir });
    const deleted = await janitorSnapshots({ baseDir, ttlMs: 60_000, now: Date.now() });
    expect(deleted).toBe(0);
    expect(await readSnapshot('fresh', { baseDir })).toBe('x');
  });
});

describe('字节上限', () => {
  it('命中总字节上限 → 拒新写（返回 false）', async () => {
    // 上限极小：首写占满后再写被拒。
    const ok1 = await writeSnapshot('a', 'xxxxxxxxxx', { baseDir, maxTotalBytes: 12 });
    expect(ok1).toBe(true);
    const ok2 = await writeSnapshot('b', 'yyyyyyyyyy', { baseDir, maxTotalBytes: 12 });
    expect(ok2).toBe(false); // 现有 10 + 新 10 > 12，janitor 无过期可删 → 拒。
    // 被拒的源无快照文件。
    expect(await readSnapshot('b', { baseDir })).toBeNull();
  });
});
