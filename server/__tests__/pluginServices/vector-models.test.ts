import { test, expect } from "bun:test";
import type { LanguageModelV1 } from "@ai-sdk/provider";
import {
  createTextGeneratorFactory,
  createTextModelCatalog,
} from "../../services/pluginServices/ModelResolver";

test("text catalog whitelists metadata and uses the actual configured default", async () => {
  const catalog = createTextModelCatalog({
    listMetadata: async () => [
      {
        id: 1,
        title: "Synthetic chat",
        providerLabel: "Synthetic",
        capabilities: { inference: true },
      },
      {
        id: 2,
        title: "Synthetic embed",
        providerLabel: "Synthetic",
        capabilities: { inference: false },
      },
    ],
    readDefaultModelId: async () => 1,
  });
  expect(await catalog.findTextModel(7, "default")).toEqual({
    id: 1,
    name: "Synthetic chat",
  });
  expect(await catalog.findTextModel(7, 2)).toBeNull();
});
test("text factory calls AI SDK 4 directly with no tools, zero retries and output cap", async () => {
  let options: any;
  let constructions = 0;
  const model: LanguageModelV1 = {
    specificationVersion: "v1",
    provider: "synthetic",
    modelId: "no-network",
    defaultObjectGenerationMode: "json",
    async doGenerate(input) {
      options = input;
      return {
        text: "Synthetic answer",
        finishReason: "stop",
        usage: { promptTokens: 6, completionTokens: 2 },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
    async doStream() {
      throw new Error("streaming is not supported");
    },
  };
  const factory = createTextGeneratorFactory({
    createLanguageModel: async () => {
      constructions++;
      return model;
    },
  });
  expect(constructions).toBe(0);
  const generator = await factory.create(1, 1);
  const result = await generator.generate({
    modelId: 1,
    messages: [{ role: "user", content: "Synthetic prompt" }],
    maxOutputTokens: 128,
    signal: new AbortController().signal,
  });
  expect(constructions).toBe(1);
  expect(options.maxTokens).toBe(128);
  expect(options.mode.type).toBe("regular");
  expect(options.mode.tools ?? []).toHaveLength(0);
  expect(result).toMatchObject({
    text: "Synthetic answer",
    finishReason: "stop",
    usage: { inputTokens: 6, outputTokens: 2, status: "reported" },
  });
});
test("unreported usage remains null and unknown", async () => {
  const model = {
    specificationVersion: "v1",
    provider: "synthetic",
    modelId: "no-usage",
    defaultObjectGenerationMode: "json",
    async doGenerate() {
      return {
        text: "Synthetic",
        finishReason: "stop",
        usage: { promptTokens: NaN, completionTokens: NaN },
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
    async doStream() {
      throw new Error("no streaming");
    },
  } as LanguageModelV1;
  const generator = await createTextGeneratorFactory({
    createLanguageModel: async () => model,
  }).create(1, 1);
  const result = await generator.generate({
    modelId: 1,
    messages: [{ role: "user", content: "Prompt" }],
    maxOutputTokens: 1,
    signal: new AbortController().signal,
  });
  expect(result.usage).toEqual({
    inputTokens: null,
    outputTokens: null,
    status: "unknown",
  });
});
