import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReactNode } from 'react';

// Keep the renderer type stable so polling does not remount the scroll container.
function AnswerTable({ children }: { children?: ReactNode }) {
  return <div className="answer-table"><table>{children}</table></div>;
}

export default function ResearchAnswer({ text, sources }: { text: string; sources: { title: string; url: string }[] }) {
  return <div className="ai-output"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => {
      let url: URL;
      try { url = new URL(href ?? ''); } catch { return <span>{children}</span>; }
      if (!['http:', 'https:'].includes(url.protocol)) return <span>{children}</span>;
      const label = String(children);
      const title = sources.find(source => source.url === url.href)?.title;
      return <a href={url.href} target="_blank" rel="noopener noreferrer" title={url.href}>{/^https?:\/\//i.test(label) ? title || `${url.hostname}（來源）` : children}</a>;
    },
    img: () => null,
    table: AnswerTable,
  }}>{text}</Markdown></div>;
}
