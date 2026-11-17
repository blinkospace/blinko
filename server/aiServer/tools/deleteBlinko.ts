import { userCaller } from '@server/routerTrpc/_app';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { verifyToken } from '@server/lib/helper';

export const deleteBlinkoTool = createTool({
  id: 'delete-blinko-tool',
  description: 'you are a blinko assistant,you can use api to delete blinko,save to database',
  //@ts-ignore
  inputSchema: z.object({
    ids: z.array(z.number()),
    token: z.string().optional().describe("internal use, do not pass!")
  }),
  execute: async ({ context, runtimeContext }) => {
    const accountId = runtimeContext?.get('accountId') || (await verifyToken(context.token))?.sub;

    try {
      const caller = userCaller({
        id: String(accountId),
        exp: 0,
        iat: 0,
        name: 'admin',
        sub: String(accountId),
        role: 'superadmin'
      })
      const result = await caller.notes.trashMany({
        ids: context.ids
      })
      return { success: true, deletedCount: result.count }
    } catch (error) {
      console.log(error)
      return { success: false, error: error.message }
    }
  }
});