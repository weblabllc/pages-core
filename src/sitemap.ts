export interface SitemapEntry {
    path: string;
    lastmod: string | null;
}

export interface SitemapSource {
    slug: string;
    category?: string | null;
    authorSlug?: string | null;
    updatedAt?: Date | string | null;
}

export interface ContentSitemapOptions {
    basePath: string;
    categories?: readonly string[];
    includeAuthors?: boolean;
    categoryPath?: (slug: string) => string;
    authorPath?: (slug: string) => string;
    sections?: ReadonlyArray<SitemapSection>;
}

export type SitemapSection = 'root' | 'categories' | 'pages' | 'authors';

const DEFAULT_SECTIONS: readonly SitemapSection[] = ['root', 'categories', 'pages', 'authors'];

const toIso = (value: Date | string | null | undefined): string | null =>
    value ? new Date(value).toISOString() : null;

function latest(values: Array<Date | string | null | undefined>): string | null {
    let max: number | null = null;
    for (const value of values) {
        if (!value) continue;
        const time = new Date(value).getTime();
        if (max === null || time > max) max = time;
    }
    return max === null ? null : new Date(max).toISOString();
}

export function contentSitemapEntries(pages: readonly SitemapSource[], options: ContentSitemapOptions): SitemapEntry[] {
    const base = options.basePath.replace(/\/+$/, '');
    const categoryPath = options.categoryPath ?? (slug => `${base}/category/${slug}`);
    const authorPath = options.authorPath ?? (slug => `${base}/author/${slug}`);

    const build: Record<SitemapSection, () => SitemapEntry[]> = {
        root: () => [{ path: base || '/', lastmod: latest(pages.map(p => p.updatedAt)) }],
        categories: () =>
            (options.categories ?? []).map(category => ({
                path: categoryPath(category),
                lastmod: latest(pages.filter(p => p.category === category).map(p => p.updatedAt)),
            })),
        pages: () => pages.map(page => ({ path: `${base}/${page.slug}`, lastmod: toIso(page.updatedAt) })),
        authors: () => {
            if (!options.includeAuthors) return [];
            const authors = [...new Set(pages.map(p => p.authorSlug).filter((s): s is string => Boolean(s)))];
            return authors.map(author => ({
                path: authorPath(author),
                lastmod: latest(pages.filter(p => p.authorSlug === author).map(p => p.updatedAt)),
            }));
        },
    };
    const entries = (options.sections ?? DEFAULT_SECTIONS).flatMap(section => build[section]());
    return entries;
}

const escapeXml = (value: string) =>
    value.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c);

export function renderSitemapXml(entries: readonly SitemapEntry[], baseUrl: string): string {
    const origin = baseUrl.replace(/\/+$/, '');
    const urls = entries.map(entry => {
        const loc = escapeXml(`${origin}${entry.path.startsWith('/') ? '' : '/'}${encodeURI(entry.path)}`);
        const lastmod = entry.lastmod ? `<lastmod>${entry.lastmod}</lastmod>` : '';
        return `  <url><loc>${loc}</loc>${lastmod}</url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
