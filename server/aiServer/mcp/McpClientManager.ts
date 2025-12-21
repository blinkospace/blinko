import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { prisma } from '@server/prisma';
import type { mcpServers } from '@prisma/client';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, any>;
  serverId: number;
  serverName: string;
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  tools: McpTool[];
  lastUsed: number;
  serverId: number;
  serverName: string;
}

// Connection idle timeout in milliseconds (5 minutes)
const IDLE_TIMEOUT = 5 * 60 * 1000;
// Cleanup interval (1 minute)
const CLEANUP_INTERVAL = 60 * 1000;

/**
 * MCP Client Manager - manages connections to external MCP servers
 * Implements on-demand connection with automatic idle disconnection
 */
export class McpClientManager {
  private static instance: McpClientManager;
  private connections: Map<number, McpConnection> = new Map();
  private connecting: Map<number, Promise<McpConnection>> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private constructor() {
    this.startCleanupTimer();
  }

  static getInstance(): McpClientManager {
    if (!McpClientManager.instance) {
      McpClientManager.instance = new McpClientManager();
    }
    return McpClientManager.instance;
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleConnections();
    }, CLEANUP_INTERVAL);
  }

  private async cleanupIdleConnections(): Promise<void> {
    const now = Date.now();
    const toDisconnect: number[] = [];

    for (const [serverId, connection] of this.connections) {
      if (now - connection.lastUsed > IDLE_TIMEOUT) {
        toDisconnect.push(serverId);
      }
    }

    for (const serverId of toDisconnect) {
      console.log(`[MCP] Disconnecting idle server: ${serverId}`);
      await this.disconnect(serverId);
    }
  }

  /**
   * Get or create a connection to an MCP server
   */
  async connect(serverId: number): Promise<McpConnection> {
    // Return existing connection if available
    const existing = this.connections.get(serverId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }

    // If already connecting, wait for that promise
    const connecting = this.connecting.get(serverId);
    if (connecting) {
      return connecting;
    }

    // Create new connection
    const connectPromise = this.createConnection(serverId);
    this.connecting.set(serverId, connectPromise);

    try {
      const connection = await connectPromise;
      this.connections.set(serverId, connection);
      return connection;
    } finally {
      this.connecting.delete(serverId);
    }
  }

  private async createConnection(serverId: number): Promise<McpConnection> {
    const serverConfig = await prisma.mcpServers.findUnique({
      where: { id: serverId }
    });

    if (!serverConfig) {
      throw new Error(`MCP server with id ${serverId} not found`);
    }

    if (!serverConfig.isEnabled) {
      throw new Error(`MCP server ${serverConfig.name} is disabled`);
    }

    console.log(`[MCP] Connecting to server: ${serverConfig.name} (${serverConfig.type})`);

    let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport | undefined;
    let client: Client | undefined;

    try {
      transport = await this.createTransport(serverConfig);
      client = new Client({
        name: 'blinko-mcp-client',
        version: '1.0.0'
      });

      // Set a timeout for connection
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout')), 30000); // 30 second timeout
      });

      await Promise.race([connectPromise, timeoutPromise]);

      // Discover tools
      const toolsResponse = await client.listTools();
      const tools: McpTool[] = (toolsResponse.tools || []).map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, any>,
        serverId,
        serverName: serverConfig.name
      }));

      console.log(`[MCP] Connected to ${serverConfig.name}, discovered ${tools.length} tools`);

      return {
        client: client!,
        transport: transport!,
        tools,
        lastUsed: Date.now(),
        serverId,
        serverName: serverConfig.name
      };
    } catch (error: any) {
      // Clean up on error
      if (client) {
        try {
          await client.close();
        } catch (closeError) {
          // Ignore close errors
        }
      }
      const errorMessage = error?.message || String(error);
      throw new Error(`Failed to connect to MCP server ${serverConfig.name}: ${errorMessage}`);
    }
  }

  private async createTransport(config: mcpServers): Promise<StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport> {
    switch (config.type) {
      case 'stdio':
        return this.createStdioTransport(config);
      case 'sse':
        return this.createSseTransport(config);
      case 'streamable-http':
        return this.createStreamableHttpTransport(config);
      default:
        throw new Error(`Unsupported transport type: ${config.type}`);
    }
  }

  private createStdioTransport(config: mcpServers): StdioClientTransport {
    if (!config.command) {
      throw new Error('stdio transport requires a command');
    }

    const args = (config.args as string[]) || [];
    const env = (config.env as Record<string, string>) || {};

    return new StdioClientTransport({
      command: config.command,
      args,
      env: { ...process.env, ...env } as Record<string, string>
    });
  }

  private createSseTransport(config: mcpServers): SSEClientTransport {
    if (!config.url) {
      throw new Error('SSE transport requires a URL');
    }

    const headers = (config.headers as Record<string, string>) || {};

    return new SSEClientTransport(new URL(config.url), {
      requestInit: {
        headers
      }
    });
  }

  private createStreamableHttpTransport(config: mcpServers): StreamableHTTPClientTransport {
    if (!config.url) {
      throw new Error('Streamable HTTP transport requires a URL');
    }

    const headers = (config.headers as Record<string, string>) || {};

    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: {
        headers
      }
    });
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverId: number): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) return;

    try {
      await connection.client.close();
      console.log(`[MCP] Disconnected from server: ${connection.serverName}`);
    } catch (error) {
      console.error(`[MCP] Error disconnecting from server ${serverId}:`, error);
    } finally {
      this.connections.delete(serverId);
    }
  }

  /**
   * Disconnect all connections
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.connections.keys()).map(id => 
      this.disconnect(id)
    );
    await Promise.all(disconnectPromises);
  }

  /**
   * Get tools from a specific MCP server
   */
  async getTools(serverId: number): Promise<McpTool[]> {
    const connection = await this.connect(serverId);
    return connection.tools;
  }

  /**
   * Get all tools from all enabled MCP servers
   */
  async getAllEnabledTools(): Promise<McpTool[]> {
    const enabledServers = await prisma.mcpServers.findMany({
      where: { isEnabled: true }
    });

    const allTools: McpTool[] = [];
    
    for (const server of enabledServers) {
      try {
        const tools = await this.getTools(server.id);
        allTools.push(...tools);
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        console.error(`[MCP] Failed to get tools from server ${server.name}:`, errorMessage);
        // Disconnect if connection was attempted but failed
        if (this.isConnected(server.id)) {
          try {
            await this.disconnect(server.id);
          } catch (disconnectError) {
            // Ignore disconnect errors
          }
        }
        // Continue with other servers even if one fails
      }
    }

    return allTools;
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverId: number, toolName: string, args: Record<string, any>): Promise<any> {
    const connection = await this.connect(serverId);
    connection.lastUsed = Date.now();

    try {
      console.log(`[MCP] Calling tool ${toolName} on server ${connection.serverName}`);
      const result = await connection.client.callTool({
        name: toolName,
        arguments: args
      });
      return result;
    } catch (error) {
      console.error(`[MCP] Error calling tool ${toolName} on server ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Check if a server is connected
   */
  isConnected(serverId: number): boolean {
    return this.connections.has(serverId);
  }

  /**
   * Get connection status for all servers
   */
  async getConnectionStatus(): Promise<Array<{
    serverId: number;
    serverName: string;
    isConnected: boolean;
    toolCount: number;
    lastUsed?: Date;
  }>> {
    const servers = await prisma.mcpServers.findMany({
      where: { isEnabled: true }
    });

    return servers.map(server => {
      const connection = this.connections.get(server.id);
      return {
        serverId: server.id,
        serverName: server.name,
        isConnected: !!connection,
        toolCount: connection?.tools.length || 0,
        lastUsed: connection ? new Date(connection.lastUsed) : undefined
      };
    });
  }

  /**
   * Refresh tools for a connected server
   */
  async refreshTools(serverId: number): Promise<McpTool[]> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Server ${serverId} is not connected`);
    }

    const toolsResponse = await connection.client.listTools();
    connection.tools = (toolsResponse.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, any>,
      serverId,
      serverName: connection.serverName
    }));

    return connection.tools;
  }

  /**
   * Stop the cleanup timer (for graceful shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Export singleton instance
export const mcpClientManager = McpClientManager.getInstance();

