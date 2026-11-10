import { fromMarkdown } from 'mdast-util-from-markdown';
/** Change when visible-body classification changes; stored certificates bind this rule. */
export const BODY_ELIGIBILITY_VERSION = 'markdown-visible-v1';
interface AstNode { type: string; value?: string; children?: AstNode[] }
export function hasUsableBody(content: string): boolean {
  if (/^[ \t]{0,3}(?:(?:#{1,6}|[-+*]|>)[ \t]+)?(?:\*\*\p{L}[\p{L}\p{N} \t.,!?;:'"()-]*\*\*|\p{L}[\p{L}\p{N} \t.,!?;:'"()-]*)(?:\r?\n|$)/u.test(content)) return true;
  if (/^(?:`{3,}[^`\r\n]*|~{3,}[^\r\n]*)\r?\n[ \t]*\p{L}/u.test(content)) return true;
  const stack: AstNode[] = [fromMarkdown(content)];
  while (stack.length) {
    const node = stack.pop()!;
    if (['text', 'code', 'inlineCode'].includes(node.type) && node.value?.trim()) return true;
    if (!['image', 'imageReference', 'html', 'definition'].includes(node.type) && node.children) stack.push(...node.children);
  }
  return false;
}
