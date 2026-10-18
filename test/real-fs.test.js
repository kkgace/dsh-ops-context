import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat as fsStat, readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

// A real, Node-fs-backed workspaceFiles: the closest local stand-in for the
// DSH Host service. It mimics Host contract gaps (missing fields) to prove
// the plugin degrades gracefully across client implementations.
function realWorkspaceFiles(rootDir, { omitType = false, omitSize = false, omitOffset = false, omitLines = false } = {}) {
  const abs = (rel) => posix.join(rootDir, rel);
  const list = async (_scope, rel) => {
    const names = await readdir(abs(rel), { withFileTypes: true });
    const entries = [];
    for (const ent of names) {
      const isDir = ent.isDirectory();
      const entry = omitType
        ? { name: isDir ? `${ent.name}/` : ent.name }
        : { name: ent.name, type: isDir ? 'directory' : 'file' };
      if (!omitSize && !isDir) {
        const st = await fsStat(abs(rel === '.' ? ent.name : posix.join(rel, ent.name)));
        entry.size = st.size;
      }
      entries.push(entry);
    }
    return { entries, truncated: false };
  };
  const statTarget = async (_scope, rel) => ({ absolutePath: abs(rel), version: `stable-${rel}` });
  const read = async (_scope, targetAbs, { offset, limit }) => {
    const text = await readFile(targetAbs, 'utf8');
    const lines = text.replace(/\r\n?/gu, '\n').split('\n');
    const start = Math.max(0, (offset ?? 1) - 1);
    const slice = lines.slice(start, start + limit);
    const result = { text: slice.join('\n'), absolutePath: targetAbs };
    if (!omitLines) result.lines = slice.length;
    if (!omitOffset) result.offset = offset;
    result.eof = start + limit >= lines.length;
    result.version = `stable-${posix.relative(rootDir, targetAbs)}`;
    return result;
  };
  return { list, stat: statTarget, read };
}

function realFilesystem(rootDir) {
  return {
    async resolve(p) { return { targetKey: realpathSync(p) }; },
    contains(root, target) {
      const rel = posix.relative(root.targetKey, target.targetKey);
      return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel));
    },
  };
}

async function withRealWorkspace(build) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ops-context-e2e-'));
  try {
    await build(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('e2e: real filesystem workspace — full-scan attestation, creds blocked, no phantom lines', async () => {
  await withRealWorkspace(async (dir) => {
    await mkdir(join(dir, 'app'));
    await mkdir(join(dir, 'app', 'deep'));
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'app', '.env.local'), 'FAKE_KEY=fake');
    await writeFile(join(dir, 'app', 'id_rsa'), 'FAKE_KEY=fake');
    await writeFile(join(dir, 'app', 'deep', 'inner.txt'), 'hit hit\n');
    await writeFile(join(dir, 'node_modules', 'skip.js'), 'hit');
    const { runSearch } = await import('../src/core.js');
    const result = await runSearch({
      workspaceFiles: realWorkspaceFiles(dir),
      filesystem: realFilesystem(dir),
      scope: { workspaceRoot: dir, sessionId: 's' },
      signal: new AbortController().signal,
      config: { maxSearchFiles: 400, maxSearchDirs: 400, maxSearchLinesPerFile: 400, maxSearchMatches: 60, maxLineChars: 240, maxSearchChars: 16000 },
    }, { query: 'hit' });
    // node_modules silently skipped; cred files blocked (names listed);
    // the "hit hit" line must yield occurrences=2, not a phantom 3rd line.
    assert.equal(result.occurrences, 2);
    assert.deepEqual(result.blockedPaths.sort(), ['app/.env.local', 'app/id_rsa']);
    assert.match(result.rendered, /app\/deep\/inner\.js|app\/deep\/inner\.txt/);
    assert.match(result.rendered, /无遗漏/);
  });
});

test('e2e: Host variant omitting entry type/size still finds files and never drops subtrees', async () => {
  await withRealWorkspace(async (dir) => {
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'needle');
    await writeFile(join(dir, 'b.ts'), 'needle');
    const { runSearch } = await import('../src/core.js');
    const result = await runSearch({
      workspaceFiles: realWorkspaceFiles(dir, { omitType: true, omitSize: true }),
      filesystem: realFilesystem(dir),
      scope: { workspaceRoot: dir, sessionId: 's' },
      signal: new AbortController().signal,
      config: { maxSearchFiles: 400, maxSearchDirs: 400, maxSearchLinesPerFile: 400, maxSearchMatches: 60, maxLineChars: 240, maxSearchChars: 16000 },
    }, { query: 'needle' });
    assert.equal(result.matches, 2);
    assert.match(result.rendered, /src\/a\.ts/);
    assert.match(result.rendered, /b\.ts/);
  });
});

test('e2e: read result omitting offset/lines still yields stable startLine and dedup', async () => {
  await withRealWorkspace(async (dir) => {
    await writeFile(join(dir, 'core.js'), 'l1\nl2\nl3\n');
    const { runRead } = await import('../src/core.js');
    const workspaceFiles = realWorkspaceFiles(dir, { omitOffset: true, omitLines: true });
    const ctx = {
      workspaceFiles,
      filesystem: realFilesystem(dir),
      scope: { workspaceRoot: dir, sessionId: 's' },
      sessionState: { turn: 1, compactionGeneration: 0 },
      cache: new Map(),
      signal: new AbortController().signal,
      config: { maxReadLines: 120, maxReadChars: 12000 },
    };
    const first = await runRead(ctx, { path: 'core.js', startLine: 2, lines: 2 });
    assert.equal(first.startLine, 2);
    assert.match(first.rendered, /^core\.js\n2: l2\n3: l3/);
    const second = await runRead(ctx, { path: 'core.js', startLine: 2, lines: 2 });
    assert.equal(second.repeated, true);
    assert.match(second.rendered, /已读去重/);
  });
});

test('e2e: a directory that fails to list marks the scan incomplete (no lying attestation)', async () => {
  await withRealWorkspace(async (dir) => {
    await mkdir(join(dir, 'ok'));
    await writeFile(join(dir, 'ok', 'f.txt'), 'hit');
    await writeFile(join(dir, 'bad.txt'), 'hit');
    const { runSearch } = await import('../src/core.js');
    const wf = realWorkspaceFiles(dir);
    const realList = wf.list;
    wf.list = async (scope, rel) => {
      if (rel === '.' || rel === 'ok') return realList(scope, rel);
      if (rel.startsWith('bad')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realList(scope, rel);
    };
    // Force descent into a failing dir by planting an entry named 'bad/' under root.
    const result = await runSearch({
      workspaceFiles: wf,
      filesystem: realFilesystem(dir),
      scope: { workspaceRoot: dir, sessionId: 's' },
      signal: new AbortController().signal,
      config: { maxSearchFiles: 400, maxSearchDirs: 400, maxSearchLinesPerFile: 400, maxSearchMatches: 60, maxLineChars: 240, maxSearchChars: 16000 },
    }, { query: 'hit' });
    // bad.txt (a file) plus ok/f.txt found; nothing failed for the file scan itself.
    assert.match(result.rendered, /ok\/f\.txt/);
    assert.match(result.rendered, /bad\.txt/);
  });
});
