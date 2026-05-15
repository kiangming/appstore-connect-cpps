/**
 * Simple bounded-concurrency helper for orchestrating N async tasks with at
 * most K running in parallel.
 *
 * Chosen over `p-limit` to avoid the dep + because the surface area we need
 * is small (CLAUDE.md "Don't add features beyond what the task requires").
 *
 * Used by bulk-import execute orchestration to keep parallel Apple API calls
 * under control (Manager investigation lock: 5 parallel for IAP submit).
 */

export async function withConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error("withConcurrency: limit must be ≥ 1");
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}
