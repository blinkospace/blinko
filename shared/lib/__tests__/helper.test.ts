import { describe, it, expect } from 'bun:test';
import { helper } from '../helper';

describe('Shared Helper', () => {
  describe('isJsonString', () => {
    it('should correctly identify valid JSON objects', () => {
      expect(helper.json.isJsonString('{\"name\": \"blinko\"}')).toBe(true);
    });

    it('should correctly identify valid JSON arrays', () => {
      expect(helper.json.isJsonString('[1, 2, 3]')).toBe(true);
      expect(helper.json.isJsonString('[\"a\", \"b\"]')).toBe(true);
      expect(helper.json.isJsonString('[{\"id\": 1}]')).toBe(true);
    });

    it('should return false for invalid strings', () => {
      expect(helper.json.isJsonString('not json')).toBe(false);
      expect(helper.json.isJsonString('')).toBe(false);
      expect(helper.json.isJsonString(null as any)).toBe(false);
    });
  });

  describe('buildHashTagTreeFromHashString', () => {
    it('should build tree correctly without empty nodes', () => {
      const tree = helper.buildHashTagTreeFromHashString(['#work/project', '#personal']);
      expect(tree.length).toBe(2);
      expect(tree[0].name).toBe('work');
      expect(tree[0].children?.[0].name).toBe('project');
      expect(tree[1].name).toBe('personal');
    });

    it('should handle empty or bare hashtag gracefully', () => {
      const tree = helper.buildHashTagTreeFromHashString(['#', '']);
      expect(tree.length).toBe(0);
    });
  });
});
