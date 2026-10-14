/** Bounded per-process admission, shared across Next route bundles. */
export class TaskLimiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private concurrency: number, private maxQueued: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.queue.length >= this.maxQueued) throw new Error('Processing busy; try again later');
      await new Promise<void>((resolve, reject) => {
        const enter = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          this.queue = this.queue.filter(item => item !== enter);
          reject(new Error('Processing queue timed out'));
        }, 30000);
        this.queue.push(enter);
      });
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next(); // Transfer this slot without allowing a new arrival to steal it.
      else this.active--;
    }
  }
}

export const getTaskLimiter = (name: string, concurrency: number, maxQueued: number) => {
  const state = globalThis as typeof globalThis & { archiveTaskLimiters?: Map<string, TaskLimiter> };
  state.archiveTaskLimiters ??= new Map();
  if (!state.archiveTaskLimiters.has(name)) state.archiveTaskLimiters.set(name, new TaskLimiter(concurrency, maxQueued));
  return state.archiveTaskLimiters.get(name)!;
};
