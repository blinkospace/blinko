import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getTokenFromRequest } from '@server/lib/helper';
import { searchBlinkoTool } from '@server/aiServer/tools/searchBlinko';
import { upsertBlinkoTool } from '@server/aiServer/tools/createBlinko';
import { updateBlinkoTool } from '@server/aiServer/tools/updateBlinko';
import { deleteBlinkoTool } from '@server/aiServer/tools/deleteBlinko';
import { createCommentTool } from '@server/aiServer/tools/createComment';
import { webSearchTool } from '@server/aiServer/tools/webSearch';
import { webExtra } from '@server/aiServer/tools/webExtra';
import {
  createScheduledTaskTool,
  deleteScheduledTaskTool,
  listScheduledTasksTool,
} from '@server/aiServer/tools/scheduledTask';

const router = express.Router();

router.use(express.json());
router.use((_req, res, next) => {
  res.append('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  next();
});

type AuthContext = NonNullable<Awaited<ReturnType<typeof getTokenFromRequest>>>;
interface StreamableSession {
  authContext: AuthContext;
  transport: StreamableHTTPServerTransport;
}

interface SseSession {
  authContext: AuthContext;
  transport: SSEServerTransport;
}

const streamableSessions = new Map<string, StreamableSession>();
const sseSessions = new Map<string, SseSession>();

function getFirstString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return undefined;
}

function isInitializationPayload(payload: unknown): boolean {
  return isInitializeRequest(payload)
    || (Array.isArray(payload) && payload.some(message => isInitializeRequest(message)));
}

function getStreamableSessionId(req: express.Request): string | undefined {
  return getFirstString(req.headers['mcp-session-id']);
}

function getSseSessionId(req: express.Request): string | undefined {
  return getFirstString(req.query.sessionId);
}

async function authenticateRequest(req: express.Request, res: express.Response): Promise<AuthContext | null> {
  try {
    const authContext = await getTokenFromRequest(req);
    if (!authContext) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }

    req.user = authContext.token;
    return authContext;
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
}

function isSameSessionUser(currentAuth: AuthContext, sessionAuth: AuthContext): boolean {
  return currentAuth.id === sessionAuth.id && currentAuth.role === sessionAuth.role;
}

async function authenticateSessionRequest(
  req: express.Request,
  res: express.Response,
  sessionAuth: AuthContext,
): Promise<AuthContext | null> {
  const authContext = await authenticateRequest(req, res);
  if (!authContext) {
    return null;
  }

  if (!isSameSessionUser(authContext, sessionAuth)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }

  return authContext;
}

function sendJsonRpcError(res: express.Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

function logTransportError(protocol: 'streamable' | 'sse', error: unknown, sessionId?: string) {
  const label = protocol === 'streamable' ? 'MCP Streamable' : 'MCP SSE';
  console.error(`[${label}][${sessionId || 'unknown'}]`, error);
}

function cleanupTransport(
  protocol: 'streamable' | 'sse',
  sessionId: string,
) {
  if (protocol === 'streamable') {
    if (!streamableSessions.delete(sessionId)) {
      return;
    }
    console.log(`[MCP Streamable] Session closed: ${sessionId}`);
    return;
  }

  if (!sseSessions.delete(sessionId)) {
    return;
  }
  console.log(`[MCP SSE] Session closed: ${sessionId}`);
}

function createBlinkoMcpServer(getAuthContext: () => AuthContext) {
  const server = new McpServer({
    name: 'blinko-mcp-server',
    version: '1.0.0',
  });

  const createToolWithContext = (toolName: string, tool: any) => {
    const mcpSchema = tool.inputSchema.shape;

    server.registerTool(
      toolName,
      {
        description: tool.description || '',
        inputSchema: mcpSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const authContext = getAuthContext();
          const finalContext = {
            ...args,
            token: authContext.token,
          };
          const result = await tool.execute({ context: finalContext });

          return {
            content: [
              {
                type: 'text' as const,
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            ],
            structuredContent: result,
          };
        } catch (error) {
          console.error(`Tool ${toolName} error:`, error);
          const errorMessage = error instanceof Error ? error.message : String(error);

          return {
            content: [
              {
                type: 'text' as const,
                text: errorMessage,
              },
            ],
            structuredContent: { success: false, error: errorMessage },
          };
        }
      },
    );
  };

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

async function createStreamableTransport(authContext: AuthContext): Promise<StreamableHTTPServerTransport> {
  let transport!: StreamableHTTPServerTransport;
  const session: StreamableSession = {
    authContext,
    transport: undefined as unknown as StreamableHTTPServerTransport,
  };
  const server = createBlinkoMcpServer(() => session.authContext);

  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      session.transport = transport;
      streamableSessions.set(sessionId, session);
      console.log(`[MCP Streamable] Session initialized: ${sessionId}`);
    },
  });
  session.transport = transport;

  transport.onclose = () => {
    if (transport.sessionId) {
      cleanupTransport('streamable', transport.sessionId);
    }
  };
  transport.onerror = (error) => {
    logTransportError('streamable', error, transport.sessionId);
  };

  await server.connect(transport);
  return transport;
}

async function createSseTransport(
  authContext: AuthContext,
  res: express.Response,
): Promise<SSEServerTransport> {
  let session!: SseSession;
  const server = createBlinkoMcpServer(() => session.authContext);
  const transport = new SSEServerTransport('/messages', res);
  const sessionId = transport.sessionId;

  session = { authContext, transport };
  sseSessions.set(sessionId, session);
  console.log(`[MCP SSE] Session initialized: ${sessionId}`);

  transport.onclose = () => {
    cleanupTransport('sse', sessionId);
  };
  transport.onerror = (error) => {
    logTransportError('sse', error, sessionId);
  };

  res.on('close', () => {
    cleanupTransport('sse', sessionId);
  });

  await server.connect(transport);
  return transport;
}

router.all('/mcp', async (req, res) => {
  try {
    const sessionId = getStreamableSessionId(req);

    if (sessionId) {
      if (sseSessions.has(sessionId)) {
        sendJsonRpcError(res, 400, 'Bad Request: Session exists but uses the legacy SSE transport');
        return;
      }

      const existingSession = streamableSessions.get(sessionId);
      if (!existingSession) {
        sendJsonRpcError(res, 404, 'MCP session not found');
        return;
      }

      const authContext = await authenticateSessionRequest(req, res, existingSession.authContext);
      if (!authContext) {
        return;
      }
      existingSession.authContext = authContext;

      await existingSession.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === 'GET') {
      res.setHeader('Allow', 'POST');
      res.status(405).end();
      return;
    }

    if (req.method !== 'POST') {
      sendJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
      return;
    }

    if (!isInitializationPayload(req.body)) {
      sendJsonRpcError(res, 400, 'Bad Request: Streamable HTTP sessions must start with initialize');
      return;
    }

    const authContext = await authenticateRequest(req, res);
    if (!authContext) {
      return;
    }

    const transport = await createStreamableTransport(authContext);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logTransportError('streamable', error, getStreamableSessionId(req));

    if (!res.headersSent) {
      sendJsonRpcError(res, 500, 'Internal server error');
    }
  }
});

router.get('/sse', async (req, res) => {
  const authContext = await authenticateRequest(req, res);
  if (!authContext) {
    return;
  }

  try {
    await createSseTransport(authContext, res);
  } catch (error) {
    logTransportError('sse', error);

    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

router.post('/messages', async (req, res) => {
  const sessionId = getSseSessionId(req);

  if (!sessionId) {
    sendJsonRpcError(res, 400, 'Bad Request: Missing sessionId query parameter');
    return;
  }

  if (streamableSessions.has(sessionId)) {
    sendJsonRpcError(res, 400, 'Bad Request: Session exists but uses the Streamable HTTP transport');
    return;
  }

  const existingSession = sseSessions.get(sessionId);
  if (!existingSession) {
    sendJsonRpcError(res, 404, 'MCP session not found');
    return;
  }

  try {
    const authContext = await authenticateSessionRequest(req, res, existingSession.authContext);
    if (!authContext) {
      return;
    }
    existingSession.authContext = authContext;

    await existingSession.transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    logTransportError('sse', error, sessionId);

    if (!res.headersSent) {
      sendJsonRpcError(res, 500, 'Internal server error');
    }
  }
});

export default router;
