import type { Core } from '@strapi/strapi';
import { registerMemoryTools } from './mcp/memory-tools';

export default {
  /**
   * Runs before the application is initialized. MCP capabilities must be registered here,
   * before the MCP HTTP server starts during bootstrap.
   */
  register({ strapi }: { strapi: Core.Strapi }) {
    // Headquarters-scoped shared memory for Creator City agents (see src/mcp/memory-tools.ts).
    registerMemoryTools(strapi);
  },

  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // strapi-plugin-imagekit 1.0.2 crashes when it sanitises an uploaded file whose `formats` is null (audio,
    // video, PDFs, text, and images too small for thumbnails): the file is stored but /api/upload answers 500,
    // and so does listing files. New files store an empty object instead, and older ones get one when read.
    const fillFormats = (file: unknown) => {
      if (file && typeof file === 'object' && 'formats' in file && (file as { formats: unknown }).formats == null) {
        (file as { formats: unknown }).formats = {};
      }
    };
    strapi.db.lifecycles.subscribe({
      models: ['plugin::upload.file'],
      beforeCreate(event) {
        const data = event.params.data as { formats?: unknown } | undefined;
        if (data && data.formats == null) data.formats = {};
      },
      afterFindOne(event) { fillFormats(event.result); },
      afterFindMany(event) { if (Array.isArray(event.result)) event.result.forEach(fillFormats); },
    });
  },
};
