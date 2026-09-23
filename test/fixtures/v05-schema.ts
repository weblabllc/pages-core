export function pgSchemaV05(p: string): string[] {
    return [
        `CREATE TABLE ${p}pages (
            slug varchar(255) NOT NULL,
            tenant varchar(64) NOT NULL DEFAULT '',
            type varchar(32) NOT NULL DEFAULT 'page',
            status varchar(16) NOT NULL DEFAULT 'draft',
            title varchar(255),
            title_mlt jsonb,
            annotation jsonb,
            data jsonb NOT NULL DEFAULT 'null'::jsonb,
            category varchar(64),
            pinned boolean NOT NULL DEFAULT false,
            author_slug varchar(64),
            cover_image varchar(512),
            reading_time integer,
            published_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant, slug)
        )`,
        `CREATE INDEX ${p}pages_list_idx ON ${p}pages (tenant, type, status, published_at DESC)`,
        `ALTER TABLE ${p}pages ADD COLUMN seo_title jsonb`,
        `ALTER TABLE ${p}pages ADD COLUMN seo_description jsonb`,
        `CREATE TABLE ${p}authors (
            slug varchar(64) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', name jsonb NOT NULL, role jsonb,
            photo varchar(512), enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant, slug)
        )`,
        `CREATE TABLE ${p}categories (
            slug varchar(64) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', kind varchar(16) NOT NULL, name jsonb,
            sort_order integer NOT NULL DEFAULT 0, enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (tenant, kind, slug)
        )`,
        `ALTER TABLE ${p}pages ADD COLUMN role varchar(32)`,
        `CREATE UNIQUE INDEX ${p}pages_role_idx ON ${p}pages (tenant, role) WHERE role IS NOT NULL`,
        `ALTER TABLE ${p}pages ADD COLUMN folder_id varchar(64)`,
        `ALTER TABLE ${p}pages ADD COLUMN segment varchar(255)`,
        `CREATE INDEX ${p}pages_folder_idx ON ${p}pages (tenant, folder_id)`,
        `CREATE TABLE ${p}page_folders (
            id varchar(64) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', parent_id varchar(64), name varchar(255) NOT NULL,
            name_mlt jsonb, segment varchar(64) NOT NULL, sort_order integer NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id)
        )`,
        `CREATE TABLE ${p}page_slug_history (
            slug varchar(255) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', current_slug varchar(255) NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, slug)
        )`,
    ];
}

export function mysqlSchemaV05(p: string): string[] {
    return [
        `CREATE TABLE ${p}pages (
            slug varchar(255) NOT NULL,
            tenant varchar(64) NOT NULL DEFAULT '',
            type varchar(32) NOT NULL DEFAULT 'page',
            status varchar(16) NOT NULL DEFAULT 'draft',
            title varchar(255) NULL,
            title_mlt json NULL,
            annotation json NULL,
            data json NULL,
            category varchar(64) NULL,
            pinned tinyint(1) NOT NULL DEFAULT 0,
            author_slug varchar(64) NULL,
            cover_image varchar(512) NULL,
            reading_time int NULL,
            published_at datetime NULL,
            created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (tenant, slug),
            KEY list_idx (tenant, type, status, published_at)
        )`,
        `CREATE TABLE ${p}authors (
            slug varchar(64) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', name json NOT NULL, role json NULL,
            photo varchar(512) NULL, enabled tinyint(1) NOT NULL DEFAULT 1, PRIMARY KEY (tenant, slug)
        )`,
        `CREATE TABLE ${p}categories (
            slug varchar(64) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', kind varchar(16) NOT NULL, name json NULL,
            sort_order int NOT NULL DEFAULT 0, enabled tinyint(1) NOT NULL DEFAULT 1, PRIMARY KEY (tenant, kind, slug)
        )`,
        `ALTER TABLE ${p}pages ADD COLUMN seo_title json NULL`,
        `ALTER TABLE ${p}pages ADD COLUMN seo_description json NULL`,
        `ALTER TABLE ${p}pages ADD COLUMN role varchar(32) NULL, ADD UNIQUE KEY role_idx (tenant, role)`,
        `ALTER TABLE ${p}pages ADD COLUMN folder_id varchar(64) NULL, ADD KEY folder_idx (tenant, folder_id)`,
        `ALTER TABLE ${p}pages ADD COLUMN segment varchar(255) NULL`,
        `CREATE TABLE ${p}page_folders (
            id varchar(64) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', parent_id varchar(64) NULL, name varchar(255) NOT NULL,
            name_mlt json NULL, segment varchar(64) NOT NULL, sort_order int NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id)
        )`,
        `CREATE TABLE ${p}page_slug_history (
            slug varchar(255) NOT NULL, tenant varchar(64) NOT NULL DEFAULT '', current_slug varchar(255) NOT NULL,
            created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (tenant, slug)
        )`,
    ];
}
