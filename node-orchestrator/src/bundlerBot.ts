import fetch from 'node-fetch';

interface BundlerTask {
  tokenAddress: string;
  amountBNB: string;
  slippage: number;
  deadlineSecs: number;
}

interface BundlerBotConfig {
  executorUrl: string;
  concurrency?: number;
  onResult?: (task: BundlerTask, result: any) => void;
}

/**
 * BundlerBot — handles multiple buy operations concurrently,
 * distributing load safely to the Rust executor via HTTP calls.
 */
export class BundlerBot {
  private executorUrl: string;
  private concurrency: number;
  private onResult?: (task: BundlerTask, result: any) => void;

  private queue: BundlerTask[] = [];
  private active = 0;
  private running = false;

  constructor(config: BundlerBotConfig) {
    this.executorUrl = config.executorUrl;
    this.concurrency = config.concurrency || 3;
    this.onResult = config.onResult;
  }

  public addTask(task: BundlerTask) {
    this.queue.push(task);
    if (!this.running) this.runLoop();
  }

  private async runLoop() {
    this.running = true;
    while (this.queue.length > 0 || this.active > 0) {
      while (this.active < this.concurrency && this.queue.length > 0) {
        const task = this.queue.shift()!;
        this.runTask(task);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.running = false;
  }

  private async runTask(task: BundlerTask) {
    this.active++;
    try {
      const res = await fetch(`${this.executorUrl}/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task),
      });
      const data = await res.json().catch(() => ({ error: 'Invalid JSON response' }));
      console.log(`[BundlerBot] Completed task for ${task.tokenAddress}:`, data);
      if (this.onResult) this.onResult(task, data);
    } catch (err) {
      console.error(`[BundlerBot] Task failed for ${task.tokenAddress}`, err);
    } finally {
      this.active--;
    }
  }
}
