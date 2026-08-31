import { MultiLangText } from './mlt.js';

export interface ContentCategory {
    slug: string;
    name: MultiLangText | null;
    sortOrder: number;
    enabled: boolean;
}

export interface ContentAuthor {
    slug: string;
    name: MultiLangText | string | null;
    photo: string | null;
    role: MultiLangText | string | null;
}

export function categoryComparator(a: ContentCategory, b: ContentCategory): number {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.slug.localeCompare(b.slug);
}

export function enabledCategories(categories: ContentCategory[]): ContentCategory[] {
    return categories.filter(c => c.enabled).sort(categoryComparator);
}
