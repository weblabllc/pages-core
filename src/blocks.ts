import { SimpleBlock } from './types.js';

const BLOCK_TYPES: ReadonlyArray<SimpleBlock['type']> = [
    'heading',
    'paragraph',
    'quote',
    'image',
    'document',
    'contact-form',
    'manuscript-form',
];
const URL_BLOCK_TYPES: ReadonlyArray<SimpleBlock['type']> = ['image', 'document'];

/** Relative `/assets/...` path or an `http(s)://` URL — rejects `//host/...` and other protocol-relative forms. */
function isValidBlockUrl(value: unknown): value is string {
    return typeof value === 'string' && (/^\/assets\//.test(value) || /^https?:\/\//.test(value));
}

export function normalizeBlocks(value: unknown): SimpleBlock[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
        .map(b => {
            const type = BLOCK_TYPES.includes(b.type as SimpleBlock['type'])
                ? (b.type as SimpleBlock['type'])
                : 'paragraph';
            const block: SimpleBlock = { type, text: typeof b.text === 'string' ? b.text : '' };
            if (URL_BLOCK_TYPES.includes(type)) block.url = isValidBlockUrl(b.url) ? b.url : '';
            return block;
        });
}

export function blocksToPlainText(blocks: SimpleBlock[], separator = '\n\n'): string {
    return blocks
        .map(b => b.text.trim())
        .filter(Boolean)
        .join(separator);
}
