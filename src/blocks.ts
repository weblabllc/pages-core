import { SimpleBlock } from './types.js';

const BLOCK_TYPES: ReadonlyArray<SimpleBlock['type']> = ['heading', 'paragraph', 'quote'];

export function normalizeBlocks(value: unknown): SimpleBlock[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
        .map(b => ({
            type: BLOCK_TYPES.includes(b.type as SimpleBlock['type'])
                ? (b.type as SimpleBlock['type'])
                : 'paragraph',
            text: typeof b.text === 'string' ? b.text : '',
        }));
}

export function blocksToPlainText(blocks: SimpleBlock[], separator = '\n\n'): string {
    return blocks
        .map(b => b.text.trim())
        .filter(Boolean)
        .join(separator);
}
