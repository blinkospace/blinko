import { z } from 'zod';
import { prisma } from '../prisma';
import { router, authProcedure, publicProcedure } from '../middleware';

// Helper to convert Buffer to base64 string for JSON transmission
function bufferToBase64(buffer: Buffer | null | undefined): string | null {
  if (!buffer) return null;
  return buffer.toString('base64');
}

// Helper to transform font from DB to API response
function transformFont(font: any) {
  return {
    id: font.id,
    name: font.name,
    displayName: font.displayName,
    url: font.url,
    fileData: bufferToBase64(font.fileData),
    isLocal: font.isLocal,
    weights: font.weights as number[],
    category: font.category,
    isSystem: font.isSystem,
    sortOrder: font.sortOrder,
    createdAt: font.createdAt,
    updatedAt: font.updatedAt,
  };
}

// Schema for font metadata (without binary data - for listing)
const fontMetadataSchema = z.object({
  id: z.number(),
  name: z.string(),
  displayName: z.string(),
  url: z.string().nullable(),
  isLocal: z.boolean(),
  weights: z.array(z.number()),
  category: z.string(),
  isSystem: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Schema for font data with binary (for single font fetch)
const fontSchema = z.object({
  id: z.number(),
  name: z.string(),
  displayName: z.string(),
  url: z.string().nullable(),
  fileData: z.string().nullable(), // Base64 encoded string
  isLocal: z.boolean(),
  weights: z.array(z.number()),
  category: z.string(),
  isSystem: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const fontInputSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  url: z.string().nullable().optional(),
  isLocal: z.boolean().default(false),
  weights: z.array(z.number()).default([400]),
  category: z.enum(['serif', 'sans-serif', 'monospace', 'display', 'handwriting']).default('sans-serif'),
  isSystem: z.boolean().default(false),
  sortOrder: z.number().default(0),
});

// Helper to transform font metadata (without fileData)
function transformFontMetadata(font: any) {
  return {
    id: font.id,
    name: font.name,
    displayName: font.displayName,
    url: font.url,
    isLocal: font.isLocal,
    weights: font.weights as number[],
    category: font.category,
    isSystem: font.isSystem,
    sortOrder: font.sortOrder,
    createdAt: font.createdAt,
    updatedAt: font.updatedAt,
  };
}

export const fontRouter = router({
  // List all fonts (metadata only - no binary data for performance)
  list: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/font/list', summary: 'List all available fonts (metadata only)', tags: ['Font'] } })
    .input(z.object({
      category: z.string().optional(),
    }).optional())
    .output(z.array(fontMetadataSchema))
    .query(async ({ input }) => {
      const where: any = {};
      
      if (input?.category) {
        where.category = input.category;
      }

      // Select only metadata fields, exclude fileData for performance
      const fonts = await prisma.fonts.findMany({
        where,
        select: {
          id: true,
          name: true,
          displayName: true,
          url: true,
          isLocal: true,
          weights: true,
          category: true,
          isSystem: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
          // fileData intentionally excluded
        },
        orderBy: [
          { sortOrder: 'asc' },
          { name: 'asc' },
        ],
      });

      return fonts.map(transformFontMetadata);
    }),

  // Get font binary data by name (for lazy loading)
  getFontData: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/font/data', summary: 'Get font binary data by name', tags: ['Font'] } })
    .input(z.object({ name: z.string() }))
    .output(z.object({
      name: z.string(),
      fileData: z.string().nullable(),
    }))
    .query(async ({ input }) => {
      const font = await prisma.fonts.findUnique({
        where: { name: input.name },
        select: {
          name: true,
          fileData: true,
        },
      });

      if (!font) return { name: input.name, fileData: null };

      return {
        name: font.name,
        fileData: bufferToBase64(font.fileData),
      };
    }),

  // Get a single font by name
  getByName: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/font/get', summary: 'Get font by name', tags: ['Font'] } })
    .input(z.object({ name: z.string() }))
    .output(fontSchema.nullable())
    .query(async ({ input }) => {
      const font = await prisma.fonts.findUnique({
        where: { name: input.name },
      });

      if (!font) return null;

      return transformFont(font);
    }),

  // Create a new font (admin only)
  create: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/font/create', summary: 'Create a new font', protect: true, tags: ['Font'] } })
    .input(fontInputSchema)
    .output(fontSchema)
    .mutation(async ({ input, ctx }) => {
      // Only superadmin can create fonts
      if (ctx.role !== 'superadmin') {
        throw new Error('Unauthorized: Only superadmin can create fonts');
      }

      const font = await prisma.fonts.create({
        data: {
          name: input.name,
          displayName: input.displayName,
          url: input.url ?? null,
          isLocal: input.isLocal,
          weights: input.weights,
          category: input.category,
          isSystem: input.isSystem,
          sortOrder: input.sortOrder,
        },
      });

      return transformFont(font);
    }),

  // Update a font (admin only)
  update: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/font/update', summary: 'Update a font', protect: true, tags: ['Font'] } })
    .input(z.object({
      id: z.number(),
      data: fontInputSchema.partial(),
    }))
    .output(fontSchema)
    .mutation(async ({ input, ctx }) => {
      if (ctx.role !== 'superadmin') {
        throw new Error('Unauthorized: Only superadmin can update fonts');
      }

      const font = await prisma.fonts.update({
        where: { id: input.id },
        data: input.data,
      });

      return transformFont(font);
    }),

  // Delete a font (admin only)
  delete: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/font/delete', summary: 'Delete a font', protect: true, tags: ['Font'] } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.role !== 'superadmin') {
        throw new Error('Unauthorized: Only superadmin can delete fonts');
      }

      await prisma.fonts.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  // Upload a font file (admin only)
  upload: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/font/upload', summary: 'Upload a font file', protect: true, tags: ['Font'] } })
    .input(z.object({
      name: z.string().min(1),
      displayName: z.string().min(1),
      fileData: z.string(), // Base64 encoded font file
      category: z.enum(['serif', 'sans-serif', 'monospace', 'display', 'handwriting']).default('sans-serif'),
    }))
    .output(fontMetadataSchema)
    .mutation(async ({ input, ctx }) => {
      if (ctx.role !== 'superadmin') {
        throw new Error('Unauthorized: Only superadmin can upload fonts');
      }

      // Decode base64 to Buffer
      const fileBuffer = Buffer.from(input.fileData, 'base64');
      
      // Validate file size (max 10MB to prevent memory issues)
      const MAX_FONT_SIZE = 10 * 1024 * 1024; // 10MB
      if (fileBuffer.length > MAX_FONT_SIZE) {
        throw new Error(`Font file too large. Maximum size is ${MAX_FONT_SIZE / 1024 / 1024}MB`);
      }
      
      if (fileBuffer.length === 0) {
        throw new Error('Font file is empty');
      }

      // Detect if it's a variable font (check file size heuristic - variable fonts are usually larger)
      // For simplicity, assume variable font weights
      // TODO: Could improve by actually parsing font file to detect weights
      const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900];

      // Get the next sort order
      const lastFont = await prisma.fonts.findFirst({
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const sortOrder = (lastFont?.sortOrder ?? 0) + 1;

      const font = await prisma.fonts.create({
        data: {
          name: input.name,
          displayName: input.displayName,
          url: null,
          fileData: fileBuffer,
          isLocal: true,
          weights: weights,
          category: input.category,
          isSystem: false,
          sortOrder: sortOrder,
        },
      });

      return transformFontMetadata(font);
    }),
});
