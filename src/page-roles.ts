import { ContentError } from './addressing.js';
import { ContentModel } from './content-model.js';
import { resolveMlt, MultiLangText } from './mlt.js';
import { PageChange, pageChange } from './page-changes.js';
import { PageStore, StoredPage } from './store.js';
import { inTransaction } from './writes.js';

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

export async function assignRoleIn(
    tx: PageStore,
    model: ContentModel,
    tenant: string,
    id: string,
    role: string | null,
): Promise<StoredPage | null> {
    model.assertRole(role);
    const page = await tx.getPageById(id, tenant, 'index');
    if (!page) throw new ContentError('not_found', `Page ${id} not found`, { id });
    let released: StoredPage | null = null;
    if (role) {
        const holder = await tx.findPageByRole(role, tenant);
        if (holder && holder.id !== id) {
            await tx.setRole(holder.id, null, tenant);
            released = holder;
        }
    }
    await tx.setRole(id, role, tenant);
    return released;
}

export class PageRoles {
    constructor(
        private store: PageStore,
        private model: ContentModel,
        private tenant = '',
    ) {}

    async assign(id: string, role: string | null): Promise<{ released: string | null; changes: PageChange[] }> {
        this.model.assertRole(role);
        return inTransaction(this.store, async tx => {
            const released = await assignRoleIn(tx, this.model, this.tenant, id, role);
            const page = await tx.getPageById(id, this.tenant, 'index');
            const changes = [pageChange(page!, 'updated')];
            if (released) changes.push(pageChange(released, 'role_released'));
            return { released: released?.id ?? null, changes };
        });
    }

    async links(options: RoleLinkOptions = {}): Promise<Record<string, RoleLink>> {
        const pages = await this.store.listPagesWithRole(this.tenant);
        return roleLinks(pages.filter(page => this.model.hasKind(page.type)), options);
    }
}
