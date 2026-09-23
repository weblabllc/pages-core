import { ContentError } from './addressing.js';
import { ContentModel } from './content-model.js';
import { resolveMlt, MultiLangText } from './mlt.js';
import { PageStore, StoredPage } from './store.js';

export interface RoleLink {
    role: string;
    slug: string;
    title: string | null;
    path: string;
}

export interface RoleLinkOptions {
    basePath?: string;
    publishedOnly?: boolean;
    lang?: string;
}

function titleOf(page: StoredPage, lang?: string): string | null {
    if (lang && page.titleMlt) {
        const localized = resolveMlt(page.titleMlt as MultiLangText, lang);
        if (localized) return localized;
    }
    return page.title;
}

export function roleLinks(pages: readonly StoredPage[], options: RoleLinkOptions = {}): Record<string, RoleLink> {
    const base = (options.basePath ?? '').replace(/\/+$/, '');
    const publishedOnly = options.publishedOnly ?? true;
    const links: Record<string, RoleLink> = {};
    for (const page of pages) {
        if (!page.role) continue;
        if (publishedOnly && page.status !== 'published') continue;
        links[page.role] = { role: page.role, slug: page.slug, title: titleOf(page, options.lang), path: `${base}/${page.slug}` };
    }
    return links;
}

export class PageRoles {
    constructor(
        private store: PageStore,
        private model: ContentModel,
        private tenant = '',
    ) {}

    async assign(slug: string, role: string | null): Promise<{ released: string | null }> {
        this.model.assertRole(role);
        const page = await this.store.getPage(slug, this.tenant);
        if (!page) throw new ContentError('not_found', `Page "${slug}" not found`, { slug });
        return this.store.assignRole(slug, role, this.tenant);
    }

    async links(options: RoleLinkOptions = {}): Promise<Record<string, RoleLink>> {
        return roleLinks(await this.store.listPagesWithRole(this.tenant), options);
    }
}
