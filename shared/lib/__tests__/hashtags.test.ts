import { describe, expect, it } from 'bun:test';
import { helper } from '../helper';

describe('extractHashtags', () => {
  it.each([
    ['comma-separated', '#Traum, #Auto, #Identität'],
    ['space-separated', '#Traum #Auto #Identität'],
    ['newline-separated', '#Traum\n#Auto\n#Identität'],
  ])('extracts %s model output', (_name, output) => {
    expect(helper.extractHashtags(output)).toEqual(['#Traum', '#Auto', '#Identität']);
  });

  it('supports Unicode and hierarchical tags', () => {
    expect(helper.extractHashtags('#Träume/Identität #開発/設計 #front-end/testing')).toEqual([
      '#Träume/Identität', '#開発/設計', '#front-end/testing',
    ]);
  });

  it('extracts tags from explanatory text without retaining the prose', () => {
    expect(helper.extractHashtags('Suggested tags: #Traum, #Auto, #Identität.')).toEqual([
      '#Traum', '#Auto', '#Identität',
    ]);
  });

  it('deduplicates tags while retaining first-seen order', () => {
    expect(helper.extractHashtags('#Traum, #Auto #Traum\n#Auto')).toEqual(['#Traum', '#Auto']);
  });

  it.each(['', 'No suitable tags.', '# ##Tag #/Child #Parent/ https://example.test/#fragment'])
    ('rejects empty or malformed output: %s', output => {
      expect(helper.extractHashtags(output)).toEqual([]);
    });

  it('ignores tags inside fenced code blocks', () => {
    expect(helper.extractHashtags('```md\n#NotATag\n```\n#RealTag')).toEqual(['#RealTag']);
  });
});
