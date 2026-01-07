import { userCaller } from '@server/routerTrpc/_app';
import { NoteType } from '@shared/lib/types';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { verifyToken } from '@server/lib/helper';

export const upsertBlinkoTool = createTool({
  id: 'upsert-blinko-tool',
  description: 'You are a blinko assistant. You can create different types of content. "Blinko" means flash thoughts or sudden inspiration - those fleeting ideas that pop into mind.',
  inputSchema: z.object({
    id: z.number().optional().describe('Optional: The note ID to update. If provided, updates the existing note; if omitted, creates a new note.'),
    content: z.string().describe("The content to save. Tag is start with #"),
    type: z.string().optional().default('blinko').describe('Optional: The type of content: "blinko" (flash thoughts/sudden ideas/fleeting inspiration - the default), "note" (longer, structured content), or "todo" (tasks to be done)'),
    token: z.string().optional().describe("internal use, do not pass!")
  }),
  execute: async ({ context, runtimeContext }) => {
    const accountId = runtimeContext?.get('accountId') || (await verifyToken(context.token))?.sub;
    
    console.log(`create note:${context.content}, type:${context.type}, accountId:${accountId}`);
    
    // Convert string type to NoteType enum
    let noteType: NoteType;
    const typeStr = (context.type || 'blinko').toLowerCase();
    
    switch (typeStr) {
      case 'note':
      case '1':
        noteType = NoteType.NOTE; // 1
        break;
      case 'todo':
      case '2':
        noteType = NoteType.TODO; // 2
        break;
      case 'blinko':
      case '0':
      default:
        noteType = NoteType.BLINKO; // 0
        break;
    }
    
    try {
      const caller = userCaller({
        id: String(accountId),
        exp: 0,
        iat: 0,
        name: 'admin',
        sub: String(accountId),
        role: 'superadmin'
      })
      const note = await caller.notes.upsert({
        id: context.id, // Pass the id if provided, otherwise undefined (will create new)
        content: context.content,
        type: noteType,
      })
      console.log(context.id ? 'Updated note:' : 'Created note:', note)
      return note
    } catch (error) {
      console.log('Error creating/updating note:', error)
      return error.message
    }
  }
});