use tauri_plugin_sql::{Migration, MigrationKind};

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_confirmed_task_cache",
            sql: include_str!("../migrations/001_confirmed_cache.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "cache_snapshot_context",
            sql: include_str!("../migrations/002_snapshot_context.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
