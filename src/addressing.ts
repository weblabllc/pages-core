import { MultiLangText } from './mlt.js';

export type AddressingMode = 'flat' | 'nested';

export interface StoredFolder {
    id: string;
    tenant: string;
    parentId: string | null;
    name: string;
    nameMlt: MultiLangText | null;
    segment: string;
    sortOrder: number;
}

export interface FolderNode extends StoredFolder {
    children: FolderNode[];
}

export interface RenamedPage {
    from: string;
    to: string;
}

export const MAX_FOLDER_DEPTH = 32;

const FOLDER_SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PAGE_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

export type ContentErrorCode =
    | 'not_found'
    | 'invalid_segment'
    | 'slug_conflict'
    | 'folder_conflict'
    | 'folder_cycle'
    | 'folder_not_empty'
    | 'invalid_import'
    | 'invalid_role';

const STATUS_BY_CODE: Record<ContentErrorCode, number> = {
    not_found: 404,
    invalid_segment: 400,
    slug_conflict: 409,
    folder_conflict: 409,
    folder_cycle: 400,
    folder_not_empty: 409,
    invalid_import: 400,
    invalid_role: 400,
};

export class ContentError extends Error {
    readonly status: number;

    constructor(
        readonly code: ContentErrorCode,
        message: string,
        readonly details: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = 'ContentError';
        this.status = STATUS_BY_CODE[code];
    }
}

export function isValidFolderSegment(segment: unknown): segment is string {
    return typeof segment === 'string' && segment.length <= 64 && FOLDER_SEGMENT_RE.test(segment);
}

export function isValidPageSegment(segment: unknown): segment is string {
    return (
        typeof segment === 'string' &&
        segment.length <= 255 &&
        segment !== '.' &&
        segment !== '..' &&
        PAGE_SEGMENT_RE.test(segment)
    );
}

type FolderIndex = ReadonlyMap<string, StoredFolder>;

export function indexFolders(folders: Iterable<StoredFolder>): Map<string, StoredFolder> {
    const index = new Map<string, StoredFolder>();
    for (const folder of folders) index.set(folder.id, folder);
    return index;
}

export function folderChain(index: FolderIndex, folderId: string | null): StoredFolder[] {
    const chain: StoredFolder[] = [];
    const seen = new Set<string>();
    let current = folderId;
    while (current) {
        if (seen.has(current) || chain.length >= MAX_FOLDER_DEPTH) {
            throw new ContentError('folder_cycle', 'Folder tree is too deep or cyclic', { folderId });
        }
        seen.add(current);
        const folder = index.get(current);
        if (!folder) throw new ContentError('not_found', `Folder ${current} not found`, { folderId: current });
        chain.unshift(folder);
        current = folder.parentId;
    }
    return chain;
}

export function folderPath(index: FolderIndex, folderId: string | null): string[] {
    return folderChain(index, folderId).map(f => f.segment);
}

export interface SlugParts {
    mode: AddressingMode;
    category?: string | null;
    categoryInPath?: boolean;
    folderPath?: readonly string[];
    segment: string;
}

export function composeSlug({ mode, category, categoryInPath, folderPath: path = [], segment }: SlugParts): string {
    if (mode === 'flat') return segment;
    const parts: string[] = [];
    if (categoryInPath && category) parts.push(category);
    parts.push(...path, segment);
    return parts.join('/');
}

export function buildFolderTree(folders: Iterable<StoredFolder>): FolderNode[] {
    const nodes = new Map<string, FolderNode>();
    for (const folder of folders) nodes.set(folder.id, { ...folder, children: [] });
    const roots: FolderNode[] = [];
    for (const node of nodes.values()) {
        const parent = node.parentId ? nodes.get(node.parentId) : undefined;
        (parent ? parent.children : roots).push(node);
    }
    const sort = (list: FolderNode[]) => {
        list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        for (const node of list) sort(node.children);
    };
    sort(roots);
    return roots;
}

export function subtreeIds(index: FolderIndex, folderId: string): string[] {
    const children = new Map<string, string[]>();
    for (const folder of index.values()) {
        if (!folder.parentId) continue;
        const list = children.get(folder.parentId) ?? [];
        list.push(folder.id);
        children.set(folder.parentId, list);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    const stack = [folderId];
    while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        stack.push(...(children.get(id) ?? []));
    }
    return ids;
}

export function wouldCreateCycle(index: FolderIndex, folderId: string, newParentId: string | null): boolean {
    if (!newParentId) return false;
    return subtreeIds(index, folderId).includes(newParentId);
}
