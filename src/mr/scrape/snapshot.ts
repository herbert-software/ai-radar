/**
 * Model Radar（P5 / 5b，design D13）抓取文本快照安全存储（供人 diff，**best-effort 证据**）。
 *
 * flag **不依赖**快照存活（过期人重抓）；快照只为人工复核时看「哪段变了」。安全契约：
 * - **存储键 = 安全派生 id**（`sha256(source_id)`）：禁止把 `source_url`/厂商名拼进路径（防穿越）。
 *   即便 source_id 含 `../`/斜杠，sha256 出纯 hex，落盘文件名恒安全。
 * - **越界断言**（纵深防御）：写前 `path.resolve(base, id).startsWith(base + sep)`，拒任何越界。
 * - **原子写**：写 `<id>.tmp`（与目标同 base-dir 保 rename 同文件系统原子）+ `rename`——
 *   并发同源 last-writer-wins 可接受，**绝不让 diff 读到半截文件**；处理 ENOSPC（写满不崩主流程）。
 * - **不可执行字节**：以 `octet-stream`/纯文本落盘（无渲染路径，防二阶 stored-XSS——nosniff/attachment 属 5c 渲染边界）。
 * - **TTL + janitor**：陈旧度/cron 扫删过期快照 + 总字节上限防本地 DoS；命中字节上限拒新写。
 *
 * 不入任何 `mr_*` 列、不引新依赖（对象存储留 5c）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { env } from '../../config/env.js';

/** 安全派生快照 id：`sha256(source_id)` hex（纯 [0-9a-f]，落盘文件名恒安全）。 */
export function snapshotId(sourceId: string): string {
  return createHash('sha256').update(sourceId, 'utf8').digest('hex');
}

/** 解析快照文件绝对路径，并断言落在 base-dir 内（拒越界，纵深防御）。 */
function resolveSnapshotPath(baseDir: string, id: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, id);
  // 越界断言：target 必在 base + sep 之下（或恰为 base，不可能因 id 非空）。
  if (!target.startsWith(base + path.sep)) {
    throw new Error('mr-snapshot: path traversal blocked');
  }
  return target;
}

/** 当前快照目录总字节（janitor 上限判定用）。 */
async function totalBytes(baseDir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return 0; // 目录不存在 = 0 字节。
  }
  for (const name of entries) {
    try {
      const st = await fs.stat(path.join(baseDir, name));
      if (st.isFile()) total += st.size;
    } catch {
      // 并发删除中的文件，忽略。
    }
  }
  return total;
}

/**
 * 原子写一份快照（best-effort）。命中总字节上限 → 拒新写（返回 false，不抛——快照非关键路径）。
 *
 * @returns true=写成功；false=被字节上限拒 / ENOSPC（主流程不受影响）。
 */
export async function writeSnapshot(
  sourceId: string,
  content: string,
  opts: { baseDir?: string; maxTotalBytes?: number } = {},
): Promise<boolean> {
  const baseDir = path.resolve(opts.baseDir ?? env.MR_SNAPSHOT_DIR);
  const maxTotal = opts.maxTotalBytes ?? env.MR_SNAPSHOT_MAX_TOTAL_BYTES;
  const id = snapshotId(sourceId);
  const finalPath = resolveSnapshotPath(baseDir, id);
  // 每次写用唯一 tmp（同 base-dir 保 rename 原子）：并发同源不互相覆盖/破坏对方的 rename。
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;

  await fs.mkdir(baseDir, { recursive: true });

  const incoming = Buffer.byteLength(content, 'utf8');
  // 字节上限：现有总量 + 本次 > 上限则先 janitor，仍超则拒（防本地 DoS，design D13）。
  if ((await totalBytes(baseDir)) + incoming > maxTotal) {
    await janitorSnapshots({ baseDir });
    if ((await totalBytes(baseDir)) + incoming > maxTotal) {
      return false; // 命中字节上限拒新写。
    }
  }

  try {
    // 不可执行字节：纯 utf8 文本落盘，无渲染路径（design D13）。
    await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmpPath, finalPath); // 原子替换（绝不让 diff 读半截）。
    return true;
  } catch (err) {
    // ENOSPC / 其它 IO 错：清 tmp，不崩主流程（快照 best-effort）。
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') return false;
    return false;
  }
}

/** 读一份快照（人工 diff 用）；不存在/过期返回 null。 */
export async function readSnapshot(
  sourceId: string,
  opts: { baseDir?: string } = {},
): Promise<string | null> {
  const baseDir = path.resolve(opts.baseDir ?? env.MR_SNAPSHOT_DIR);
  const finalPath = resolveSnapshotPath(baseDir, snapshotId(sourceId));
  try {
    return await fs.readFile(finalPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * janitor：扫删超 TTL 的快照 + （被 writeSnapshot 调时）腾字节空间。
 * 由陈旧度/cron 周期调（design D13）。返回删除文件数。
 */
export async function janitorSnapshots(
  opts: { baseDir?: string; ttlMs?: number; now?: number } = {},
): Promise<number> {
  const baseDir = path.resolve(opts.baseDir ?? env.MR_SNAPSHOT_DIR);
  const ttlMs = opts.ttlMs ?? env.MR_SNAPSHOT_TTL_MS;
  const now = opts.now ?? Date.now();
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of entries) {
    const full = path.join(baseDir, name);
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      // mtime 超 TTL（含遗留 .tmp）→ 删。
      if (now - st.mtimeMs > ttlMs) {
        await fs.rm(full, { force: true });
        deleted++;
      }
    } catch {
      // 并发删除竞态，忽略。
    }
  }
  return deleted;
}
