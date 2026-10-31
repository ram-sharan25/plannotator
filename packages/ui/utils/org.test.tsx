import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { OrgBlock } from '../components/OrgBlock';
import { exportAnnotations } from './parser';
import { AnnotationType } from '../types';
import { parseOrgToBlocks, resolveOrgSourceAnchor } from './org';

const source = readFileSync(resolve(import.meta.dir, '../../../tests/fixtures/requirements.org'), 'utf8');
const testDocument = new Window().document;

function nodeTypes() {
  return parseOrgToBlocks(source).map(block => (block.orgNode as { type: string }).type);
}

describe('native Org parsing and rendering', () => {
  test('uses Orga for review-relevant constructs and retains exact node positions', () => {
    const blocks = parseOrgToBlocks(source);
    const types = nodeTypes();
    expect(types).toContain('headline');
    // Drawers are metadata and hidden, as GitHub hides them.
    expect(types).not.toContain('drawer');
    expect(types).toContain('planning');
    expect(types).toContain('list');
    expect(types).toContain('block');
    expect(types).toContain('table');

    const authentication = blocks.find(block => block.content === 'Authentication')!;
    const node = authentication.orgNode as any;
    expect(node.keyword).toBe('DRAFT');
    expect(node.tags).toEqual(['security', 'review']);
    expect(node.position.start).toEqual({ line: 4, column: 1, offset: 52 });
    expect(source.slice(node.position.start.offset, node.position.end.offset)).toBe('* DRAFT Authentication :security:review:');

    const link = (blocks.find(block => block.content.startsWith('Review [['))!.orgNode as any)
      .children.find((child: any) => child.type === 'link');
    expect(source.slice(link.position.start.offset, link.position.end.offset)).toBe('[[https://example.com/policy][the security policy]]');
  });

  test('renders readable Org without executing or hiding unsupported source', () => {
    const html = parseOrgToBlocks(source)
      .map(block => renderToStaticMarkup(<OrgBlock block={block} />))
      .join('');
    expect(html).toContain('DRAFT');
    expect(html).toContain('security');
    expect(html).toContain('[#A]');
    expect(html).toContain('quality');
    expect(html).not.toContain('PROPERTIES');
    expect(html).toContain('DEADLINE');
    expect(html).toContain('disabled=""');
    expect(html).toContain('emacs-lisp');
    // Header arguments are execution settings; GitHub shows only the code.
    expect(html).not.toContain(':results none');
    expect(html).toContain('https://example.com/policy');
    expect(html).toContain('<table');
    expect(html).toContain('Read-only review.');
    expect(html).toContain('```text');
    expect(html).toContain('not native Org');
    expect(html).toContain('Retry policy');
    expect(html).toContain('Three attempts');
    expect(html).toContain('<strong');
    expect(html).toContain('<em');
    expect(html).toContain('x^2');
    expect(html).toContain('Retry details.');
    expect(html).not.toContain('<script');
  });

  test('renders in-buffer settings, wrapping, empty items and tables the way GitHub does', () => {
    const doc = [
      '#+title: Plan — Overlay',
      '#+status: DRAFT',
      '#+planning-directory: /tmp/plans/overlay/',
      '#+implementation-repository: /tmp/repo',
      '',
      '* Global constraints',
      '',
      'Rules that bind every task,',
      'copied word for word.',
      '',
      '- ',
      '',
      '| Area  | State |',
      '|-------+-------|',
      '| Login | done  |',
      '',
    ].join('\n');
    const blocks = parseOrgToBlocks(doc);
    const types = blocks.map(block => (block.orgNode as { type: string }).type);
    // Only the title survives from the settings, hyphenated keys included.
    expect(types).toEqual(['title', 'headline', 'paragraph', 'list', 'table']);
    const html = blocks.map(block => renderToStaticMarkup(<OrgBlock block={block} />)).join('');
    expect(html).toContain('<h1');
    expect(html).toContain('Plan — Overlay</h1>');
    expect(html).not.toContain('DRAFT');
    expect(html).not.toContain('planning-directory');
    expect(html).not.toContain('/tmp/repo');
    // A wrapped line continues the paragraph instead of breaking it.
    expect(html).toContain('every task,</span> <span');
    expect(html).not.toContain('<br');
    // A bare `- ` is one empty bullet, not a bullet followed by blank lines.
    expect(html).toMatch(/<li[^>]*> <\/li>/);
    // A rule after the first row makes it the header; padding is trimmed and
    // the cell's source range follows the trimmed text.
    expect(html).toContain('<thead>');
    const area = html.match(/<th[^>]*><span data-org-source-start="(\d+)" data-org-source-end="(\d+)"[^>]*>Area<\/span>/);
    expect(area).not.toBeNull();
    expect(doc.slice(Number(area![1]), Number(area![2]))).toBe('Area');
  });
});

describe('Org source anchors', () => {
  test('maps a rendered link to the complete Org link source', () => {
    const excerpt = '[[https://example.com/policy][the security policy]]';
    const start = source.indexOf(excerpt);
    const carrier = testDocument.createElement('a');
    carrier.dataset.orgSourceStart = String(start);
    carrier.dataset.orgSourceEnd = String(start + excerpt.length);
    carrier.dataset.orgSourceAtomic = 'true';
    const mark = testDocument.createElement('mark');
    mark.textContent = 'security policy';
    carrier.append(mark);

    const anchor = resolveOrgSourceAnchor(source, '/docs/requirements.org', 'security policy', [mark as unknown as HTMLElement]);
    expect(anchor).toEqual({
      filePath: '/docs/requirements.org',
      start: { line: 11, column: 8, offset: start },
      end: { line: 11, column: 59, offset: start + excerpt.length },
      excerpt,
      renderedText: 'security policy',
    });
  });

  test('rejects malformed rendered source ranges', () => {
    const carrier = testDocument.createElement('span');
    carrier.dataset.orgSourceStart = '-1';
    carrier.dataset.orgSourceEnd = String(source.length + 1);
    const mark = testDocument.createElement('mark');
    mark.textContent = 'invalid';
    carrier.append(mark);
    expect(resolveOrgSourceAnchor(source, 'requirements.org', 'invalid', [mark as unknown as HTMLElement])).toBeUndefined();
  });

  test('uses the smallest covering source range for a selection spanning nodes', () => {
    const firstText = 'Review ';
    const linkSource = '[[https://example.com/policy][the security policy]]';
    const firstStart = source.indexOf(firstText);
    const linkStart = source.indexOf(linkSource);

    const firstCarrier = testDocument.createElement('span');
    firstCarrier.dataset.orgSourceStart = String(firstStart);
    firstCarrier.dataset.orgSourceEnd = String(firstStart + firstText.length);
    firstCarrier.append('Re');
    const firstMark = testDocument.createElement('mark');
    firstMark.textContent = 'view';
    firstCarrier.append(firstMark, ' ');

    const linkCarrier = testDocument.createElement('a');
    linkCarrier.dataset.orgSourceStart = String(linkStart);
    linkCarrier.dataset.orgSourceEnd = String(linkStart + linkSource.length);
    linkCarrier.dataset.orgSourceAtomic = 'true';
    const linkMark = testDocument.createElement('mark');
    linkMark.textContent = 'the security';
    linkCarrier.append(linkMark);

    const anchor = resolveOrgSourceAnchor(source, 'requirements.org', 'view the security', [firstMark as unknown as HTMLElement, linkMark as unknown as HTMLElement])!;
    expect(anchor.start.offset).toBe(firstStart + 2);
    expect(anchor.end.offset).toBe(linkStart + linkSource.length);
    expect(anchor.excerpt).toBe(source.slice(firstStart + 2, linkStart + linkSource.length));
  });

  test('exports the rendered selection with exact Org source and location', () => {
    const blocks = parseOrgToBlocks(source);
    const heading = blocks.find(block => block.content === 'Requirements')!;
    const start = source.indexOf('** Requirements');
    const excerpt = '** Requirements';
    const feedback = exportAnnotations(blocks, [{
      id: 'org-annotation', blockId: heading.id, startOffset: 0, endOffset: excerpt.length,
      type: AnnotationType.COMMENT, text: 'Define failure handling', originalText: 'Requirements', createdA: 1,
      orgAnchor: {
        filePath: 'requirements.org',
        start: { line: 13, column: 1, offset: start },
        end: { line: 13, column: 16, offset: start + excerpt.length },
        excerpt,
        renderedText: 'Requirements',
      },
    }]);
    expect(feedback).toContain('Feedback on: "Requirements"');
    expect(feedback).toContain('Org source: requirements.org, line 13, columns 1–16');
    expect(feedback).toContain('```org\n** Requirements\n```');
  });

  test('validates imported anchor metadata and chooses a collision-safe fence', () => {
    const blocks = parseOrgToBlocks(source);
    const heading = blocks.find(block => block.content === 'Requirements')!;
    const feedback = exportAnnotations(blocks, [{
      id: 'fenced-org', blockId: heading.id, startOffset: 0, endOffset: 4,
      type: AnnotationType.COMMENT, text: 'Keep this literal', originalText: '````', createdA: 1,
      orgAnchor: {
        filePath: 'requirements.org',
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 5, offset: 4 },
        excerpt: '````', renderedText: '````',
      },
    }, {
      id: 'invalid-org', blockId: heading.id, startOffset: 0, endOffset: 1,
      type: AnnotationType.COMMENT, text: 'Reject this anchor', originalText: 'R', createdA: 2,
      orgAnchor: {
        filePath: 'requirements.org',
        start: { line: 0, column: 1, offset: -1 },
        end: { line: 1, column: 1, offset: 0 },
        excerpt: 'x', renderedText: 'R',
      },
    }]);
    expect(feedback).toContain('`````org\n````\n`````');
    expect(feedback.match(/Org source:/g)).toHaveLength(1);
  });
});
