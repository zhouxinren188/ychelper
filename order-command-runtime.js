'use strict';

const { PROTOCOL_VERSION, COMMAND_DEFINITIONS } = require('./order-command-protocol');
const { OrderCommandExecutor } = require('./order-command-executor');

const DISABLED_TRANSPORT = Object.freeze({
  enabled: false,
  state: 'disabled',
  reason: 'central_service_not_configured'
});

function getDisabledCapabilities() {
  return Object.keys(COMMAND_DEFINITIONS).map(command => {
    const definition = COMMAND_DEFINITIONS[command];
    return {
      command,
      enabled: false,
      mode: definition.mode,
      max_ttl_ms: definition.maxTtlMs,
      requires_confirmation: definition.requiresConfirmation,
      expected_status: definition.successStates ? definition.successStates[0] : null
    };
  });
}

function getMachineCodePendingStatus() {
  return {
    protocol_version: PROTOCOL_VERSION,
    generated: false,
    machine_code: '',
    online: false,
    transport: {
      enabled: false,
      state: 'disabled',
      reason: 'machine_code_not_generated'
    },
    capabilities: getDisabledCapabilities()
  };
}

class OrderCommandRuntime {
  constructor(options = {}) {
    this.machineCode = String(options.machineCode || '');
    this.executor = new OrderCommandExecutor(options);
  }

  getStatus() {
    return {
      protocol_version: PROTOCOL_VERSION,
      generated: true,
      machine_code: this.machineCode,
      online: false,
      transport: { ...DISABLED_TRANSPORT },
      capabilities: this.executor.getCapabilities()
    };
  }

  executeTask(task, context) {
    return this.executor.executeTask(task, context);
  }
}

module.exports = {
  DISABLED_TRANSPORT,
  getDisabledCapabilities,
  getMachineCodePendingStatus,
  OrderCommandRuntime
};
