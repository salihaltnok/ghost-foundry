/**
 * THE FOUNDRY — Ghost Core v1.0 · Ana Orkestratör
 *
 * Hafızayı ve hibrit kuyruk motorunu başlatır, beş organın kuyruk işçilerini
 * bağlar, Express API uç noktalarını ve Socket.IO canlı yayınını açar,
 * yeniden başlatmada yarım kalan işleri uzlaştırır ve zarifçe kapanır.
 */
import http from 'node:http';
import { mkdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';

import { config, CIRCUIT_BREAKERS, getConfigWarnings, hasValidApiKey, publicConfig } from './config/index.js';
import { logger, organLogger, attachIO, emitEvent, getRecentLogs, getRecentDebate } from './utils/logger.js';
import { store, DNA_STATUS, LIVE_STATUSES } from './memory/evolution-store.js';
import { queues, QUEUES, enqueueStage } from './queues/queue-manager.js';
import { validateModels } from './utils/openrouter.js';
import { runScout, injectSignal } from './organs/scout.js';
import { runCouncil } from './organs/council.js';
import { runForge } from './organs/forge.js';
import { runDeploy, reconcileDeployments } from './organs/deployer.js';
import { runReaper, requestEvaluation, terminateManually } from './organs/reaper.js';

const log = organLogger('core');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TELEMETRY_EVENTS = new Set(['open', 'click', 'input', 'change', 'paste', 'copy', 'drop', 'session_end', 'custom', 'simulated']);
const runtimeWarnings = [];

// ─── Süreç düzeyi sigortalar ────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.warn(`Yakalanmamış Promise reddi: ${message}`, { organ: 'core' });
});

// ─── Yardımcılar ────────────────────────────────────────────────────
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireControl(req, res, next) {
  if (!config.controlToken) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-ghost-token') || '';
  if (token && safeEqual(token, config.controlToken)) return next();
  return res.status(401).json({ ok: false, error: 'Kontrol jetonu gerekli (CONTROL_TOKEN).' });
}

/** Form tabanlı CSRF'ye karşı: kontrol uçları yalnızca application/json kabul eder. */
function requireJson(req, res, next) {
  if (req.is('application/json')) return next();
  return res.status(415).json({ ok: false, error: 'İstek gövdesi application/json olmalı.' });
}

function requireApiKey(req, res, next) {
  if (hasValidApiKey()) return next();
  return res.status(503).json({ ok: false, error: 'OPENROUTER_API_KEY tanımlı değil. .env dosyasına geçerli anahtarı girip sunucuyu yeniden başlatın.' });
}

/** Hangi aşamadan yeniden denenebileceğini belirler (Konsey reddi ve Darwin ölümü bir karardır, tekrar denenmez). */
function retryPlanFor(dna) {
  const plans = {
    council: { status: DNA_STATUS.SCOUTED, stage: 'council' },
    forge: { status: DNA_STATUS.APPROVED, stage: 'forge' },
    deploy: { status: DNA_STATUS.FORGED, stage: 'deploy' },
  };
  if (dna.status === DNA_STATUS.FORGE_FAILED) return plans.forge;
  if (dna.status === DNA_STATUS.DEPLOY_FAILED) return plans.deploy;
  if ([DNA_STATUS.FAILED, DNA_STATUS.BUDGET_EXCEEDED].includes(dna.status) || dna.error?.parked) {
    return plans[dna.error?.stage] || null;
  }
  return null;
}

async function retryDna(dnaId) {
  const dna = store.getDna(dnaId);
  if (!dna) throw Object.assign(new Error('DNA bulunamadı.'), { statusCode: 404 });
  const plan = retryPlanFor(dna);
  if (!plan) throw Object.assign(new Error(`Bu DNA yeniden denenemez (durum: ${dna.status}). Konsey reddi ve Darwin kararları kesindir.`), { statusCode: 409 });
  if (plan.stage !== 'deploy' && !hasValidApiKey()) throw Object.assign(new Error('OPENROUTER_API_KEY tanımlı değil.'), { statusCode: 503 });
  if (plan.stage === 'forge' && !dna.council?.upgraded_spec) {
    throw Object.assign(new Error('Konsey spesifikasyonu yok; Forge yeniden denenemez.'), { statusCode: 409 });
  }
  if (plan.stage === 'deploy') {
    try {
      await fsp.access(path.join(config.paths.artifacts, dnaId, 'index.html'));
    } catch {
      throw Object.assign(new Error('Artefakt diskte yok; dağıtım yeniden denenemez.'), { statusCode: 409 });
    }
  }
  if (store.getDnaCost(dnaId) >= CIRCUIT_BREAKERS.MAX_BUDGET_PER_DNA_USD) {
    throw Object.assign(new Error(`DNA bütçesi tükenmiş ($${store.getDnaCost(dnaId).toFixed(4)}). MAX_BUDGET_PER_DNA_USD değerini artırıp sunucuyu yeniden başlatın.`), { statusCode: 409 });
  }
  if (store.getTotalCost() >= CIRCUIT_BREAKERS.MAX_TOTAL_BUDGET_USD) {
    throw Object.assign(new Error('Küresel bütçe tavanı dolu (MAX_TOTAL_BUDGET_USD).'), { statusCode: 409 });
  }
  await store.unbury(dnaId);
  await store.setStatus(dnaId, plan.status, `Operatör yeniden denemeyi başlattı (${plan.stage})`, (draft) => {
    draft.error = null;
  });
  await enqueueStage(plan.stage, dnaId);
  log.info(`DNA yeniden deneniyor: ${plan.stage} aşamasından.`, { dna_id: dnaId });
  return { stage: plan.stage, dna: store.summarize(store.peekDna(dnaId)) };
}

function validDnaParam(req, res, next) {
  if (UUID_RE.test(req.params.dna_id || '')) return next();
  return res.status(400).json({ ok: false, error: 'Geçersiz DNA kimliği.' });
}

class SlidingRateLimiter {
  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs);
    this.timer.unref?.();
  }

  allow(key, limit) {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  }

  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (now - bucket.start >= this.windowMs) this.buckets.delete(key);
  }
}

function appCsp(req, dnaId) {
  const origin = `${req.protocol}://${req.get('host')}`;
  const connect = [`${origin}/api/telemetry/${dnaId}`, 'blob:', 'data:'];
  if (req.protocol === 'http') connect.push('https:');
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https:",
    'font-src https: data:',
    'img-src * data: blob:',
    'media-src * data: blob:',
    "worker-src 'self' blob:",
    `connect-src ${connect.join(' ')}`,
    "form-action 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join('; ');
}

function statusPage(title, message, code) {
  return `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05060a;color:#cbd5e1;font-family:ui-monospace,Menlo,Consolas,monospace}
main{max-width:560px;padding:32px;border:1px solid #1e293b;border-radius:12px;background:#0b0f19}h1{color:#f472b6;font-size:18px;margin:0 0 12px}
p{line-height:1.6;margin:0 0 16px}a{color:#22d3ee}</style></head><body><main><h1>${code} · ${title}</h1><p>${message}</p><a href="/">← Flight Recorder</a></main></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

async function buildStatsPayload() {
  return { stats: store.stats(), queues: await queues.getStats() };
}

// ─── Kuyruk işçileri ───────────────────────────────────────────────
function registerWorkers() {
  queues.process(QUEUES.SCOUT, async (job) => runScout({ trigger: job.data?.trigger || 'manual' }), { concurrency: 1 });
  queues.process(QUEUES.COUNCIL, async (job) => runCouncil(job.data.dnaId), { concurrency: config.council.concurrency });
  queues.process(QUEUES.FORGE, async (job) => runForge(job.data.dnaId), { concurrency: config.forge.concurrency });
  queues.process(
    QUEUES.DEPLOY,
    async (job) => {
      const maxAttempts = Number(job.opts?.attempts) || 1;
      return runDeploy(job.data.dnaId, { isFinalAttempt: job.attemptsMade + 1 >= maxAttempts });
    },
    { concurrency: 1 },
  );
  queues.process(QUEUES.REAPER, async (job) => runReaper(job.data.dnaId, { manual: Boolean(job.data.manual) }), { concurrency: 2 });
}

/** Yeniden başlatmada yarım kalan DNA'ları doğru kuyruğa geri koyar. */
async function reconcilePipeline() {
  const counts = { council: 0, forge: 0, deploy: 0, reaper: 0 };
  for (const dna of store.listDnas()) {
    try {
      switch (dna.status) {
        case DNA_STATUS.SCOUTED:
        case DNA_STATUS.IN_COUNCIL:
          await enqueueStage('council', dna.id);
          counts.council += 1;
          break;
        case DNA_STATUS.APPROVED:
        case DNA_STATUS.FORGING:
        case DNA_STATUS.HEALING:
          await enqueueStage('forge', dna.id);
          counts.forge += 1;
          break;
        case DNA_STATUS.FORGED:
        case DNA_STATUS.DEPLOYING:
        case DNA_STATUS.DEPLOY_WAITING:
          await enqueueStage('deploy', dna.id);
          counts.deploy += 1;
          break;
        case DNA_STATUS.DEPLOYED: {
          const expires = Date.parse(dna.deployment?.expires_at || '') || Date.now();
          await enqueueStage('reaper', dna.id, { delay: Math.max(0, expires - Date.now()) });
          counts.reaper += 1;
          break;
        }
        case DNA_STATUS.EVALUATING:
          await store.setStatus(dna.id, DNA_STATUS.DEPLOYED, 'Yeniden başlatma: yarım kalan Darwin testi tekrarlanacak');
          await enqueueStage('reaper', dna.id, { delay: 0 });
          counts.reaper += 1;
          break;
        default:
          break;
      }
    } catch (err) {
      log.error(`Uzlaştırma hatası (${dna.id}): ${err.message}`);
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total) log.info(`Boru hattı uzlaştırıldı: ${JSON.stringify(counts)}`);
  try {
    await reconcileDeployments();
  } catch (err) {
    log.warn(`Docker uzlaştırması başarısız: ${err.message}`);
  }
}

// ─── Ana akış ───────────────────────────────────────────────────────
async function main() {
  for (const dir of [config.paths.data, config.paths.artifacts, config.paths.logs]) mkdirSync(dir, { recursive: true });
  await store.init();
  const queueMode = await queues.init();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const server = http.createServer(app);
  const io = new SocketIOServer(server, { serveClient: true, cors: { origin: false } });
  attachIO(io);

  io.use((socket, next) => {
    if (!config.controlToken) return next();
    const token = socket.handshake.auth?.token;
    return token && safeEqual(token, config.controlToken) ? next() : next(new Error('unauthorized'));
  });
  io.on('connection', async (socket) => {
    log.debug(`Panel bağlandı (${socket.id})`);
    try {
      socket.emit('stats', await buildStatsPayload());
    } catch (err) {
      log.warn(`İlk istatistik gönderilemedi: ${err.message}`);
    }
  });

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const jsonBody = express.json({ limit: '64kb' });
  const telemetryCors = cors({ origin: '*', methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type'], maxAge: 86_400 });
  const telemetryLimiter = new SlidingRateLimiter();

  // ── Sağlık
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, version: config.version, uptime_s: Math.round(process.uptime()), queue_mode: queues.mode });
  });

  // ── Tüm sistem durumu
  app.get(
    '/api/state',
    requireControl,
    asyncRoute(async (req, res) => {
      res.json({
        ok: true,
        server_time: new Date().toISOString(),
        config: { ...publicConfig(), queue_mode: queues.mode },
        stats: store.stats(),
        queues: await queues.getStats(),
        dnas: store.listSummaries(300),
        rules: store.getRules(),
        graveyard: store.getGraveyard(100),
        recent_logs: getRecentLogs(150),
        recent_debate: getRecentDebate({ limit: 250 }),
        warnings: [...getConfigWarnings(), ...runtimeWarnings],
      });
    }),
  );

  // ── Tek DNA ayrıntısı
  app.get(
    '/api/dna/:dna_id',
    requireControl,
    validDnaParam,
    asyncRoute(async (req, res) => {
      const dna = store.getDna(req.params.dna_id);
      if (!dna) return res.status(404).json({ ok: false, error: 'DNA bulunamadı.' });
      if (dna.telemetry) delete dna.telemetry.visitor_hashes;
      return res.json({ ok: true, dna, summary: store.summarize(dna), debate: getRecentDebate({ dnaId: dna.id, limit: 200 }) });
    }),
  );

  // ── Canlı radar taraması
  app.post(
    '/api/scout/trigger',
    requireControl,
    requireJson,
    jsonBody,
    requireApiKey,
    asyncRoute(async (req, res) => {
      const stats = await queues.getStats();
      const scout = stats.queues[QUEUES.SCOUT] || {};
      if ((scout.active || 0) + (scout.waiting || 0) > 0) {
        return res.status(409).json({ ok: false, error: 'Bir radar taraması zaten sürüyor.' });
      }
      const job = await queues.add(QUEUES.SCOUT, 'scan', { trigger: 'manual' }, { jobId: `scout-manual-${Date.now()}` });
      return res.status(202).json({ ok: true, job_id: job.id, message: 'Radar taraması başlatıldı.' });
    }),
  );

  // ── Manuel sinyal enjeksiyonu
  app.post(
    '/api/scout/inject',
    requireControl,
    requireJson,
    jsonBody,
    requireApiKey,
    asyncRoute(async (req, res) => {
      const summary = await injectSignal(req.body || {});
      res.status(201).json({ ok: true, dna: summary });
    }),
  );

  // ── Telemetri (üretilen mikro-araçlardan; CORS açık, text/plain veya JSON)
  app.options('/api/telemetry/:dna_id', telemetryCors);
  app.post(
    '/api/telemetry/:dna_id',
    telemetryCors,
    validDnaParam,
    express.text({ type: () => true, limit: '4kb' }),
    asyncRoute(async (req, res) => {
      const dnaId = req.params.dna_id;
      let body = {};
      if (typeof req.body === 'string' && req.body.trim()) {
        try {
          body = JSON.parse(req.body);
        } catch {
          body = {};
        }
      }
      const event = TELEMETRY_EVENTS.has(body?.event) ? body.event : 'custom';
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (!telemetryLimiter.allow(`${ip}|${dnaId}`, CIRCUIT_BREAKERS.TELEMETRY_RATE_LIMIT_PER_MINUTE)) {
        return res.status(429).json({ ok: false, error: 'Telemetri hız sınırı aşıldı.' });
      }
      const visitorHash = createHash('sha256').update(`${ip}|${req.get('user-agent') || ''}|${dnaId}`).digest('hex').slice(0, 16);
      const result = await store.registerTelemetry(dnaId, { event, visitorHash });
      if (!result.ok) {
        return res.status(result.reason === 'not_found' ? 404 : 410).json({ ok: false, error: result.reason, status: result.status });
      }
      emitEvent('telemetry', { dna_id: dnaId, event, telemetry_pings: result.dna.telemetry_pings, ts: new Date().toISOString() });
      return res.json({ ok: true, telemetry_pings: result.dna.telemetry_pings });
    }),
  );

  // ── Darwin testi (anında)
  app.post(
    '/api/reaper/evaluate/:dna_id',
    requireControl,
    requireJson,
    jsonBody,
    validDnaParam,
    asyncRoute(async (req, res) => {
      const result = await requestEvaluation(req.params.dna_id);
      res.status(202).json({ ok: true, ...result, message: 'Darwin testi kuyruğa alındı.' });
    }),
  );

  // ── Operatör imhası (kota boşaltma)
  app.post(
    '/api/dna/:dna_id/terminate',
    requireControl,
    requireJson,
    jsonBody,
    validDnaParam,
    asyncRoute(async (req, res) => {
      const reason = String(req.body?.reason || 'Operatör tarafından imha edildi').slice(0, 300);
      const summary = await terminateManually(req.params.dna_id, reason);
      res.json({ ok: true, dna: summary });
    }),
  );

  // ── Yeniden dene (yapılandırma hatasıyla park edilen veya teknik hatayla düşen DNA'lar)
  app.post(
    '/api/dna/:dna_id/retry',
    requireControl,
    requireJson,
    jsonBody,
    validDnaParam,
    asyncRoute(async (req, res) => {
      const result = await retryDna(req.params.dna_id);
      res.status(202).json({ ok: true, ...result, message: `DNA ${result.stage} aşamasından yeniden kuyruğa alındı.` });
    }),
  );

  // ── Üretilen mikro-araçların canlı yayını
  app.get('/apps', (req, res) => res.redirect('/'));
  app.get(
    ['/apps/:dna_id', '/apps/:dna_id/'],
    asyncRoute(async (req, res) => {
      const dnaId = req.params.dna_id;
      res.setHeader('Cache-Control', 'no-store');
      if (!UUID_RE.test(dnaId)) return res.status(400).type('html').send(statusPage('Geçersiz kimlik', 'DNA kimliği geçerli bir UUID değil.', 400));
      const dna = store.peekDna(dnaId);
      if (!dna) return res.status(404).type('html').send(statusPage('Bulunamadı', 'Bu DNA kimliğiyle kayıtlı bir mikro-araç yok.', 404));
      if (dna.status === DNA_STATUS.TERMINATED) {
        const autopsy = dna.evaluation?.autopsy ? `<br><br><em>Otopsi:</em> ${escapeHtml(dna.evaluation.autopsy)}` : '';
        return res
          .status(410)
          .type('html')
          .send(statusPage('İmha edildi', `Bu mikro-araç Darwinci seçilimde elendi (${dna.evaluation?.pings_at_eval ?? 0} ping).${autopsy}`, 410));
      }
      if (!LIVE_STATUSES.has(dna.status)) {
        return res.status(404).type('html').send(statusPage('Henüz yayında değil', `Bu DNA şu an <strong>${escapeHtml(dna.status)}</strong> aşamasında.`, 404));
      }
      let html;
      try {
        html = await fsp.readFile(path.join(config.paths.artifacts, dnaId, 'index.html'), 'utf8');
      } catch {
        return res.status(404).type('html').send(statusPage('Artefakt yok', 'Araç dosyası diskte bulunamadı.', 404));
      }
      res.setHeader('Content-Security-Policy', appCsp(req, dnaId));
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      return res.type('html').send(html);
    }),
  );

  // ── Flight Recorder paneli
  app.use(express.static(config.paths.public, { index: 'index.html', maxAge: 0 }));

  // ── 404 ve hata yakalayıcı
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Uç nokta bulunamadı.' }));
  app.use((err, req, res, next) => {
    const status = Number(err.statusCode || err.status) || 500;
    if (status >= 500) log.error(`${req.method} ${req.originalUrl} → ${err.message}`, { stack: err.stack });
    if (res.headersSent) return next(err);
    return res.status(status).json({ ok: false, error: status >= 500 ? `Sunucu hatası: ${err.message}` : err.message });
  });

  registerWorkers();
  await reconcilePipeline();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  log.info('═══════════════════════════════════════════════════════════');
  log.info(`THE FOUNDRY · Ghost Core v${config.version} çevrimiçi`);
  log.info(`Flight Recorder → ${config.publicBaseUrl}  (dinleniyor: ${config.host}:${config.port})`);
  log.info(`Kuyruk: ${queueMode} · Dağıtım: ${config.docker.dryRun ? 'dry-run (/apps)' : `docker (${config.docker.image})`} · Nesil #${store.getRules().mutation_generation}`);
  log.info('═══════════════════════════════════════════════════════════');
  for (const warning of getConfigWarnings()) log.warn(warning);

  if (hasValidApiKey()) {
    validateModels(Object.values(config.models))
      .then(({ catalogAvailable, missing }) => {
        if (!catalogAvailable) return;
        for (const model of missing) {
          const message = `Model "${model}" OpenRouter kataloğunda bulunamadı — .env'de güncel bir model kimliği kullanın (openrouter.ai/models).`;
          runtimeWarnings.push(message);
          log.warn(message);
        }
      })
      .catch((err) => log.warn(`Model doğrulaması yapılamadı: ${err.message}`));
  }

  let autoScoutTimer = null;
  if (config.scout.autoIntervalMs > 0) {
    if (!hasValidApiKey()) {
      log.warn('AUTO_SCOUT_INTERVAL_MS ayarlı ama API anahtarı yok; otonom tarama devre dışı.');
    } else {
      autoScoutTimer = setInterval(async () => {
        try {
          const stats = await queues.getStats();
          const scout = stats.queues[QUEUES.SCOUT] || {};
          if ((scout.active || 0) + (scout.waiting || 0) > 0) return;
          await queues.add(QUEUES.SCOUT, 'scan', { trigger: 'auto' }, { jobId: `scout-auto-${Date.now()}` });
        } catch (err) {
          log.error(`Otonom tarama kuyruğa alınamadı: ${err.message}`);
        }
      }, config.scout.autoIntervalMs);
      log.info(`Otonom radar: her ${Math.round(config.scout.autoIntervalMs / 60000)} dakikada bir.`);
    }
  }

  const statsTimer = setInterval(async () => {
    if (io.engine.clientsCount === 0) return;
    try {
      emitEvent('stats', await buildStatsPayload());
    } catch (err) {
      log.debug(`İstatistik yayını başarısız: ${err.message}`);
    }
  }, 2_000);

  let shuttingDown = false;
  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} alındı — Ghost Core kapanıyor...`);
    const force = setTimeout(() => process.exit(exitCode || 1), 15_000);
    force.unref();
    clearInterval(statsTimer);
    if (autoScoutTimer) clearInterval(autoScoutTimer);
    try {
      io.close();
      await new Promise((resolve) => server.close(() => resolve()));
      await queues.close();
      await store.flush();
      log.info('Durum diske yazıldı. Görüşmek üzere.');
    } catch (err) {
      log.error(`Kapanış hatası: ${err.message}`);
    } finally {
      logger.on('finish', () => process.exit(exitCode));
      logger.end();
      setTimeout(() => process.exit(exitCode), 1_000).unref();
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error(`Yakalanmamış istisna: ${err.message}`, { organ: 'core', stack: err.stack });
    shutdown('uncaughtException', 1);
  });
}

main().catch((err) => {
  logger.error(`Ghost Core başlatılamadı: ${err.message}`, { organ: 'core', stack: err.stack });
  if (err.code === 'EADDRINUSE') logger.error(`Port ${config.port} kullanımda. .env içinde PORT değerini değiştirin.`, { organ: 'core' });
  setTimeout(() => process.exit(1), 300);
});
