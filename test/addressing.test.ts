import { describe, expect, it } from 'vitest';
import {
    buildFolderTree,
    composeSlug,
    ContentError,
    folderPath,
    indexFolders,
    isValidFolderSegment,
    isValidPageSegment,
    StoredFolder,
    subtreeIds,
    wouldCreateCycle,
} from '../src/index.js';

const folder = (id: string, parentId: string | null, segment: string, sortOrder = 0): StoredFolder => ({
    id, tenant: '', parentId, name: segment.toUpperCase(), nameMlt: null, segment, sortOrder,
});

const folders = [
    folder('countries', null, 'countries', 1),
    folder('europe', 'countries', 'europe'),
    folder('germany-region', 'europe', 'dach'),
    folder('guides', null, 'guides', 0),
];
const index = indexFolders(folders);

describe('segments', () => {
    it('accepts folder segments in kebab case only', () => {
        expect(isValidFolderSegment('europe-west')).toBe(true);
        for (const bad of ['Europe', 'eu_west', '-eu', 'eu-', 'a/b', '', 'x'.repeat(65)]) {
            expect(isValidFolderSegment(bad)).toBe(false);
        }
    });

    it('accepts page segments without slashes or dot paths', () => {
        expect(isValidPageSegment('Germany.v2~draft')).toBe(true);
        for (const bad of ['a/b', '..', '.', 'with space', '']) expect(isValidPageSegment(bad)).toBe(false);
    });
});

describe('folder paths', () => {
    it('walks up to the root', () => {
        expect(folderPath(index, 'germany-region')).toEqual(['countries', 'europe', 'dach']);
        expect(folderPath(index, null)).toEqual([]);
    });

    it('refuses cycles and unknown folders', () => {
        const cyclic = indexFolders([folder('a', 'b', 'a'), folder('b', 'a', 'b')]);
        expect(() => folderPath(cyclic, 'a')).toThrowError(ContentError);
        expect(() => folderPath(index, 'missing')).toThrow(/not found/);
    });

    it('builds a sorted tree', () => {
        const tree = buildFolderTree(folders);
        expect(tree.map(n => n.id)).toEqual(['guides', 'countries']);
        expect(tree[1].children[0].children[0].id).toBe('germany-region');
    });

    it('knows the subtree and refuses moves into it', () => {
        expect(subtreeIds(index, 'countries').sort()).toEqual(['countries', 'europe', 'germany-region']);
        expect(wouldCreateCycle(index, 'countries', 'germany-region')).toBe(true);
        expect(wouldCreateCycle(index, 'germany-region', 'guides')).toBe(false);
        expect(wouldCreateCycle(index, 'europe', null)).toBe(false);
    });
});

describe('composeSlug', () => {
    it('composes slugs per addressing mode', () => {
        expect(composeSlug({ mode: 'nested', categoryInPath: true, category: 'countries', segment: 'germany' })).toBe('countries/germany');
        expect(composeSlug({ mode: 'nested', categoryInPath: true, category: 'countries', folderPath: ['countries', 'europe'], segment: 'germany' }))
            .toBe('countries/countries/europe/germany');
        expect(composeSlug({ mode: 'nested', folderPath: ['europe'], segment: 'germany' })).toBe('europe/germany');
        expect(composeSlug({ mode: 'nested', segment: 'about' })).toBe('about');
        expect(composeSlug({ mode: 'flat', category: 'news', folderPath: ['x'], segment: 'post' })).toBe('post');
    });
});
