'use strict';

const { getCommandDefinition } = require('./order-command-protocol');

class OrderControlPlaneRunner {
  constructor(options = {}) {
    if (!options.client || !options.runtime) {
      throw new Error('OrderControlPlaneRunner requires client and runtime');
    }
    this.client = options.client;
    this.runtime = options.runtime;
  }

  async runTask(task) {
    if (!task || !task.task_id) throw new Error('Missing command task');
    if (!getCommandDefinition(task.command)) throw new Error('Command is not in the fixed allowlist');

    // Local receipts and order locks guarantee that redelivery only replays the
    // immutable result and never repeats an already executed write operation.
    const response = await this.runtime.executeTask(task);
    const receipt = await this.client.reportResult(task, response);
    return { response, receipt };
  }

  async waitAndRun(options = {}) {
    const waited = await this.client.waitForCommand({
      capabilities: this.runtime.executor.getCapabilities(),
      waitSeconds: options.waitSeconds === undefined ? 25 : options.waitSeconds
    });
    if (!waited.task) {
      return { empty: true, retry_after_seconds: waited.retry_after_seconds };
    }
    return this.runTask(waited.task);
  }
}

module.exports = { OrderControlPlaneRunner };
