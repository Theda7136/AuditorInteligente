const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createAuthStore } = require('../auth-store.js');
const { createBackup } = require('../backup-db.js');

test('crea y verifica una copia SQLite de cuentas e historial', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-backup-'));
    const sourcePath = path.join(directory, 'source.sqlite');
    const backupDirectory = path.join(directory, 'backups');
    const store = createAuthStore(sourcePath);
    try {
        const user = store.register('backup@example.test', 'password-largo-de-prueba');
        store.saveAnalysis(user.id, {
            title: 'Contrato de prueba',
            excerpt: 'Extracto confidencial',
            score: 24,
            data: { score: 24, alerts: [], recommendations: [] }
        });
    } finally {
        store.close();
    }

    try {
        const first = createBackup({ sourcePath, backupDirectory, now: 1_700_000_300_000 });
        assert.equal(first.integrity, 'ok');
        assert.ok(first.sizeBytes > 0);
        assert.equal(fs.existsSync(first.path), true);

        const backup = new DatabaseSync(first.path);
        try {
            assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
            assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM analyses').get().count, 1);
            assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        } finally {
            backup.close();
        }

        const second = createBackup({ sourcePath, backupDirectory, now: 1_700_000_300_000 });
        assert.notEqual(second.path, first.path);
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(backupDirectory).mode & 0o777, 0o700);
            assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('falla con un mensaje claro si no existe la base a copiar', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-backup-missing-'));
    try {
        assert.throws(
            () => createBackup({ sourcePath: path.join(directory, 'missing.sqlite'), backupDirectory: path.join(directory, 'backups') }),
            /No se encontró la base SQLite/
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
