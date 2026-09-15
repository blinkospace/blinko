import { helper } from '@shared/lib/helper';
import type { ProcessingEffect } from './noteProcessing';

export function generatedTagEffects(output: string, noteContent: string, maximum = 5): ProcessingEffect[] {
  const tags = helper.extractHashtags(output).slice(0, maximum);
  if (!tags.length) throw new Error('NO_USABLE_TAGS');
  const existing = new Set(helper.extractHashtags(noteContent));
  const additions = tags.filter(tag => !existing.has(tag));
  return additions.length ? [{ kind: 'tags', content: additions.join(' ') }] : [];
}
