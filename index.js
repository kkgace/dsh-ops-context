import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import { registerTools } from './src/register.js';
import { createReadStateProjection } from './src/session-state.js';

export const inject = ['tools', 'workspaceFiles', 'sessionProjections', 'fs'];

const readStateProjection = createReadStateProjection(zod.object({
  turn: zod.number().int().nonnegative().nullable(),
  compactionGeneration: zod.number().int().nonnegative(),
}).strict());

export const Config = z.object({
  maxReadLines: z.number().default(120).description('context_read 每次允许读取的最大行数。'),
  maxReadChars: z.number().default(12000).description('单次读取结果的字符上限。'),
  maxSearchFiles: z.number().default(400).description('一次搜索最多扫描的源码文件数。'),
  maxSearchDirs: z.number().default(400).description('一次搜索最多遍历的目录数。'),
  maxSearchLinesPerFile: z.number().default(400).description('一次搜索每个文件最多检查的行数。'),
  maxSearchMatches: z.number().default(60).description('一次搜索最多返回的匹配行数。'),
  maxLineChars: z.number().default(240).description('搜索结果单行预览的字符上限。'),
  maxSearchChars: z.number().default(16000).description('单次搜索结果的字符上限。'),
});

export function apply(ctx, config) {
  ctx.effect(() => {
    const disposeProjection = ctx.sessionProjections.register(readStateProjection);
    const disposeTools = registerTools(ctx, config);
    return () => {
      disposeTools();
      disposeProjection();
    };
  }, 'dsh-ops-context:tools');
}
