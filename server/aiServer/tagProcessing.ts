import { helper } from '@shared/lib/helper';
import type { ProcessingEffect } from './noteProcessing';

/** In combined mode, the dedicated tagging phase owns hashtag-only output. */
export function withoutTagOnlyLines(content: string): string {
  return content.split('\n').filter(line => {
    const tags = helper.extractHashtags(line);
    return !tags.length || tags.join(' ') !== line.trim().replace(/[,\s]+/g, ' ');
  }).join('\n').trim();
}

// Only inline tags removed by the editor should lose their relations. Tags
// assigned independently by post-processing are not represented in the body.
export function inlineTagIds(content: string, tags: Array<{ id: number; name: string; parent: number }>): Set<number> {
  const paths = new Set<string>();
  for (const hashtag of helper.extractHashtags(content)) {
    const parts = hashtag.slice(1).split('/');
    parts.forEach((_part, index) => paths.add(parts.slice(0, index + 1).join('/')));
  }
  const byId = new Map(tags.map(tag => [tag.id, tag]));
  return new Set(tags.filter(tag => {
    let path = tag.name;
    let parent = tag.parent;
    const seen = new Set([tag.id]);
    while (parent) {
      const ancestor = byId.get(parent);
      if (!ancestor || seen.has(parent)) return false;
      seen.add(parent);
      path = `${ancestor.name}/${path}`;
      parent = ancestor.parent;
    }
    return paths.has(path);
  }).map(tag => tag.id));
}

export function generatedTagEffects(output: string, noteContent: string, maximum?: number, existingPaths: string[] = []): ProcessingEffect[] {
  const canonical = new Map(existingPaths.map(path => [path.toLocaleLowerCase(), path]));
  const tags = [...new Set(helper.extractHashtags(output).map(tag =>
    `#${canonical.get(tag.slice(1).toLocaleLowerCase()) || tag.slice(1)}`))].slice(0, maximum);
  if (!tags.length) throw new Error('NO_USABLE_TAGS');
  const existing = new Set(helper.extractHashtags(noteContent));
  const additions = tags.filter(tag => !existing.has(tag));
  return additions.length ? [{ kind: 'tags', content: additions.join(' ') }] : [];
}
