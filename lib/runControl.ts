// pause / resume / stop for one analysis run (see analyzeTab in entrypoints/background.ts).
// pausing or stopping only stops NEW work from starting: requests already sent finish and their results are saved

// how often to poke the browser while paused: an MV3 service worker is shut down after ~30s without extension
// events/API calls, which would lose the paused run (Chrome resets that timer on any extension API call)
const KEEP_ALIVE_MS = 20 * 1000;

export class RunControl {
  paused = false;
  stopped = false;
  private waiters: (() => void)[] = []; // callers of waitIfPaused, released on resume/stop
  private keepAliveTimer?: ReturnType<typeof setInterval>;

  // `keepAlive`: a cheap extension API call, made every KEEP_ALIVE_MS while paused
  constructor(private keepAlive: () => void) {}

  pause() {
    if (this.stopped) return;
    this.paused = true;
    this.keepAliveTimer ??= setInterval(this.keepAlive, KEEP_ALIVE_MS);
  }

  resume() {
    this.paused = false;
    this.release();
  }

  stop() {
    this.stopped = true;
    this.paused = false;
    this.release();
  }

  // resolves right away unless paused; otherwise once resumed or stopped (check `stopped` after awaiting)
  waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
