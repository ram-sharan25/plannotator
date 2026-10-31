import { parse, type Document } from 'orga';
import type { Block, OrgSourceAnchor } from '../types';

type Point = { line: number; column: number; offset?: number };
type Position = { start: Point; end: Point };
type OrgaNode = {
  type: string;
  value?: unknown;
  name?: string;
  children?: OrgaNode[];
  position?: Position;
  [key: string]: unknown;
};

export const isOrgPath = (path: string | null | undefined): boolean => /\.org$/i.test(path ?? '');

const positionOf = (node: OrgaNode): Position | undefined => node.position;

/** Orga includes the newline and indentation before the next construct in a
 * headline's range. A rendered headline is an atomic review target, so trim
 * that range to the exact original heading line without searching rendered
 * text. The start offset still comes directly from Orga. */
function headlinePosition(source: string, node: OrgaNode): Position | undefined {
  const position = positionOf(node);
  const start = position?.start.offset;
  if (!position || typeof start !== 'number') return position;
  const newline = source.indexOf('\n', start);
  const end = newline === -1 ? source.length : newline;
  return {
    start: position.start,
    end: pointAtOffset(source, end),
  };
}

function pointAtOffset(source: string, offset: number): Point {
  const bounded = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, bounded);
  const lastNewline = before.lastIndexOf('\n');
  return {
    line: (before.match(/\n/g)?.length ?? 0) + 1,
    column: bounded - lastNewline,
    offset: bounded,
  };
}

function toBlock(node: OrgaNode, source: string, order: number): Block {
  const position = node.type === 'headline' ? headlinePosition(source, node) : positionOf(node);
  const start = position?.start.offset ?? 0;
  const end = position?.end.offset ?? start;
  const headlineText = node.type === 'headline'
    ? (node.children ?? []).filter(child => child.type === 'text').map(child => String(child.value ?? '')).join(' ')
    : null;
  return {
    id: `org-${start}-${end}-${order}`,
    type: node.type === 'headline' ? 'heading' : 'org',
    content: headlineText ?? source.slice(start, end) ?? String(node.value ?? ''),
    ...(node.type === 'headline' ? { level: Number(node.level ?? 1) } : {}),
    order,
    startLine: position?.start.line ?? 1,
    sourceLineCount: Math.max(1, (position?.end.line ?? position?.start.line ?? 1) - (position?.start.line ?? 1) + 1),
    orgNode: { ...node, position },
  };
}

function collectRenderable(node: OrgaNode, source: string, output: Block[]): void {
  if (node.type === 'document' || node.type === 'section') {
    for (const child of node.children ?? []) collectRenderable(child, source, output);
    return;
  }
  if (node.type === 'emptyLine' || node.type === 'newline') return;
  // Drawers (`:PROPERTIES:`, `:LOGBOOK:`) are metadata; GitHub hides them too.
  if (node.type === 'drawer') return;
  output.push(toBlock(node, source, output.length));
}

const KEYWORD_LINE_RE = /^#\+([A-Za-z0-9_-]+):[ \t]*(.*)$/;

/** The `#+key: value` lines of a block, or null when any line is something
 * else. Orga only recognizes word-character keys, so `#+planning-directory:`
 * arrives as a paragraph; this reads it, and Orga's own keywords, alike. */
function keywordEntries(block: Block, source: string): OrgaNode[] | null {
  const node = block.orgNode as OrgaNode;
  const start = node.position?.start.offset;
  if (typeof start !== 'number' || (node.type !== 'keyword' && node.type !== 'paragraph')) return null;
  const entries: OrgaNode[] = [];
  let offset = start;
  for (const line of block.content.replace(/\n+$/, '').split('\n')) {
    const match = KEYWORD_LINE_RE.exec(line);
    if (!match) return null;
    entries.push({
      type: 'keyword',
      key: match[1],
      value: match[2],
      position: { start: pointAtOffset(source, offset), end: pointAtOffset(source, offset + line.length) },
    });
    offset += line.length + 1;
  }
  return entries.length > 0 ? entries : null;
}

/** In-buffer settings render the way GitHub renders Org: `#+title:` becomes
 * the document title and every other `#+key:` line is hidden. Each title
 * keeps its own source range for anchoring. */
function applySettings(blocks: Block[], source: string): Block[] {
  const kept: Block[] = [];
  for (const block of blocks) {
    const entries = keywordEntries(block, source);
    if (!entries) {
      kept.push({ ...block, order: kept.length });
      continue;
    }
    for (const entry of entries) {
      if (String(entry.key).toLowerCase() !== 'title' || !String(entry.value ?? '').trim()) continue;
      const position = entry.position!;
      const start = position.start.offset ?? 0;
      const end = position.end.offset ?? start;
      kept.push({
        id: `org-${start}-${end}-${kept.length}`,
        type: 'org',
        content: String(entry.value),
        order: kept.length,
        startLine: position.start.line,
        sourceLineCount: 1,
        orgNode: { type: 'title', value: entry.value, position },
      });
    }
  }
  return kept;
}

/** Parse the original Org source directly with Orga. Parse failures remain
 * reviewable as one safe source block rather than falling through to Markdown. */
export function parseOrgToBlocks(source: string): Block[] {
  try {
    const document = parse(source) as Document as unknown as OrgaNode;
    const collected: Block[] = [];
    collectRenderable(document, source, collected);
    const blocks = applySettings(collected, source);
    return blocks.length > 0 ? blocks : [{
      id: 'org-empty', type: 'org', content: source, order: 0, startLine: 1,
      sourceLineCount: Math.max(1, source.split('\n').length),
      orgNode: { type: 'unsupported', value: source, position: document.position },
    }];
  } catch {
    return [{
      id: 'org-source', type: 'org', content: source, order: 0, startLine: 1,
      sourceLineCount: Math.max(1, source.split('\n').length),
      orgNode: {
        type: 'unsupported', value: source,
        position: { start: pointAtOffset(source, 0), end: pointAtOffset(source, source.length) },
      },
    }];
  }
}

function numericData(element: HTMLElement, name: keyof DOMStringMap): number | null {
  const raw = element.dataset[name];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function sourceCarrier(mark: HTMLElement): HTMLElement | null {
  return mark.closest<HTMLElement>('[data-org-source-start][data-org-source-end]');
}

function atomicCarrier(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>('[data-org-source-atomic="true"]');
}

function textOffsetBefore(root: HTMLElement, target: HTMLElement): number {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEndBefore(target);
  return range.toString().length;
}

/** Resolve a web-highlighter selection from rendered Org nodes to the smallest
 * safe original-source range. Atomic constructs (links, styled spans,
 * headlines, source blocks) deliberately expand to their complete syntax. */
export function resolveOrgSourceAnchor(
  source: string,
  filePath: string,
  renderedText: string,
  doms: readonly HTMLElement[],
): OrgSourceAnchor | undefined {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const mark of doms) {
    const carrier = sourceCarrier(mark);
    if (!carrier) continue;
    const atomic = atomicCarrier(carrier);
    const chosen = atomic ?? carrier;
    const baseStart = numericData(chosen, 'orgSourceStart');
    const baseEnd = numericData(chosen, 'orgSourceEnd');
    if (
      baseStart == null || baseEnd == null ||
      !Number.isInteger(baseStart) || !Number.isInteger(baseEnd) ||
      baseStart < 0 || baseEnd < baseStart || baseEnd > source.length
    ) continue;
    if (atomic) {
      ranges.push({ start: baseStart, end: baseEnd });
      continue;
    }
    const relative = textOffsetBefore(chosen, mark);
    ranges.push({
      start: Math.min(baseEnd, baseStart + relative),
      end: Math.min(baseEnd, baseStart + relative + (mark.textContent?.length ?? 0)),
    });
  }
  if (ranges.length === 0) return undefined;
  const startOffset = Math.min(...ranges.map((range) => range.start));
  const endOffset = Math.max(...ranges.map((range) => range.end));
  const start = pointAtOffset(source, startOffset);
  const end = pointAtOffset(source, endOffset);
  return {
    filePath,
    start: { line: start.line, column: start.column, offset: startOffset },
    end: { line: end.line, column: end.column, offset: endOffset },
    excerpt: source.slice(startOffset, endOffset),
    renderedText,
  };
}

export type { OrgaNode, Position };
