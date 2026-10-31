import React, { useEffect, useRef } from 'react';
import type { Block } from '../types';
import type { OrgaNode, Position } from '../utils/org';
import { applyHighlight, codeBlockClassName } from '../utils/codeHighlight';
import { useFenceTheme } from '../hooks/useFenceTheme';
import { hasLinkedDocExtension } from '../utils/markdownExtensions';

/*
 * Native Org rendering, styled the way GitHub renders an .org file: headings
 * and body text on GitHub's document scale (bordered h1/h2, 16px rhythm),
 * in-buffer settings and drawers hidden (see parseOrgToBlocks), wrapped lines
 * joined into one paragraph, tables with a header row when a rule follows the
 * first row, and code in a plain grey block. Every rendered construct carries
 * its original source range (sourceAttrs) so feedback quotes the Org source.
 */

interface Props {
  block: Block;
  onOpenLinkedDoc?: (path: string) => void;
}

function sourceAttrs(position?: Position, atomic = false): Record<string, string | number | boolean> {
  if (!position || typeof position.start.offset !== 'number' || typeof position.end.offset !== 'number') return {};
  return {
    'data-org-source-start': position.start.offset,
    'data-org-source-end': position.end.offset,
    'data-org-source-start-line': position.start.line,
    'data-org-source-start-column': position.start.column,
    'data-org-source-end-line': position.end.line,
    'data-org-source-end-column': position.end.column,
    ...(atomic ? { 'data-org-source-atomic': 'true' } : {}),
  };
}

const textValue = (node: OrgaNode): string => String(node.value ?? '');

/** GitHub's document scale, shared by headlines and the title. */
const HEADING_CLASS: Record<number, string> = {
  1: 'text-[2em] pb-[0.3em] border-b border-border/70',
  2: 'text-[1.5em] pb-[0.3em] border-b border-border/70',
  3: 'text-[1.25em]',
  4: 'text-base',
  5: 'text-[0.875em]',
  6: 'text-[0.85em] text-muted-foreground',
};
const HEADING_BASE = 'mt-6 mb-4 font-semibold leading-tight text-foreground first:mt-0';
const PARAGRAPH = 'mb-4 text-base leading-normal text-foreground/90';
const INLINE_CODE = 'rounded-md bg-muted/70 px-[0.4em] py-[0.2em] font-mono text-[85%]';
const PRE = 'mb-4 overflow-auto rounded-md bg-[var(--code-bg)] p-4 font-mono text-[0.8125rem] leading-[1.6] whitespace-pre-wrap';

const OrgSourceCode: React.FC<{ code: string; language: string }> = ({ code, language }) => {
  const ref = useRef<HTMLElement>(null);
  const theme = useFenceTheme();
  useEffect(() => {
    if (ref.current) applyHighlight(ref.current, code, language, theme);
  }, [code, language, theme]);
  return <code ref={ref} className={codeBlockClassName(language)}>{code}</code>;
};

function safeWebHref(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : null;
  } catch {
    return null;
  }
}

/** Orga keeps the line break and blank line after an item or paragraph as
 *  trailing nodes; rendered, they would be empty space at the block's end. */
function trimBreaks(nodes: OrgaNode[]): OrgaNode[] {
  let end = nodes.length;
  while (end > 0 && (nodes[end - 1].type === 'newline' || nodes[end - 1].type === 'emptyLine')) end--;
  return nodes.slice(0, end);
}

function phrasing(nodes: OrgaNode[] = [], onOpenLinkedDoc?: (path: string) => void): React.ReactNode[] {
  return nodes.flatMap((node, index): React.ReactNode[] => {
    const key = `${node.type}-${node.position?.start.offset ?? index}`;
    if (node.type === 'text') {
      const content = <>{textValue(node)}</>;
      const attrs = sourceAttrs(node.position, Boolean(node.style));
      switch (node.style) {
        case 'bold': return [<strong key={key} {...attrs} className="font-semibold">{content}</strong>];
        case 'italic': return [<em key={key} {...attrs}>{content}</em>];
        case 'underline': return [<u key={key} {...attrs}>{content}</u>];
        case 'strikeThrough': return [<s key={key} {...attrs}>{content}</s>];
        case 'verbatim':
        case 'code': return [<code key={key} {...attrs} className={INLINE_CODE}>{content}</code>];
        case 'math': return [<span key={key} {...attrs} className="font-serif italic">{content}</span>];
        default: return [<span key={key} {...attrs}>{content}</span>];
      }
    }
    if (node.type === 'link') {
      const target = String((node.path as { value?: unknown } | undefined)?.value ?? '');
      const labelNodes = (node.children ?? []).filter(child => !['opening', 'closing', 'link.path'].includes(child.type));
      const label = phrasing(labelNodes, onOpenLinkedDoc);
      const shown = label.length ? label : target;
      const linkClass = 'text-primary hover:underline';
      const webHref = safeWebHref(target);
      if (webHref) {
        return [<a key={key} {...sourceAttrs(node.position, true)} href={webHref} target="_blank" rel="noopener noreferrer" className={linkClass}>{shown}</a>];
      }
      const localPath = target.replace(/^file:/, '').replace(/::.*$/, '');
      const isLocalDocument = !/^[a-z][a-z0-9+.-]*:/i.test(localPath)
        && hasLinkedDocExtension(localPath, { allowFragment: true });
      if (target && isLocalDocument && onOpenLinkedDoc) {
        return [<button key={key} {...sourceAttrs(node.position, true)} type="button" className={linkClass} onClick={() => onOpenLinkedDoc(localPath)}>{shown}</button>];
      }
      return [<span key={key} {...sourceAttrs(node.position, true)} title={target || undefined} className="text-primary">{shown}</span>];
    }
    if (node.type === 'footnote.reference') {
      const label = String(node.label ?? '');
      return [<sup key={key} {...sourceAttrs(node.position, true)} className="text-primary">[{label || phrasing(node.children, onOpenLinkedDoc)}]</sup>];
    }
    // A wrapped line continues the paragraph, as on GitHub; a blank line
    // inside an item separates its paragraphs.
    if (node.type === 'newline') return [' '];
    if (node.type === 'emptyLine') return [<span key={key} className="block h-2" />];
    if (['opening', 'closing', 'link.path', 'stars', 'todo', 'priority', 'tags', 'list.item.bullet', 'list.item.checkbox', 'list.item.tag', 'table.columnSeparator'].includes(node.type)) return [];
    const visible = textValue(node);
    return visible ? [<span key={key} {...sourceAttrs(node.position, true)}>{visible}</span>] : [];
  });
}

function title(node: OrgaNode, block: Block) {
  return <h1 {...sourceAttrs(node.position, true)} data-block-id={block.id} data-block-type="heading" className={`${HEADING_BASE} ${HEADING_CLASS[1]}`}>{textValue(node)}</h1>;
}

function headline(node: OrgaNode, block: Block, onOpenLinkedDoc?: (path: string) => void) {
  const level = Math.max(1, Math.min(6, Number(node.level ?? 1)));
  const Tag = `h${level}` as React.ElementType;
  const text = (node.children ?? []).filter(child => !['stars', 'todo', 'priority', 'tags'].includes(child.type));
  const todo = typeof node.keyword === 'string' ? node.keyword : undefined;
  const priority = typeof node.priority === 'string' ? node.priority : undefined;
  const tags = Array.isArray(node.tags) ? node.tags.map(String) : [];
  return (
    <Tag {...sourceAttrs(node.position, true)} data-block-id={block.id} data-block-type="heading" className={`${HEADING_BASE} ${HEADING_CLASS[level]} flex items-baseline gap-2`}>
      <span className="min-w-0 flex-1">
        {todo && <span className={`mr-2 font-mono text-[0.8em] ${node.actionable ? 'text-amber-600 dark:text-amber-400' : 'text-success'}`}>{todo}</span>}
        {priority && <span className="mr-2 font-mono text-[0.8em] text-muted-foreground">{priority}</span>}
        {phrasing(text, onOpenLinkedDoc)}
      </span>
      {tags.length > 0 && <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">:{tags.join(':')}:</span>}
    </Tag>
  );
}

function listItemBody(child: OrgaNode) {
  return trimBreaks(child.children?.filter(item => !['list.item.bullet', 'list.item.checkbox', 'list.item.tag'].includes(item.type)) ?? []);
}

/** GitHub's marker per nesting depth: disc, circle, square; decimal, roman, alpha. */
const BULLET_BY_DEPTH = ['list-disc', 'list-[circle]', 'list-[square]'];
const NUMBER_BY_DEPTH = ['list-decimal', 'list-[lower-roman]', 'list-[lower-alpha]'];

function renderList(node: OrgaNode, blockId: string | undefined, onOpenLinkedDoc?: (path: string) => void, depth = 0): React.ReactNode {
  const nested = depth > 0;
  const items = node.children ?? [];
  // `- term :: description` items are a description list, as on GitHub.
  if (items.length > 0 && items.every(child => child.type !== 'list.item' || typeof child.tag === 'string')) {
    return (
      <dl {...sourceAttrs(node.position)} data-block-id={blockId} className={nested ? 'mt-1' : 'mb-4'}>
        {items.map((child, index) => child.type === 'list.item' ? (
          <div key={child.position?.start.offset ?? index} {...sourceAttrs(child.position)}>
            <dt className="mt-4 font-semibold italic first:mt-0">{String(child.tag)}</dt>
            <dd className="mb-4 pl-4">{phrasing(listItemBody(child), onOpenLinkedDoc)}</dd>
          </div>
        ) : child.type === 'list' ? <React.Fragment key={`nested-${index}`}>{renderList(child, undefined, onOpenLinkedDoc, depth + 1)}</React.Fragment> : null)}
      </dl>
    );
  }
  const Tag = node.ordered ? 'ol' : 'ul';
  const elements: React.ReactNode[] = [];
  for (const [index, child] of items.entries()) {
    if (child.type === 'list') {
      // A nested list belongs to the item before it.
      const sub = renderList(child, undefined, onOpenLinkedDoc, depth + 1);
      const last = elements.pop();
      elements.push(React.isValidElement(last)
        ? React.cloneElement(last as React.ReactElement<{ children?: React.ReactNode }>, {}, (last.props as { children?: React.ReactNode }).children, sub)
        : <li key={`nested-${index}`} className="list-none">{sub}</li>);
      continue;
    }
    if (child.type !== 'list.item') continue;
    const checkbox = child.children?.find(item => item.type === 'list.item.checkbox');
    const body = listItemBody(child);
    elements.push(
      <li key={child.position?.start.offset ?? index} {...sourceAttrs(child.position)} className={`mt-1 leading-normal ${checkbox ? 'list-none' : ''}`}>
        {/* GitHub's task-list layout: the checkbox takes the bullet's place and
            wrapped lines align with the text, not the checkbox. */}
        {checkbox && <input type="checkbox" checked={Boolean(checkbox.checked)} readOnly disabled aria-label="Read-only Org checkbox" className="-ml-[1.4em] mr-[0.4em] align-middle accent-primary" />}
        {body.length > 0 ? phrasing(body, onOpenLinkedDoc) : ' '}
      </li>,
    );
  }
  return (
    <Tag {...sourceAttrs(node.position)} data-block-id={blockId} className={`${(node.ordered ? NUMBER_BY_DEPTH : BULLET_BY_DEPTH)[Math.min(depth, 2)]} pl-8 text-base text-foreground/90 ${nested ? 'mt-1' : 'mb-4'}`}>
      {elements}
    </Tag>
  );
}

/** Org pads cells with spaces to align the columns in the source. The
 *  trimmed text's source range moves with it, so a selection inside the cell
 *  still quotes exactly the characters it covers. */
function trimCellText(part: OrgaNode, first: boolean, last: boolean): OrgaNode {
  const raw = textValue(part);
  const leading = first ? raw.length - raw.trimStart().length : 0;
  const trailing = last ? raw.length - raw.trimEnd().length : 0;
  if (leading === 0 && trailing === 0) return part;
  const position = part.position;
  const shift = (point: Position['start'], by: number) => ({
    ...point,
    column: point.column + by,
    ...(typeof point.offset === 'number' ? { offset: point.offset + by } : {}),
  });
  return {
    ...part,
    value: raw.slice(leading, raw.length - trailing),
    ...(position ? { position: { start: shift(position.start, leading), end: shift(position.end, -trailing) } } : {}),
  };
}

function renderTable(node: OrgaNode, block: Block, onOpenLinkedDoc?: (path: string) => void) {
  const rows = node.children ?? [];
  // Org has no header syntax of its own; a rule right after the first row
  // makes it the header, which is how Org export and GitHub read it.
  const hasHeader = rows[0]?.type === 'table.row' && rows[1]?.type === 'table.hr';
  const cells = (row: OrgaNode) => (row.children ?? []).filter(cell => cell.type === 'table.cell');
  const cellBody = (cell: OrgaNode) => {
    const parts = cell.children ?? [];
    return phrasing(parts.map((part, i) => part.type === 'text'
      ? trimCellText(part, i === 0, i === parts.length - 1)
      : part), onOpenLinkedDoc);
  };
  const bodyRows = rows.slice(hasHeader ? 1 : 0).filter(row => row.type === 'table.row');
  const cellClass = 'border border-border px-[13px] py-[6px] text-left align-top';
  return (
    <div {...sourceAttrs(node.position)} data-block-id={block.id} className="mb-4 max-w-full overflow-auto">
      <table className="border-collapse text-base text-foreground/90">
        {hasHeader && (
          <thead>
            <tr {...sourceAttrs(rows[0].position)}>
              {cells(rows[0]).map((cell, i) => <th key={cell.position?.start.offset ?? i} {...sourceAttrs(cell.position)} className={`${cellClass} font-semibold`}>{cellBody(cell)}</th>)}
            </tr>
          </thead>
        )}
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr key={row.position?.start.offset ?? rowIndex} {...sourceAttrs(row.position)} className={rowIndex % 2 === 1 ? 'bg-muted/30' : ''}>
              {cells(row).map((cell, i) => <td key={cell.position?.start.offset ?? i} {...sourceAttrs(cell.position)} className={cellClass}>{cellBody(cell)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const OrgBlock: React.FC<Props> = ({ block, onOpenLinkedDoc }) => {
  const node = block.orgNode as OrgaNode | undefined;
  if (!node) return null;
  switch (node.type) {
    case 'title': return title(node, block);
    case 'headline': return headline(node, block, onOpenLinkedDoc);
    case 'paragraph': return <p {...sourceAttrs(node.position)} data-block-id={block.id} className={PARAGRAPH}>{phrasing(trimBreaks(node.children ?? []), onOpenLinkedDoc)}</p>;
    case 'planning': return <p {...sourceAttrs(node.position, true)} data-block-id={block.id} className="mb-2 font-mono text-sm text-muted-foreground">{block.content.trim()}</p>;
    case 'list': return renderList(node, block.id, onOpenLinkedDoc);
    case 'table': return renderTable(node, block, onOpenLinkedDoc);
    case 'hr': return <hr {...sourceAttrs(node.position, true)} data-block-id={block.id} className="my-6 h-1 border-0 bg-border" />;
    case 'block': {
      const name = String(node.name ?? '').toLowerCase();
      if (name === 'src') {
        const params = Array.isArray(node.params) ? node.params.map(String) : [];
        return <pre {...sourceAttrs(node.position, true)} data-block-id={block.id} className="mb-4"><OrgSourceCode code={textValue(node)} language={params[0] || 'text'} /></pre>;
      }
      if (name === 'quote' || name === 'verse' || name === 'center') {
        const paragraphs = textValue(node).split(/\n\s*\n/);
        return (
          <blockquote {...sourceAttrs(node.position, true)} data-block-id={block.id} className={`mb-4 border-l-4 border-border px-4 text-base text-muted-foreground ${name === 'center' ? 'text-center' : ''}`}>
            {paragraphs.map((text, index) => <p key={index} className={`${index < paragraphs.length - 1 ? 'mb-4' : ''} ${name === 'verse' ? 'whitespace-pre-line' : ''}`}>{name === 'verse' ? text : text.replace(/\s*\n\s*/g, ' ')}</p>)}
          </blockquote>
        );
      }
      return <pre {...sourceAttrs(node.position, true)} data-block-id={block.id} className={PRE}>{textValue(node) || block.content}</pre>;
    }
    case 'footnote': return (
      <div {...sourceAttrs(node.position, true)} data-block-id={block.id} className="mb-2 flex gap-2 text-sm text-muted-foreground">
        <sup className="pt-2 text-primary">{String(node.label ?? '')}</sup>
        <div>{(node.children ?? []).filter(child => child.type !== 'footnote.label').map((child, index) => <React.Fragment key={index}>{child.type === 'paragraph' ? phrasing(trimBreaks(child.children ?? []), onOpenLinkedDoc) : textValue(child)}</React.Fragment>)}</div>
      </div>
    );
    case 'latex': return <pre {...sourceAttrs(node.position, true)} data-block-id={block.id} className={PRE}>{block.content}</pre>;
    case 'html':
    case 'jsx': return <pre {...sourceAttrs(node.position, true)} data-block-id={block.id} className={PRE}>{block.content}</pre>;
    default: return <pre {...sourceAttrs(node.position, true)} data-block-id={block.id} className={PRE}>{block.content}</pre>;
  }
};
