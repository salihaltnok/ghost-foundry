/**
 * Ghost Core v1.0 — Kalıcı Evrim Hafızası
 *
 * ./data/dna-vault.json        → tüm DNA paketleri + sistem sayaçları
 * ./data/graveyard.json        → reddedilen / ölen araçların mezarlığı
 * ./data/evolutionary_rules.json → sistemin kendi kendine yeniden yazdığı genom
 *
 * Yazımlar atomiktir (geçici dosya + fsync + rename) ve dosya başına sıraya
 * alınıp birleştirilir; aynı anda gelen yüzlerce güncelleme tek yazıma iner.
 */
import { promises as fsp, mkdirSync } from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { config, CIRCUIT_BREAKERS } from '../config/index.js';
import { organLogger, emitDnaUpdate, emitEvent } from '../utils/logger.js';

const log = organLogger('memory');

export const DNA_STATUS = Object.freeze({
  SCOUTED: 'SCOUTED',
  IN_COUNCIL: 'IN_COUNCIL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  FORGING: 'FORGING',
  HEALING: 'HEALING',
  FORGED: 'FORGED',
  FORGE_FAILED: 'FORGE_FAILED',
  DEPLOY_WAITING: 'DEPLOY_WAITING',
  DEPLOYING: 'DEPLOYING',
  DEPLOYED: 'DEPLOYED',
  DEPLOY_FAILED: 'DEPLOY_FAILED',
  EVALUATING: 'EVALUATING',
  IMMORTALIZED: 'IMMORTALIZED',
  TERMINATED: 'TERMINATED',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  FAILED: 'FAILED',
});

/** Yayında olan (telemetri kabul eden ve kota tüketen) durumlar. */
export const LIVE_STATUSES = new Set([DNA_STATUS.DEPLOYED, DNA_STATUS.EVALUATING, DNA_STATUS.IMMORTALIZED]);
export const DEAD_STATUSES = new Set([
  DNA_STATUS.REJECTED,
  DNA_STATUS.FORGE_FAILED,
  DNA_STATUS.DEPLOY_FAILED,
  DNA_STATUS.TERMINATED,
  DNA_STATUS.BUDGET_EXCEEDED,
  DNA_STATUS.FAILED,
]);

const MAX_HISTORY = 80;
const MAX_CALLS = 60;
const MAX_VISITOR_HASHES = 2_000;
const MAX_SEEN_SIGNALS = 3_000;
const MAX_GRAVEYARD = 500;
const MAX_MUTATION_LOG = 50;

const iso = () => new Date().toISOString();
const money = (value) => Math.round((Number(value) || 0) * 1e6) / 1e6;
const clone = (value) => (value === undefined ? undefined : structuredClone(value));

export function defaultRules() {
  return {
    schema_version: 1,
    mutation_generation: 1,
    created_at: iso(),
    updated_at: iso(),
    preferred_patterns: [
      'Tek bir acı noktasını açılır açılmaz, 30 saniye içinde çözen odaklı araçlar',
      'Yapıştır → anında dönüştür/analiz et akışı (paste-to-result), sonuç tek tıkla kopyalanabilir',
      'Gerçekçi örnek veriyi tek tıkla yükleyen boş durum; değer ilk saniyede görünür',
      'Tüm durum tarayıcıda (localStorage); kurulum, hesap ve sunucu yok',
      'Ağır hesaplamalar Web Worker içinde; arayüz asla donmaz',
    ],
    banned_ideas: [
      'Genel amaçlı yapılacaklar listesi, not defteri veya pomodoro klonları',
      'Gerçek bir backend, kimlik doğrulama, ödeme ya da gizli/ücretli API anahtarı gerektiren araçlar',
      'Etkileşimsiz, yalnızca statik bilgi gösteren sayfalar',
      'Bilinen büyük ürünlerin birebir kopyaları',
      'Kullanıcı verisini üçüncü taraf sunuculara gönderen araçlar',
    ],
    ui_guidelines: [
      'Koyu tema (zinc/slate tabanlı), tek güçlü vurgu rengi, yüksek kontrast',
      'Ana eylem ilk ekranda; ikincil ayarlar katlanabilir panelde',
      'Mobilde de çalışan duyarlı yerleşim (360px ve üzeri)',
      'Klavye kısayolları ve görünür odak halkaları; sonuçlar için aria-live',
      'Hata mesajları satır içi, açıklayıcı ve çözüm önerili',
    ],
    learned_insights: [],
    survival_stats: { immortalized: 0, terminated: 0 },
    mutation_log: [],
  };
}

function normalizeRules(data) {
  const base = defaultRules();
  const out = { ...base, ...(data && typeof data === 'object' ? data : {}) };
  for (const key of ['preferred_patterns', 'banned_ideas', 'ui_guidelines', 'learned_insights', 'mutation_log']) {
    if (!Array.isArray(out[key])) out[key] = base[key];
  }
  const generation = Number.parseInt(out.mutation_generation, 10);
  out.mutation_generation = Number.isFinite(generation) && generation >= 1 ? generation : 1;
  if (!out.survival_stats || typeof out.survival_stats !== 'object') out.survival_stats = base.survival_stats;
  out.survival_stats.immortalized = Number(out.survival_stats.immortalized) || 0;
  out.survival_stats.terminated = Number(out.survival_stats.terminated) || 0;
  return out;
}

function defaultVault() {
  return {
    schema_version: 1,
    created_at: iso(),
    meta: {
      total_cost_usd: 0,
      system_cost_usd: 0,
      scout_runs: 0,
      last_scout_at: null,
      seen_signals: [],
    },
    dnas: {},
  };
}

function normalizeVault(data) {
  const base = defaultVault();
  const out = { ...base, ...(data && typeof data === 'object' ? data : {}) };
  out.meta = { ...base.meta, ...(out.meta || {}) };
  if (!Array.isArray(out.meta.seen_signals)) out.meta.seen_signals = [];
  if (!out.dnas || typeof out.dnas !== 'object') out.dnas = {};
  return out;
}

function defaultGraveyard() {
  return { schema_version: 1, created_at: iso(), entries: [] };
}

async function writeAtomic(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Windows'ta virüs tarayıcısı vb. dosyayı kısa süre kilitleyebilir: birkaç kez dene.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, filePath);
      return;
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fsp.unlink(tmp).catch(() => {});
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Birleştirmeli (coalescing), sıralı ve atomik JSON dosya deposu. */
class JsonFile {
  constructor(filePath, defaults, label, normalize = (value) => value) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.label = label;
    this.normalize = normalize;
    this.data = null;
    this.version = 0;
    this.flushedVersion = 0;
    this.loop = null;
    this.waiters = [];
  }

  async load() {
    try {
      const text = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') throw new Error('Kök değer bir JSON nesnesi değil');
      this.data = this.normalize(parsed);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = this.normalize(this.defaults());
        await this.save();
        log.info(`${this.label} oluşturuldu → ${this.filePath}`);
        return;
      }
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fsp.rename(this.filePath, backup).catch(() => {});
      log.error(`${this.label} okunamadı (${err.message}). Yedek: ${backup}. Varsayılanlarla yeniden oluşturuluyor.`);
      this.data = this.normalize(this.defaults());
      await this.save();
    }
  }

  save() {
    this.version += 1;
    const target = this.version;
    const promise = new Promise((resolve, reject) => this.waiters.push({ target, resolve, reject }));
    if (!this.loop) this.loop = this._flushLoop();
    return promise;
  }

  async _flushLoop() {
    try {
      while (this.flushedVersion < this.version) {
        const version = this.version;
        const snapshot = JSON.stringify(this.data, null, 2);
        await writeAtomic(this.filePath, snapshot);
        this.flushedVersion = version;
        this.waiters = this.waiters.filter((waiter) => {
          if (waiter.target <= version) {
            waiter.resolve();
            return false;
          }
          return true;
        });
      }
    } catch (err) {
      log.error(`${this.label} diske yazılamadı: ${err.message}`);
      for (const waiter of this.waiters.splice(0)) waiter.reject(err);
    } finally {
      this.loop = null;
    }
  }

  async flush() {
    if (this.flushedVersion < this.version) await this.save();
  }
}

function normalizeSignal(signal = {}) {
  const text = (value, max) => String(value ?? '').trim().slice(0, max);
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  };
  return {
    source: text(signal.source || 'unknown', 40),
    title: text(signal.title, 300),
    pain_point: text(signal.pain_point, 4000),
    evidence: text(signal.evidence, 2000),
    target_user: text(signal.target_user, 300),
    tool_concept: text(signal.tool_concept, 600),
    why_zero_backend: text(signal.why_zero_backend, 600),
    urgency: num(signal.urgency),
    feasibility: num(signal.feasibility),
    url: text(signal.url, 600) || null,
    refs: Array.isArray(signal.refs) ? signal.refs.slice(0, 10) : [],
  };
}

class EvolutionStore {
  constructor() {
    const dataDir = config.paths.data;
    this.vault = new JsonFile(path.join(dataDir, 'dna-vault.json'), defaultVault, 'DNA kasası', normalizeVault);
    this.graveyard = new JsonFile(path.join(dataDir, 'graveyard.json'), defaultGraveyard, 'Mezarlık', (data) => ({
      ...defaultGraveyard(),
      ...data,
      entries: Array.isArray(data?.entries) ? data.entries : [],
    }));
    this.rules = new JsonFile(path.join(dataDir, 'evolutionary_rules.json'), defaultRules, 'Evrim kuralları', normalizeRules);
    this.seenSignals = new Set();
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    mkdirSync(config.paths.data, { recursive: true });
    mkdirSync(config.paths.artifacts, { recursive: true });
    mkdirSync(config.paths.graveyardArtifacts, { recursive: true });
    await Promise.all([this.vault.load(), this.graveyard.load(), this.rules.load()]);
    this.seenSignals = new Set(this.vault.data.meta.seen_signals);
    this.ready = true;
    const count = Object.keys(this.vault.data.dnas).length;
    log.info(`Hafıza yüklendi: ${count} DNA, ${this.graveyard.data.entries.length} mezar, nesil #${this.rules.data.mutation_generation}.`);
  }

  _require() {
    if (!this.ready) throw new Error('Evrim hafızası başlatılmadı (store.init() çağrılmalı).');
  }

  // ─── DNA yaşam döngüsü ──────────────────────────────────────────

  async createDna({ origin = 'scout', signal = {} } = {}) {
    this._require();
    const id = uuidv4();
    const now = iso();
    const normalized = normalizeSignal(signal);
    const dna = {
      id,
      created_at: now,
      updated_at: now,
      status: DNA_STATUS.SCOUTED,
      origin,
      generation: this.rules.data.mutation_generation,
      title: normalized.title || normalized.tool_concept || 'Adsız sinyal',
      signal: normalized,
      council: null,
      forge: null,
      deployment: null,
      evaluation: null,
      error: null,
      telemetry_pings: 0,
      telemetry: { events: {}, unique_visitors: 0, visitor_hashes: [], first_ping_at: null, last_ping_at: null },
      token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, calls: [] },
      history: [
        { at: now, status: DNA_STATUS.SCOUTED, note: origin === 'manual' ? 'Manuel sinyal enjekte edildi' : 'Radar sinyali yakalandı' },
      ],
    };
    this.vault.data.dnas[id] = dna;
    await this.vault.save();
    emitDnaUpdate(this.summarize(dna));
    return clone(dna);
  }

  getDna(id) {
    this._require();
    return clone(this.vault.data.dnas[id]) ?? null;
  }

  /** Salt-okunur hızlı erişim (kopyalamaz). Dönen nesne DEĞİŞTİRİLMEMELİDİR. */
  peekDna(id) {
    this._require();
    return this.vault.data.dnas[id] ?? null;
  }

  listDnas() {
    this._require();
    return Object.values(this.vault.data.dnas)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((dna) => clone(dna));
  }

  listSummaries(limit = 300) {
    this._require();
    return Object.values(this.vault.data.dnas)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
      .map((dna) => this.summarize(dna));
  }

  /**
   * DNA'yı atomik olarak günceller. mutator taslak kopya üzerinde çalışır;
   * hata fırlatırsa hiçbir değişiklik uygulanmaz.
   */
  async updateDna(id, mutator, { note = null, emit = true } = {}) {
    this._require();
    const current = this.vault.data.dnas[id];
    if (!current) throw new Error(`DNA bulunamadı: ${id}`);
    const draft = clone(current);
    const previousStatus = draft.status;
    if (typeof mutator === 'function') {
      await mutator(draft);
    } else if (mutator && typeof mutator === 'object') {
      Object.assign(draft, mutator);
    }
    draft.updated_at = iso();
    if (draft.status !== previousStatus || note) {
      draft.history.push({ at: draft.updated_at, status: draft.status, note: note || null });
      if (draft.history.length > MAX_HISTORY) draft.history.splice(0, draft.history.length - MAX_HISTORY);
    }
    this.vault.data.dnas[id] = draft;
    await this.vault.save();
    if (emit) emitDnaUpdate(this.summarize(draft));
    return clone(draft);
  }

  async setStatus(id, status, note = null, mutator = null) {
    if (!Object.values(DNA_STATUS).includes(status)) throw new Error(`Geçersiz DNA durumu: ${status}`);
    return this.updateDna(
      id,
      async (draft) => {
        draft.status = status;
        if (mutator) await mutator(draft);
      },
      { note },
    );
  }

  // ─── Maliyet muhasebesi ─────────────────────────────────────────

  async recordUsage(dnaId, entry) {
    this._require();
    const cost = money(entry.cost_usd);
    const meta = this.vault.data.meta;
    meta.total_cost_usd = money(meta.total_cost_usd + cost);
    if (!this.vault.data.dnas[dnaId]) {
      meta.system_cost_usd = money(meta.system_cost_usd + cost);
      await this.vault.save();
      return null;
    }
    return this.updateDna(dnaId, (draft) => {
      const usage = draft.token_usage;
      usage.prompt_tokens += Number(entry.prompt_tokens) || 0;
      usage.completion_tokens += Number(entry.completion_tokens) || 0;
      usage.total_tokens += Number(entry.total_tokens) || 0;
      usage.cost_usd = money(usage.cost_usd + cost);
      usage.calls.push({ ...entry, cost_usd: cost });
      if (usage.calls.length > MAX_CALLS) usage.calls.splice(0, usage.calls.length - MAX_CALLS);
    });
  }

  async recordSystemUsage(entry) {
    this._require();
    const cost = money(entry.cost_usd);
    const meta = this.vault.data.meta;
    meta.total_cost_usd = money(meta.total_cost_usd + cost);
    meta.system_cost_usd = money(meta.system_cost_usd + cost);
    await this.vault.save();
  }

  /** Sistem çağrısı (ör. radar analizi) maliyetinin bir payını DNA'ya aktarır; toplamı değiştirmez. */
  async attributeSystemCost(dnaId, entry) {
    this._require();
    const cost = money(entry.cost_usd);
    if (!this.vault.data.dnas[dnaId] || cost <= 0) return null;
    const meta = this.vault.data.meta;
    meta.system_cost_usd = money(Math.max(0, meta.system_cost_usd - cost));
    return this.updateDna(dnaId, (draft) => {
      const usage = draft.token_usage;
      usage.prompt_tokens += Number(entry.prompt_tokens) || 0;
      usage.completion_tokens += Number(entry.completion_tokens) || 0;
      usage.total_tokens += Number(entry.total_tokens) || 0;
      usage.cost_usd = money(usage.cost_usd + cost);
      usage.calls.push({ ...entry, cost_usd: cost });
      if (usage.calls.length > MAX_CALLS) usage.calls.splice(0, usage.calls.length - MAX_CALLS);
    });
  }

  getDnaCost(id) {
    return Number(this.vault.data.dnas[id]?.token_usage?.cost_usd) || 0;
  }

  getTotalCost() {
    return Number(this.vault.data.meta.total_cost_usd) || 0;
  }

  // ─── Telemetri ──────────────────────────────────────────────────

  async registerTelemetry(dnaId, { event, visitorHash = null }) {
    this._require();
    const dna = this.vault.data.dnas[dnaId];
    if (!dna) return { ok: false, reason: 'not_found' };
    if (!LIVE_STATUSES.has(dna.status)) return { ok: false, reason: 'not_live', status: dna.status };
    const updated = await this.updateDna(dnaId, (draft) => {
      const now = iso();
      draft.telemetry_pings += 1;
      const telemetry = draft.telemetry;
      telemetry.events[event] = (telemetry.events[event] || 0) + 1;
      if (visitorHash && !telemetry.visitor_hashes.includes(visitorHash)) {
        telemetry.visitor_hashes.push(visitorHash);
        if (telemetry.visitor_hashes.length > MAX_VISITOR_HASHES) telemetry.visitor_hashes.shift();
        telemetry.unique_visitors += 1;
      }
      telemetry.first_ping_at = telemetry.first_ping_at || now;
      telemetry.last_ping_at = now;
    });
    return { ok: true, dna: updated };
  }

  // ─── Mezarlık ───────────────────────────────────────────────────

  async bury(dnaOrId, cause, { summary = '', autopsy = null } = {}) {
    this._require();
    const dna = typeof dnaOrId === 'string' ? this.vault.data.dnas[dnaOrId] : dnaOrId;
    const spec = dna?.council?.upgraded_spec || dna?.council?.proposer_spec || null;
    const entry = {
      id: uuidv4(),
      dna_id: dna?.id ?? null,
      buried_at: iso(),
      cause,
      title: spec?.tool_name || dna?.title || 'Bilinmeyen DNA',
      tool_concept: spec?.tagline || dna?.signal?.tool_concept || '',
      pain_point: dna?.signal?.pain_point?.slice(0, 400) || '',
      source: dna?.signal?.source || null,
      origin: dna?.origin || null,
      score: dna?.council?.final_score ?? null,
      generation: dna?.generation ?? null,
      cost_usd: money(dna?.token_usage?.cost_usd),
      telemetry_pings: dna?.telemetry_pings ?? 0,
      summary: String(summary || '').slice(0, 2000),
      autopsy: autopsy ? String(autopsy).slice(0, 4000) : null,
    };
    this.graveyard.data.entries.unshift(entry);
    if (this.graveyard.data.entries.length > MAX_GRAVEYARD) this.graveyard.data.entries.length = MAX_GRAVEYARD;
    await this.graveyard.save();
    emitEvent('graveyard:update', entry);
    return entry;
  }

  /** Yeniden denenen (diriltilen) bir DNA'nın mezar kayıtlarını kaldırır. */
  async unbury(dnaId) {
    this._require();
    const before = this.graveyard.data.entries.length;
    this.graveyard.data.entries = this.graveyard.data.entries.filter((entry) => entry.dna_id !== dnaId);
    const removed = before - this.graveyard.data.entries.length;
    if (removed) {
      await this.graveyard.save();
      emitEvent('graveyard:remove', { dna_id: dnaId });
    }
    return removed;
  }

  getGraveyard(limit = 100) {
    this._require();
    return clone(this.graveyard.data.entries.slice(0, limit));
  }

  // ─── Genom (evrim kuralları) ────────────────────────────────────

  getRules() {
    this._require();
    return clone(this.rules.data);
  }

  async replaceRules(next) {
    this._require();
    const normalized = normalizeRules(next);
    normalized.updated_at = iso();
    if (normalized.mutation_log.length > MAX_MUTATION_LOG) normalized.mutation_log.length = MAX_MUTATION_LOG;
    this.rules.data = normalized;
    await this.rules.save();
    emitEvent('rules:update', clone(normalized));
    return clone(normalized);
  }

  // ─── Radar hafızası ─────────────────────────────────────────────

  hasSeenSignal(ref) {
    return this.seenSignals.has(ref);
  }

  async markSignalsSeen(refs) {
    this._require();
    const meta = this.vault.data.meta;
    for (const ref of refs) {
      if (this.seenSignals.has(ref)) continue;
      this.seenSignals.add(ref);
      meta.seen_signals.push(ref);
    }
    if (meta.seen_signals.length > MAX_SEEN_SIGNALS) {
      const removed = meta.seen_signals.splice(0, meta.seen_signals.length - MAX_SEEN_SIGNALS);
      for (const ref of removed) this.seenSignals.delete(ref);
    }
    await this.vault.save();
  }

  async noteScoutRun() {
    this._require();
    const meta = this.vault.data.meta;
    meta.scout_runs = (Number(meta.scout_runs) || 0) + 1;
    meta.last_scout_at = iso();
    await this.vault.save();
  }

  // ─── Özetler ve istatistik ──────────────────────────────────────

  activeAppCount() {
    this._require();
    return Object.values(this.vault.data.dnas).filter((dna) => LIVE_STATUSES.has(dna.status)).length;
  }

  summarize(dna) {
    const spec = dna.council?.upgraded_spec || dna.council?.proposer_spec || null;
    const lastHistory = dna.history?.[dna.history.length - 1] || null;
    return {
      id: dna.id,
      status: dna.status,
      origin: dna.origin,
      generation: dna.generation,
      title: spec?.tool_name || dna.title,
      tagline: spec?.tagline || dna.signal?.tool_concept || '',
      pain_point: (dna.signal?.pain_point || '').slice(0, 400),
      source: dna.signal?.source || null,
      source_url: dna.signal?.url || null,
      urgency: dna.signal?.urgency ?? null,
      score: dna.council?.final_score ?? null,
      threshold: config.council.approvalThreshold,
      cost_usd: money(dna.token_usage?.cost_usd),
      total_tokens: dna.token_usage?.total_tokens || 0,
      telemetry_pings: dna.telemetry_pings || 0,
      unique_visitors: dna.telemetry?.unique_visitors || 0,
      heal_attempts: dna.forge?.heal_attempts ?? null,
      artifact_bytes: dna.forge?.bytes ?? null,
      deployment: dna.deployment
        ? {
            mode: dna.deployment.mode,
            url: dna.deployment.url,
            host_port: dna.deployment.host_port ?? null,
            container_name: dna.deployment.container_name ?? null,
            deployed_at: dna.deployment.deployed_at,
            expires_at: dna.deployment.expires_at,
          }
        : null,
      evaluation: dna.evaluation
        ? { verdict: dna.evaluation.verdict, evaluated_at: dna.evaluation.evaluated_at, pings_at_eval: dna.evaluation.pings_at_eval }
        : null,
      error: dna.error,
      last_note: lastHistory?.note || null,
      created_at: dna.created_at,
      updated_at: dna.updated_at,
    };
  }

  stats() {
    this._require();
    const dnas = Object.values(this.vault.data.dnas);
    const byStatus = {};
    for (const dna of dnas) byStatus[dna.status] = (byStatus[dna.status] || 0) + 1;
    const meta = this.vault.data.meta;
    const rules = this.rules.data;
    return {
      generation: rules.mutation_generation,
      total_cost_usd: money(meta.total_cost_usd),
      system_cost_usd: money(meta.system_cost_usd),
      budget_cap_usd: CIRCUIT_BREAKERS.MAX_TOTAL_BUDGET_USD,
      dna_total: dnas.length,
      active_apps: dnas.filter((dna) => LIVE_STATUSES.has(dna.status)).length,
      max_active: CIRCUIT_BREAKERS.MAX_ACTIVE_CONTAINERS,
      by_status: byStatus,
      graveyard_total: this.graveyard.data.entries.length,
      immortalized: rules.survival_stats.immortalized,
      terminated: rules.survival_stats.terminated,
      scout_runs: meta.scout_runs,
      last_scout_at: meta.last_scout_at,
    };
  }

  async flush() {
    if (!this.ready) return;
    await Promise.all([this.vault.flush(), this.graveyard.flush(), this.rules.flush()]);
  }
}

export const store = new EvolutionStore();
