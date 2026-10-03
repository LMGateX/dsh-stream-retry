import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply, Config } from '../index.js';

function install(config = Config({})) {
  let handler;
  const cleanups = [];
  const logs = [];
  const ctx = {
    on(event, callback) { assert.equal(event, 'llm/stream'); handler = callback; },
    effect(job) { const cleanup = job(); if (cleanup) cleanups.push(cleanup); },
    logger: { info(...args) { logs.push(args); } },
  };
  apply(ctx, config);
  return { handler, logs, dispose() { for (const cleanup of cleanups) cleanup(); } };
}

async function runStream(chunks, config = {}, options = { provider: 'test-provider' }) {
  const mounted = install(Config(config));
  let calls = 0;
  const next = () => { calls++; return (async function* () { yield* chunks; })(); };
  const output = [];
  for await (const chunk of mounted.handler(options, next)) output.push(chunk);
  assert.equal(calls, 1, 'Middleware must not retry next() itself');
  return { output, logs: mounted.logs };
}

const failure = (code, message, extras = {}) => Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'error', failure: Object.freeze({ code, message, ...extras }) }) });

test('a preset code recovers independently of its descriptive message', async () => {
  const input = failure('PI_AI_ERROR', 'Error Code upstream_stream_read_error: a completely different description');
  const { output } = await runStream([input]);
  assert.equal(output[0].reason.failure.code, 'TRANSPORT');
  assert.equal(output[0].reason.failure.message, input.reason.failure.message);
  assert.equal(input.reason.failure.code, 'PI_AI_ERROR');
});

test('protected permanent failures cannot be opted into retry', async () => {
  for (const code of ['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'ABORTED', 'INVALID_CONFIG', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'INVALID_CREDENTIAL', 'invalid_api_key']) {
    const input = failure(code, 'Error Code upstream_stream_read_error: anything');
    assert.equal((await runStream([input], { errorCodes: [code, 'upstream_stream_read_error'] })).output[0], input, code);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    const input = failure('PI_AI_ERROR', 'Error Code upstream_stream_read_error: anything', { status });
    assert.equal((await runStream([input])).output[0], input, 'HTTP ' + status);
  }
});

test('existing normalized retry codes keep the provider policy classification', async () => {
  for (const code of ['TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE']) {
    const input = failure(code, 'Error Code upstream_stream_read_error: another description');
    assert.equal((await runStream([input], { errorCodes: [code, 'upstream_stream_read_error'] })).output[0], input, code);
  }
});

test('three literal presets work as structured codes and known outer formats', async () => {
  for (const code of ['upstream_stream_read_error', 'stream_timeout', 'stream error']) {
    const variants = [failure(code, 'description does not match'), failure('PI_AI_ERROR', 'Error Code ' + code + ': any description'), failure('PI_AI_ERROR', code + ': changed'), failure('PI_AI_ERROR', code)];
    for (const input of variants) assert.equal((await runStream([input])).output[0].reason.failure.code, 'TRANSPORT');
  }
});

test('editable lists replace presets; provider routes are exact and an empty code list disables mapping', async () => {
  const custom = failure('PI_AI_ERROR', 'Error Code gateway_disconnect: message');
  const options = { provider: 'allowed' };
  assert.equal((await runStream([custom], { errorCodes: ['gateway_disconnect'], providers: ['allowed'] }, options)).output[0].reason.failure.code, 'TRANSPORT');
  for (const providers of [['other'], ['Allowed']]) assert.equal((await runStream([custom], { errorCodes: ['gateway_disconnect'], providers }, options)).output[0], custom);
  assert.equal((await runStream([custom], { errorCodes: [] }, options)).output[0], custom);
  const preset = failure('upstream_stream_read_error', 'message');
  assert.equal((await runStream([preset], { errorCodes: ['gateway_disconnect'] }, options)).output[0], preset);
});

test('bare-message matching cannot bypass protected or generic carrier codes', async () => {
  for (const code of ['AUTH', 'invalid_api_key', 'INVALID_REQUEST']) {
    const input = failure('PI_AI_ERROR', code);
    assert.equal((await runStream([input], { errorCodes: [code] })).output[0], input);
  }
  const generic = failure('PI_AI_ERROR', 'An unrelated opaque provider error');
  assert.equal((await runStream([generic], { errorCodes: ['PI_AI_ERROR'] })).output[0], generic);
});

test('settings reject empty codes, template text, multiline entries and invalid lists', () => {
  const tick = String.fromCharCode(96);
  for (const value of ['', '   ', 'with:description', 'two' + String.fromCharCode(10) + 'lines', '"quoted"', tick + 'quoted' + tick]) assert.throws(() => Config({ errorCodes: [value] }));
  assert.throws(() => Config({ errorCodes: [17] }));
  assert.throws(() => Config({ errorCodes: Array(101).fill('foo') }));
  assert.throws(() => Config({ providers: [''] }));
  assert.throws(() => Config({ providers: ['two routes'] }));
});

test('only complete outer identifiers match; descriptions and quoted text are not searched', async () => {
  const messages = [
    'Error Code upstream_stream_read_error_extra: x', 'Error Code prefix_upstream_stream_read_error: x',
    'Error Code UPSTREAM_STREAM_READ_ERROR: x', 'Error Code invalid_request: upstream_stream_read_error',
    'Error Code stream error extra: x', 'stream error occurred in a prompt', 'stream_error: x', 'stream  error: x',
    'stream' + String.fromCharCode(9) + 'error: x', 'The prompt said "Error Code stream error: x"',
    '"Error Code upstream_stream_read_error: x"', String.fromCharCode(0) + 'Error Code upstream_stream_read_error: x',
    'ordinary first line' + String.fromCharCode(10) + 'Error Code upstream_stream_read_error: x',
    '{"error":{"code":"invalid_request","message":"stream error"}}',
    '{"prompt":{"code":"upstream_stream_read_error"}}', 'generic provider failure',
  ];
  for (const carrier of ['PI_AI_ERROR', 'UNKNOWN', 'STREAM_CLOSED']) for (const message of messages) {
    const input = failure(carrier, message);
    assert.equal((await runStream([input])).output[0], input, carrier + ': ' + JSON.stringify(message));
  }
  const nonCarrier = failure('SOME_OTHER_ERROR', 'Error Code upstream_stream_read_error: x');
  assert.equal((await runStream([nonCarrier])).output[0], nonCarrier);
});

test('all failure and replay fields survive remapping, and logs omit descriptions', async () => {
  const input = Object.freeze({ ...failure('PI_AI_ERROR', 'stream error: SENSITIVE_DESCRIPTION', { status: 502, providerRetryAfterMs: 75, requestId: 'request-123', offloadImages: 2 }), replayState: { secret: 'opaque-replay' } });
  const { output, logs } = await runStream([input]);
  assert.deepEqual(output[0], { ...input, reason: { ...input.reason, failure: { ...input.reason.failure, code: 'TRANSPORT' } } });
  assert(!JSON.stringify(logs).includes('SENSITIVE_DESCRIPTION'));
  assert(!JSON.stringify(logs).includes('opaque-replay'));
});

test('text, successful finishes, aborted finishes and canceled requests pass through', async () => {
  const text = Object.freeze({ type: 'text-delta', index: 0, text: 'Error Code upstream_stream_read_error: x' });
  const stop = Object.freeze({ type: 'finish', reason: { kind: 'stop' } });
  const tool = Object.freeze({ type: 'finish', reason: { kind: 'tool-calls' } });
  const aborted = Object.freeze({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'upstream_stream_read_error', message: 'x' } } });
  const chunks = [text, stop, tool, aborted];
  assert.deepEqual((await runStream(chunks)).output, chunks);
  const input = failure('upstream_stream_read_error', 'x');
  assert.equal((await runStream([input], {}, { provider: 'test-provider', signal: AbortSignal.abort() })).output[0], input);
});

test('upstream middleware exceptions propagate unchanged', async () => {
  const { handler } = install();
  const primary = new Error('plugin failed');
  const next = async function* () { throw primary; };
  await assert.rejects(async () => { for await (const _chunk of handler({ provider: 'test-provider' }, next)) {} }, error => error === primary);
});

test('live config references are reread for each terminal error', async () => {
  let codes = ['upstream_stream_read_error'];
  let providers = [];
  const { handler } = install({ errorCodes: { get: () => codes }, providers: { get: () => providers } });
  const input = failure('upstream_stream_read_error', 'x');
  const collect = async () => { const items = []; for await (const item of handler({ provider: 'test' }, async function* () { yield input; })) items.push(item); return items[0]; };
  assert.equal((await collect()).reason.failure.code, 'TRANSPORT');
  codes = [];
  assert.equal(await collect(), input);
  codes = ['upstream_stream_read_error']; providers = ['other'];
  assert.equal(await collect(), input);
});

test('unloading stops previously captured streams from making new compatibility mappings', async () => {
  const mounted = install();
  const input = failure('upstream_stream_read_error', 'x');
  const source = async function* () { yield { type: 'text-delta', index: 0, text: 'partial' }; yield input; };
  const iterator = mounted.handler({ provider: 'test' }, source)[Symbol.asyncIterator]();
  await iterator.next();
  mounted.dispose();
  assert.equal((await iterator.next()).value, input);
  assert.equal(mounted.logs.length, 0);
});
