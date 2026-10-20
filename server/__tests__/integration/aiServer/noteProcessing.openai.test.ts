import { describe, expect, it, mock } from 'bun:test';
import { Agent } from '@mastra/core/agent';
import { createOpenAI } from '@ai-sdk/openai';
import type { ProcessingState } from '../../../aiServer/noteProcessing';

// Real Mastra + OpenAI SDK, with deterministic wire responses instead of a live
// model. Run separately from suites that mock the OpenAI SDK/agent factory.
let toolResponse = false;
let requests: any[] = [];
const body = '### Hasen und Farben\n\nZuerst verfolgten mich Hasen. Dann war ich blau.';
const provider = createOpenAI({
  apiKey: 'test-only', baseURL: 'http://local-model.test/v1',
  fetch: async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    requests.push(request);
    const call = toolResponse && requests.length === 1;
    return new Response(JSON.stringify({
      id: 'completion-test', object: 'chat.completion', created: 1, model: 'local-model',
      choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: {
        role: 'assistant', content: call ? null : body,
        ...(call ? { tool_calls: [{ id: 'call-1', type: 'function', function: {
          name: 'updateBlinkoTool', arguments: JSON.stringify({ id: 7, content: body }),
        } }] } : {}),
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
mock.module('../../../aiServer/aiModelFactory', () => ({ AiModelFactory: {
  BaseChatAgent: async (options: any) => new Agent({
    name: 'Processing integration test', instructions: options.extraInstructions,
    model: provider.chat('local-model'), tools: options.localTools,
  }),
} }));
mock.module('../../../prisma', () => ({ prisma: { tag: { findMany: async () => [] } } }));
mock.module('../../../aiServer/index', () => ({ AiService: {} }));
mock.module('../../../lib/files', () => ({ FileService: {} }));
const { processingModels } = await import('../../../aiServer/processingModels');

describe('OpenAI-compatible note processing responses', () => {
  for (const calls of [false, true]) {
    it(`saves replacement effects for ${calls ? 'tool_calls' : 'content without tool_calls'}`, async () => {
      toolResponse = calls; requests = [];
      const state: ProcessingState = {
        version: 1, requestedBy: 1, audio: [], mode: 'smartEdit', post: true,
        prompts: { smartEdit: 'Bereinige die Notiz.' }, done: [],
      };
      const effects = await processingModels.post('smartEdit', { id: 7, accountId: 1, content: 'Hasen, äh blau' }, state);
      expect(effects).toEqual([{ kind: 'replace', content: body }]);
      expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['updateBlinkoTool']);
      expect(requests[0].messages[0].content).toContain('Blinko Note Editor');
      expect(requests[0].messages[0].content).not.toContain('Comment Assistant');
    });
  }
});
