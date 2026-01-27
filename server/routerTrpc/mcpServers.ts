import { router, authProcedure, superAdminAuthMiddleware } from '@server/middleware';
import { z } from 'zod';
import { prisma } from '@server/prisma';
import { mcpClientManager } from '@server/aiServer/mcp';
import { TRPCError } from '@trpc/server';
import path from 'path';

// Schema for MCP server
const mcpServerSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().nullable(),
  args: z.union([z.array(z.string()), z.null(), z.undefined()]),
  url: z.string().nullable(),
  env: z.union([z.record(z.string(), z.unknown()), z.null(), z.undefined()]),
  headers: z.union([z.record(z.string(), z.unknown()), z.null(), z.undefined()]),
  isEnabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Schema for connection status
const connectionStatusSchema = z.object({
  serverId: z.number(),
  serverName: z.string(),
  isConnected: z.boolean(),
  toolCount: z.number(),
  lastUsed: z.date().optional(),
});

// Allowed commands for MCP stdio servers (whitelist approach)
const ALLOWED_MCP_COMMANDS = [
  'npx',
  'node',
  'python',
  'python3',
  'bun',
  'deno',
  // Add other trusted MCP server commands as needed
];

/**
 * Validates if a command is allowed for MCP stdio servers
 * @param command - The command to validate
 * @returns true if the command is allowed, false otherwise
 */
function isCommandAllowed(command: string): boolean {
  if (!command || typeof command !== 'string') {
    return false;
  }

  // Get the base command name (without path)
  const baseName = path.basename(command).toLowerCase();
  
  // Check if it's in the whitelist
  return ALLOWED_MCP_COMMANDS.includes(baseName);
}

/**
 * Validates if command arguments are safe (no shell injection)
 * @param args - Array of command arguments
 * @returns true if all arguments are safe, false otherwise
 */
function areArgsSafe(args: string[]): boolean {
  if (!Array.isArray(args)) {
    return false;
  }

  // Dangerous patterns that could lead to command injection
  const dangerousPatterns = [
    /[;&|`$]/g,           // Shell metacharacters: ; & | ` $
    /\$\(/g,               // Command substitution: $(...)
    /`/g,                  // Backtick command substitution
    />\s*\//g,             // Redirect to absolute path: > /path
    /\/etc\//g,            // Access to /etc directory
    /\/proc\//g,           // Access to /proc filesystem
    /\/sys\//g,            // Access to /sys filesystem
    /\.\./g,               // Path traversal
    /&&/g,                 // Command chaining
    /\|\|/g,               // Command chaining
    /<|>/g,                // Input/output redirection
  ];

  // Check each argument for dangerous patterns
  for (const arg of args) {
    if (typeof arg !== 'string') {
      return false;
    }
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(arg)) {
        return false;
      }
    }
  }

  return true;
}

export const mcpServersRouter = router({
  // List all MCP servers (admin only)
  list: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'GET', path: '/v1/mcp-servers/list', summary: 'List MCP servers', protect: true, tags: ['MCP Server'] } })
    .input(z.void())
    .output(z.array(mcpServerSchema))
    .query(async () => {
      const servers = await prisma.mcpServers.findMany({
        orderBy: { createdAt: 'desc' }
      });
      return servers as z.infer<typeof mcpServerSchema>[];
    }),

  // Get a single MCP server by ID (admin only)
  get: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'GET', path: '/v1/mcp-servers/get', summary: 'Get MCP server by ID', protect: true, tags: ['MCP Server'] } })
    .input(z.object({ id: z.number() }))
    .output(z.union([mcpServerSchema, z.null()]))
    .query(async ({ input }) => {
      const server = await prisma.mcpServers.findUnique({
        where: { id: input.id }
      });
      return server as z.infer<typeof mcpServerSchema> | null;
    }),

  // Create a new MCP server (admin only)
  create: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/mcp-servers/create', summary: 'Create MCP server', protect: true, tags: ['MCP Server'] } })
    .input(z.object({
      name: z.string().min(1).max(255),
      description: z.string().optional(),
      type: z.enum(['stdio', 'sse', 'streamable-http']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.any().optional(),
      headers: z.any().optional(),
      isEnabled: z.boolean().default(true),
    }))
    .output(mcpServerSchema)
    .mutation(async ({ input }) => {
      // Validate based on type
      if (input.type === 'stdio' && !input.command) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'stdio transport requires a command'
        });
      }
      if ((input.type === 'sse' || input.type === 'streamable-http') && !input.url) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${input.type} transport requires a URL`
        });
      }

      // Security validation for stdio type: validate command and args
      if (input.type === 'stdio') {
        if (!input.command || !isCommandAllowed(input.command)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Command not allowed. Allowed commands: ${ALLOWED_MCP_COMMANDS.join(', ')}`
          });
        }

        if (input.args && !areArgsSafe(input.args)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Arguments contain disallowed characters or patterns that could lead to command injection'
          });
        }
      }

      const server = await prisma.mcpServers.create({
        data: {
          name: input.name,
          description: input.description || null,
          type: input.type,
          command: input.command || null,
          args: (input.args || null) as any,
          url: input.url || null,
          env: (input.env || null) as any,
          headers: (input.headers || null) as any,
          isEnabled: input.isEnabled,
        }
      });
      return server as z.infer<typeof mcpServerSchema>;
    }),

  // Update an MCP server (admin only)
  update: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/mcp-servers/update', summary: 'Update MCP server', protect: true, tags: ['MCP Server'] } })
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      type: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.any().optional(),
      headers: z.any().optional(),
      isEnabled: z.boolean().optional(),
    }))
    .output(mcpServerSchema)
    .mutation(async ({ input }) => {
      const { id, ...data } = input;

      // Get existing server to check current type if type is being changed
      const existingServer = await prisma.mcpServers.findUnique({
        where: { id }
      });

      if (!existingServer) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'MCP server not found'
        });
      }

      // Determine the type we're validating (use new type if provided, otherwise existing)
      const serverType = data.type || existingServer.type;

      // Security validation for stdio type: validate command and args
      if (serverType === 'stdio') {
        const commandToValidate = data.command !== undefined ? data.command : existingServer.command;
        
        if (!commandToValidate || !isCommandAllowed(commandToValidate)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Command not allowed. Allowed commands: ${ALLOWED_MCP_COMMANDS.join(', ')}`
          });
        }

        const argsToValidate = data.args !== undefined ? data.args : (existingServer.args as string[] | null);
        if (argsToValidate && !areArgsSafe(argsToValidate)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Arguments contain disallowed characters or patterns that could lead to command injection'
          });
        }
      }

      // Disconnect if connected before updating
      if (mcpClientManager.isConnected(id)) {
        await mcpClientManager.disconnect(id);
      }

      const server = await prisma.mcpServers.update({
        where: { id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.type && { type: data.type }),
          ...(data.command !== undefined && { command: data.command }),
          ...(data.args !== undefined && { args: data.args as any }),
          ...(data.url !== undefined && { url: data.url }),
          ...(data.env !== undefined && { env: data.env as any }),
          ...(data.headers !== undefined && { headers: data.headers as any }),
          ...(data.isEnabled !== undefined && { isEnabled: data.isEnabled }),
        }
      });
      return server as z.infer<typeof mcpServerSchema>;
    }),

  // Delete an MCP server (admin only)
  delete: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/mcp-servers/delete', summary: 'Delete MCP server', protect: true, tags: ['MCP Server'] } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      // Disconnect if connected
      if (mcpClientManager.isConnected(input.id)) {
        await mcpClientManager.disconnect(input.id);
      }

      await prisma.mcpServers.delete({
        where: { id: input.id }
      });
      return { success: true };
    }),

  // Toggle server enabled/disabled (admin only)
  toggle: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/mcp-servers/toggle', summary: 'Toggle MCP server enabled', protect: true, tags: ['MCP Server'] } })
    .input(z.object({
      id: z.number(),
      enabled: z.boolean(),
    }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      // Disconnect if disabling
      if (!input.enabled && mcpClientManager.isConnected(input.id)) {
        await mcpClientManager.disconnect(input.id);
      }

      await prisma.mcpServers.update({
        where: { id: input.id },
        data: { isEnabled: input.enabled }
      });
      return { success: true };
    }),

  // Test connection to an MCP server (admin only)
  testConnection: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/mcp-servers/test-connection', summary: 'Test MCP server connection', protect: true, tags: ['MCP Server'] } })
    .input(z.object({ id: z.number() }))
    .output(z.object({
      success: z.boolean(),
      toolCount: z.number().optional(),
      tools: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
      })).optional(),
      error: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        const tools = await mcpClientManager.getTools(input.id);
        return {
          success: true,
          toolCount: tools.length,
          tools: tools.map(t => ({
            name: t.name,
            description: t.description
          }))
        };
      } catch (error: any) {
        return {
          success: false,
          error: error?.message || 'Connection failed'
        };
      }
    }),

  // Get connection status for all servers (admin only)
  connectionStatus: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'GET', path: '/v1/mcp-servers/connection-status', summary: 'Get MCP servers connection status', protect: true, tags: ['MCP Server'] } })
    .input(z.void())
    .output(z.array(connectionStatusSchema))
    .query(async () => {
      const status = await mcpClientManager.getConnectionStatus();
      return status;
    }),

  // Disconnect a server (admin only)
  disconnect: authProcedure
    .use(superAdminAuthMiddleware)
    .meta({ openapi: { method: 'POST', path: '/v1/mcp-servers/disconnect', summary: 'Disconnect MCP server', protect: true, tags: ['MCP Server'] } })
    .input(z.object({ id: z.number() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ input }) => {
      await mcpClientManager.disconnect(input.id);
      return { success: true };
    }),

  // Get available tools from all connected servers
  getTools: authProcedure
    .meta({ openapi: { method: 'GET', path: '/v1/mcp-servers/tools', summary: 'Get all MCP tools', protect: true, tags: ['MCP Server'] } })
    .input(z.void())
    .output(z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      serverId: z.number(),
      serverName: z.string(),
    })))
    .query(async () => {
      const tools = await mcpClientManager.getAllEnabledTools();
      return tools.map(t => ({
        name: t.name,
        description: t.description,
        serverId: t.serverId,
        serverName: t.serverName
      }));
    }),
});

