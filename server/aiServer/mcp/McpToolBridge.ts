import { createTool } from '@mastra/core/tools';
import { z } from 'zod/v3';
import { mcpClientManager, type McpTool } from './McpClientManager';

/**
 * Convert a JSON Schema to a Zod schema
 * This is a simplified converter that handles common cases
 */
function jsonSchemaToZod(schema: Record<string, any>): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.any();
  }

  const type = schema.type;

  switch (type) {
    case 'string':
      let stringSchema = z.string();
      if (schema.description) {
        stringSchema = stringSchema.describe(schema.description);
      }
      if (schema.enum) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      return schema.nullable ? stringSchema.nullable() : stringSchema;

    case 'number':
    case 'integer':
      let numberSchema = z.number();
      if (schema.description) {
        numberSchema = numberSchema.describe(schema.description);
      }
      if (schema.minimum !== undefined) {
        numberSchema = numberSchema.min(schema.minimum);
      }
      if (schema.maximum !== undefined) {
        numberSchema = numberSchema.max(schema.maximum);
      }
      return schema.nullable ? numberSchema.nullable() : numberSchema;

    case 'boolean':
      let boolSchema = z.boolean();
      if (schema.description) {
        boolSchema = boolSchema.describe(schema.description);
      }
      return schema.nullable ? boolSchema.nullable() : boolSchema;

    case 'array':
      const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.any();
      let arraySchema = z.array(itemSchema);
      if (schema.description) {
        arraySchema = arraySchema.describe(schema.description);
      }
      return schema.nullable ? arraySchema.nullable() : arraySchema;

    case 'object':
      if (schema.properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        const required = schema.required || [];

        for (const [key, propSchema] of Object.entries(schema.properties)) {
          let propZod = jsonSchemaToZod(propSchema as Record<string, any>);
          if (!required.includes(key)) {
            propZod = propZod.optional();
          }
          shape[key] = propZod;
        }

        let objSchema = z.object(shape);
        if (schema.description) {
          objSchema = objSchema.describe(schema.description);
        }
        return schema.nullable ? objSchema.nullable() : objSchema;
      }
      return z.record(z.any());

    case 'null':
      return z.null();

    default:
      // Handle anyOf, oneOf, allOf
      if (schema.anyOf || schema.oneOf) {
        const schemas = (schema.anyOf || schema.oneOf) as Record<string, any>[];
        if (schemas.length === 2) {
          const nullIndex = schemas.findIndex(s => s.type === 'null');
          if (nullIndex !== -1) {
            const otherSchema = schemas[nullIndex === 0 ? 1 : 0];
            return jsonSchemaToZod(otherSchema).nullable();
          }
        }
        // For complex unions, use z.any()
        return z.any();
      }
      return z.any();
  }
}

/**
 * Convert an MCP tool to a Mastra-compatible tool
 */
function convertMcpToolToMastra(mcpTool: McpTool) {
  // Create input schema from MCP tool's JSON Schema
  const inputSchema = jsonSchemaToZod(mcpTool.inputSchema);

  return createTool({
    id: `mcp-${mcpTool.serverName}-${mcpTool.name}`.replace(/[^a-zA-Z0-9-_]/g, '-'),
    description: mcpTool.description || `MCP tool: ${mcpTool.name} from ${mcpTool.serverName}`,
    inputSchema: inputSchema instanceof z.ZodObject ? inputSchema : z.object({}),
    execute: async ({ context }) => {
      try {
        const result = await mcpClientManager.callTool(
          mcpTool.serverId,
          mcpTool.name,
          context as Record<string, any>
        );

        // MCP tools return content array, extract text content
        if (result && result.content) {
          const textContent = result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');

          return {
            success: true,
            result: textContent || result.content,
            rawResult: result
          };
        }

        return {
          success: true,
          result
        };
      } catch (error: any) {
        console.error(`[MCP Tool Bridge] Error executing ${mcpTool.name}:`, error);
        return {
          success: false,
          error: error?.message || 'Failed to execute MCP tool'
        };
      }
    }
  });
}

/**
 * Get all MCP tools converted to Mastra format
 */
export async function getMcpMastraTools(): Promise<Record<string, ReturnType<typeof createTool>>> {
  try {
    const mcpTools = await mcpClientManager.getAllEnabledTools();
    const tools: Record<string, ReturnType<typeof createTool>> = {};

    for (const mcpTool of mcpTools) {
      try {
        const toolId = `mcp_${mcpTool.serverName}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
        tools[toolId] = convertMcpToolToMastra(mcpTool);
      } catch (error: any) {
        console.error(`[MCP Tool Bridge] Failed to convert tool ${mcpTool.name}:`, error?.message || error);
        // Continue with other tools
      }
    }

    if (Object.keys(tools).length > 0) {
      console.log(`[MCP Tool Bridge] Loaded ${Object.keys(tools).length} MCP tools`);
    }
    return tools;
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    console.error('[MCP Tool Bridge] Failed to get MCP tools:', errorMessage);
    // Return empty tools object instead of throwing - don't break the agent
    return {};
  }
}

/**
 * Get MCP tools from a specific server
 */
export async function getMcpToolsFromServer(serverId: number): Promise<Record<string, ReturnType<typeof createTool>>> {
  try {
    const mcpTools = await mcpClientManager.getTools(serverId);
    const tools: Record<string, ReturnType<typeof createTool>> = {};

    for (const mcpTool of mcpTools) {
      const toolId = `mcp_${mcpTool.serverName}_${mcpTool.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
      tools[toolId] = convertMcpToolToMastra(mcpTool);
    }

    return tools;
  } catch (error) {
    console.error(`[MCP Tool Bridge] Failed to get tools from server ${serverId}:`, error);
    return {};
  }
}

/**
 * Check if MCP tools are available (any enabled servers exist)
 */
export async function hasMcpServers(): Promise<boolean> {
  const { prisma } = await import('@server/prisma');
  const count = await prisma.mcpServers.count({
    where: { isEnabled: true }
  });
  return count > 0;
}

