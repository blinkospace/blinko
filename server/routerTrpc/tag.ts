import { router, authProcedure, demoAuthMiddleware } from '@server/middleware';
import { z } from 'zod';
import { prisma } from '@server/prisma';
import { userCaller } from './_app';
import { tagSchema } from '@shared/lib/prismaZodType';

export const tagRouter = router({
  list: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/tags/list', summary: 'Get user tags', protect: true, tags: ['Tag'] } })
    .input(z.void())
    .output(z.array(z.object({
      id: z.number().int(),
      name: z.string(),
      icon: z.string(),
      parent: z.number().int(),
      sortOrder: z.number().int(),
      createdAt: z.coerce.date(),
      updatedAt: z.coerce.date(),
      _count: z.object({
        tagsToNote: z.number().int()
      }).optional()
    })))
    .query(async function ({ ctx }) {
      const tags = await prisma.tag.findMany({
        where: {
          accountId: Number(ctx.id)
        },
        orderBy: {
          sortOrder: 'asc'
        },
        distinct: ['id'],
        include: {
          _count: {
            select: {
              tagsToNote: {
                where: {
                  note: {
                    isRecycle: false
                  }
                }
              }
            }
          }
        }
      });
      return tags;
    }),

  fullTagNameById: authProcedure
    .input(z.object({
      id: z.number()
    }))
    .output(z.string())
    .query(async function ({ input }) {
      const { id } = input
      const tag = await prisma.tag.findFirst({ where: { id } })
      if (!tag) {
        throw new Error('Tag not found')
      }

      if (tag.parent === 0) {
        return '#' + tag.name;
      }

      const getParentTags = async (currentTag: typeof tag): Promise<string[]> => {
        if (!currentTag || currentTag.parent === 0) {
          return [currentTag.name];
        }
        
        const parentTag = await prisma.tag.findFirst({
          where: { id: currentTag.parent }
        });
        
        if (!parentTag) {
          return [currentTag.name];
        }

        const parentNames = await getParentTags(parentTag);
        return [...parentNames, currentTag.name];
      };

      const tagNames = await getParentTags(tag);
      return '#' + tagNames.join('/');
    }),
  updateTagMany: authProcedure
    .meta({
      openapi: {
        method: 'POST', path: '/v1/tags/batch-update', summary: 'Batch update tags',
        description: 'Batch update tags and add tag to notes', protect: true, tags: ['Tag']
      }
    })
    .input(z.object({
      ids: z.array(z.number()),
      tag: z.string()
    }))
    .output(z.boolean())
    .mutation(async function ({ input, ctx }) {
      const { ids, tag } = input
      const notes = await prisma.notes.findMany({ where: { id: { in: ids } } })
      for (const note of notes) {
        const newContent = note.content += ' #' + tag
        await userCaller(ctx).notes.upsert({ content: newContent, id: note.id, type: -1 })
      }
      return true
    }),
  updateTagName: authProcedure
    .meta({
      openapi: {
        method: 'POST', path: '/v1/tags/update-name', summary: 'Update tag name',
        description: 'Update tag name and update tag to notes', protect: true, tags: ['Tag']
      }
    })
    .input(z.object({
      oldName: z.string(),
      newName: z.string(),
      id: z.number()
    }))
    .output(z.boolean())
    .mutation(async function ({ input, ctx }) {
      const { id, oldName, newName } = input
      const tagToNote = await prisma.tagsToNote.findMany({ where: { tagId: id } })
      const noteIds = tagToNote.map(i => i.noteId)
      const hasTagNote = await prisma.notes.findMany({ where: { id: { in: noteIds } } })
      hasTagNote.map(i => {
        i.content = i.content.replace(new RegExp(`#${oldName}`, 'g'), "#" + newName)
      })
      for (const note of hasTagNote) {
        await userCaller(ctx).notes.upsert({ content: note.content, id: note.id, type: note.type })
      }
      return true
    }),
  updateTagIcon: authProcedure
    .meta({ openapi: { method: 'POST', path: '/v1/tags/update-icon', summary: 'Update tag icon', protect: true, tags: ['Tag'] } })
    .input(z.object({
      id: z.number(),
      icon: z.string()
    }))
    .output(tagSchema)
    .mutation(async function ({ input }) {
      const { id, icon } = input
      return await prisma.tag.update({ where: { id }, data: { icon } })
    }),
  deleteOnlyTag: authProcedure.use(demoAuthMiddleware)
    .meta({
      openapi: {
        method: 'POST', path: '/v1/tags/delete-only-tag', summary: 'Only delete tag name',
        description: 'Only delete tag name and remove tag from notes, but not delete notes', protect: true, tags: ['Tag']
      }
    })
    .input(z.object({
      id: z.number()
    }))
    .output(z.boolean())
    .mutation(async function ({ input, ctx }) {
      const { id } = input
      const tag = await prisma.tag.findFirst({
        where: {
          id,
          accountId: Number(ctx.id)
        },
        include: { tagsToNote: true }
      })

      if (!tag) return true

      const allNotesId = tag.tagsToNote.map(i => i.noteId)

      for (const noteId of allNotesId) {
        const note = await prisma.notes.findFirst({ where: { id: noteId } })
        if (!note) continue

        const getAllTagIdsInChain = async (tagId: number): Promise<number[]> => {
          const result: number[] = [tagId];
          
          let currentTag = await prisma.tag.findFirst({ where: { id: tagId } });
          while (currentTag && currentTag.parent !== 0) {
            result.push(currentTag.parent);
            currentTag = await prisma.tag.findFirst({ where: { id: currentTag.parent } });
          }
          
          const childTags = await prisma.tag.findMany({ where: { parent: tagId } });
          for (const childTag of childTags) {
            const childChain = await getAllTagIdsInChain(childTag.id);
            result.push(...childChain);
          }
          
          return [...new Set(result)];
        };

        const tagIdsInChain = await getAllTagIdsInChain(tag.id);
        
        await prisma.notes.update({
          where: { id: note.id },
          data: { 
            content: note.content.replace(
              new RegExp(`#[^\\s]*${tag.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[^\\s]*)?(?=\\s|$)`, 'g'),
              ''
            ).trim()
          }
        })

        await prisma.tagsToNote.deleteMany({ 
          where: { 
            noteId: note.id,
            tagId: {
              in: tagIdsInChain
            }
          } 
        })

        for (const tagId of tagIdsInChain) {
          const tagExists = await prisma.tag.findFirst({
            where: { id: tagId }
          });
          
          if (tagExists) {
            const tagUsageCount = await prisma.tagsToNote.count({
              where: { tagId }
            });

            if (tagUsageCount === 0) {
              await prisma.tag.delete({ where: { id: tagId } });
            }
          }
        }
      }
      return true
    }),
  deleteTagWithAllNote: authProcedure.use(demoAuthMiddleware)
    .meta({
      openapi: {
        method: 'POST', path: '/v1/tags/delete-tag-with-notes', summary: 'Delete tag and delete notes',
        description: 'Delete tag and delete notes', protect: true, tags: ['Tag']
      }
    })
    .input(z.object({
      id: z.number()
    }))
    .output(z.boolean())
    .mutation(async function ({ input, ctx }) {
      const { id } = input
      const tag = await prisma.tag.findFirst({ where: { id, accountId: Number(ctx.id) }, include: { tagsToNote: true } })
      const allNotesId = tag?.tagsToNote.map(i => i.noteId) ?? []
      await userCaller(ctx).notes.trashMany({ ids: allNotesId })
      await userCaller(ctx).tags.deleteOnlyTag({ id })
      return true
    }),
  updateTagOrder: authProcedure
    .input(z.object({
      id: z.number(),
      sortOrder: z.number()
    }))
    .mutation(async function ({ input }) {
      const { id, sortOrder } = input
      return await prisma.tag.update({
        where: { id },
        data: { sortOrder }
      })
    }),
})
