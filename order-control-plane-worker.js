'use strict';

const DEFAULT_EMPTY_RETRY_SECONDS = 1;
const DEFAULT_ERROR_RETRY_SECONDS = 5;

function clampSeconds(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function safeFailureReason(error) {
  const code = error && typeof error.code === 'string' ? error.code.trim().toLowerCase() : '';
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'command_service_error';
}

class OrderControlPlaneWorker {
  constructor(options = {}) {
    if (!options.client || !options.runner) {
      throw new Error('OrderControlPlaneWorker requires client and runner');
    }
    this.client = options.client;
    this.runner = options.runner;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
    this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
    this.logger = options.logger || console;
    this.running = false;
    this.generation = 0;
    this.timer = null;
    this.waitInFlight = false;
    this.waitAbortController = null;
    this.online = false;
    this.state = 'stopped';
    this.lastFailureReason = '';
    this.lastConnectedAt = '';
    this.lastTaskAt = '';
  }

  start() {
    if (this.running) return false;
    const clientStatus = this.client.getStatus();
    if (!clientStatus.configured || !clientStatus.authenticated) {
      this.state = !clientStatus.configured ? 'not_configured' : 'login_required';
      this.online = false;
      return false;
    }
    this.running = true;
    this.generation++;
    this.state = 'connecting';
    this.lastFailureReason = '';
    this._schedule(0, this.generation);
    return true;
  }

  stop() {
    this.running = false;
    this.generation++;
    this.online = false;
    this.state = 'stopped';
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.waitAbortController) this.waitAbortController.abort();
    this.waitAbortController = null;
  }

  getStatus() {
    return {
      running: this.running,
      online: this.online,
      state: this.state,
      last_failure_reason: this.lastFailureReason,
      last_connected_at: this.lastConnectedAt,
      last_task_at: this.lastTaskAt
    };
  }

  _isCurrent(generation) {
    return this.running && generation === this.generation;
  }

  _schedule(delayMs, generation) {
    if (!this._isCurrent(generation)) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this._wait(generation).catch(error => {
        this.logger.error('[order command] wait loop failed:', safeFailureReason(error));
      });
    }, Math.max(0, delayMs));
  }

  async _wait(generation) {
    if (!this._isCurrent(generation) || this.waitInFlight) return;
    this.waitInFlight = true;
    const waitAbortController = new AbortController();
    this.waitAbortController = waitAbortController;
    this.state = 'waiting';
    let nextDelaySeconds = 0;
    try {
      const result = await this.client.waitForCommand({
        capabilities: this.runner.runtime.executor.getCapabilities(),
        waitSeconds: 25,
        signal: waitAbortController.signal
      });
      if (!this._isCurrent(generation)) return;
      this.online = true;
      this.lastConnectedAt = new Date(this.now()).toISOString();
      this.lastFailureReason = '';
      if (!result.task) {
        this.state = 'waiting';
        nextDelaySeconds = clampSeconds(
          result.retry_after_seconds,
          DEFAULT_EMPTY_RETRY_SECONDS,
          0,
          10
        );
      } else {
        this.state = 'executing';
        await this.runner.runTask(result.task);
        if (!this._isCurrent(generation)) return;
        this.state = 'waiting';
        this.lastTaskAt = new Date(this.now()).toISOString();
      }
    } catch (error) {
      if (!this._isCurrent(generation)) return;
      this.online = false;
      this.lastFailureReason = safeFailureReason(error);
      this.state = ['executor_not_authenticated', 'executor_unauthorized', 'subscription_inactive']
        .includes(this.lastFailureReason)
        ? 'login_required'
        : 'reconnecting';
      nextDelaySeconds = DEFAULT_ERROR_RETRY_SECONDS;
    } finally {
      if (this.waitAbortController === waitAbortController) this.waitAbortController = null;
      this.waitInFlight = false;
      if (this._isCurrent(generation)) this._schedule(nextDelaySeconds * 1000, generation);
    }
  }
}

module.exports = {
  DEFAULT_EMPTY_RETRY_SECONDS,
  DEFAULT_ERROR_RETRY_SECONDS,
  OrderControlPlaneWorker,
  clampSeconds,
  safeFailureReason
};
