import { describe, it, expect } from 'bun:test';
import { DEFAULT_MODEL_TEMPLATES, inferModelCapabilities } from '../modelTemplates';

describe('MiniMax Model Templates', () => {
  const minimaxModels = DEFAULT_MODEL_TEMPLATES.filter(t =>
    t.modelKey.toLowerCase().startsWith('minimax')
  );

  it('should include MiniMax models in DEFAULT_MODEL_TEMPLATES', () => {
    expect(minimaxModels.length).toBeGreaterThanOrEqual(2);
  });

  it('should have MiniMax-M3 model', () => {
    const model = DEFAULT_MODEL_TEMPLATES.find(t => t.modelKey === 'MiniMax-M3');
    expect(model).toBeDefined();
    expect(model!.title).toBe('MiniMax M3');
    expect(model!.capabilities.inference).toBe(true);
    expect(model!.capabilities.tools).toBe(true);
  });

  it('should have MiniMax-M2.7 model', () => {
    const model = DEFAULT_MODEL_TEMPLATES.find(t => t.modelKey === 'MiniMax-M2.7');
    expect(model).toBeDefined();
    expect(model!.title).toBe('MiniMax M2.7');
    expect(model!.capabilities.inference).toBe(true);
    expect(model!.capabilities.tools).toBe(true);
  });

  it('should list MiniMax-M3 before MiniMax-M2.7', () => {
    const keys = minimaxModels.map(m => m.modelKey);
    const indexM3 = keys.indexOf('MiniMax-M3');
    const indexM27 = keys.indexOf('MiniMax-M2.7');
    expect(indexM3).toBeGreaterThanOrEqual(0);
    expect(indexM27).toBeGreaterThanOrEqual(0);
    expect(indexM3).toBeLessThan(indexM27);
  });

  it('should not include deprecated MiniMax-M2.5 models', () => {
    const m25 = DEFAULT_MODEL_TEMPLATES.find(t => t.modelKey === 'MiniMax-M2.5');
    const m25hs = DEFAULT_MODEL_TEMPLATES.find(t => t.modelKey === 'MiniMax-M2.5-highspeed');
    expect(m25).toBeUndefined();
    expect(m25hs).toBeUndefined();
  });

  it('should infer MiniMax model capabilities correctly', () => {
    const caps = inferModelCapabilities('MiniMax-M3');
    expect(caps.inference).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.embedding).toBe(false);
    expect(caps.imageGeneration).toBe(false);
  });

  it('should infer capabilities for MiniMax-M2.7', () => {
    const caps = inferModelCapabilities('MiniMax-M2.7');
    expect(caps.inference).toBe(true);
    expect(caps.tools).toBe(true);
  });

  it('should infer capabilities for MiniMax-M3', () => {
    const caps = inferModelCapabilities('MiniMax-M3');
    expect(caps.inference).toBe(true);
    expect(caps.tools).toBe(true);
  });

  it('should have all MiniMax models with valid structure', () => {
    for (const model of minimaxModels) {
      expect(model.modelKey).toBeTruthy();
      expect(model.title).toBeTruthy();
      expect(model.capabilities).toBeDefined();
      expect(typeof model.capabilities.inference).toBe('boolean');
    }
  });

  it('should not have duplicate model keys among MiniMax models', () => {
    const keys = minimaxModels.map(m => m.modelKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});
