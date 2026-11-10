import { expect, test } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { hasUsableBody } from "../../services/pluginServices/VectorSnapshotService";

// Frozen eligibility rule expressed over the authoritative full Markdown AST.
// Shortcut implementations must preserve this policy for ambiguous input too.
function fullAst(content: string): boolean {
  const visit = (node: { type: string; value?: string; children?: unknown[] }): boolean => {
    if (["text", "code", "inlineCode"].includes(node.type) && node.value?.trim()) return true;
    if (["image", "imageReference", "html", "definition"].includes(node.type)) return false;
    return (node.children ?? []).some((child) => visit(child as Parameters<typeof visit>[0]));
  };
  return visit(fromMarkdown(content));
}

test("unambiguous Markdown starts retain full-AST eligibility across following blocks", () => {
  const prefixes = ["", "# ", "###### ", "- ", "* ", "+ ", "> ", "**", "- **", "> **"];
  const texts = ["Alpha 2026", "中文正文", "Grüße", "𠮷野", "A (note): 'yes'"];
  const tails = ["", "\n\n![image](/a)", "\n\n<!-- hidden -->", "\n\n[ref]: /notes", "\n\n```js\nvalue\n```", "\n---\n", "\r\n\r\n<div>HTML only</div>"];
  for (const indent of ["", "   ", "\t"])
    for (const prefix of prefixes)
      for (const text of texts)
        for (const tail of tails) {
          const content = indent + prefix + text + (prefix.includes("**") ? "**" : "") + tail;
          expect(hasUsableBody(content)).toBe(fullAst(content));
        }
});

test("fences, empty lists, references, HTML and image-only input keep the original eligibility", () => {
  const cases = [
    "", " \n ", "1. ", "1) ", "---", "***", "# ", "- ", "> ", "** **",
    "![image](/a)", "![image][ref]\n\n[ref]: /a", "[ref]: /a\n", "[ref]:\n  /a\n  'title'",
    "<div>hidden</div>", "<!--\n# Not visible\n-->", "<script>\nAlpha\n</script>",
    "```\n```", "```js\n\n```", "~~~\n~~~", "```js\nconst n = 1;\n```",
    "~~~~ts\nconst n = 1;\n~~~~", "```\nAlpha", "```a`b\nAlpha\n```", "  ```\nAlpha\n  ```",
    "> **Alpha**\n> <!-- hidden -->", "# ![image](/a)", "- ![image](/a)", "**[ref]: /a**",
    "Alpha\n===", "Alpha\n<div>hidden</div>", "A <span>visible</span>", "```\n\u00a0\n```",
  ];
  for (const content of cases) expect(hasUsableBody(content)).toBe(fullAst(content));
});
