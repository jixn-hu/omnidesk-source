import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default memo(function AiMarkdown({ text }: { text: string }) {
  return <div className="ai-markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    urlTransform={url => /^https?:\/\//i.test(url) ? url : ''}
    components={{
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span className="ai-image-label">{alt || '图片'}</span>,
      pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
      table: ({ children }) => <div className="ai-table-scroll" tabIndex={0} role="region" aria-label="AI 回复表格"><table>{children}</table></div>
    }}
  >{text}</ReactMarkdown></div>
})
