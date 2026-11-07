'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
}

function safeEqual(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createAuthStore(filename = 'auditor-inteligente.sqlite') {
    const db = new DatabaseSync(filename);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            csrf_token TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS analyses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            excerpt TEXT NOT NULL DEFAULT '',
            score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
            data_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS analyses_user_idx ON analyses(user_id, id DESC);
        CREATE TABLE IF NOT EXISTS analysis_quotas (
            quota_key TEXT PRIMARY KEY,
            window_started_at INTEGER NOT NULL,
            count INTEGER NOT NULL CHECK(count > 0)
        );
        CREATE INDEX IF NOT EXISTS analysis_quotas_window_idx ON analysis_quotas(window_started_at);
    `);

    const statements = {
        findUser: db.prepare('SELECT id, email, password_salt, password_hash FROM users WHERE email = ?'),
        insertUser: db.prepare('INSERT INTO users (email, password_salt, password_hash) VALUES (?, ?, ?)'),
        insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)'),
        findSession: db.prepare(`SELECT sessions.user_id, sessions.csrf_token, users.email
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?`),
        deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
        deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
        insertAnalysis: db.prepare('INSERT INTO analyses (user_id, title, excerpt, score, data_json) VALUES (?, ?, ?, ?, ?)'),
        listAnalyses: db.prepare(`SELECT id, title, excerpt, score, data_json, created_at
            FROM analyses WHERE user_id = ? ORDER BY id DESC LIMIT 50`),
        findAnalysis: db.prepare('SELECT id FROM analyses WHERE id = ? AND user_id = ?'),
        deleteAnalysis: db.prepare('DELETE FROM analyses WHERE id = ? AND user_id = ?'),
        clearAnalyses: db.prepare('DELETE FROM analyses WHERE user_id = ?'),
        findAnalysisQuota: db.prepare('SELECT window_started_at, count FROM analysis_quotas WHERE quota_key = ?'),
        deleteExpiredAnalysisQuotas: db.prepare('DELETE FROM analysis_quotas WHERE window_started_at <= ?'),
        upsertAnalysisQuota: db.prepare(`INSERT INTO analysis_quotas (quota_key, window_started_at, count) VALUES (?, ?, ?)
            ON CONFLICT(quota_key) DO UPDATE SET window_started_at = excluded.window_started_at, count = excluded.count`)
    };

    function register(email, password) {
        const credentials = hashPassword(password);
        try {
            const result = statements.insertUser.run(email, credentials.salt, credentials.hash);
            return { id: Number(result.lastInsertRowid), email };
        } catch (error) {
            if (String(error.message).includes('UNIQUE')) return null;
            throw error;
        }
    }

    function authenticate(email, password) {
        const user = statements.findUser.get(email);
        if (!user) {
            hashPassword(password, 'timing-safe-placeholder-salt');
            return null;
        }
        const candidate = crypto.scryptSync(password, user.password_salt, 64).toString('hex');
        if (!safeEqual(candidate, user.password_hash)) return null;
        return { id: user.id, email: user.email };
    }

    function createSession(userId) {
        const token = crypto.randomBytes(32).toString('base64url');
        const csrfToken = crypto.randomBytes(24).toString('base64url');
        const expiresAt = Date.now() + SESSION_TTL_MS;
        statements.insertSession.run(crypto.createHash('sha256').update(token).digest('hex'), userId, csrfToken, expiresAt);
        return { token, csrfToken, expiresAt };
    }

    function getSession(token) {
        if (!token) return null;
        statements.deleteExpired.run(Date.now());
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const session = statements.findSession.get(tokenHash, Date.now());
        return session ? { user: { id: session.user_id, email: session.email }, csrfToken: session.csrf_token, tokenHash } : null;
    }

    function destroySession(tokenHash) {
        if (tokenHash) statements.deleteSession.run(tokenHash);
    }

    function consumeAnalysisQuota(checks, now, windowMs) {
        db.exec('BEGIN IMMEDIATE');
        try {
            statements.deleteExpiredAnalysisQuotas.run(now - windowMs);
            for (const check of checks) {
                const current = statements.findAnalysisQuota.get(check.key);
                if (current && current.count >= check.limit) {
                    db.exec('ROLLBACK');
                    return {
                        allowed: false,
                        retryAfter: Math.max(1, Math.ceil((current.window_started_at + windowMs - now) / 1000))
                    };
                }
            }
            for (const check of checks) {
                const current = statements.findAnalysisQuota.get(check.key);
                if (!current) {
                    statements.upsertAnalysisQuota.run(check.key, now, 1);
                } else {
                    statements.upsertAnalysisQuota.run(check.key, current.window_started_at, current.count + 1);
                }
            }
            db.exec('COMMIT');
            return { allowed: true, retryAfter: 0 };
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch (rollbackError) { /* transaction already ended */ }
            throw error;
        }
    }

    function saveAnalysis(userId, entry) {
        const result = statements.insertAnalysis.run(userId, entry.title, entry.excerpt, entry.score, JSON.stringify(entry.data));
        return Number(result.lastInsertRowid);
    }

    function listAnalyses(userId) {
        return statements.listAnalyses.all(userId).map(row => ({
            id: row.id,
            title: row.title,
            excerpt: row.excerpt,
            score: row.score,
            date: row.created_at,
            textStored: false,
            data: JSON.parse(row.data_json)
        }));
    }

    return {
        register, authenticate, createSession, getSession, destroySession,
        saveAnalysis, listAnalyses, consumeAnalysisQuota,
        deleteAnalysis: (id, userId) => statements.deleteAnalysis.run(id, userId).changes > 0,
        clearAnalyses: userId => statements.clearAnalyses.run(userId).changes,
        close: () => db.close()
    };
}

module.exports = { createAuthStore, SESSION_TTL_MS };
