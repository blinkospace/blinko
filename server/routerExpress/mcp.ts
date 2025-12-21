import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sseHandlers } from 'express-mcp-handler';
import { getTokenFromRequest } from '@server/lib/helper';
import { searchBlinkoTool } from "@server/aiServer/tools/searchBlinko";
import { upsertBlinkoTool } from "@server/aiServer/tools/createBlinko";
import { updateBlinkoTool } from "@server/aiServer/tools/updateBlinko";
import { deleteBlinkoTool } from "@server/aiServer/tools/deleteBlinko";
import { createCommentTool } from "@server/aiServer/tools/createComment";
import { webSearchTool } from "@server/aiServer/tools/webSearch";
import { webExtra } from "@server/aiServer/tools/webExtra";
import { createScheduledTaskTool, deleteScheduledTaskTool, listScheduledTasksTool } from "@server/aiServer/tools/scheduledTask";
import { RuntimeContext } from '@mastra/core/di';

const router = express.Router();

// Middleware to parse JSON
router.use(express.json());

// Global token for serverFactory
let globalToken: any = null;

// Auth middleware
const requireAuth = async (req: any, res: any, next: any) => {
  try {
    const token = await getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.user = token.token;
    globalToken = token.token;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Unauthorized" });
  }
};

function serverFactory() {
  const server = new McpServer({
    name: 'blinko-mcp-server',
    version: '1.0.0',
  });

  // Helper function to create tool with context
  const createToolWithContext = (toolName: string, tool: any) => {
    // Use the shape directly
    const mcpSchema = tool.inputSchema.shape;

    server.registerTool(
      toolName,
      {
        description: tool.description || '',
        inputSchema: mcpSchema
      },
      async (args: any, extra: any) => {
        try {
          console.log(`Executing tool ${toolName} with token:`, args);
          const { ...toolArgs } = args;
          let finalContext = { ...toolArgs, token: globalToken };
          console.log({ finalContext })
          const result = await tool.execute({ context: finalContext });

          return {
            content: [
              {
                type: "text",
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
              }
            ],
            structuredContent: result
          };
        } catch (error) {
          console.error(`Tool ${toolName} error:`, error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text",
                text: errorMessage
              }
            ],
            structuredContent: { success: false, error: errorMessage }
          };
        }
      }
    );
  };

  // Register all Blinko tools
  createToolWithContext('searchBlinko', searchBlinkoTool);
  createToolWithContext('upsertBlinko', upsertBlinkoTool);
  createToolWithContext('updateBlinko', updateBlinkoTool);
  createToolWithContext('deleteBlinko', deleteBlinkoTool);
  createToolWithContext('createComment', createCommentTool);
  createToolWithContext('webSearch', webSearchTool);
  createToolWithContext('webExtra', webExtra);
  createToolWithContext('createScheduledTask', createScheduledTaskTool);
  createToolWithContext('deleteScheduledTask', deleteScheduledTaskTool);
  createToolWithContext('listScheduledTasks', listScheduledTasksTool);

  return server;
}

// Configure the SSE handlers
const handlers = sseHandlers(serverFactory, {
  onError: (error: Error, sessionId?: string) => {
    console.error(`[MCP SSE][${sessionId || 'unknown'}]`, error);
  },
  onClose: (sessionId: string) => {
    console.log(`[MCP SSE] Transport closed: ${sessionId}`);
  }
});

// Mount the handlers with auth
router.get('/sse', requireAuth, (req, res, next) => {
  handlers.getHandler(req, res, next);
});
router.post('/messages', requireAuth, (req, res, next) => {
  handlers.postHandler(req, res, next);
});

export default router;
