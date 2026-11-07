'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function createBackup(options = {}) {
    const root = __dirname;
    const sourcePath = path.resolve(options.sourcePath || path.join(root, 'data', 'auditor-inteligente.sqlite'));
    const backupDirectory = path.resolve(options.backupDirectory || path.join(root, 'data', 'backups'));
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw new Error('No se encontró la base SQLite de origen.');
    }

    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(backupDirectory, 0o700);

    const stamp = new Date(options.now === undefined ? Date.now() : options.now)
        .toISOString()
        .replace(/[:.]/g, '-');
    const baseName = 'auditor-inteligente-' + stamp;
    let backupPath = path.join(backupDirectory, baseName + '.sqlite');
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
        backupPath = path.join(backupDirectory, baseName + '-' + suffix + '.sqlite');
        suffix += 1;
    }

    const source = new DatabaseSync(sourcePath);
    try {
        source.prepare('VACUUM INTO ?').run(backupPath);
    } catch (error) {
        try { fs.rmSync(backupPath, { force: true }); } catch (cleanupError) { /* keep the backup error */ }
        throw error;
    } finally {
        source.close();
    }

    try {
        const verification = new DatabaseSync(backupPath);
        let integrity;
        try {
            integrity = verification.prepare('PRAGMA integrity_check').get();
        } finally {
            verification.close();
        }
        if (!integrity || integrity.integrity_check !== 'ok') {
            throw new Error('La copia SQLite no superó la verificación de integridad.');
        }
        if (process.platform !== 'win32') fs.chmodSync(backupPath, 0o600);
        return {
            path: backupPath,
            integrity: integrity.integrity_check,
            sizeBytes: fs.statSync(backupPath).size
        };
    } catch (error) {
        try { fs.rmSync(backupPath, { force: true }); } catch (cleanupError) { /* keep the verification error */ }
        throw error;
    }
}

if (require.main === module) {
    try {
        const result = createBackup();
        console.log('Copia creada y verificada:', result.path);
        console.log('Tamaño:', result.sizeBytes, 'bytes');
    } catch (error) {
        console.error('No se pudo crear la copia:', error.message);
        process.exitCode = 1;
    }
}

module.exports = { createBackup };
