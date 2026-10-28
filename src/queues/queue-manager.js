/**
 * Ghost Core v1.0 — Hibrit Kuyruk Motoru
 *
 * USE_IN_MEMORY_QUEUE=true ise (veya Redis'e ulaşılamazsa) sıfır bağımlılıklı,
 * gecikmeli görev, yeniden deneme/backoff, eşzamanlılık ve jobId tekilleştirme
 * destekleyen yerleşik asenkron bellek kuyruğu çalışır. false ise aynı arayüz
 * BullMQ + ioredis üzerinden yürür. Organlar hangi motorun çalıştığını bilmez.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { organLogger } from '../utils/logger.js';

const log = organLogger('queue');

export const QUEUES = Object.freeze({
  SCOUT: 'scout-queue',
  COUNCIL: 'council-queue',
  FORGE: 'forge-queue',
  DEPLOY: 'deploy-queue',
  REAPER: 'reaper-queue',
});

const QUEUE_NAMES = Object.values(QUEUES);
const MAX_TIMER_MS = 2_147_000_000; // setTimeout üst sınırı (~24.8 gün)
const KEEP_FINISHED = 500;
const PENDING_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

function computeBackoff(opts, attemptsMade) {
  const backoff = opts.backoff;
  if (!backoff) return 1_000;
  if (typeof backoff === 'number') return backoff;
  const delay = Number(backoff.delay) || 1_000;
  return backoff.type === 'exponential' ? delay * 2 ** Math.max(0, attemptsMade - 1) : delay;
}

function sanitizeJobId(jobId) {
  return jobId === undefined || jobId === null ? undefined : String(jobId).replace(/:/g, '_');
}

/** Tek bir bellek içi kuyruk: waiting → active → completed/failed, delayed zamanlayıcılı. */
class MemoryQueue extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.waiting = [];
    this.delayed = new Map();
    this.active = new Map();
    this.jobs = new Map();
    this.finishedOrder = [];
    this.counters = { completed: 0, failed: 0 };
    this.handler = null;
    this.concurrency = 1;
    this.closed = false;
    this.idleResolvers = [];
  }

  add(name, data, opts = {}) {
    if (this.closed) throw new Error(`Kuyruk kapalı: ${this.name}`);
    const id = sanitizeJobId(opts.jobId) || randomUUID();
    const existing = this.jobs.get(id);
    // BullMQ semantiği: aynı jobId ile ikinci ekleme yok sayılır.
    if (existing) return existing;
    const job = {
      id,
      name,
      data: structuredClone(data ?? {}),
      opts: { attempts: 1, delay: 0, ...opts, jobId: id },
      attemptsMade: 0,
      state: 'waiting',
      timestamp: Date.now(),
      processedOn: null,
      finishedOn: null,
      failedReason: null,
      returnvalue: null,
      progress: 0,
      runAt: null,
    };
    this.jobs.set(id, job);
    const delay = Math.max(0, Number(job.opts.delay) || 0);
    if (delay > 0) {
      this._schedule(job, delay);
    } else {
      this.waiting.push(job);
      this._drain();
    }
    return job;
  }

  _schedule(job, delay) {
    job.state = 'delayed';
    job.runAt = Date.now() + delay;
    const arm = () => {
      const remaining = job.runAt - Date.now();
      if (remaining > MAX_TIMER_MS) {
        const timer = setTimeout(arm, MAX_TIMER_MS);
        timer.unref?.();
        this.delayed.set(job.id, timer);
        return;
      }
      const timer = setTimeout(() => {
        this.delayed.delete(job.id);
        if (this.closed || job.state !== 'delayed') return;
        job.state = 'waiting';
        this.waiting.push(job);
        this._drain();
      }, Math.max(0, remaining));
      timer.unref?.();
      this.delayed.set(job.id, timer);
    };
    arm();
  }

  process(handler, concurrency = 1) {
    this.handler = handler;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this._drain();
  }

  _drain() {
    if (!this.handler || this.closed) return;
    while (this.active.size < this.concurrency && this.waiting.length > 0) {
      const job = this.waiting.shift();
      if (job.state !== 'waiting') continue;
      this._run(job);
    }
  }

  async _run(job) {
    job.state = 'active';
    job.processedOn = Date.now();
    this.active.set(job.id, job);
    this.emit('active', job);
    const handle = {
      id: job.id,
      name: job.name,
      data: job.data,
      opts: job.opts,
      timestamp: job.timestamp,
      get attemptsMade() {
        return job.attemptsMade;
      },
      updateProgress: async (progress) => {
        job.progress = progress;
      },
      log: async () => 0,
    };
    try {
      const result = await this.handler(handle);
      job.returnvalue = result ?? null;
      job.state = 'completed';
      job.finishedOn = Date.now();
      this.counters.completed += 1;
      this.emit('completed', job, result);
      this._trackFinished(job);
    } catch (err) {
      job.attemptsMade += 1;
      job.failedReason = err?.message || String(err);
      const maxAttempts = Number(job.opts.attempts) || 1;
      if (!this.closed && job.attemptsMade < maxAttempts) {
        const delay = computeBackoff(job.opts, job.attemptsMade);
        this.emit('retrying', job, err, delay);
        this._schedule(job, delay);
      } else {
        job.state = 'failed';
        job.finishedOn = Date.now();
        this.counters.failed += 1;
        this.emit('failed', job, err);
        this._trackFinished(job);
      }
    } finally {
      this.active.delete(job.id);
      if (this.active.size === 0) {
        for (const resolve of this.idleResolvers.splice(0)) resolve();
      }
      setImmediate(() => this._drain());
    }
  }

  _trackFinished(job) {
    this.finishedOrder.push(job.id);
    while (this.finishedOrder.length > KEEP_FINISHED) {
      const oldId = this.finishedOrder.shift();
      const old = this.jobs.get(oldId);
      if (old && (old.state === 'completed' || old.state === 'failed')) this.jobs.delete(oldId);
    }
  }

  getState(id) {
    return this.jobs.get(String(id))?.state ?? null;
  }

  remove(id) {
    const job = this.jobs.get(String(id));
    if (!job) return false;
    if (job.state === 'active') return false;
    if (job.state === 'delayed') {
      const timer = this.delayed.get(job.id);
      if (timer) clearTimeout(timer);
      this.delayed.delete(job.id);
    }
    if (job.state === 'waiting') {
      const index = this.waiting.indexOf(job);
      if (index >= 0) this.waiting.splice(index, 1);
    }
    job.state = 'removed';
    this.jobs.delete(job.id);
    return true;
  }

  counts() {
    return {
      waiting: this.waiting.length,
      active: this.active.size,
      delayed: this.delayed.size,
      completed: this.counters.completed,
      failed: this.counters.failed,
    };
  }

  async close(timeoutMs = 10_000) {
    this.closed = true;
    for (const timer of this.delayed.values()) clearTimeout(timer);
    this.delayed.clear();
    if (this.active.size === 0) return;
    await Promise.race([
      new Promise((resolve) => this.idleResolvers.push(resolve)),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
}

class QueueManager extends EventEmitter {
  constructor() {
    super();
    this.mode = null;
    this.memory = new Map();
    this.bull = { lib: null, connection: null, queues: new Map(), workers: new Map() };
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this.mode;
    if (config.queue.useInMemory) {
      this._initMemory('USE_IN_MEMORY_QUEUE=true');
    } else {
      try {
        await this._initBull();
      } catch (err) {
        log.warn(`Redis/BullMQ başlatılamadı (${err.message}). Yerleşik bellek kuyruğuna otomatik geçiliyor.`);
        await this._teardownBull();
        this._initMemory('Redis erişilemedi — otomatik geri düşüş');
      }
    }
    this.initialized = true;
    return this.mode;
  }

  _initMemory(reason) {
    this.mode = 'memory';
    for (const name of QUEUE_NAMES) {
      const queue = new MemoryQueue(name);
      queue.on('failed', (job, err) => log.error(`[${name}] görev başarısız (${job.id}): ${err?.message || err}`));
      queue.on('retrying', (job, err, delay) =>
        log.warn(`[${name}] görev yeniden denenecek (${job.id}, deneme ${job.attemptsMade}) ${delay}ms sonra: ${err?.message || err}`),
      );
      this.memory.set(name, queue);
    }
    log.info(`Hibrit kuyruk motoru BELLEK modunda (${reason}).`);
  }

  async _initBull() {
    const [bullmq, ioredis] = await Promise.all([import('bullmq'), import('ioredis')]);
    const RedisCtor = ioredis.Redis || ioredis.default;
    const { host, port, password, db } = config.queue.redis;
    const base = { host, port, db, password: password || undefined };

    // Hızlı erişilebilirlik sondası: kısa zaman aşımı, yeniden deneme yok.
    const probe = new RedisCtor({
      ...base,
      lazyConnect: true,
      connectTimeout: 3_000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    probe.on('error', () => {});
    try {
      await probe.connect();
      const pong = await probe.ping();
      if (pong !== 'PONG') throw new Error(`Beklenmeyen PING yanıtı: ${pong}`);
    } finally {
      probe.disconnect();
    }

    this.bull.lib = { Queue: bullmq.Queue, Worker: bullmq.Worker };
    this.bull.connection = new RedisCtor({
      ...base,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 500, 10_000),
    });
    this.bull.connection.on('error', (err) => log.error(`Redis bağlantı hatası: ${err.message}`));

    for (const name of QUEUE_NAMES) {
      const queue = new bullmq.Queue(name, {
        connection: this.bull.connection,
        prefix: config.queue.prefix,
        defaultJobOptions: { removeOnComplete: { count: KEEP_FINISHED }, removeOnFail: { count: KEEP_FINISHED } },
      });
      queue.on('error', (err) => log.error(`[${name}] BullMQ kuyruk hatası: ${err.message}`));
      this.bull.queues.set(name, queue);
    }
    this.mode = 'bullmq';
    log.info(`Hibrit kuyruk motoru BULLMQ modunda (Redis ${host}:${port}/${db}).`);
  }

  async _teardownBull() {
    for (const queue of this.bull.queues.values()) await queue.close().catch(() => {});
    this.bull.queues.clear();
    if (this.bull.connection) {
      this.bull.connection.disconnect();
      this.bull.connection = null;
    }
  }

  _assert(queueName) {
    if (!this.initialized) throw new Error('Kuyruk motoru başlatılmadı (queues.init() çağrılmalı).');
    if (!QUEUE_NAMES.includes(queueName)) throw new Error(`Bilinmeyen kuyruk: ${queueName}`);
  }

  /** Bir kuyruğa işleyici bağlar. */
  process(queueName, handler, { concurrency = 1 } = {}) {
    this._assert(queueName);
    const wrapped = async (job) => {
      const started = Date.now();
      try {
        return await handler(job);
      } finally {
        log.debug(`[${queueName}] ${job.name} (${job.id}) ${Date.now() - started}ms`);
      }
    };
    if (this.mode === 'memory') {
      this.memory.get(queueName).process(wrapped, concurrency);
      return;
    }
    const worker = new this.bull.lib.Worker(queueName, wrapped, {
      connection: this.bull.connection,
      prefix: config.queue.prefix,
      concurrency,
      lockDuration: 120_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    });
    worker.on('failed', (job, err) => log.error(`[${queueName}] görev başarısız (${job?.id}): ${err?.message || err}`));
    worker.on('error', (err) => log.error(`[${queueName}] BullMQ işçi hatası: ${err.message}`));
    this.bull.workers.set(queueName, worker);
  }

  async add(queueName, jobName, data = {}, opts = {}) {
    this._assert(queueName);
    const clean = { attempts: 1, ...opts };
    if (clean.jobId !== undefined) clean.jobId = sanitizeJobId(clean.jobId);
    if (this.mode === 'memory') {
      const job = this.memory.get(queueName).add(jobName, data, clean);
      return { id: job.id, state: job.state };
    }
    const job = await this.bull.queues.get(queueName).add(jobName, data, clean);
    return { id: job.id, state: clean.delay > 0 ? 'delayed' : 'waiting' };
  }

  async getJobState(queueName, jobId) {
    this._assert(queueName);
    const id = sanitizeJobId(jobId);
    if (this.mode === 'memory') return this.memory.get(queueName).getState(id);
    const job = await this.bull.queues.get(queueName).getJob(id);
    if (!job) return null;
    return job.getState();
  }

  /**
   * Görevin kuyrukta bekliyor/çalışıyor olmasını garanti eder; tamamlanmış/başarısız
   * eski bir kopyası varsa onu silip yeniden ekler (durum uzlaştırma için idempotent).
   */
  async ensureJob(queueName, jobName, data = {}, opts = {}) {
    if (!opts.jobId) throw new Error('ensureJob için jobId zorunludur.');
    const state = await this.getJobState(queueName, opts.jobId);
    if (state && PENDING_STATES.has(state)) return { id: sanitizeJobId(opts.jobId), state, deduplicated: true };
    if (state) await this.removeJob(queueName, opts.jobId);
    return this.add(queueName, jobName, data, opts);
  }

  async removeJob(queueName, jobId) {
    this._assert(queueName);
    const id = sanitizeJobId(jobId);
    if (this.mode === 'memory') return this.memory.get(queueName).remove(id);
    const job = await this.bull.queues.get(queueName).getJob(id);
    if (!job) return false;
    const state = await job.getState();
    if (state === 'active') return false;
    try {
      await job.remove();
      return true;
    } catch (err) {
      log.warn(`[${queueName}] ${id} silinemedi: ${err.message}`);
      return false;
    }
  }

  async getStats() {
    const queues = {};
    for (const name of QUEUE_NAMES) {
      try {
        if (this.mode === 'memory') {
          queues[name] = this.memory.get(name).counts();
        } else {
          const counts = await this.bull.queues
            .get(name)
            .getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'prioritized');
          queues[name] = {
            waiting: (counts.waiting || 0) + (counts.prioritized || 0),
            active: counts.active || 0,
            delayed: counts.delayed || 0,
            completed: counts.completed || 0,
            failed: counts.failed || 0,
          };
        }
      } catch (err) {
        queues[name] = { error: err.message };
      }
    }
    return { mode: this.mode, queues };
  }

  async close() {
    if (this.mode === 'memory') {
      await Promise.all([...this.memory.values()].map((queue) => queue.close()));
      return;
    }
    await Promise.all([...this.bull.workers.values()].map((worker) => worker.close().catch(() => {})));
    await this._teardownBull();
  }
}

export const queues = new QueueManager();

/** Boru hattı aşamaları ve deterministik jobId'leri (tekilleştirme + durum uzlaştırma için). */
export const STAGES = Object.freeze({
  council: { queue: QUEUES.COUNCIL, name: 'deliberate', jobId: (dnaId) => `council-${dnaId}`, attempts: 1 },
  forge: { queue: QUEUES.FORGE, name: 'forge', jobId: (dnaId) => `forge-${dnaId}`, attempts: 1 },
  deploy: { queue: QUEUES.DEPLOY, name: 'deploy', jobId: (dnaId) => `deploy-${dnaId}`, attempts: 2 },
  reaper: { queue: QUEUES.REAPER, name: 'evaluate', jobId: (dnaId) => `reap-${dnaId}`, attempts: 1 },
});

/**
 * Bir DNA'yı belirtilen aşamanın kuyruğuna idempotent biçimde yerleştirir.
 * @param {'council'|'forge'|'deploy'|'reaper'} stage
 */
export async function enqueueStage(stage, dnaId, { delay = 0, jobId = null, data = {} } = {}) {
  const def = STAGES[stage];
  if (!def) throw new Error(`Bilinmeyen aşama: ${stage}`);
  return queues.ensureJob(def.queue, def.name, { dnaId, ...data }, {
    jobId: jobId || def.jobId(dnaId),
    delay,
    attempts: def.attempts,
    backoff: { type: 'exponential', delay: 10_000 },
  });
}
