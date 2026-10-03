import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime, runTurn, events, attemptChunks, PARTIAL, llm, provider, runtimeVersion } from './runtime.mjs';

// Tracer bullet: real Cordis + real loop + actual product + official retry.
test('main agent retries the failed request in the same step with clean history', { timeout: 10000 }, async t => {
  // Never print the resolved local path: test logs are often published.
  t.diagnostic('Installed DSH ' + runtimeVersion + ' resolved from the configured runtime root');
  const runtime = await createRuntime();
  try {
    const handle = await runtime.createAgent({ sessionId: 'main-tracer', adapter: {
      failure: { code: 'PI_AI_ERROR', message: 'Error Code upstream_stream_read_error: Upstream response stream was interrupted' },
    } });
    const state = await runTurn(handle);
    assert.equal(state.requests.length, 2);
    assert(state.requests.every(request => request.frozen));
    const starts = state.frames.filter(frame => frame.type === 'start');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].turn, starts[1].turn);
    assert.equal(starts[0].step, starts[1].step);
    assert(state.frames.some(frame => frame.type === 'chunk' && frame.chunk.text === PARTIAL));
    assert.deepEqual(state.requests[1].messages, state.requests[0].messages);
    assert.equal(events(state, 'step/start').length, 1);
    assert.equal(events(state, 'llm/retry').length, 1);
    assert.equal(events(state, 'llm/retry-started').length, 1);
    assert.equal(events(state, 'turn/end').at(-1).data.reason.kind, 'completed');
    const attempt = events(state, 'assistant/attempt')[0];
    assert(attemptChunks(attempt).some(chunk => chunk.text === PARTIAL));
    assert.equal(attemptChunks(attempt).at(-1).reason.failure.code, 'TRANSPORT');
    assert(!JSON.stringify(handle.agent.session.deriveMessages()).includes(PARTIAL));
  } finally { await runtime.dispose(); }
});

async function faultCase(failure, { config, product, retry, adapter, expectRetry = true, expectedCode = 'TRANSPORT' } = {}) {
  const runtime = await createRuntime({ config, product, retry });
  try {
    const handle = await runtime.createAgent({ sessionId: 'fault-case', adapter: { failure, ...adapter } });
    const state = await runTurn(handle);
    assert.equal(state.requests.length, expectRetry ? 2 : 1);
    assert.equal(events(state, 'llm/retry').length, expectRetry ? 1 : 0);
    assert.equal(events(state, 'turn/end').at(-1).data.reason.kind, expectRetry ? 'completed' : 'error');
    const chunks = attemptChunks(events(state, 'assistant/attempt')[0]);
    assert.equal(chunks.at(-1).reason.failure.code, expectedCode);
    assert.equal(chunks.at(-1).reason.failure.message, failure.message);
    assert(!JSON.stringify(handle.agent.session.deriveMessages()).includes(PARTIAL));
    if (expectRetry) assert.deepEqual(state.requests[0].messages, state.requests[1].messages);
    return state;
  } finally { await runtime.dispose(); }
}

for (const raw of ['upstream_stream_read_error', 'stream_timeout', 'stream error']) {
  test('default raw code retries: ' + raw, { timeout: 10000 }, async () => {
    await faultCase({ code: raw, message: 'Provider description is deliberately unrelated to eligibility' });
  });
  test('PI_AI_ERROR outer marker retries independent of description: ' + raw, { timeout: 10000 }, async () => {
    for (const message of ['Error Code ' + raw + ': New upstream wording', raw + ': Completely changed detail', raw]) {
      await faultCase({ code: 'PI_AI_ERROR', message });
    }
  });
}

test('plain adapter Error is normalized to UNKNOWN and then retried by the real stream seam', { timeout: 10000 }, async () => {
  await faultCase(new Error('Error Code upstream_stream_read_error: actual adapter throw'));
});
test('adapter LlmError STREAM_CLOSED fixture is normalized and retried', { timeout: 10000 }, async () => {
  await faultCase(new llm.LlmError('stream_timeout: adapter closed fixture', 'STREAM_CLOSED'));
});

test('custom errorCodes replace defaults and providers scope the classification', { timeout: 10000 }, async () => {
  const custom = { code: 'PI_AI_ERROR', message: 'Error Code custom_stream_fault: description' };
  await faultCase(custom, { config: { errorCodes: ['custom_stream_fault'], providers: [provider] } });
  await faultCase(custom, { config: { errorCodes: ['custom_stream_fault'], providers: ['another-provider'] },
    expectRetry: false, expectedCode: 'PI_AI_ERROR' });
  await faultCase({ code: 'stream_timeout', message: 'stream_timeout' }, {
    config: { errorCodes: ['custom_stream_fault'] }, expectRetry: false, expectedCode: 'stream_timeout' });
  await faultCase({ code: 'stream_timeout', message: 'stream_timeout' }, {
    config: { errorCodes: [] }, expectRetry: false, expectedCode: 'stream_timeout' });
});

for (const fixture of [
  { code: 'PI_AI_ERROR', message: 'ordinary application failure' },
  { code: 'PI_AI_ERROR', message: 'Documentation quotes Error Code stream_timeout: as an example' },
  { code: 'UNKNOWN', message: 'A diagnostic references upstream_stream_read_error but is not that failure' },
  { code: 'STREAM_CLOSED', message: 'A quoted "stream error" should not match' },
  { code: 'UNRELATED', message: 'Error Code stream_timeout: not an allowed carrier' },
  { code: 'AUTH', message: 'Error Code stream_timeout: authentication stays permanent' },
  { code: 'QUOTA', message: 'Error Code stream_timeout: quota stays permanent' },
  { code: 'INVALID_REQUEST', message: 'Error Code stream_timeout: invalid request stays permanent' },
  { code: 'PI_AI_ERROR', message: 'stream_timeout: unauthorized', status: 401 },
]) {
  test('ordinary/reference/permanent failure passes through: ' + fixture.code + ' / ' + fixture.message,
    { timeout: 10000 }, async () => {
      await faultCase(fixture, { expectRetry: false, expectedCode: fixture.code });
    });
}

test('plain thrown ordinary Error remains UNKNOWN without retry', { timeout: 10000 }, async () => {
  await faultCase(new Error('This merely mentions stream_timeout in documentation'), {
    expectRetry: false, expectedCode: 'UNKNOWN' });
});
for (const code of ['TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE']) {
  test('existing official retry code is preserved: ' + code, { timeout: 10000 }, async () => {
    await faultCase({ code, message: 'Error Code stream_timeout: already classified' }, { expectedCode: code });
  });
}

test('product does not own a retry loop: without official retry there is no redispatch', { timeout: 10000 }, async () => {
  await faultCase({ code: 'stream_timeout', message: 'stream_timeout' }, {
    retry: false, expectRetry: false, expectedCode: 'TRANSPORT' });
});
test('official retry alone does not treat provider raw codes as retryable', { timeout: 10000 }, async () => {
  await faultCase({ code: 'stream_timeout', message: 'stream_timeout' }, {
    product: false, expectRetry: false, expectedCode: 'stream_timeout' });
});

test('official maxRetries=2 exhausts after exactly three adapter calls in one step', { timeout: 10000 }, async () => {
  const runtime = await createRuntime();
  try {
    const handle = await runtime.createAgent({ sessionId: 'budget', adapter: {
      failure: { code: 'stream_timeout', message: 'stream_timeout: repeated failure' }, failures: Infinity, maxRetries: 2,
    } });
    const state = await runTurn(handle);
    assert.equal(state.requests.length, 3);
    assert.equal(events(state, 'llm/retry').length, 2);
    assert.equal(events(state, 'llm/retry-started').length, 2);
    assert.deepEqual(events(state, 'llm/retry').map(event => event.data.retry), [1, 2]);
    assert(events(state, 'llm/retry').every(event => event.data.maxRetries === 2 && event.data.delayMs === 1));
    assert.equal(new Set(events(state, 'llm/retry').map(event => event.data.retryId)).size, 1);
    assert.equal(events(state, 'assistant/attempt').length, 3);
    assert.equal(events(state, 'step/start').length, 1);
    assert.equal(events(state, 'turn/end').at(-1).data.reason.kind, 'error');
    assert.deepEqual(state.requests[1].messages, state.requests[0].messages);
    assert.deepEqual(state.requests[2].messages, state.requests[0].messages);
    assert(!JSON.stringify(handle.agent.session.deriveMessages()).includes(PARTIAL));
  } finally { await runtime.dispose(); }
});

test('AbortSignal cancels official backoff without another adapter dispatch', { timeout: 10000 }, async () => {
  const runtime = await createRuntime();
  try {
    const handle = await runtime.createAgent({ sessionId: 'cancel-backoff', adapter: {
      failure: { code: 'stream_timeout', message: 'stream_timeout' }, failures: Infinity, delayMs: 60000,
    } });
    let canceled = false;
    const remove = runtime.ctx.on('session/event', (session, event) => {
      if (session.id === handle.agent.id && event.type === 'llm/retry') {
        // Schedule from the durable event, not a sleep: official retry enters its
        // cancellable wait before this microtask fires. No timer is substituted.
        queueMicrotask(() => { canceled = true; handle.agent.cancel({ kind: 'user' }); });
      }
    });
    try {
      const state = await runTurn(handle);
      assert(canceled);
      assert.equal(state.requests.length, 1);
      assert.equal(state.requests[0].signal.aborted, true);
      assert.equal(events(state, 'llm/retry').length, 1);
      assert.equal(events(state, 'llm/retry')[0].data.delayMs, 60000);
      assert.equal(events(state, 'llm/retry-started').length, 0);
      assert.equal(events(state, 'turn/end').at(-1).data.reason.kind, 'aborted');
    } finally { remove(); }
  } finally { await runtime.dispose(); }
});

// These call the real public subagent service/providers, not model-facing
// dsh-tool-subagent (tool argument validation/UI dispatch is deliberately out of scope).
for (const kind of ['spawn', 'fork']) {
  test('actual in-process ' + kind + ' child automatically reuses product and official retry',
    { timeout: 10000 }, async () => {
      const runtime = await createRuntime({ subagents: true });
      let run;
      try {
        const parent = await runtime.createAgent({ sessionId: kind + '-parent', route: kind + '-parent-route',
          adapter: { failures: 0 } });
        await runTurn(parent, 'PARENT_CONTEXT_INHERITANCE_SENTINEL');
        const childRoute = kind + '-child-route';
        const state = runtime.registerMock(childRoute, {
          failure: new Error('Error Code upstream_stream_read_error: child adapter threw'),
        });
        run = await runtime.ctx.subagents.start(kind, { parent: parent.agent,
          label: 'Real ' + kind + ' integration child', signal: new AbortController().signal,
          prompt: [{ type: 'text', text: 'CHILD_DELEGATION_PROMPT' }],
          agentOptions: { provider: childRoute, model: 'integration-model' },
        });
        const result = await run.result;
        assert.equal(result.stopReason, 'completed');
        assert.deepEqual(result.output, [{ type: 'text', text: 'RECOVERED_OK' }]);
        assert(run.localAgent, 'Provider must publish an actual same-process child Agent');
        assert.equal(run.localAgent.session.header.parentSession, parent.agent.id);
        assert.equal(runtime.ctx.agents.get(run.id), run.localAgent);
        assert.equal(state.requests.length, 2);
        assert.equal(events(state, 'llm/retry').length, 1);
        assert.equal(events(state, 'llm/retry-started').length, 1);
        assert.equal(events(state, 'assistant/attempt').length, 1);
        assert.equal(events(state, 'step/start').length, 1);
        assert.deepEqual(state.requests[1].messages, state.requests[0].messages);
        assert.equal(JSON.stringify(state.requests[0].messages).includes('PARENT_CONTEXT_INHERITANCE_SENTINEL'), kind === 'fork');
        assert(!JSON.stringify(state.requests).includes(PARTIAL));
        assert(!JSON.stringify(run.localAgent.session.deriveMessages()).includes(PARTIAL));
        const failure = attemptChunks(events(state, 'assistant/attempt')[0]).at(-1).reason.failure;
        assert.equal(failure.code, 'TRANSPORT');
        assert.equal(events(parent.state, 'llm/retry').length, 0);
        assert.equal(parent.state.requests.length, 1);
      } finally {
        if (run) await run.dispose();
        await runtime.dispose();
      }
    });
}

test('parallel real children keep retry budget and failed partial history isolated', { timeout: 10000 }, async () => {
  const runtime = await createRuntime({ subagents: true });
  const runs = [];
  try {
    const parent = await runtime.createAgent({ sessionId: 'parallel-parent', route: 'parallel-parent-route', adapter: { failures: 0 } });
    const failure = { code: 'stream_timeout', message: 'stream_timeout: repeated child failure' };
    const noBudget = runtime.registerMock('child-no-budget', { failure, failures: Infinity, maxRetries: 0 });
    const twoBudget = runtime.registerMock('child-two-budget', { failure, failures: Infinity, maxRetries: 2 });
    // Both public starts are admitted together; keep every returned run owned even
    // if another branch rejects, so cleanup cannot leak a published Agent.
    const started = await Promise.allSettled(['child-no-budget', 'child-two-budget'].map(route =>
      runtime.ctx.subagents.start('spawn', { parent: parent.agent, signal: new AbortController().signal,
        prompt: [{ type: 'text', text: route }], agentOptions: { provider: route, model: 'integration-model' },
      }).then(run => { runs.push(run); return run; })));
    assert(started.every(result => result.status === 'fulfilled'));
    const results = await Promise.all(runs.map(run => run.result));
    assert(results.every(result => result.stopReason === 'error'));
    assert.equal(noBudget.requests.length, 1);
    assert.equal(events(noBudget, 'llm/retry').length, 0);
    assert.equal(twoBudget.requests.length, 3);
    assert.deepEqual(events(twoBudget, 'llm/retry').map(event => event.data.retry), [1, 2]);
    for (const state of [noBudget, twoBudget]) {
      assert.equal(events(state, 'step/start').length, 1);
      assert(!JSON.stringify(state.requests).includes(PARTIAL));
      assert.equal(events(state, 'assistant/attempt').length, state.requests.length);
    }
    assert.equal(parent.state.requests.length, 0);
    assert.equal(events(parent.state, 'llm/retry').length, 0);
  } finally {
    await Promise.all(runs.map(run => run.dispose()));
    await runtime.dispose();
  }
});

function waitForSubagentEnd(ctx, childId) {
  const completion = Promise.withResolvers();
  const remove = ctx.on('subagent/end', info => {
    if (info.id === childId) { remove(); completion.resolve(info); }
  });
  return { promise: completion.promise, dispose: remove };
}

test('real continuable child retries again after persisted settlement and public sendMessage cold resume',
  { timeout: 15000 }, async () => {
    // JSONL storage is an isolated mkdtemp directory, removed on teardown;
    // neither an installed profile nor a fake persistence service is involved.
    const runtime = await createRuntime({ subagents: true, persistent: true });
    const waiters = [];
    try {
      const parent = await runtime.createAgent({ sessionId: 'continuable-parent', route: 'continuable-parent-route', adapter: { failures: 0 } });
      const route = 'continuable-child-route';
      const state = runtime.registerMock(route, {
        failure: new llm.LlmError('stream error: continuable adapter closed fixture', 'STREAM_CLOSED'),
        failures: [1, 3], maxRetries: 1,
      });
      const childId = 'continuable-real-child';
      const firstEnd = waitForSubagentEnd(runtime.ctx, childId);
      waiters.push(firstEnd);
      const first = await runtime.ctx.subagents.startContinuable({ provider: 'spawn', label: 'Integration continuable child',
        childId, signal: new AbortController().signal,
        request: { parent: parent.agent, prompt: [{ type: 'text', text: 'CONTINUABLE_FIRST_PROMPT' }],
          agentOptions: { provider: route, model: 'integration-model' } },
      });
      assert.equal(first.childId, childId);
      assert(first.messageId);
      assert.equal((await firstEnd.promise).stopReason, 'completed');
      assert.equal(state.requests.length, 2);
      assert.equal(runtime.ctx.agents.get(childId), undefined, 'First activation really settled and released its live Agent');
      const stored = await runtime.ctx.sessionPersistence.stat(childId);
      assert.equal(stored.header.parentSession, parent.agent.id);
      const secondEnd = waitForSubagentEnd(runtime.ctx, childId);
      waiters.push(secondEnd);
      const messageId = await runtime.ctx.subagents.sendMessage(parent.agent, childId,
        [{ type: 'text', text: 'CONTINUABLE_SECOND_PROMPT' }], { signal: new AbortController().signal });
      assert(messageId);
      assert.equal((await secondEnd.promise).stopReason, 'completed');
      assert.equal(state.requests.length, 4);
      assert.equal(events(state, 'assistant/attempt').length, 2);
      assert.equal(events(state, 'llm/retry').length, 2);
      assert.deepEqual(events(state, 'llm/retry').map(event => event.data.retry), [1, 1], 'Retry budget resets on the next child turn');
      assert.equal(new Set(events(state, 'llm/retry').map(event => event.data.retryId)).size, 2);
      assert.deepEqual(state.requests[1].messages, state.requests[0].messages);
      assert.deepEqual(state.requests[3].messages, state.requests[2].messages);
      const resumedMessages = JSON.stringify(state.requests[2].messages);
      assert(resumedMessages.includes('CONTINUABLE_FIRST_PROMPT'));
      assert(resumedMessages.includes('CONTINUABLE_SECOND_PROMPT'));
      assert(!JSON.stringify(state.requests).includes(PARTIAL));
      assert.equal(events(state, 'turn/end').length, 2);
      assert(events(state, 'turn/end').every(event => event.data.reason.kind === 'completed'));
      await parent.agent.whenIdle();
      assert.equal(events(parent.state, 'llm/retry').length, 0);
    } finally {
      for (const waiter of waiters) waiter.dispose();
      await runtime.dispose();
    }
  });


test('failed partial then successful retry tool-call executes the real tool exactly once', { timeout: 10000 }, async () => {
  const runtime = await createRuntime();
  try {
    let executions = 0;
    runtime.ctx.tools.register({
      name: 'integration_count_once', description: 'Count one deterministic in-process execution with no external effects.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'integer' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() { return ++executions; },
    });
    const handle = await runtime.createAgent({ sessionId: 'retry-tool-once', adapter: {
      failure: { code: 'PI_AI_ERROR', message: 'Error Code upstream_stream_read_error: original stream interrupted' },
      tool: 'integration_count_once',
    } });
    const state = await runTurn(handle, 'Execute integration_count_once, then finish.');
    assert.equal(state.requests.length, 3, 'Failed attempt, successful tool retry, final post-tool response');
    assert.equal(executions, 1);
    assert.equal(events(state, 'tool/result').length, 1);
    assert.equal(events(state, 'llm/retry').length, 1);
    assert.equal(events(state, 'llm/retry-started').length, 1);
    assert.equal(events(state, 'assistant/attempt').length, 1);
    assert.equal(events(state, 'assistant/message').length, 2);
    assert.equal(events(state, 'step/start').length, 2, 'Only the tool result opens the next step');
    assert.equal(events(state, 'turn/end').at(-1).data.reason.kind, 'completed');
    assert.deepEqual(state.requests[1].messages, state.requests[0].messages);
    assert(state.requests[2].messages.some(message => message.role === 'tool'));
    assert(!JSON.stringify(state.requests).includes(PARTIAL));
    const failed = events(state, 'assistant/attempt')[0];
    const success = events(state, 'assistant/message')[0];
    assert.equal(failed.data.turn, success.data.turn);
    assert.equal(failed.data.step, success.data.step);
    assert(attemptChunks(failed).some(chunk => chunk.text === PARTIAL));
    assert.equal(attemptChunks(failed).at(-1).reason.failure.code, 'TRANSPORT');
    assert(!JSON.stringify(handle.agent.session.deriveMessages()).includes(PARTIAL));
  } finally { await runtime.dispose(); }
});
