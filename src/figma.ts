import chalk from 'chalk';
import { getCached, setCached } from './cache.js';
import { adfToText, commentsText, getAcceptanceCriteria, getDescriptionText } from './jira-text.js';
import type { JiraIssueDetail } from './types.js';

const FIGMA_URL_REGEX = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/[^\s)\]>,]+/gi;
const FIGMA_API_BASE = 'https://api.figma.com/v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FigmaNode = {
	id: string;
	name: string;
	type: string;
	children?: FigmaNode[];
	componentId?: string;
	absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
	layoutMode?: string;
	primaryAxisAlignItems?: string;
	counterAxisAlignItems?: string;
	paddingLeft?: number;
	paddingRight?: number;
	paddingTop?: number;
	paddingBottom?: number;
	itemSpacing?: number;
	cornerRadius?: number;
	fills?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } }>;
	strokes?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } }>;
	strokeWeight?: number;
	opacity?: number;
	characters?: string;
	style?: {
		fontFamily?: string;
		fontSize?: number;
		fontWeight?: number;
		lineHeightPx?: number;
		letterSpacing?: number;
	};
	layoutSizingHorizontal?: string;
	layoutSizingVertical?: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	boundVariables?: Record<string, any>;
};

type FigmaFileResponse = {
	name: string;
	document?: FigmaNode;
	nodes?: Record<string, { document: FigmaNode }>;
	styles?: Record<string, { key: string; name: string; styleType: string; description?: string }>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	components?: Record<string, any>;
};

type FigmaImagesResponse = {
	images?: Record<string, string | null>;
	err?: string;
};

type ParsedFigmaUrl = { fileKey: string; nodeId?: string; pageId?: string };

type DesignToken = { name: string; category: string; value: string };

type FigmaLinkCache = {
	frameSections: string[];
	tokens: DesignToken[];
	fetchedAt: number;
};

const FIGMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function figmaCacheKey(url: string): string {
	return `figma_${url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 120)}`;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

export function extractFigmaLinks(detail: JiraIssueDetail): string[] {
	const sources: string[] = [];

	sources.push(getDescriptionText(detail));
	sources.push(getAcceptanceCriteria(detail));
	sources.push(commentsText(detail));

	const figmaFieldKey = process.env.FORGEPILOT_JIRA_FIGMA_FIELD?.trim();
	if (figmaFieldKey) {
		const fieldValue = detail.fields[figmaFieldKey];
		if (fieldValue) {
			sources.push(typeof fieldValue === 'string' ? fieldValue : adfToText(fieldValue));
		}
	}

	const combined = sources.join('\n');
	const matches = combined.match(FIGMA_URL_REGEX);
	if (!matches) return [];

	const seen = new Set<string>();
	return matches.filter((url) => {
		const normalized = url.replace(/\/+$/, '');
		if (seen.has(normalized)) return false;
		seen.add(normalized);
		return true;
	});
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function decodeNodeId(raw: string): string {
	return decodeURIComponent(raw).replace(/-/g, ':');
}

export function parseFigmaUrl(url: string): ParsedFigmaUrl | null {
	const match = url.match(/figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/);
	if (!match) return null;

	const fileKey = match[1];
	let nodeId: string | undefined;
	let pageId: string | undefined;

	const nodeMatch = url.match(/[?&]node-id=([^&]+)/);
	if (nodeMatch) nodeId = decodeNodeId(nodeMatch[1]);

	const startMatch = url.match(/[?&]starting-point-node-id=([^&]+)/);
	if (startMatch && !nodeId) nodeId = decodeNodeId(startMatch[1]);

	const pageMatch = url.match(/[?&]page-id=([^&]+)/);
	if (pageMatch) pageId = decodeNodeId(pageMatch[1]);

	return { fileKey, nodeId, pageId };
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function rgbaToHex(r: number, g: number, b: number, a: number): string {
	const toHex = (v: number) =>
		Math.round(v * 255)
			.toString(16)
			.padStart(2, '0');
	const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	return a < 1 ? `${hex} (${Math.round(a * 100)}% opacity)` : hex;
}

function getFillColor(node: FigmaNode): string | null {
	const solidFill = node.fills?.find((f) => f.type === 'SOLID' && f.color);
	if (!solidFill?.color) return null;
	const { r, g, b, a } = solidFill.color;
	return rgbaToHex(r, g, b, a);
}

function getStrokeColor(node: FigmaNode): string | null {
	const solidStroke = node.strokes?.find((s) => s.type === 'SOLID' && s.color);
	if (!solidStroke?.color) return null;
	const { r, g, b, a } = solidStroke.color;
	return rgbaToHex(r, g, b, a);
}

// ---------------------------------------------------------------------------
// Node summarization
// ---------------------------------------------------------------------------

function countNodes(node: FigmaNode): number {
	let count = 1;
	if (node.children) {
		for (const child of node.children) count += countNodes(child);
	}
	return count;
}

function countMeaningfulNodes(nodes: FigmaNode[]): number {
	const meaningful = new Set(['TEXT', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET']);
	let count = 0;
	function walk(node: FigmaNode) {
		if (meaningful.has(node.type)) count++;
		else if (node.type === 'FRAME' && node.layoutMode) count++;
		if (node.children) for (const child of node.children) walk(child);
	}
	for (const n of nodes) walk(n);
	return count;
}

function summarizeNode(
	node: FigmaNode,
	indent: string,
	components?: Record<string, { name?: string }>,
): string {
	if (node.type === 'CANVAS') return '';

	const lines: string[] = [];
	const dims = node.absoluteBoundingBox;
	const size = dims ? ` [${Math.round(dims.width)}x${Math.round(dims.height)}]` : '';
	const pos = dims ? ` @(${Math.round(dims.x)},${Math.round(dims.y)})` : '';

	const fill = getFillColor(node);
	const fillStr = fill ? ` fill:${fill}` : '';

	const stroke = getStrokeColor(node);
	const strokeStr = stroke ? ` stroke:${stroke}${node.strokeWeight ? `(${node.strokeWeight}px)` : ''}` : '';

	const radius = node.cornerRadius ? ` radius:${node.cornerRadius}` : '';
	const opacityStr = node.opacity !== undefined && node.opacity < 1 ? ` opacity:${Math.round(node.opacity * 100)}%` : '';

	let layoutStr = '';
	if (node.layoutMode) {
		const parts = [node.layoutMode];
		if (node.itemSpacing) parts.push(`gap:${node.itemSpacing}`);
		if (node.primaryAxisAlignItems) parts.push(`main:${node.primaryAxisAlignItems}`);
		if (node.counterAxisAlignItems) parts.push(`cross:${node.counterAxisAlignItems}`);
		const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].filter(
			(v) => v !== undefined && v !== 0,
		);
		if (pad.length) parts.push(`pad:${pad.join(',')}`);
		layoutStr = ` (${parts.join(' ')})`;
	}

	let sizingStr = '';
	if (node.layoutSizingHorizontal || node.layoutSizingVertical) {
		const parts: string[] = [];
		if (node.layoutSizingHorizontal) parts.push(`w:${node.layoutSizingHorizontal}`);
		if (node.layoutSizingVertical) parts.push(`h:${node.layoutSizingVertical}`);
		sizingStr = ` sizing:[${parts.join(' ')}]`;
	}

	let textStr = '';
	if (node.type === 'TEXT') {
		const s = node.style;
		const textParts: string[] = [];
		if (s?.fontFamily) textParts.push(s.fontFamily);
		if (s?.fontSize) textParts.push(`${s.fontSize}px`);
		if (s?.fontWeight) textParts.push(`w${s.fontWeight}`);
		if (s?.lineHeightPx) textParts.push(`lh:${Math.round(s.lineHeightPx)}px`);
		if (s?.letterSpacing && s.letterSpacing !== 0) textParts.push(`ls:${s.letterSpacing}`);
		if (textParts.length) textStr = ` font:[${textParts.join(' ')}]`;
		if (node.characters) {
			const preview = node.characters.length > 100 ? node.characters.slice(0, 100) + '...' : node.characters;
			textStr += ` "${preview}"`;
		}
	}

	let componentRef = '';
	if (node.type === 'INSTANCE' && node.componentId && components?.[node.componentId]) {
		componentRef = ` -> ${components[node.componentId].name ?? node.componentId}`;
	}

	let varStr = '';
	if (node.boundVariables) {
		const vars = Object.entries(node.boundVariables)
			.map(([field, binding]) => {
				const id = binding?.id ?? binding?.collection?.id;
				return id ? `${field}=var(${id})` : null;
			})
			.filter(Boolean);
		if (vars.length) varStr = ` vars:[${vars.join(', ')}]`;
	}

	lines.push(
		`${indent}${node.type} "${node.name}"${size}${pos}${layoutStr}${fillStr}${strokeStr}${radius}${opacityStr}${sizingStr}${textStr}${componentRef}${varStr}`,
	);

	if (node.children) {
		for (const child of node.children) {
			const childSummary = summarizeNode(child, indent + '  ', components);
			if (childSummary) lines.push(childSummary);
		}
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Figma API calls
// ---------------------------------------------------------------------------

function figmaHeaders(): Record<string, string> {
	return { 'X-Figma-Token': process.env.FORGEPILOT_FIGMA_PAT?.trim() ?? '' };
}

async function apiFetch<T>(url: string, label: string): Promise<{ data: T; elapsed: number } | null> {
	const startTime = Date.now();
	let response: Response;
	try {
		response = await fetch(url, { headers: figmaHeaders() });
	} catch (err) {
		console.log(chalk.yellow(`    ${label}: network error — ${err instanceof Error ? err.message : err}`));
		return null;
	}
	const elapsed = Date.now() - startTime;

	if (!response.ok) {
		if (response.status === 429) {
			console.log(chalk.yellow(`    ${label}: rate limited (${elapsed}ms)`));
		} else {
			console.log(chalk.yellow(`    ${label}: HTTP ${response.status} (${elapsed}ms)`));
		}
		return null;
	}

	const data = (await response.json()) as T;
	console.log(chalk.gray(`    ${label}: OK (${elapsed}ms)`));
	return { data, elapsed };
}

async function fetchFigmaFileNodes(
	fileKey: string,
	nodeIds: string[],
): Promise<{ nodes: FigmaNode[]; components?: Record<string, { name?: string }>; styles?: FigmaFileResponse['styles'] } | null> {
	const params = new URLSearchParams({ ids: nodeIds.join(',') });
	console.log(chalk.gray(`    Fetching node(s) ${nodeIds.join(', ')} from file ${fileKey} (full depth)`));

	const result = await apiFetch<FigmaFileResponse>(`${FIGMA_API_BASE}/files/${fileKey}/nodes?${params}`, 'Nodes API');
	if (!result) return null;

	const { data } = result;
	const nodes: FigmaNode[] = [];
	if (data.nodes) {
		for (const [id, entry] of Object.entries(data.nodes)) {
			if (entry.document) {
				nodes.push(entry.document);
				console.log(chalk.gray(`    Node ${id}: "${entry.document.name}" (${entry.document.type}), ${countNodes(entry.document)} nodes`));
			}
		}
	}

	return nodes.length ? { nodes, components: data.components, styles: data.styles } : null;
}

async function fetchFigmaFileFull(
	fileKey: string,
	pageId?: string,
): Promise<{ nodes: FigmaNode[]; components?: Record<string, { name?: string }>; styles?: FigmaFileResponse['styles'] } | null> {
	const params = new URLSearchParams({ depth: '3' });
	if (pageId) params.set('ids', pageId);
	const label = pageId ? `page ${pageId}` : 'full file';
	console.log(chalk.gray(`    Fetching ${label} from file ${fileKey} (depth=3)`));

	const result = await apiFetch<FigmaFileResponse>(`${FIGMA_API_BASE}/files/${fileKey}?${params}`, 'File API');
	if (!result) return null;

	const { data } = result;

	if (pageId && data.nodes) {
		const nodes: FigmaNode[] = [];
		for (const entry of Object.values(data.nodes)) {
			if (entry.document) nodes.push(entry.document);
		}
		return nodes.length ? { nodes, components: data.components, styles: data.styles } : null;
	}

	if (data.document) {
		console.log(chalk.gray(`    File: "${data.name}", ${countNodes(data.document)} total nodes`));
		return { nodes: [data.document], components: data.components, styles: data.styles };
	}

	return null;
}

async function exportFrameImages(fileKey: string, nodeIds: string[]): Promise<Map<string, string>> {
	const imageMap = new Map<string, string>();
	if (!nodeIds.length) return imageMap;

	console.log(chalk.gray(`    Exporting ${nodeIds.length} frame(s) as PNG...`));
	const params = new URLSearchParams({ ids: nodeIds.join(','), format: 'png', scale: '2' });
	const result = await apiFetch<FigmaImagesResponse>(`${FIGMA_API_BASE}/images/${fileKey}?${params}`, 'Images API');
	if (!result) return imageMap;

	const { data } = result;
	if (data.images) {
		for (const [id, url] of Object.entries(data.images)) {
			if (url) {
				imageMap.set(id, url);
				console.log(chalk.gray(`    Image for ${id}: exported`));
			}
		}
	}
	console.log(chalk.gray(`    Exported ${imageMap.size}/${nodeIds.length} image(s)`));
	return imageMap;
}

// ---------------------------------------------------------------------------
// Design tokens extraction from styles
// ---------------------------------------------------------------------------

function extractDesignTokens(
	nodes: FigmaNode[],
	styles?: FigmaFileResponse['styles'],
): DesignToken[] {
	const tokens: DesignToken[] = [];
	const seenColors = new Set<string>();
	const seenFonts = new Set<string>();

	function walkForTokens(node: FigmaNode) {
		const fill = getFillColor(node);
		if (fill && !seenColors.has(fill)) {
			seenColors.add(fill);
			tokens.push({ name: node.name, category: 'color', value: fill });
		}

		if (node.type === 'TEXT' && node.style) {
			const s = node.style;
			const key = `${s.fontFamily}-${s.fontSize}-${s.fontWeight}`;
			if (!seenFonts.has(key)) {
				seenFonts.add(key);
				const parts: string[] = [];
				if (s.fontFamily) parts.push(s.fontFamily);
				if (s.fontSize) parts.push(`${s.fontSize}px`);
				if (s.fontWeight) parts.push(`w${s.fontWeight}`);
				if (s.lineHeightPx) parts.push(`lh:${Math.round(s.lineHeightPx)}px`);
				tokens.push({ name: node.name, category: 'typography', value: parts.join(' ') });
			}
		}

		if (node.children) {
			for (const child of node.children) walkForTokens(child);
		}
	}

	for (const node of nodes) walkForTokens(node);

	if (styles) {
		for (const style of Object.values(styles)) {
			if (style.styleType === 'FILL') {
				tokens.push({ name: style.name, category: 'style/fill', value: style.description ?? '(see Figma)' });
			} else if (style.styleType === 'TEXT') {
				tokens.push({ name: style.name, category: 'style/text', value: style.description ?? '(see Figma)' });
			} else if (style.styleType === 'EFFECT') {
				tokens.push({ name: style.name, category: 'style/effect', value: style.description ?? '(see Figma)' });
			}
		}
	}

	return tokens;
}

function formatDesignTokens(tokens: DesignToken[]): string {
	if (!tokens.length) return '';

	const grouped = new Map<string, DesignToken[]>();
	for (const token of tokens) {
		const list = grouped.get(token.category) ?? [];
		list.push(token);
		grouped.set(token.category, list);
	}

	const lines = ['Design Tokens:'];
	for (const [category, items] of grouped) {
		lines.push(`  ${category}:`);
		for (const item of items.slice(0, 20)) {
			lines.push(`    ${item.name}: ${item.value}`);
		}
		if (items.length > 20) lines.push(`    ... and ${items.length - 20} more`);
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Frame collection helpers
// ---------------------------------------------------------------------------

function collectFrames(node: FigmaNode): FigmaNode[] {
	const frames: FigmaNode[] = [];
	if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
		frames.push(node);
	}
	if (node.children && node.type !== 'FRAME') {
		for (const child of node.children) {
			frames.push(...collectFrames(child));
		}
	}
	return frames;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function fetchFigmaDesignContext(detail: JiraIssueDetail): Promise<string> {
	const links = extractFigmaLinks(detail);
	if (!links.length) {
		console.log(chalk.gray('  No Figma links found in ticket.'));
		return '';
	}

	console.log(chalk.cyan(`\n  Found ${links.length} Figma design link(s) in ticket:`));
	for (const link of links) {
		console.log(chalk.cyan(`    ${link}`));
	}

	const token = process.env.FORGEPILOT_FIGMA_PAT?.trim();
	if (!token) {
		console.log(chalk.yellow('  FIGMA_PAT not set — including links as plain URLs in prompt.'));
		return buildPlainLinkSection(links);
	}

	console.log(chalk.cyan('  Fetching design data from Figma API...\n'));

	const frameSections: string[] = [];
	const allTokens: DesignToken[] = [];
	let fetchedCount = 0;
	let failedCount = 0;
	let rateLimited = false;

	for (let i = 0; i < links.length; i++) {
		const link = links[i];
		if (rateLimited) break;

		console.log(chalk.gray(`  [${i + 1}/${links.length}] Processing: ${link}`));

		const cacheKey = figmaCacheKey(link);
		const cached = await getCached<FigmaLinkCache>(cacheKey);
		if (cached && Date.now() - cached.fetchedAt < FIGMA_CACHE_TTL_MS) {
			console.log(chalk.gray(`    Cache hit (${Math.round((Date.now() - cached.fetchedAt) / 60000)}m old) — skipping API calls.`));
			frameSections.push(...cached.frameSections);
			allTokens.push(...cached.tokens);
			fetchedCount++;
			continue;
		}

		const parsed = parseFigmaUrl(link);
		if (!parsed) {
			console.log(chalk.yellow(`    Could not parse Figma URL, skipping.`));
			failedCount++;
			frameSections.push(`Link: ${link}\n  (could not parse URL)`);
			continue;
		}

		console.log(
			chalk.gray(
				`    File: ${parsed.fileKey}` +
					(parsed.nodeId ? `, node: ${parsed.nodeId}` : '') +
					(parsed.pageId ? `, page: ${parsed.pageId}` : '') +
					(!parsed.nodeId && !parsed.pageId ? ' (full file)' : ''),
			),
		);

		let fetchResult: Awaited<ReturnType<typeof fetchFigmaFileNodes>> = null;

		if (parsed.nodeId) {
			fetchResult = await fetchFigmaFileNodes(parsed.fileKey, [parsed.nodeId]);

			if (fetchResult && fetchResult.nodes.length === 1 && fetchResult.nodes[0].type === 'FRAME' && parsed.pageId) {
				const singleFrame = fetchResult.nodes[0];
				console.log(chalk.gray(`    Node "${singleFrame.name}" is a single frame — fetching parent page for sibling frames...`));
				const pageResult = await fetchFigmaFileNodes(parsed.fileKey, [parsed.pageId]);
				if (pageResult && pageResult.nodes.length > 0) {
					const pageNode = pageResult.nodes[0];
					const siblingFrames = (pageNode.children ?? []).filter((c) => c.type === 'FRAME');
					if (siblingFrames.length > 1) {
						console.log(chalk.gray(`    Found ${siblingFrames.length} sibling frame(s): ${siblingFrames.map((f) => `"${f.name}"`).join(', ')}`));
						fetchResult = { nodes: siblingFrames, components: pageResult.components, styles: pageResult.styles };
					}
				}
			}
		} else {
			fetchResult = await fetchFigmaFileFull(parsed.fileKey, parsed.pageId);
		}

		if (!fetchResult || !fetchResult.nodes.length) {
			failedCount++;
			frameSections.push(`Link: ${link}\n  (could not fetch design data)`);
			continue;
		}

		const { nodes, components, styles } = fetchResult;

		const meaningfulCount = countMeaningfulNodes(nodes);
		const totalCount = nodes.reduce((sum, n) => sum + countNodes(n), 0);
		if (totalCount > 0 && meaningfulCount / totalCount < 0.15) {
			console.log(
				chalk.yellow(
					`    Warning: design is mostly images/rectangles (${meaningfulCount}/${totalCount} meaningful nodes).`,
				),
			);
			console.log(chalk.yellow(`    The rendered image will be the primary reference for the AI agent.`));
		}
		const tokens = extractDesignTokens(nodes, styles);
		allTokens.push(...tokens);

		const frames = nodes.flatMap((n) => (n.type === 'FRAME' ? [n] : collectFrames(n)));
		const frameIds = frames.map((f) => f.id);

		let imageMap = new Map<string, string>();
		if (frameIds.length > 0 && !rateLimited) {
			imageMap = await exportFrameImages(parsed.fileKey, frameIds);
			if (imageMap.size === 0 && frameIds.length > 0) {
				rateLimited = true;
			}
		}

		const linkSections: string[] = [];
		for (const node of nodes) {
			const summary = summarizeNode(node, '    ', components);
			if (!summary) continue;

			const imageUrl = imageMap.get(node.id);
			const imageStr = imageUrl ? `  Rendered image (2x): ${imageUrl}\n` : '';
			const frameLabel = nodes.length > 1 ? ` [State: "${node.name}"]` : '';

			linkSections.push(`Link: ${link}${frameLabel}\n${imageStr}  Structure:\n${summary}`);
		}

		frameSections.push(...linkSections);
		fetchedCount++;
		console.log(chalk.green(`    Extracted ${frames.length} frame(s), ${tokens.length} token(s)`));

		await setCached(cacheKey, { frameSections: linkSections, tokens, fetchedAt: Date.now() } satisfies FigmaLinkCache);
		console.log(chalk.gray(`    Cached for future runs.`));
	}

	console.log(chalk.cyan(`\n  Figma fetch complete: ${fetchedCount} succeeded, ${failedCount} failed.`));
	if (fetchedCount > 0) {
		console.log(chalk.green('  Design context will be injected into the agent prompt.'));
	}

	const tokenSection = formatDesignTokens(allTokens);

	return [
		'',
		'--- FIGMA DESIGN CONTEXT ---',
		'The following design structure and tokens were extracted from Figma.',
		'Use this to match your implementation to the design specs.',
		'',
		...(tokenSection ? [tokenSection, ''] : []),
		...frameSections,
		'',
		'Implementation guidelines:',
		'- Match layout direction (HORIZONTAL → flex-direction:row, VERTICAL → flex-direction:column).',
		'- Use exact spacing values: gap for itemSpacing, padding for pad values.',
		'- Apply fill colors as background-color, stroke colors as border-color.',
		'- Match font family, size, weight, line-height, and letter-spacing for text.',
		'- Respect corner radius for border-radius.',
		'- Use @(x,y) position data for absolute positioning or to understand element placement.',
		'- Respect sizing mode: FILL → flex:1/width:100%, HUG → fit-content/auto, FIXED → exact px value.',
		'- If rendered images are provided, use them as the visual source of truth.',
		'- If a node references a component (->), check the component for reusable patterns.',
		'--- END FIGMA ---',
	].join('\n');
}

function buildPlainLinkSection(links: string[]): string {
	const linkList = links.map((url) => `  - ${url}`).join('\n');
	return [
		'',
		'--- FIGMA DESIGN REFERENCES ---',
		'This ticket has associated Figma designs (FIGMA_PAT not configured, showing links only):',
		'',
		linkList,
		'',
		'Refer to these designs when implementing the UI.',
		'--- END FIGMA ---',
	].join('\n');
}
