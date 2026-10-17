import { DEFAULTS, runRead, runSearch } from './core.js';
import { READ_STATE_KEY } from './session-state.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    rendered: { type: 'string' },
    truncated: { type: 'boolean' },
    repeated: { type: 'boolean' },
  },
  required: ['rendered'],
  additionalProperties: true,
};

const renderOutput = (_args, value) => [
  { type: 'text', text: typeof value?.rendered === 'string' ? value.rendered : JSON.stringify(value) },
];

function workspaceContext(ctx, exec) {
  const session = exec.agent?.session;
  const header = session?.header;
  const sessionId = header?.id ?? exec.agent?.id;
  const workspaceRoot = header?.cwd;
  if (!session || !sessionId || typeof workspaceRoot !== 'string') {
    throw new Error('此工具需要带有工作区 cwd 的活动 DSH 会话。');
  }
  if (!ctx.workspaceFiles) throw new Error('当前 DSH Host 未提供 workspaceFiles 工作区能力。');
  if (!ctx.fs) throw new Error('当前 DSH Host 未提供 fs 目标解析能力。');
  if (!ctx.sessionProjections) throw new Error('当前 DSH Host 未提供 sessionProjections 状态能力。');
  return {
    session,
    scope: { sessionId, workspaceRoot },
    workspaceFiles: ctx.workspaceFiles,
    filesystem: ctx.fs,
  };
}

function sessionReadCache(caches, sessionId) {
  if (!caches.has(sessionId)) {
    caches.set(sessionId, new Map());
    while (caches.size > 64) caches.delete(caches.keys().next().value);
  }
  const cache = caches.get(sessionId);
  caches.delete(sessionId);
  caches.set(sessionId, cache);
  return cache;
}

export function registerTools(ctx, config = {}) {
  const caches = new Map();
  const caps = { ...DEFAULTS, ...config };
  const disposers = [];

  disposers.push(ctx.tools.register({
    name: 'context_search',
    description: '在当前会话授权的工作区中做有界字面搜索；仅返回路径、行号和短片段，同行多次命中合并为一条并标注 ×次数。无截断时返回「全量扫描…无遗漏」自证标记；隐藏/凭据文件仅列出文件名（内容一律不读取）。不访问工作区外文件。一次搜索即可覆盖全域，无需为计数或完整性追加逐字读取。',
    deferLoading: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 300, description: '大小写不敏感的字面文本，不是正则表达式。' },
        path: { type: 'string', description: '工作区内的相对目录，默认整个工作区。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const context = workspaceContext(ctx, exec);
      return runSearch({ ...context, signal: exec.signal, config: caps }, args);
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'context_read',
    description: '从当前会话工作区按行读取代码/文档，默认最多 120 行，单次 12000 字符封顶。只接受工作区相对路径；隐藏路径和敏感配置/密钥文件默认拒绝。若同一轮、同一版本、同一范围已完整返回且未压缩，会提示复用前次结果；压缩后或内容不可见时传 force=true。',
    deferLoading: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: '工作区内文件的相对路径。' },
        startLine: { type: 'integer', minimum: 1, description: '起始行（从 1 开始），默认 1。' },
        lines: { type: 'integer', minimum: 1, maximum: 500, description: '读取行数，默认 120；实际受 maxReadLines 配置限制。' },
        force: { type: 'boolean', description: '即使本轮已经读取也重新输出内容；上下文压缩后前次片段不可见时使用。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderOutput },
    timeoutMs: 15000,
    execute: async (args, exec) => {
      const context = workspaceContext(ctx, exec);
      const sessionState = ctx.sessionProjections.stateOf(context.session, READ_STATE_KEY);
      if (!sessionState) throw new Error('当前会话的 context-lite Projection 状态不可用。');
      const cache = sessionReadCache(caches, context.scope.sessionId);
      return runRead({ ...context, sessionState, cache, signal: exec.signal, config: caps }, args);
    },
  }));

  return () => {
    for (const dispose of disposers.reverse()) dispose();
    caches.clear();
  };
}
