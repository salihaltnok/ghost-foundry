/**
 * Ghost Core v1.0 — Kara Kutu (Flight Recorder) Günlük Motoru
 *
 * winston tabanlı; konsola, logs/ghost.log dosyasına (döner dosya) ve
 * Socket.IO bağlandığında canlı kontrol paneline aynı anda yazar.
 * Ajan tartışmaları (emitDebateMessage) ayrı bir kanaldan akar.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import winston from 'winston';
import { config } from '../config/index.js';

mkdirSync(config.paths.logs, { recursive: true });

const RECENT_LOG_LIMIT = 400;
const RECENT_DEBATE_LIMIT = 500;
const LEVELS = new Set(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']);

const recentLogs = [];
const recentDebate = [];
let io = null;

function pushRing(ring, item, limit) {
  ring.push(item);
  if (ring.length > limit) ring.splice(0, ring.length - limit);
}

/** Socket.IO'ya canlı log akışı yapan özel winston taşıyıcısı. */
class SocketTransport extends winston.Transport {
  log(info, callback) {
    setImmediate(() => this.emit('logged', info));
    if (!info.debate) {
      const entry = {
        id: randomUUID(),
        ts: info.timestamp || new Date().toISOString(),
        level: info.level,
        message: typeof info.message === 'string' ? info.message : JSON.stringify(info.message),
        organ: info.organ || 'core',
        dna_id: info.dna_id || null,
      };
      if (info.stack && info.level === 'error') {
        entry.stack = String(info.stack).split('\n').slice(0, 6).join('\n');
      }
      pushRing(recentLogs, entry, RECENT_LOG_LIMIT);
      if (io) {
        try {
          io.emit('log', entry);
        } catch {
          // Yayın hatası günlüklemeyi durdurmamalı.
        }
      }
    }
    callback();
  }
}

const { combine, timestamp, errors, printf, colorize, json } = winston.format;

const consoleLine = printf((info) => {
  const organ = `[${String(info.organ || 'core').toUpperCase()}]`;
  const dna = info.dna_id ? ` (${String(info.dna_id).slice(0, 8)})` : '';
  const stack = info.stack && String(info.level).includes('error') ? `\n${info.stack}` : '';
  return `${info.timestamp} ${info.level} ${organ}${dna} ${info.message}${stack}`;
});

export const logger = winston.createLogger({
  level: LEVELS.has(config.logLevel) ? config.logLevel : 'info',
  format: combine(errors({ stack: true }), timestamp()),
  transports: [
    new winston.transports.Console({ format: combine(colorize(), consoleLine) }),
    new winston.transports.File({
      filename: path.join(config.paths.logs, 'ghost.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      format: json(),
    }),
    new SocketTransport(),
  ],
  exitOnError: false,
});

/** Organ etiketli alt günlükçü. */
export function organLogger(organ) {
  return logger.child({ organ });
}

/** Socket.IO sunucusunu bağlar; bağlantıdan sonra tüm olaylar canlı yayınlanır. */
export function attachIO(instance) {
  io = instance;
}

export function emitEvent(event, payload) {
  if (!io) return;
  try {
    io.emit(event, payload);
  } catch (err) {
    logger.warn(`Socket yayını başarısız (${event}): ${err.message}`);
  }
}

export function emitLog(level, message, meta = {}) {
  logger.log(LEVELS.has(level) ? level : 'info', message, meta);
}

export function emitDnaUpdate(summary) {
  emitEvent('dna:update', summary);
}

export function emitAgentThinking({ dnaId = null, role, active, label = '' }) {
  emitEvent('agent:thinking', { dna_id: dnaId, role, active: Boolean(active), label, ts: new Date().toISOString() });
}

/**
 * Ajan tartışma mesajı yayınlar (Vizyoner, Eleştirmen, Hakem, Forge, Reaper...).
 * Mesaj hem panele hem dosya günlüğüne düşer.
 */
export function emitDebateMessage({ dnaId = null, role = 'system', title = '', content = '', meta = {} }) {
  const entry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    dna_id: dnaId,
    role: String(role),
    title: String(title).slice(0, 300),
    content: String(content ?? '').slice(0, 8000),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  pushRing(recentDebate, entry, RECENT_DEBATE_LIMIT);
  logger.info(`«${entry.role}» ${entry.title}`, { organ: entry.role, dna_id: dnaId, debate: true });
  emitEvent('debate', entry);
  return entry;
}

export function getRecentLogs(limit = 200) {
  return recentLogs.slice(-limit);
}

export function getRecentDebate({ dnaId = null, limit = 300 } = {}) {
  const source = dnaId ? recentDebate.filter((entry) => entry.dna_id === dnaId) : recentDebate;
  return source.slice(-limit);
}
