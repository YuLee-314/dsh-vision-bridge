/**
 * lib/queue.js — FIFO 并发限制信号量 (v2.2.0)
 * 所有视觉推理调用统一串行,防止模型被并发工具调用压垮(显存/算力独占)。
 * 使用: const q = createQueue(1); await q(() => callVisionAPI(...));
 */
export function createQueue(concurrency = 1) {
  let running = 0;
  const waiting = [];
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        running++;
        fn().then(resolve, reject).finally(() => {
          running--;
          const next = waiting.shift();
          if (next) next();
        });
      };
      if (running < concurrency) run();
      else waiting.push(run);
    });
}
