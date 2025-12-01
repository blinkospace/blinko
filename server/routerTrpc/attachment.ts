import { router, authProcedure } from '../middleware';
import { z } from 'zod';
import { prisma } from '../prisma';
import { Prisma } from '@prisma/client';
import path from 'path';
import { FileService } from '../lib/files';

export interface AttachmentResult {
  id: number | null;
  path: string;
  name: string;
  size: string | null;
  type: string | null;
  isShare: boolean;
  sharePassword: string;
  noteId: number | null;
  sortOrder: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  isFolder: boolean;
  folderName: string | null;
}

const mapAttachmentResult = (item: any): AttachmentResult => ({
  id: item.id,
  path: item.path,
  name: item.name,
  size: item.size?.toString() || null,
  type: item.type,
  isShare: item.isShare,
  sharePassword: item.sharePassword,
  noteId: item.noteId,
  sortOrder: item.sortOrder,
  createdAt: item.createdAt ? new Date(item.createdAt) : null,
  updatedAt: item.updatedAt ? new Date(item.updatedAt) : null,
  isFolder: item.is_folder,
  folderName: item.folder_name
});

export const attachmentsRouter = router({
  createFolder: authProcedure
    .input(z.object({
      folderName: z.string(),
      parentFolder: z.string().optional()
    }))
    .mutation(async ({ input, ctx }) => {
      const { folderName, parentFolder } = input;
      
      // Build the folder path
      const folderPath = parentFolder 
        ? `${parentFolder.split('/').join(',')},${folderName}`
        : folderName;
      
      // Create a placeholder attachment record for the folder
      const placeholder = await prisma.attachments.create({
        data: {
          path: `/api/file/${parentFolder ? `${parentFolder}/` : ''}${folderName}/.folder`,
          name: '.folder',
          size: 0,
          type: 'folder',
          perfixPath: folderPath,
          accountId: Number(ctx.id),
          isShare: false,
          sharePassword: '',
          sortOrder: 0
        }
      });
      
      return {
        success: true,
        folderName,
        folderPath
      };
    }),
  
  list: authProcedure
    .input(z.object({
      page: z.number().default(1),
      size: z.number().default(10),
      searchText: z.string().default('').optional(),
      folder: z.string().optional()
    }))
    .query(async function ({ input, ctx }) {
      const { page, size, searchText, folder } = input;
      const skip = (page - 1) * size;

      if (searchText) {
        const attachments = await prisma.attachments.findMany({
          where: {
            OR: [
              {
                note: {
                  accountId: Number(ctx.id)
                }
              },
              {
                accountId: Number(ctx.id)
              }
            ],
            AND: {
              OR: [
                { name: { contains: searchText, mode: 'insensitive' } },
                { path: { contains: searchText, mode: 'insensitive' } }
              ]
            }
          },
          orderBy: [
            { sortOrder: 'asc' },
            { updatedAt: 'desc' }
          ],
          take: size,
          skip: skip
        });

        return attachments.map(item => ({
          id: item.id,
          path: item.path,
          name: item.name,
          size: item.size?.toString() || null,
          type: item.type,
          isShare: item.isShare,
          sharePassword: item.sharePassword,
          noteId: item.noteId,
          sortOrder: item.sortOrder,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          isFolder: false,
          folderName: null
        }));
      }

      if (folder) {
        const folderPath = folder.split('/').join(',');

        const rawQuery = Prisma.sql`
          WITH combined_items AS (
            SELECT DISTINCT ON (folder_name)
              NULL as id,
              CASE 
                WHEN path LIKE '/api/s3file/%' THEN '/api/s3file/'
                ELSE '/api/file/'
              END || split_part("perfixPath", ',', array_length(string_to_array(${folderPath}, ','), 1) + 1) as path,
              split_part("perfixPath", ',', array_length(string_to_array(${folderPath}, ','), 1) + 1) as name,
              NULL::decimal as size,
              NULL as type,
              false as "isShare",
              '' as "sharePassword",
              NULL as "noteId",
              0 as "sortOrder",
              NULL as "createdAt",
              NULL as "updatedAt",
              true as is_folder,
              split_part("perfixPath", ',', array_length(string_to_array(${folderPath}, ','), 1) + 1) as folder_name
            FROM attachments
            WHERE ("noteId" IN (
              SELECT id FROM notes WHERE "accountId" = ${Number(ctx.id)}
            ) OR "accountId" = ${Number(ctx.id)})
              AND "perfixPath" LIKE ${`${folderPath},%`}
              AND array_length(string_to_array("perfixPath", ','), 1) > array_length(string_to_array(${folderPath}, ','), 1)
            
            UNION ALL
            
            SELECT 
              id,
              path,
              name,
              size,
              type,
              "isShare",
              "sharePassword",
              "noteId",
              "sortOrder",
              "createdAt",
              "updatedAt",
              false as is_folder,
              NULL as folder_name
            FROM attachments
            WHERE ("noteId" IN (
              SELECT id FROM notes WHERE "accountId" = ${Number(ctx.id)}
            ) OR "accountId" = ${Number(ctx.id)})
              AND "perfixPath" = ${folderPath}
          )
          SELECT *
          FROM combined_items
          ORDER BY is_folder DESC, "sortOrder" ASC, "updatedAt" DESC NULLS LAST
          LIMIT ${size}
          OFFSET ${skip};
        `;

        const results = await prisma.$queryRaw<any[]>(rawQuery);
        return results.map(mapAttachmentResult);
      }

      const rawQuery = Prisma.sql`
        WITH combined_items AS (
          SELECT DISTINCT ON (folder_name)
            NULL as id,
            CASE 
              WHEN path LIKE '/api/s3file/%' THEN '/api/s3file/'
              ELSE '/api/file/'
            END || split_part("perfixPath", ',', 1) as path,
            split_part("perfixPath", ',', 1) as name,
            NULL::decimal as size,
            NULL as type,
            false as "isShare",
            '' as "sharePassword",
            NULL as "noteId",
            0 as "sortOrder",
            NULL as "createdAt",
            NULL as "updatedAt",
            true as is_folder,
            split_part("perfixPath", ',', 1) as folder_name
          FROM attachments
          WHERE ("noteId" IN (
            SELECT id FROM notes WHERE "accountId" = ${Number(ctx.id)}
          ) OR "accountId" = ${Number(ctx.id)})
            AND "perfixPath" != ''
            AND LOWER("perfixPath") LIKE ${`%${searchText?.toLowerCase() || ''}%`}
          
          UNION ALL
          
          SELECT 
            id,
            path,
            name,
            size,
            type,
            "isShare",
            "sharePassword",
            "noteId",
            "sortOrder",
            "createdAt",
            "updatedAt",
            false as is_folder,
            NULL as folder_name
          FROM attachments
          WHERE ("noteId" IN (
            SELECT id FROM notes WHERE "accountId" = ${Number(ctx.id)}
          ) OR "accountId" = ${Number(ctx.id)})
            AND depth = 0
            AND LOWER(path) LIKE ${`%${searchText?.toLowerCase() || ''}%`}
        )
        SELECT *
        FROM combined_items
        ORDER BY is_folder DESC, "sortOrder" ASC, "updatedAt" DESC NULLS LAST
        LIMIT ${size}
        OFFSET ${skip};
      `;

      const results = await prisma.$queryRaw<any[]>(rawQuery);
      return results.map(mapAttachmentResult);
    }),

  rename: authProcedure
    .input(z.object({
      id: z.number().optional(),
      newName: z.string(),
      isFolder: z.boolean().optional(),
      oldFolderPath: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, newName, isFolder, oldFolderPath } = input;

      if (!isFolder && (newName.includes('/') || newName.includes('\\'))) {
        throw new Error('File names cannot contain path separators');
      }

      return await prisma.$transaction(async (tx) => {
        if (isFolder && oldFolderPath) {
          const attachments = await tx.attachments.findMany({
            where: {
              OR: [
                {
                  note: {
                    accountId: Number(ctx.id)
                  },
                },
                {
                  accountId: Number(ctx.id)
                }
              ],
              perfixPath: {
                startsWith: oldFolderPath
              }
            }
          });

          try {
            for (const attachment of attachments) {
              const newPerfixPath = attachment.perfixPath?.replace(oldFolderPath, newName);
              const oldPath = attachment.path;
              const isS3File = oldPath.startsWith('/api/s3file/');
              const baseUrl = isS3File ? '/api/s3file/' : '/api/file/';

              const newPath = attachment.path.replace(
                `${baseUrl}${oldFolderPath.split(',').join('/')}`,
                `${baseUrl}${newName.split(',').join('/')}`
              );

              await FileService.moveFile(oldPath, newPath);

              await tx.attachments.update({
                where: { id: attachment.id },
                data: {
                  perfixPath: newPerfixPath,
                  path: newPath,
                  depth: newPerfixPath?.split(',').length
                }
              });
            }
            return { success: true };
          } catch (error) {
            throw new Error(`Failed to rename folder: ${error.message}`);
          }
        }

        const attachment = await tx.attachments.findFirst({
          where: {
            id,
            note: {
              accountId: Number(ctx.id)
            }
          }
        });

        if (!attachment) {
          throw new Error('Attachment not found');
        }

        try {
          await FileService.renameFile(attachment.path, input.newName);
          return await tx.attachments.update({
            where: { id: input.id },
            data: {
              name: input.newName,
              path: attachment.path.replace(attachment.name, input.newName)
            }
          });
        } catch (error) {
          throw new Error(`Failed to rename file: ${error.message}`);
        }
      });
    }),

  move: authProcedure
    .input(z.object({
      sourceIds: z.array(z.number()),
      targetFolder: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { sourceIds, targetFolder } = input;

      return await prisma.$transaction(async (tx) => {
        const attachments = await tx.attachments.findMany({
          where: {
            id: { in: sourceIds },
            note: {
              accountId: Number(ctx.id)
            }
          }
        });

        if (attachments.length === 0) {
          throw new Error('Attachments not found');
        }

        try {
          for (const attachment of attachments) {
            const newPerfixPath = targetFolder;
            const oldPath = attachment.path;
            const isS3File = oldPath.startsWith('/api/s3file/');
            const baseUrl = isS3File ? '/api/s3file/' : '/api/file/';

            const newPath = targetFolder 
              ? `${baseUrl}${targetFolder.split(',').join('/')}/${attachment.name}`
              : `${baseUrl}${attachment.name}`;

            await FileService.moveFile(oldPath, newPath);

            await tx.attachments.update({
              where: { id: attachment.id },
              data: {
                perfixPath: newPerfixPath,
                depth: newPerfixPath ? newPerfixPath.split(',').length : 0,
                path: newPath
              }
            });
          }
          
          return {
            success: true,
            message: 'Files moved successfully'
          };
        } catch (error) {
          console.error('Move file error:', error);
          throw new Error(`Failed to move files: ${error.message}`);
        }
      });
    }),

  delete: authProcedure
    .input(z.object({
      id: z.union([z.number(),z.null()]).optional(),
      isFolder: z.boolean().optional(),
      folderPath: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, isFolder, folderPath } = input;

      return await prisma.$transaction(async (tx) => {
        if (isFolder && folderPath) {
          const attachments = await tx.attachments.findMany({
            where: {
              note: {
                accountId: Number(ctx.id)
              },
              perfixPath: {
                startsWith: folderPath
              }
            }
          });

          if (attachments.length === 0) {
            return { success: true, message: 'Folder deleted successfully' };
          }

          try {
            for (const attachment of attachments) {
              await FileService.deleteFile(attachment.path);
            }
            return { success: true, message: 'Folder and its contents deleted successfully' };
          } catch (error) {
            throw new Error(`Failed to delete folder: ${error.message}`);
          }
        }

        const attachment = await tx.attachments.findFirst({
          where: {
            id: id!
          }
        });

        if (!attachment) {
          throw new Error('Attachment not found');
        }

        try {
          await FileService.deleteFile(attachment.path);
          return {
            success: true,
            message: 'File deleted successfully'
          };
        } catch (error) {
          throw new Error(`Failed to delete file: ${error.message}`);
        }
      });
    }),
    deleteMany: authProcedure
    .input(z.object({
      ids: z.array(z.number()),
    }))
    .mutation(async ({ input, ctx }) => {
      const { ids } = input;
      await prisma.attachments.deleteMany({
        where: {
          id: { in: ids }
        }
      });
      return { success: true, message: 'Files deleted successfully' };
    }),
});
