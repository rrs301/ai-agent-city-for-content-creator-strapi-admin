import type { Core } from '@strapi/strapi';
import { z } from '@strapi/utils';
import { SCOPE_HEADER, ScopeError, verifyScope, type MemoryScope } from './scope';

/**
 * MCP tools that give Creator City agents a persistent, shared memory in the `memories` collection.
 *
 * Isolation: every tool resolves the headquarters from the signed `x-creator-city-scope` header (see scope.ts)
 * and only ever reads or writes rows of that headquarters. Tool arguments never choose the headquarters.
 *
 * Access: the MCP endpoint itself requires a Strapi admin token; each tool additionally requires the token's
 * owner to hold the matching content-manager permission on `api::memory.memory`.
 */

const MEMORY = 'api::memory.memory';
const MEMORY_KINDS = ['research', 'script', 'voice', 'media', 'video', 'publish', 'context', 'note'] as const;
const DOCUMENT_ID = /^[a-z0-9]{8,64}$/i;
const MAX_CONTENT = 60_000;

type Row = {
  documentId: string;
  kind: string;
  title: string;
  content: string;
  data?: unknown;
  tags?: unknown;
  createdAt?: string;
  updatedAt?: string;
  agent?: { documentId: string; name: string } | null;
};

// Generated content-type typings only exist after Strapi has run once, so look the service up by string.
const memories = (strapi: Core.Strapi) => strapi.documents(MEMORY as Parameters<Core.Strapi['documents']>[0]) as unknown as {
  findMany(params: Record<string, unknown>): Promise<Row[]>;
  findFirst(params: Record<string, unknown>): Promise<Row | null>;
  create(params: Record<string, unknown>): Promise<Row>;
  update(params: Record<string, unknown>): Promise<Row>;
};

const policy = (action: 'read' | 'create' | 'update') => ({
  policies: [{ action: `plugin::content-manager.explorer.${action}`, subject: MEMORY }] as [{ action: string; subject: string }],
});

function scopeOf(strapi: Core.Strapi, headers: Record<string, string | string[] | undefined> | undefined): MemoryScope {
  return verifyScope(headers?.[SCOPE_HEADER], process.env.MEMORY_SCOPE_SECRET);
}

const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true as const });

/** Runs a handler with the verified scope; turns scope and validation problems into model-visible errors. */
async function scoped<T>(
  strapi: Core.Strapi,
  headers: Record<string, string | string[] | undefined> | undefined,
  run: (scope: MemoryScope) => Promise<T>,
) {
  try {
    return await run(scopeOf(strapi, headers));
  } catch (error) {
    if (error instanceof ScopeError) {
      strapi.log.warn(`[MCP memory] rejected call: ${error.message}`);
      return failure(error.message);
    }
    strapi.log.error(`[MCP memory] ${error instanceof Error ? error.stack : String(error)}`);
    return failure('Memory is temporarily unavailable.');
  }
}

const excerpt = (text: string, length = 280) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const relation = (documentId: string) => ({ connect: [{ documentId }] });

const itemSchema = z.object({
  documentId: z.string(),
  kind: z.string(),
  title: z.string(),
  excerpt: z.string(),
  agent: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const toItem = (row: Row) => ({
  documentId: row.documentId,
  kind: row.kind,
  title: row.title,
  excerpt: excerpt(row.content ?? ''),
  agent: row.agent?.name ?? null,
  updatedAt: row.updatedAt ?? null,
});

export function registerMemoryTools(strapi: Core.Strapi) {
  const mcp = strapi.ai.mcp;

  const saveInput = z.object({
    kind: z.enum(MEMORY_KINDS).describe('What this memory is: research findings, a script, voice/media/video assets, publishing info, shared project context, or a note.'),
    title: z.string().min(1).max(160).describe('Short, searchable title.'),
    content: z.string().min(1).max(MAX_CONTENT).describe('The full content to remember (Markdown is fine).'),
    data: z.record(z.string(), z.unknown()).optional().describe('Optional structured data, e.g. asset URLs, sources, timestamps.'),
    tags: z.array(z.string().max(40)).max(12).optional(),
  });
  const savedOutput = z.object({ documentId: z.string(), kind: z.string(), title: z.string() });

  mcp.registerTool({
    name: 'memory_save',
    title: 'Save to memory',
    description: 'Save findings, scripts, asset references, or project context to the shared memory of your headquarters so other agents can use them later.',
    auth: policy('create'),
    resolveInputSchema: () => saveInput,
    resolveOutputSchema: () => savedOutput,
    createHandler: (strapi) => async ({ args, extra }) => scoped(strapi, extra.requestInfo?.headers, async (scope) => {
      const row = await memories(strapi).create({
        data: {
          kind: args.kind,
          title: args.title,
          content: args.content,
          data: args.data ?? null,
          tags: args.tags ?? [],
          headquarter: relation(scope.hq),
          ...(scope.agent ? { agent: relation(scope.agent) } : {}),
          ...(scope.task ? { task: relation(scope.task) } : {}),
        },
      });
      const result = { documentId: row.documentId, kind: row.kind, title: row.title };
      return { content: [{ type: 'text' as const, text: `Saved memory "${row.title}" (${row.documentId}).` }], structuredContent: result };
    }),
  });

  const searchInput = z.object({
    query: z.string().max(200).optional().describe('Words to look for in titles and content. Leave empty for the most recent memories.'),
    kind: z.enum(MEMORY_KINDS).optional().describe('Only return this kind of memory.'),
    agentName: z.string().max(64).optional().describe('Only memories saved by an agent whose name contains this text, e.g. "Research".'),
    limit: z.number().int().min(1).max(25).default(8),
  });
  const searchOutput = z.object({ items: z.array(itemSchema) });

  mcp.registerTool({
    name: 'memory_search',
    title: 'Search memory',
    description: 'Search the shared memory of your headquarters, newest first. Returns excerpts; use memory_get for the full content.',
    auth: policy('read'),
    resolveInputSchema: () => searchInput,
    resolveOutputSchema: () => searchOutput,
    createHandler: (strapi) => async ({ args, extra }) => scoped(strapi, extra.requestInfo?.headers, async (scope) => {
      const and: Record<string, unknown>[] = [{ headquarter: { documentId: { $eq: scope.hq } } }];
      if (args.kind) and.push({ kind: { $eq: args.kind } });
      if (args.agentName) and.push({ agent: { name: { $containsi: args.agentName } } });
      const words = (args.query ?? '').split(/\s+/).filter(Boolean).slice(0, 6);
      for (const word of words) and.push({ $or: [{ title: { $containsi: word } }, { content: { $containsi: word } }] });

      const rows = await memories(strapi).findMany({
        filters: { $and: and },
        sort: { updatedAt: 'desc' },
        limit: args.limit,
        populate: { agent: { fields: ['name'] } },
      });
      const items = rows.map(toItem);
      const text = items.length
        ? items.map((i) => `- [${i.kind}] ${i.title} (${i.documentId})${i.agent ? ` by ${i.agent}` : ''}: ${i.excerpt}`).join('\n')
        : 'No matching memories.';
      return { content: [{ type: 'text' as const, text }], structuredContent: { items } };
    }),
  });

  const getInput = z.object({ documentId: z.string().regex(DOCUMENT_ID).describe('The documentId returned by memory_search or memory_save.') });
  const getOutput = z.object({
    documentId: z.string(), kind: z.string(), title: z.string(), content: z.string(),
    data: z.unknown().nullable(), agent: z.string().nullable(), updatedAt: z.string().nullable(),
  });

  mcp.registerTool({
    name: 'memory_get',
    title: 'Read memory',
    description: 'Read the full content of one memory from your headquarters.',
    auth: policy('read'),
    resolveInputSchema: () => getInput,
    resolveOutputSchema: () => getOutput,
    createHandler: (strapi) => async ({ args, extra }) => scoped(strapi, extra.requestInfo?.headers, async (scope) => {
      const row = await memories(strapi).findFirst({
        filters: { documentId: { $eq: args.documentId }, headquarter: { documentId: { $eq: scope.hq } } },
        populate: { agent: { fields: ['name'] } },
      });
      if (!row) return failure('No memory with that id in this headquarters.');
      const result = {
        documentId: row.documentId, kind: row.kind, title: row.title, content: row.content,
        data: row.data ?? null, agent: row.agent?.name ?? null, updatedAt: row.updatedAt ?? null,
      };
      return { content: [{ type: 'text' as const, text: `# ${row.title}\n\n${row.content}` }], structuredContent: result };
    }),
  });

  const updateInput = z.object({
    documentId: z.string().regex(DOCUMENT_ID),
    title: z.string().min(1).max(160).optional(),
    content: z.string().min(1).max(MAX_CONTENT).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  });

  mcp.registerTool({
    name: 'memory_update',
    title: 'Update memory',
    description: 'Revise an existing memory of your headquarters, e.g. to refine the shared project context or fix a script.',
    auth: policy('update'),
    resolveInputSchema: () => updateInput,
    resolveOutputSchema: () => savedOutput,
    createHandler: (strapi) => async ({ args, extra }) => scoped(strapi, extra.requestInfo?.headers, async (scope) => {
      const existing = await memories(strapi).findFirst({
        filters: { documentId: { $eq: args.documentId }, headquarter: { documentId: { $eq: scope.hq } } },
      });
      if (!existing) return failure('No memory with that id in this headquarters.');
      const changes: Record<string, unknown> = {};
      if (args.title !== undefined) changes.title = args.title;
      if (args.content !== undefined) changes.content = args.content;
      if (args.data !== undefined) changes.data = args.data;
      if (!Object.keys(changes).length) return failure('Nothing to update.');
      const row = await memories(strapi).update({ documentId: existing.documentId, data: changes });
      const result = { documentId: row.documentId, kind: row.kind, title: row.title };
      return { content: [{ type: 'text' as const, text: `Updated memory "${row.title}".` }], structuredContent: result };
    }),
  });
}
