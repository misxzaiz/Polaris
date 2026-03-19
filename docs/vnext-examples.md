# Polaris Scheduler vNext - Usage Examples

This document provides practical examples for using the vNext Event Driven Multi-Agent Workflow Engine.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Workflow Creation](#workflow-creation)
3. [State Machine](#state-machine)
4. [Event Bus](#event-bus)
5. [Executor](#executor)
6. [Memory System](#memory-system)
7. [Plugin System](#plugin-system)
8. [Complete Example](#complete-example)

---

## Quick Start

```typescript
import {
  WorkflowRuntime,
  createBenchmarkWorkflow,
  PluginManager,
  loggingPlugin,
} from '@polaris/vnext';

// Create runtime with default configuration
const runtime = new WorkflowRuntime();

// Register a workflow
const workflow = createBenchmarkWorkflow(5);
await runtime.registerWorkflow(workflow);

// Start execution
await runtime.start();

// Monitor progress
runtime.on('nodeCompleted', (event) => {
  console.log(`Node ${event.nodeId} completed`);
});

// Wait for completion
await runtime.waitForCompletion();
```

---

## Workflow Creation

### Basic Workflow

```typescript
import { Workflow, WorkflowNode } from '@polaris/vnext';

const nodes: WorkflowNode[] = [
  {
    id: 'node-1',
    name: 'Initialize',
    type: 'task',
    status: 'idle',
    dependencies: [],
    createdAt: Date.now(),
    config: { priority: 10 },
  },
  {
    id: 'node-2',
    name: 'Process',
    type: 'task',
    status: 'idle',
    dependencies: ['node-1'],
    createdAt: Date.now(),
    config: { priority: 5 },
  },
  {
    id: 'node-3',
    name: 'Finalize',
    type: 'task',
    status: 'idle',
    dependencies: ['node-2'],
    createdAt: Date.now(),
    config: { priority: 1 },
  },
];

const workflow: Workflow = {
  id: 'my-workflow',
  name: 'My Workflow',
  version: '1.0.0',
  status: 'idle',
  nodes,
  edges: [
    { id: 'edge-1', source: 'node-1', target: 'node-2' },
    { id: 'edge-2', source: 'node-2', target: 'node-3' },
  ],
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
```

### Using Templates

```typescript
import { TemplateEngine, getTemplateEngine } from '@polaris/vnext';

const engine = getTemplateEngine();

// Get built-in workflow template
const devPipeline = engine.getWorkflowTemplate('dev-pipeline');

// Render with variables
const result = engine.renderWorkflowTemplate('dev-pipeline', {
  projectName: 'my-project',
  features: ['auth', 'api', 'ui'],
});

if (result.success) {
  console.log('Rendered workflow:', result.content);
}
```

---

## State Machine

### Workflow State Transitions

```typescript
import {
  canTransitionWorkflow,
  getValidWorkflowTransitions,
  WorkflowStateMachine,
} from '@polaris/vnext';

// Check if transition is valid
if (canTransitionWorkflow('idle', 'running')) {
  console.log('Can start workflow');
}

// Get all valid transitions
const validTransitions = getValidWorkflowTransitions('running');
// Returns: ['paused', 'completed', 'failed', 'cancelled']

// Using the state machine class
const sm = new WorkflowStateMachine();
const result = sm.transition('idle', 'running');
console.log(result.success); // true
```

### Node State Transitions

```typescript
import {
  canTransitionNode,
  canNodeBeReady,
  getReadyNodes,
} from '@polaris/vnext';

// Check if node can be ready
const nodes = [...]; // Array of workflow nodes
const pendingEvents = []; // Array of pending events

const readyNodes = getReadyNodes(nodes, pendingEvents);
console.log(`${readyNodes.length} nodes are ready to execute`);
```

---

## Event Bus

### Basic Usage

```typescript
import { EventBus } from '@polaris/vnext';

const bus = new EventBus();

// Subscribe to events
const unsubscribe = bus.subscribe('task.completed', (event) => {
  console.log('Task completed:', event.payload);
});

// Emit an event
bus.emit(
  'task.completed',
  { taskId: 'task-1', result: 'success' },
  { workflowId: 'workflow-1' }
);

// Unsubscribe
unsubscribe();
```

### Multiple Subscribers

```typescript
const bus = new EventBus();

// Subscribe to multiple events
bus.subscribeMultiple(['task.started', 'task.completed'], (event) => {
  console.log(`Event ${event.type}:`, event.payload);
});

// Subscribe to all events
bus.subscribeAll((event) => {
  console.log('Received event:', event.type);
});
```

---

## Executor

### Continuous Execution

```typescript
import {
  ContinuousExecutor,
  DefaultNodeSelector,
} from '@polaris/vnext';

const executor = new ContinuousExecutor({
  maxIterations: 100,
  iterationDelay: 100,
});

// Set node selector
const selector = new DefaultNodeSelector('priority');
executor.setNodeSelector(selector);

// Define node executor
executor.setNodeExecutor(async (context) => {
  console.log('Executing node:', context.node.name);

  // Simulate work
  await new Promise(resolve => setTimeout(resolve, 100));

  return {
    success: true,
    output: { result: 'completed' },
  };
});

// Run executor
const result = await executor.run({
  workflow: myWorkflow,
  nodes: myNodes,
  pendingEvents: [],
});

console.log('Execution completed:', result.state);
```

---

## Memory System

### Memory Manager

```typescript
import { MemoryManager } from '@polaris/vnext';

const memory = new MemoryManager();

// Add entry to active layer
await memory.addEntry('workflow-1', 'active', {
  type: 'decision',
  content: 'Decided to use approach A over B',
  tags: ['architecture', 'decision'],
  tokenCount: 15,
});

// Get workflow state
const state = memory.getWorkflowState('workflow-1');
console.log('Completed tasks:', state.completed);
console.log('Current goal:', state.currentGoal);

// Create checkpoint
const checkpointId = await memory.createCheckpoint('workflow-1', 'before-refactor');

// Restore checkpoint
await memory.restoreCheckpoint('workflow-1', checkpointId);
```

### Memory Compression

```typescript
import { DefaultMemoryCompactor } from '@polaris/vnext';

const compactor = new DefaultMemoryCompactor({
  maxLines: 1000,
  maxTokens: 10000,
});

// Check if compression needed
if (compactor.needsCompaction(memory, 'workflow-1')) {
  const result = await compactor.compact(memory, 'workflow-1');
  console.log('Archived:', result.archivedCount, 'entries');
}
```

---

## Plugin System

### Registering Plugins

```typescript
import {
  PluginManager,
  loggingPlugin,
  metricsPlugin,
  cachingPlugin,
} from '@polaris/vnext';

const pluginManager = new PluginManager();

// Register built-in plugins
await pluginManager.register(loggingPlugin);
await pluginManager.register(metricsPlugin);
await pluginManager.register(cachingPlugin);

// Load all plugins
await pluginManager.loadAll();
```

### Custom Plugin

```typescript
import { Plugin } from '@polaris/vnext';

const myPlugin: Plugin = {
  meta: {
    id: 'my-custom-plugin',
    name: 'My Custom Plugin',
    version: '1.0.0',
    priority: 'high',
  },
  defaultConfig: {
    enabled: true,
  },
  hooks: {
    beforeNodeExecute: async (payload, context) => {
      context.logger.info('About to execute:', payload.node.name);
      return { continue: true };
    },
    afterNodeExecute: async (payload, context) => {
      if (payload.success) {
        context.logger.info('Node completed:', payload.node.name);
      }
      return { continue: true };
    },
  },
  init: (context) => {
    context.logger.info('Plugin initialized');
  },
};

await pluginManager.register(myPlugin);
await pluginManager.load('my-custom-plugin');
```

---

## Complete Example

### AI Development Pipeline

```typescript
import {
  WorkflowRuntime,
  PluginManager,
  loggingPlugin,
  metricsPlugin,
  TemplateEngine,
  MemoryManager,
} from '@polaris/vnext';

async function runDevPipeline() {
  // 1. Setup plugins
  const pluginManager = new PluginManager();
  await pluginManager.register(loggingPlugin);
  await pluginManager.register(metricsPlugin);
  await pluginManager.loadAll();

  // 2. Create workflow from template
  const templateEngine = new TemplateEngine();
  const workflowResult = templateEngine.renderWorkflowTemplate('dev-pipeline', {
    projectName: 'my-feature',
    features: ['auth', 'api'],
  });

  if (!workflowResult.success) {
    throw new Error('Failed to render workflow');
  }

  // 3. Initialize runtime
  const runtime = new WorkflowRuntime({
    maxConcurrency: 3,
    autoSave: true,
  });

  // 4. Setup memory
  const memory = new MemoryManager();

  // 5. Register workflow
  await runtime.registerWorkflow(workflowResult.content as any);

  // 6. Configure node executors
  runtime.setNodeExecutor('task', async (context) => {
    const { node, workflow } = context;

    // Log to memory
    await memory.addEntry(workflow.id, 'active', {
      type: 'note',
      content: `Starting task: ${node.name}`,
      tags: ['task', 'execution'],
      tokenCount: 10,
    });

    // Execute task logic here
    // ...

    return {
      success: true,
      output: { task: node.name, status: 'completed' },
    };
  });

  // 7. Start execution
  console.log('Starting pipeline...');
  await runtime.start();

  // 8. Wait for completion
  const result = await runtime.waitForCompletion();

  console.log('Pipeline completed:', result.status);

  // 9. Get metrics
  const metrics = await pluginManager.executeHook('getMetrics', {});
  console.log('Execution metrics:', metrics.data);

  return result;
}

runDevPipeline().catch(console.error);
```

---

## Performance Benchmarks

```typescript
import {
  runAllBenchmarks,
  BenchmarkSuite,
  runBenchmark,
} from '@polaris/vnext';

// Run all built-in benchmarks
const results = await runAllBenchmarks();

for (const suite of results) {
  console.log(`\n${suite.suite}:`);
  for (const benchmark of suite.benchmarks) {
    console.log(`  ${benchmark.name}: ${benchmark.opsPerSecond.toFixed(0)} ops/sec`);
  }
}

// Custom benchmark
const suite = new BenchmarkSuite('Custom Benchmarks')
  .add('my operation', () => {
    // Your code here
  });

const result = await suite.run();
console.log('Average time:', result.benchmarks[0].avgTime, 'ms');
```

---

## Error Handling

```typescript
import { ErrorRecovery, RecoveryStrategy } from '@polaris/vnext';

const errorRecovery = new ErrorRecovery();

// Configure recovery strategies
errorRecovery.configureStrategy('NETWORK', {
  strategy: RecoveryStrategy.RETRY_EXPONENTIAL,
  maxRetries: 3,
  baseDelay: 1000,
});

// Capture and handle errors
try {
  await runtime.start();
} catch (error) {
  const record = errorRecovery.captureException(error as Error, {
    workflowId: 'workflow-1',
  });

  const recoveryResult = await errorRecovery.attemptRecovery(record.id);
  console.log('Recovery result:', recoveryResult.status);
}
```

---

## Best Practices

1. **Always use WorkflowRuntime** for complete workflow execution
2. **Enable plugins** for logging and metrics in production
3. **Use MemoryManager** to maintain context across node executions
4. **Configure error recovery** for resilient workflows
5. **Monitor performance** with the benchmark suite
6. **Create checkpoints** before major operations
7. **Use templates** for consistent workflow definitions

---

## API Reference

For detailed API documentation, see the TypeScript definitions in `src/vnext/types/`.
