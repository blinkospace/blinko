import { helper } from '@/lib/helper';
import { useTheme } from 'next-themes';
import React, { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { observer } from 'mobx-react-lite';
import { BlinkoStore } from '@/store/blinkoStore';
import { RootStore } from '@/store';
import rehypeRaw from 'rehype-raw';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Code } from './Code';
import { LinkPreview } from './LinkPreview';
import { ImageWrapper } from './ImageWrapper';
import { ListItem } from './ListItem';
import { TableWrapper } from './TableWrapper';
import { useNavigate, useLocation } from 'react-router-dom';
import remarkTaskList from 'remark-task-list';
import { Skeleton } from '@heroui/react';
import { MermaidWrapper } from './MermaidWrapper';
import { MarkmapWrapper } from './MarkmapWrapper';
import { EchartsWrapper } from './EchartsWrapper';

const HighlightTags = observer(({ text, }: { text: any }) => {
  const location = useLocation();
  const navigate = useNavigate();
  if (!text) return text
  try {
    const decodedText = text.replace(/&nbsp;/g, ' ');
    const lines = decodedText?.split("\n");
    return lines.map((line, lineIndex) => {
      const parts = line.split(/\s+/);
      const processedParts = parts.map((part, index) => {
        if (part.startsWith('#') && part.length > 1 && part.match(helper.regex.isContainHashTag)) {
          const isShareMode = location.pathname.includes('share')
          if (isShareMode) return <span key={`${lineIndex}-${index}`} className={`w-fit select-none blinko-tag px-1 font-bold cursor-pointer hover:opacity-80 !transition-all`}>{part + " "}</span>
          return (
            <span key={`${lineIndex}-${index}`}
              className={`select-none blinko-tag px-1 font-bold cursor-pointer hover:opacity-80 !transition-all ${isShareMode ? 'pointer-events-none' : ''}`}
              onClick={async () => {
                if (isShareMode) return;
                navigate(`/?path=all&searchText=${encodeURIComponent(part)}`);
                RootStore.Get(BlinkoStore).forceQuery++
              }}>
              {part + " "}
            </span>
          );
        } else {
          return part + " ";
        }
      });
      return [...processedParts, <br key={`br-${lineIndex}`} />];
    });
  } catch (e) {
    return text
  }
});

const Table = ({ children }: { children: React.ReactNode }) => {
  return <div className="table-container">{children}</div>;
};

export const MarkdownRender = observer(({ content = '', onChange, isShareMode, largeSpacing = false }: { content?: string, onChange?: (newContent: string) => void, isShareMode?: boolean, largeSpacing?: boolean }) => {
  const { theme } = useTheme()
  const contentRef = useRef(null);

  return (
    <div className={`markdown-body ${largeSpacing ? 'markdown-large-spacing' : ''}`}>
      <div ref={contentRef} data-markdown-theme={theme} className={`markdown-body content ${largeSpacing ? 'markdown-large-spacing' : ''}`}>
        <ReactMarkdown
          remarkPlugins={[
            [remarkGfm, { table: false }],
            remarkTaskList,
            [remarkMath, {
              singleDollarTextMath: true,
              inlineMath: [['$', '$']],
              blockMath: [['$$', '$$']]
            }]
          ]}
          rehypePlugins={[
            rehypeRaw,
            [rehypeKatex, {
              throwOnError: false,
              output: 'html',
              trust: true,
              strict: false
            }]
          ]}
          components={{
            p: ({ node, children }) => {
              // Check if paragraph contains only a single link
              if (
                node &&
                node.children &&
                node.children.length === 1 && 
                node.children[0].type === 'element' && 
                node.children[0].tagName === 'a'
              ) {
                // This is a standalone link block
                const linkNode = node.children[0] as any;
                const href = linkNode.properties?.href;
                
                // Extract text content from link children
                // children passed to p is already React elements, so we can't easily reuse it for LinkPreview text prop
                // But LinkPreview expects ReactNode as text, so we can pass the children of the link
                // However, since we are replacing the p, we need to get the children of the a tag.
                // In ReactMarkdown, the children prop of p will contain the rendered a tag.
                
                // Let's verify if we can access the link properties directly
                if (typeof href === 'string') {
                  // We need to reconstruct the link content. 
                  // Since we are in the 'p' renderer, 'children' is the rendered 'a' element.
                  // We can't easily pass 'children' (which is <a>...</a>) as 'text' to LinkPreview.
                  // Instead, we'll let the 'a' renderer handle it, but we need a way to tell the 'a' renderer it's a block.
                  
                  // Actually, simpler approach:
                  // If we detect this pattern, we render a div instead of p, but we can't easily pass "isBlock" down 
                  // unless we render LinkPreview directly here.
                  
                  // To render LinkPreview here, we need the text content.
                  // linkNode.children contains the AST nodes for the link text.
                  
                  // Let's try to extract text from AST for simple cases
                  // This might lose formatting inside the link (e.g. bold), but that's rare for standalone links.
                  let linkText = href; // Default fallback
                  if (linkNode.children && linkNode.children.length > 0) {
                    // If it's just text
                    if (linkNode.children[0].type === 'text') {
                      linkText = linkNode.children[0].value;
                    } 
                    // If it's complex, we might just render the children variable which is the <a> tag
                    // But we want to replace the <a> tag with LinkPreview(isBlock=true)
                  }
                  
                  // Since we can't easily reconstruct the exact React children structure of the link here without recursion,
                  // and we want to use LinkPreview which accepts 'text' as ReactNode.
                  
                  // Better strategy: The 'a' component logic below handles inline vs block? 
                  // No, 'a' component doesn't know parent.
                  
                  // Strategy: Render the children (which is the <a> tag), but we can't modify props of already rendered children easily.
                  // Actually 'children' in p renderer IS the result of 'a' renderer if we don't override it?
                  // No, components are called during rendering.
                  
                  // Let's use the fact that we identified it's a block link.
                  // We can render LinkPreview directly.
                  
                  // To get the content of the link (the text):
                  // We can use a utility or just simplistic text extraction since standalone links usually just text.
                  
                  return (
                    <div className="my-2">
                      <LinkPreview href={href} text={linkText} isBlock={true} />
                    </div>
                  );
                }
              }
              return <p><HighlightTags text={children} /></p>;
            },
            code: ({ node, className, children, ...props }) => {
              const match = /language-(\w+)/.exec(className || '');
              const language = match ? match[1] : '';

              if (language === 'mermaid') {
                return <MermaidWrapper content={String(children || '')} />;
              }

              if (language === 'mindmap') {
                return <MarkmapWrapper content={String(children || '')} />;
              }

              if (language === 'echarts') {
                return <EchartsWrapper options={String(children || '').trim()} />;
              }

              return <Code node={node} className={className} {...props}>{children}</Code>;
            },
            a: ({ node, children }) => {
              const href = node?.properties?.href;
              if (typeof href === 'string') {
                // By default render as inline (isBlock=false)
                return <LinkPreview href={href} text={children} isBlock={false} />
              }
              return <>{children}</>;
            },
            li: ({ node, children, className }) => {
              const isTaskListItem = className?.includes('task-list-item');
              if (isTaskListItem && onChange && !isShareMode) {
                return (
                  <ListItem
                    content={content}
                    onChange={onChange}
                    className={className}
                  >
                    {children}
                  </ListItem>
                );
              }
              return <li className={className}>{children}</li>;
            },
            img: ImageWrapper,
            table: TableWrapper
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
});

export const StreamingCodeBlock = observer(({ markdown }: { markdown: string }) => {
  return (
    <ReactMarkdown components={{ code: Code }}>
      {markdown}
    </ReactMarkdown>
  );
}); 