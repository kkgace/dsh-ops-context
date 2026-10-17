import test from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import {
  DEFAULTS,
  clipText,
  assertWorkspaceTarget,
  isExcludedEntry,
  isSensitivePath,
  isSearchableFile,
  observeSessionEvent,
  resolveWorkspaceRelative,
  runRead,
  runSearch,
} from '../src/core.js';
import { registerTools } from '../src/register.js';
import { createReadStateProjection } from '../src/session-state.js';

const readStateProjection = createReadStateProjection({ parse: (state) => state });

const signal = new AbortController().signal;

function makeFilesystem() {
  return {
    async resolve(path, options = {}) {
      return { targetKey: posix.resolve(options.cwd ?? '/', path) };
    },
    contains(root, target) {
      const relative = posix.relative(root.targetKey, target.targetKey);
      return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative));
    },
  };
}

const pathInWorkspace = (path) => posix.isAbsolute(path) ? path : posix.resolve('/workspace', path);
const filesystem = makeFilesystem();

test('workspace paths remain relative and reject traversal/absolute paths', () => {
  // Same logical assertions must hold for BOTH platform root styles.
  for (const root of ['/Users/alice/project', 'C:\\Users\\alice\\project']) {
    assert.equal(resolveWorkspaceRelative(root, 'src/file.ts'), 'src/file.ts');
    assert.equal(resolveWorkspaceRelative(root, '.'), '.');
    assert.throws(() => resolveWorkspaceRelative(root, '../secret'), /工作区外/);
    assert.throws(() => resolveWorkspaceRelative(root, '/Users/alice/secret'), /绝对路径/);
    assert.throws(() => resolveWorkspaceRelative(root, '..\\secret'), /工作区外/);
    assert.throws(() => resolveWorkspaceRelative(root, 'x\0y'), /相对路径/);
  }
});

test('resolveWorkspaceRelative accepts any non-empty root as an opaque prefix', () => {
  // Windows drive root, UNC root, and plain POSIX root all pass the root check.
  assert.equal(resolveWorkspaceRelative('C:\\Users\\me\\proj', 'a\\b.ts'), 'a/b.ts');
  assert.equal(resolveWorkspaceRelative('//server/share/proj', 'x.txt'), 'x.txt');
  assert.equal(resolveWorkspaceRelative('/opt/proj', 'x.txt'), 'x.txt');
  // Empty / missing root is rejected.
  assert.throws(() => resolveWorkspaceRelative('', 'x'), /有效的工作区根目录/);
  assert.throws(() => resolveWorkspaceRelative(undefined, 'x'), /有效的工作区根目录/);
});

test('Windows absolute and UNC inputs are rejected on any platform', () => {
  const root = '/Users/alice/project';
  assert.throws(() => resolveWorkspaceRelative(root, 'C:secret'), /绝对路径/);
  assert.throws(() => resolveWorkspaceRelative(root, 'C:\\secret'), /绝对路径/);
  assert.throws(() => resolveWorkspaceRelative(root, '\\\\server\\share'), /绝对路径/);
  assert.throws(() => resolveWorkspaceRelative(root, '/abs/secret'), /绝对路径/);
  // Lowercase drive letter too.
  assert.throws(() => resolveWorkspaceRelative(root, 'c:/secret'), /绝对路径/);
});

test('filesystem canonical paths are checked against symlink escapes', async () => {
  assert.equal(await assertWorkspaceTarget(filesystem, '/workspace', '/workspace/src/file.ts'), undefined);
  await assert.rejects(assertWorkspaceTarget(filesystem, '/workspace', '/outside/secret.txt'), /工作区之外/);
  await assert.rejects(assertWorkspaceTarget(filesystem, '/workspace', undefined), /规范路径/);
});

test('secret and generated paths are excluded from search', () => {
  assert.equal(isExcludedEntry('.env'), true);
  assert.equal(isExcludedEntry('id_rsa.pem'), true);
  assert.equal(isExcludedEntry('node_modules'), true);
  assert.equal(isExcludedEntry('.github'), true);
  assert.equal(isSensitivePath('config/passwords.json'), true);
  assert.equal(isSensitivePath('.'), false);
  assert.equal(isSensitivePath('.env.local'), true);
  for (const secretPath of ['.ssh/id_rsa', '.ssh/id_ed25519', '.npmrc', '.netrc', '.envrc', '.docker/config.json', 'id_rsa', 'signing.p8']) {
    assert.equal(isSensitivePath(secretPath), true, `${secretPath} should be blocked`);
  }
  assert.equal(isSensitivePath('src/tokenizer.ts'), false);
  assert.equal(isSearchableFile('main.ts'), true);
  assert.equal(isSearchableFile('photo.png'), false);
  assert.equal(isSearchableFile('.hidden.ts'), false);
});

test('Unicode output clipping does not split surrogate pairs', () => {
  const result = clipText('A😀B🧪C', 4);
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes('\ud83d') || result.text.includes('😀'));
  assert.ok(Array.from(result.text).length <= 4);
});

test('search is case-insensitive, bounded, relative, and reports truncation', async () => {
  const reads = [];
  const workspaceFiles = {
    async list(_scope, path) {
      if (path === '.') return { entries: [
        { name: 'src', type: 'directory' },
        { name: '.env', type: 'file' },
        { name: 'image.png', type: 'file' },
      ], truncated: false };
      if (path === 'src') return { entries: [
        { name: 'app.ts', type: 'file', size: 20 },
        { name: 'node_modules', type: 'directory' },
      ], truncated: false };
      throw new Error(`unexpected directory ${path}`);
    },
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read(_scope, path, range) {
      reads.push(path);
      assert.ok(range.offset >= 1);
      return { absolutePath: path, offset: 1, lines: 3, eof: true, version: 'v1', text: 'const X = 1;\nTarget here\nTARGET again' };
    },
  };
  const result = await runSearch({ workspaceFiles, filesystem, scope: { workspaceRoot: '/workspace', sessionId: 's' }, signal, config: {
    ...DEFAULTS, maxSearchFiles: 1, maxSearchMatches: 1,
  } }, { query: 'target' });
  assert.deepEqual(reads, ['/workspace/src/app.ts']);
  assert.equal(result.matches, 1);
  assert.match(result.rendered, /src\/app\.ts:2: Target here/);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.rendered, /\/workspace/);
});

test('context_search rejects explicit hidden credential directories before listing', async () => {
  let listings = 0;
  const workspaceFiles = {
    async list() { listings += 1; return { entries: [], truncated: false }; },
  };
  for (const path of ['.docker', '.aws', '.ssh', 'src/.github']) {
    await assert.rejects(runSearch({
      workspaceFiles,
      filesystem,
      scope: { workspaceRoot: '/workspace', sessionId: 's' },
      signal,
      config: DEFAULTS,
    }, { query: 'token', path }), /隐藏配置或凭据/);
  }
  assert.equal(listings, 0);
});

test('search enforces directory budget and propagates read cancellation', async () => {
  let lists = 0;
  const controller = new AbortController();
  const workspaceFiles = {
    async list() {
      lists += 1;
      return { entries: [{ name: `dir-${lists}`, type: 'directory' }], truncated: false };
    },
    async read() {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  };
  const result = await runSearch({
    workspaceFiles,
    filesystem,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    signal,
    config: { ...DEFAULTS, maxSearchDirs: 2 },
  }, { query: 'needle' });
  assert.equal(lists, 2);
  assert.equal(result.truncated, true);
  const fileWorkspace = {
    async list() { return { entries: [{ name: 'a.ts', type: 'file' }], truncated: false }; },
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read() {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  };
  await assert.rejects(runSearch({
    workspaceFiles: fileWorkspace,
    filesystem,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    signal: controller.signal,
    config: DEFAULTS,
  }, { query: 'needle' }), /aborted/);
});

test('search reports unreadable candidates instead of claiming zero matches', async () => {
  const workspaceFiles = {
    async list() { return { entries: [{ name: 'broken.ts', type: 'file' }], truncated: false }; },
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read() { throw new Error('not UTF-8 text'); },
  };
  const result = await runSearch({
    workspaceFiles,
    filesystem,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    signal,
    config: DEFAULTS,
  }, { query: 'missing' });
  assert.equal(result.matches, 0);
  assert.equal(result.skippedFiles, 1);
  assert.deepEqual(result.skippedPaths, ['broken.ts']);
  assert.equal(result.truncated, true);
  assert.match(result.rendered, /跳过 1 个文件、0 个目录（broken\.ts）/);
  assert.match(result.rendered, /context_read 显式读取/);
});

test('search aggregates same-line occurrences with a ×count marker', async () => {
  const workspaceFiles = {
    async list() { return { entries: [{ name: 'bundle.js', type: 'file', size: 200 }], truncated: false }; },
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read() {
      return { absolutePath: pathInWorkspace('bundle.js'), offset: 1, lines: 2, eof: true, version: 'v1', text: 'no hit line\nalpha BETA alpha beta ALPHA' };
    },
  };
  const result = await runSearch({
    workspaceFiles,
    filesystem,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    signal,
    config: DEFAULTS,
  }, { query: 'alpha' });
  assert.equal(result.matches, 1);
  assert.equal(result.occurrences, 3);
  assert.match(result.rendered, /bundle\.js:2\(×3\): alpha BETA alpha beta ALPHA/);
});

test('search reveals credential-named files as blocked paths without reading them', async () => {
  const readCalls = [];
  const workspaceFiles = {
    async list(_scope, path) {
      if (path === '.') return { entries: [{ name: 'app', type: 'directory' }], truncated: false };
      if (path === 'app') return { entries: [
        { name: 'id_rsa', type: 'file', size: 10 },
        { name: '.env.local', type: 'file', size: 10 },
        { name: 'keep.ts', type: 'file', size: 10 },
      ], truncated: false };
      throw new Error(`unexpected ${path}`);
    },
    async stat(_scope, path) { readCalls.push(path); return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read(_scope, path) { readCalls.push(path); return { absolutePath: path, offset: 1, lines: 1, eof: true, version: 'v1', text: 'keep hit' }; },
  };
  const result = await runSearch({
    workspaceFiles,
    filesystem,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    signal,
    config: DEFAULTS,
  }, { query: 'hit' });
  assert.deepEqual(result.blockedPaths, ['app/id_rsa', 'app/.env.local']);
  assert.deepEqual(readCalls, ['app/keep.ts', '/workspace/app/keep.ts']);
  assert.match(result.rendered, /app\/id_rsa、app\/\.env\.local/);
  assert.match(result.rendered, /仅列出文件名，内容一律不读取/);
});

test('complete scan reports a no-omission marker instead of an incomplete note', async () => {
  const workspaceFiles = {
    async list() { return { entries: [{ name: 'a.ts', type: 'file', size: 10 }], truncated: false }; },
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read() { return { absolutePath: pathInWorkspace('a.ts'), offset: 1, lines: 1, eof: true, version: 'v1', text: 'needle here' }; },
  };
  const result = await runSearch({
    workspaceFiles,
    filesystem,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    signal,
    config: DEFAULTS,
  }, { query: 'needle' });
  assert.equal(result.truncated, false);
  assert.match(result.rendered, /全量扫描：1 个文件、1 个目录，共 1 处命中，无遗漏/);
  assert.doesNotMatch(result.rendered, /搜索不完整/);
});

test('context_read blocks sensitive files before filesystem access', async () => {
  let calls = 0;
  const workspaceFiles = {
    async stat() { calls += 1; throw new Error('must not stat secrets'); },
    async read() { calls += 1; throw new Error('must not read secrets'); },
  };
  const request = {
    workspaceFiles,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    cache: new Map(),
    signal,
    config: DEFAULTS,
  };
  for (const path of ['.env.local', '.ssh/id_rsa', '.ssh/id_ed25519', '.npmrc', '.netrc', '.envrc', '.docker/config.json', 'id_rsa', 'signing.p8']) {
    await assert.rejects(runRead(request, { path }), /隐藏配置或凭据/);
  }
  assert.equal(calls, 0);
});

function makeSession({ id = 'session-test', cwd = '/workspace' } = {}) {
  return { header: { id, cwd } };
}

function readState(turn = 4, compactionGeneration = 0) {
  return { turn, compactionGeneration };
}

test('context_read rejects canonical targets outside workspace before reading content', async () => {
  let reads = 0;
  const workspaceFiles = {
    async stat() { return { absolutePath: '/outside/private.ts', version: 'v1' }; },
    async read() { reads += 1; throw new Error('must not read outside workspace'); },
  };
  await assert.rejects(runRead({
    workspaceFiles,
    filesystem,
    scope: { workspaceRoot: '/workspace', sessionId: 's' },
    sessionState: readState(),
    cache: new Map(),
    signal,
    config: DEFAULTS,
  }, { path: 'link/private.ts' }), /工作区之外/);
  assert.equal(reads, 0);
});

test('read-state projection tracks turns and invalidates after compaction events', () => {
  let state = readStateProjection.init({}, 0);
  const idle = { type: 'tool/result', data: {} };
  assert.equal(readStateProjection.apply(state, idle), state);
  state = readStateProjection.apply(state, { type: 'tool/call', data: { turn: 4 } });
  assert.deepEqual(state, readState(4, 0));
  state = readStateProjection.apply(state, { type: 'compaction/prune', data: {} });
  assert.deepEqual(state, readState(4, 1));
  state = readStateProjection.apply(state, { type: 'turn/start', data: { turn: 5 } });
  assert.deepEqual(state, readState(5, 1));
});

test('read suppresses an unchanged duplicate only within the same uncompacted turn', async () => {
  const cache = new Map();
  let reads = 0;
  const workspaceFiles = {
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read(_scope, path, range) {
      reads += 1;
      assert.ok(range.offset >= 1);
      const text = range.offset === 1 ? 'one\ntwo' : 'two';
      const lines = range.offset === 1 ? 2 : 1;
      return { absolutePath: pathInWorkspace(path), version: 'v1', offset: range.offset, lines, eof: true, text };
    },
  };
  const base = { workspaceFiles, filesystem, scope: { workspaceRoot: '/workspace', sessionId: 's' }, cache, signal, config: DEFAULTS };
  const first = await runRead({ ...base, sessionState: readState() }, { path: 'src/a.ts', startLine: 1, lines: 2 });
  assert.equal(first.repeated, false);
  assert.equal(first.startLine, 1);
  assert.match(first.rendered, /1: one/);
  const duplicate = await runRead({ ...base, sessionState: readState() }, { path: 'src/a.ts', startLine: 1, lines: 2 });
  assert.equal(duplicate.repeated, true);
  assert.equal(reads, 1);
  const laterLine = await runRead({ ...base, sessionState: readState() }, { path: 'src/a.ts', startLine: 2, lines: 1 });
  assert.equal(laterLine.startLine, 2);
  assert.match(laterLine.rendered, /2: two/);
  assert.equal(reads, 2);
  const nextTurn = await runRead({ ...base, sessionState: readState(5) }, { path: 'src/a.ts', startLine: 1, lines: 2 });
  assert.equal(nextTurn.repeated, false);
  assert.equal(reads, 3);
  const afterCompaction = await runRead({ ...base, sessionState: readState(5, 1) }, { path: 'src/a.ts', startLine: 1, lines: 2 });
  assert.equal(afterCompaction.repeated, false);
  assert.equal(reads, 4);
  const forced = await runRead({ ...base, sessionState: readState(5, 1) }, { path: 'src/a.ts', startLine: 1, lines: 2, force: true });
  assert.equal(forced.repeated, false);
  assert.equal(reads, 5);
});

test('read refreshes after file change, next turn, or compaction', async () => {
  const cache = new Map();
  let version = 'v1';
  let reads = 0;
  const workspaceFiles = {
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version }; },
    async read(_scope, path, range) {
      reads += 1;
      return { absolutePath: pathInWorkspace(path), version, offset: range.offset, lines: 1, eof: true, text: version };
    },
  };
  const base = { workspaceFiles, filesystem, scope: { workspaceRoot: '/workspace', sessionId: 's' }, cache, signal, config: DEFAULTS };
  await runRead({ ...base, sessionState: readState() }, { path: 'a.ts' });
  await runRead({ ...base, sessionState: readState() }, { path: 'a.ts' });
  assert.equal(reads, 1);
  version = 'v2';
  const changed = await runRead({ ...base, sessionState: readState() }, { path: 'a.ts' });
  assert.equal(changed.repeated, false);
  await runRead({ ...base, sessionState: readState(5) }, { path: 'a.ts' });
  await runRead({ ...base, sessionState: readState(5, 1) }, { path: 'a.ts' });
  assert.equal(reads, 4);
});

test('truncated read output is never cached as reusable context', async () => {
  const cache = new Map();
  let reads = 0;
  const workspaceFiles = {
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read(_scope, path, range) {
      reads += 1;
      return { absolutePath: pathInWorkspace(path), version: 'v1', offset: range.offset, lines: 1, eof: true, text: 'x'.repeat(900) };
    },
  };
  const base = { workspaceFiles, filesystem, scope: { workspaceRoot: '/workspace', sessionId: 's' }, cache, signal, sessionState: readState(), config: { ...DEFAULTS, maxReadChars: 500 } };
  const first = await runRead(base, { path: 'long.ts' });
  assert.equal(first.truncated, true);
  assert.match(first.rendered, /读取已截断/);
  assert.ok(Array.from(first.rendered).length <= 500);
  assert.equal(cache.size, 0);
  const second = await runRead(base, { path: 'long.ts' });
  assert.equal(second.truncated, true);
  assert.equal(second.repeated, false);
  assert.equal(reads, 2);
});

test('line-clamped read (request exceeds maxReadLines) is not cached as complete', async () => {
  const cache = new Map();
  let reads = 0;
  const bigText = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`).join('\n');
  const workspaceFiles = {
    async stat(_scope, path) { return { absolutePath: pathInWorkspace(path), version: 'v1' }; },
    async read(_scope, path, range) {
      reads += 1;
      const lines = bigText.split('\n').slice(range.offset - 1, range.offset - 1 + range.limit);
      return { absolutePath: pathInWorkspace(path), version: 'v1', offset: range.offset, lines: lines.length, eof: range.offset - 1 + range.limit >= 500, text: lines.join('\n') };
    },
  };
  const base = { workspaceFiles, filesystem, scope: { workspaceRoot: '/workspace', sessionId: 's' }, cache, signal, sessionState: readState(), config: { ...DEFAULTS, maxReadLines: 120 } };
  // 请求 500 行，受 maxReadLines=120 钳制 → 非完整应答，不得去重缓存
  const first = await runRead(base, { path: 'big.ts', startLine: 1, lines: 500 });
  assert.equal(first.lines, 120);
  assert.equal(first.truncated, true);
  assert.equal(first.eof, false);
  const second = await runRead(base, { path: 'big.ts', startLine: 1, lines: 500 });
  assert.equal(second.repeated, false, 'clamped read must not be deduped');
  assert.equal(reads, 2);
  assert.equal(cache.size, 0);
  // 完整小范围读取仍可正常去重
  const a = await runRead(base, { path: 'big.ts', startLine: 1, lines: 10 });
  assert.equal(a.truncated, false);
  const b = await runRead(base, { path: 'big.ts', startLine: 1, lines: 10 });
  assert.equal(b.repeated, true, 'complete read should dedupe');
});

test('plugin registers two tools and disposes them and session cache', async () => {
  const definitions = new Map();
  const disposed = [];
  const ctx = {
    workspaceFiles: {},
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => { disposed.push(definition.name); definitions.delete(definition.name); };
      },
    },
  };
  const cleanup = registerTools(ctx, {});
  assert.deepEqual([...definitions.keys()], ['context_search', 'context_read']);
  assert.equal(definitions.get('context_read').deferLoading, true);
  assert.equal(definitions.get('context_read').isConcurrencySafe, undefined);
  cleanup();
  assert.equal(definitions.size, 0);
  assert.deepEqual(disposed, ['context_read', 'context_search']);
});

test('tool execution requires an active workspace and scopes requests to its session', async () => {
  const definitions = new Map();
  const calls = [];
  const ctx = {
    workspaceFiles: {
      async list(scope, path) {
        calls.push({ scope, path });
        return { entries: [], truncated: false };
      },
    },
    fs: filesystem,
    sessionProjections: { stateOf: () => readState() },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => {}; } },
  };
  registerTools(ctx, {});
  const session = makeSession();
  session.header = { id: 'session-1', cwd: '/Users/alice/project' };
  const value = await definitions.get('context_search').execute({ query: 'needle' }, {
    agent: { id: 'session-1', session }, signal,
  });
  assert.equal(value.matches, 0);
  assert.equal(calls[0].scope.workspaceRoot, '/Users/alice/project');
  assert.equal(calls[0].scope.sessionId, 'session-1');
  await assert.rejects(
    definitions.get('context_search').execute({ query: 'needle' }, { signal }),
    /活动 DSH 会话/,
  );
});
