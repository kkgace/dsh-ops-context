import { posix } from 'node:path';

export const DEFAULTS = Object.freeze({
  maxReadLines: 120,
  maxReadChars: 12000,
  maxSearchFiles: 400,
  maxSearchDirs: 400,
  maxSearchLinesPerFile: 400,
  maxSearchMatches: 60,
  maxLineChars: 240,
  maxSearchChars: 16000,
  maxDepth: 8,
});

const EXCLUDED_NAMES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
  'target', 'Pods', 'DerivedData', '.DS_Store',
]);
const ALLOWED_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.html', '.java', '.js', '.jsx',
  '.json', '.md', '.mdx', '.mjs', '.mts', '.py', '.rs', '.scss', '.sh', '.sql',
  '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml', '.zsh',
]);
const SECRET_NAME = /^(?:\.env(?:rc)?(?:\..*)?|.*(?:secret|credential|password).*(?:\.[^.]+)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?|.*\.(?:pem|key|p8|p12|pfx|p7b|p7c|p7m|p7s|jks|keystore|kdbx|asc|cer|crt))$/iu;

export function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export function clipText(value, maxChars) {
  const chars = Array.from(String(value ?? ''));
  if (chars.length <= maxChars) return { text: chars.join(''), truncated: false };
  const marker = '…[省略]';
  if (maxChars <= Array.from(marker).length) {
    return { text: Array.from(marker).slice(0, maxChars).join(''), truncated: true };
  }
  const keep = maxChars - Array.from(marker).length;
  return { text: `${chars.slice(0, keep).join('')}${marker}`, truncated: true };
}

/** Accept only relative paths contained in the session workspace. */
export function resolveWorkspaceRelative(root, requested = '.') {
  if (typeof root !== 'string' || !posix.isAbsolute(root)) throw new Error('当前会话没有有效的工作区根目录');
  if (typeof requested !== 'string' || requested.includes('\0')) throw new Error('path 必须是工作区内的相对路径');
  if (requested.length > 256) throw new Error('path 最多 256 个字符');
  const normalizedInput = requested.replaceAll('\\', '/');
  if (posix.isAbsolute(normalizedInput)) throw new Error('不允许访问工作区外的绝对路径');
  const normalized = posix.normalize(normalizedInput || '.');
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('不允许访问工作区外的路径');
  const absolute = posix.resolve(root, normalized);
  const relative = posix.relative(root, absolute);
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
    throw new Error('不允许访问工作区外的路径');
  }
  return relative || '.';
}

export async function assertWorkspaceTarget(filesystem, rootPath, absolutePath, signal) {
  if (typeof absolutePath !== 'string' || !filesystem?.resolve || !filesystem?.contains) {
    throw new Error('无法验证文件的规范路径，已拒绝读取');
  }
  const root = await filesystem.resolve(rootPath, { signal });
  const target = await filesystem.resolve(absolutePath, { signal });
  if (!filesystem.contains(root, target)) {
    throw new Error('目标经符号链接解析后位于工作区之外，已拒绝读取');
  }
}

export function isExcludedEntry(name) {
  return name.startsWith('.') || EXCLUDED_NAMES.has(name) || SECRET_NAME.test(name);
}

export function isSensitivePath(relativePath) {
  return relativePath.split('/').some((part) => part !== '.' && part.startsWith('.') || SECRET_NAME.test(part));
}

export function isSearchableFile(name) {
  if (isExcludedEntry(name) || name.startsWith('.')) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && ALLOWED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export function observeSessionEvent(states, session, event) {
  const sessionId = session?.header?.id;
  if (!sessionId) return;
  if (!states.has(sessionId)) {
    states.set(sessionId, { turn: null, compactionGeneration: 0 });
    while (states.size > 256) states.delete(states.keys().next().value);
  }
  const state = states.get(sessionId);
  const turn = event?.data?.turn;
  if (Number.isFinite(turn)) state.turn = turn;
  if (String(event?.type ?? '').startsWith('compaction/')) state.compactionGeneration += 1;
}

export function wasReadThisTurn(cache, key, version, state) {
  const previous = cache.get(key);
  return Boolean(previous && state?.turn !== null && state?.turn !== undefined
    && previous.turn === state.turn
    && previous.compactionGeneration === state.compactionGeneration
    && previous.version === version
    && previous.complete === true);
}

export function rememberRead(cache, key, version, state, complete, maxEntries = 256) {
  if (!complete || state?.turn === null || state?.turn === undefined) {
    cache.delete(key);
    return;
  }
  cache.delete(key);
  cache.set(key, {
    version,
    turn: state.turn,
    compactionGeneration: state.compactionGeneration,
    complete: true,
  });
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

export function formatReadResult({ path, offset, text, version, repeated = false, fileContinues = false }, maxChars) {
  if (repeated) {
    const text = `已读去重：${path}（版本 ${version}）在本轮且未压缩的上下文中已完整返回；请复用前次结果。若前次内容已不可见，请用 force=true 重新读取。`;
    const clipped = clipText(text, maxChars);
    return { rendered: clipped.text, truncated: clipped.truncated };
  }
  const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n');
  const numbered = lines.map((line, index) => `${offset + index}: ${line}`).join('\n');
  const header = `${path}\n`;
  const tail = `\n[版本 ${version}${fileContinues ? '；文件还有后续行，可按需续读' : ''}]`;
  const complete = `${header}${numbered}${tail}`;
  if (Array.from(complete).length <= maxChars) return { rendered: complete, truncated: false };
  const warning = '\n[读取已截断；请缩小行范围或从更靠后的行继续。]';
  const bodyBudget = Math.max(1, maxChars - Array.from(header + tail + warning).length);
  const clipped = clipText(numbered, bodyBudget);
  const bounded = clipText(`${header}${clipped.text}${tail}${warning}`, maxChars);
  return { rendered: bounded.text, truncated: true };
}

export async function runSearch({ workspaceFiles, filesystem, scope, signal, config }, input) {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) throw new Error('query 不能为空');
  if (Array.from(query).length > 300) throw new Error('query 最多 300 个字符');
  const start = resolveWorkspaceRelative(scope.workspaceRoot, input.path ?? '.');
  if (isSensitivePath(start)) throw new Error('为避免读取隐藏配置或凭据，隐藏路径与敏感密钥默认不可由该工具搜索。');
  const maxFiles = boundedInteger(config.maxSearchFiles, DEFAULTS.maxSearchFiles, 1, 1000);
  const maxDirs = boundedInteger(config.maxSearchDirs, DEFAULTS.maxSearchDirs, 1, 500);
  const maxLines = boundedInteger(config.maxSearchLinesPerFile, DEFAULTS.maxSearchLinesPerFile, 1, 500);
  const maxMatches = boundedInteger(config.maxSearchMatches, DEFAULTS.maxSearchMatches, 1, 100);
  const maxLineChars = boundedInteger(config.maxLineChars, DEFAULTS.maxLineChars, 40, 1000);
  const queue = [{ path: start, depth: 0 }];
  const matches = [];
  const lowerQuery = query.toLowerCase();
  let filesScanned = 0;
  let truncated = false;
  let skippedFiles = 0;
  let skippedDirectories = 0;
  const skippedPaths = [];
  const blockedPaths = [];
  let directoriesScanned = 0;

  while (queue.length && matches.length < maxMatches && filesScanned < maxFiles && directoriesScanned < maxDirs) {
    if (signal?.aborted) throw new Error('搜索已取消');
    const current = queue.shift();
    if (current.depth > DEFAULTS.maxDepth) { truncated = true; continue; }
    directoriesScanned += 1;
    let listing;
    try {
      listing = await workspaceFiles.list(scope, current.path, signal);
      if (signal?.aborted) throw new Error('搜索已取消');
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
      truncated = true;
      skippedDirectories += 1;
      if (skippedPaths.length < 5) skippedPaths.push(`${current.path}/`);
      continue;
    }
    if (listing.truncated) truncated = true;
    for (const entry of listing.entries ?? []) {
      if (signal?.aborted) throw new Error('搜索已取消');
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const relative = current.path === '.' ? entry.name : posix.join(current.path, entry.name);
      if (entry.type === 'file' && (entry.name.startsWith('.') || SECRET_NAME.test(entry.name))) {
        // Credential/hidden-named files: reveal the path (name only) but never read content.
        // Full invisibility forced models into blind enumeration probes (measured 11 extra calls in benchmark v3).
        blockedPaths.push(relative);
        continue;
      }
      if (isExcludedEntry(entry.name)) continue;
      if (entry.type === 'directory') {
        if (current.depth < DEFAULTS.maxDepth) queue.push({ path: relative, depth: current.depth + 1 });
        else truncated = true;
      } else if (entry.type === 'file' && isSensitivePath(relative)) {
        // Credential/hidden-named files: reveal the path (name only) but never read content.
        // Full invisibility forced models into blind enumeration probes (measured 11 extra calls in benchmark v3).
        blockedPaths.push(relative);
      } else if (entry.type === 'file' && isSearchableFile(entry.name)) {
        if (filesScanned >= maxFiles) { truncated = true; break; }
        filesScanned += 1;
        if (typeof entry.size === 'number' && entry.size > 1024 * 1024) { truncated = true; skippedFiles += 1; if (skippedPaths.length < 5) skippedPaths.push(relative); continue; }
        try {
          const stat = await workspaceFiles.stat(scope, relative, signal);
          if (signal?.aborted) throw new Error('搜索已取消');
          await assertWorkspaceTarget(filesystem, scope.workspaceRoot, stat.absolutePath, signal);
          const page = await workspaceFiles.read(scope, stat.absolutePath, { offset: 1, limit: maxLines }, signal);
          if (signal?.aborted) throw new Error('搜索已取消');
          await assertWorkspaceTarget(filesystem, scope.workspaceRoot, page.absolutePath, signal);
          const lines = String(page.text ?? '').replace(/\r\n?/gu, '\n').split('\n');
          for (let index = 0; index < lines.length && matches.length < maxMatches; index += 1) {
            // Aggregate all occurrences on the same line so callers never need
            // a per-line read-back just to count matches (benchmark v3 lesson).
            const count = lines[index].toLowerCase().split(lowerQuery).length - 1;
            if (count > 0) {
              const clipped = clipText(lines[index], maxLineChars);
              matches.push({ path: relative, line: (page.offset ?? 1) + index, text: clipped.text, count });
            }
          }
          if (!page.eof && page.lines >= maxLines) truncated = true;
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
          truncated = true;
          skippedFiles += 1;
          if (skippedPaths.length < 5) skippedPaths.push(relative);
          // One unreadable/binary/out-of-workspace file does not abort the bounded search.
        }
      }
      if (matches.length >= maxMatches) { truncated = true; break; }
    }
  }
  if (queue.length || filesScanned >= maxFiles || directoriesScanned >= maxDirs) truncated = true;
  const linesWithHits = matches.reduce((sum, item) => sum + item.count, 0);
  const body = matches.length
    ? matches.map((item) => `${item.path}:${item.line}${item.count > 1 ? `(×${item.count})` : ''}: ${item.text}`).join('\n')
    : '没有找到匹配项。';
  const maxSearchChars = boundedInteger(config.maxSearchChars, DEFAULTS.maxSearchChars, 500, 40000);
  const blockedList = blockedPaths.length ? `\n[隐藏/凭据文件（仅列出文件名，内容一律不读取）：${blockedPaths.join('、')}]` : '';
  const scanNote = truncated
    ? (() => {
        const skippedList = skippedPaths.length ? `（${skippedPaths.join('、')}${skippedFiles + skippedDirectories > skippedPaths.length ? ' 等' : ''}）` : '';
        return `\n[搜索不完整；跳过 ${skippedFiles} 个文件、${skippedDirectories} 个目录${skippedList}。可用 context_read 显式读取所列文件，或指定更窄的 path 或 query。]`;
      })()
    : `\n[全量扫描：${filesScanned} 个文件、${directoriesScanned} 个目录，共 ${linesWithHits} 处命中，无遗漏；文件名大小写不敏感。]`;
  const clipped = clipText(body, Math.max(1, maxSearchChars - Array.from(blockedList + scanNote).length));
  const incomplete = truncated || clipped.truncated;
  return {
    query,
    path: start,
    filesScanned,
    directoriesScanned,
    skippedFiles,
    skippedDirectories,
    skippedPaths,
    blockedPaths,
    matches: matches.length,
    occurrences: linesWithHits,
    truncated: incomplete,
    rendered: incomplete ? `${clipped.text}${scanNote}${blockedList}` : `${clipped.text}${blockedList}${scanNote}`,
  };
}

export async function runRead({ workspaceFiles, filesystem, scope, sessionState, cache, signal, config }, input) {
  const relative = resolveWorkspaceRelative(scope.workspaceRoot, input.path);
  if (relative === '.') throw new Error('path 必须指向工作区内的文件');
  if (isSensitivePath(relative)) throw new Error('为避免读取隐藏配置或凭据，隐藏路径与敏感密钥默认不可由该工具读取。');
  const offset = boundedInteger(input.startLine, 1, 1, 10_000_000);
  const configuredMaxLines = boundedInteger(config.maxReadLines, DEFAULTS.maxReadLines, 1, 500);
  const requestedLines = boundedInteger(input.lines, DEFAULTS.maxReadLines, 1, 10_000_000);
  const limit = Math.min(requestedLines, configuredMaxLines);
  const clamped = requestedLines > limit;
  const stat = await workspaceFiles.stat(scope, relative, signal);
  if (signal?.aborted) throw new Error('读取已取消');
  await assertWorkspaceTarget(filesystem, scope.workspaceRoot, stat.absolutePath, signal);
  const cacheKey = `${relative}\u0000${offset}\u0000${limit}`;
  if (input.force !== true && wasReadThisTurn(cache, cacheKey, stat.version, sessionState)) {
    const duplicate = formatReadResult({ path: relative, version: stat.version, repeated: true }, limit * 160);
    return { path: relative, version: stat.version, repeated: true, truncated: duplicate.truncated, rendered: duplicate.rendered };
  }
  const page = await workspaceFiles.read(scope, stat.absolutePath, { offset, limit }, signal);
  if (signal?.aborted) throw new Error('读取已取消');
  await assertWorkspaceTarget(filesystem, scope.workspaceRoot, page.absolutePath, signal);
  const version = page.version ?? stat.version;
  const rendered = formatReadResult({
    path: relative,
    offset: page.offset ?? offset,
    text: page.text,
    version,
    fileContinues: !page.eof,
  }, boundedInteger(config.maxReadChars, DEFAULTS.maxReadChars, 500, 40000));
  // 被行数上限钳制或字符截断的返回都不是完整应答，不得写入去重缓存
  const partial = clamped || rendered.truncated;
  rememberRead(cache, cacheKey, version, sessionState, !partial);
  return {
    path: relative,
    version,
    startLine: page.offset,
    lines: page.lines,
    eof: page.eof,
    repeated: false,
    truncated: rendered.truncated || clamped,
    rendered: rendered.rendered,
  };
}
