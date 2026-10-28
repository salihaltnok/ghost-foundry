/**
 * Ghost Core v1.0 — Merkezi Konfigürasyon Modülü
 *
 * Tüm .env değişkenlerini okur, tip dönüşümü ve aralık doğrulaması yapar,
 * varsayılan değerleri atar ve sistem genelindeki güvenlik sigortası
 * (Circuit Breaker) sabitlerini dışa aktarır. Tüm nesneler dondurulmuştur.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(__dirname, '..', '..');

const ENV_PATH = resolve(ROOT_DIR, '.env');
if (existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH, quiet: true });
}

const warnings = [];

function raw(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : undefined;
}

function readString(name, fallback) {
  const value = raw(name);
  return value ? value : fallback;
}

function readBool(name, fallback) {
  const value = raw(name);
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on', 'evet'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'hayir', 'hayır'].includes(normalized)) return false;
  warnings.push(`${name}="${value}" geçerli bir boolean değil; varsayılan (${fallback}) kullanılıyor.`);
  return fallback;
}

function readNumber(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const value = raw(name);
  if (!value) return fallback;
  const parsed = integer ? Number.parseInt(value, 10) : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${name}="${value}" sayı değil; varsayılan (${fallback}) kullanılıyor.`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    const clamped = Math.min(max, Math.max(min, parsed));
    warnings.push(`${name}=${parsed} izin verilen aralığın [${min}, ${max}] dışında; ${clamped} kullanılıyor.`);
    return clamped;
  }
  return parsed;
}

const readInt = (name, fallback, opts = {}) => readNumber(name, fallback, { ...opts, integer: true });

function readList(name, fallback) {
  const value = raw(name);
  if (!value) return fallback;
  const list = value.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function readDir(name, fallback) {
  const value = readString(name, fallback);
  return isAbsolute(value) ? value : resolve(ROOT_DIR, value);
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

const PORT = readInt('PORT', 4040, { min: 1, max: 65535 });
const PLACEHOLDER_KEYS = new Set(['buraya_api_key_gelecek', 'your_api_key_here', 'changeme', 'sk-or-xxx', 'xxx']);
const apiKey = readString('OPENROUTER_API_KEY', '');
const proposerModel = readString('PROPOSER_MODEL', 'anthropic/claude-sonnet-5.5');

const dataDir = readDir('DATA_DIR', 'data');
const artifactsDir = readDir('ARTIFACTS_DIR', 'artifacts');
const logsDir = readDir('LOGS_DIR', 'logs');

export const config = deepFreeze({
  version: '1.0.0',
  env: readString('NODE_ENV', 'development'),
  port: PORT,
  host: readString('HOST', '127.0.0.1'),
  publicBaseUrl: readString('PUBLIC_BASE_URL', `http://localhost:${PORT}`).replace(/\/+$/, ''),
  controlToken: readString('CONTROL_TOKEN', ''),
  logLevel: readString('LOG_LEVEL', 'info'),

  openrouter: {
    apiKey,
    baseUrl: readString('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    appTitle: readString('OPENROUTER_APP_TITLE', 'Ghost Foundry'),
    // Katalogda fiyat bulunamazsa kullanılacak muhafazakâr fiyat (USD / 1M token)
    fallbackPromptPerMTok: readNumber('FALLBACK_PROMPT_PRICE_PER_MTOK', 3, { min: 0 }),
    fallbackCompletionPerMTok: readNumber('FALLBACK_COMPLETION_PRICE_PER_MTOK', 15, { min: 0 }),
  },

  models: {
    scout: readString('SCOUT_MODEL', 'google/gemini-2.5-flash'),
    proposer: proposerModel,
    critic: readString('CRITIC_MODEL', 'openai/gpt-5-mini'),
    arbitrator: readString('ARBITRATOR_MODEL', proposerModel),
    coder: readString('CODER_MODEL', 'anthropic/claude-sonnet-5.5'),
    mutation: readString('MUTATION_MODEL', proposerModel),
  },

  language: {
    agents: readString('OUTPUT_LANGUAGE', 'Turkish'),
    toolUi: readString('TOOL_UI_LANGUAGE', 'English'),
  },

  queue: {
    useInMemory: readBool('USE_IN_MEMORY_QUEUE', true),
    prefix: readString('QUEUE_PREFIX', 'ghost'),
    redis: {
      host: readString('REDIS_HOST', '127.0.0.1'),
      port: readInt('REDIS_PORT', 6379, { min: 1, max: 65535 }),
      password: readString('REDIS_PASSWORD', ''),
      db: readInt('REDIS_DB', 0, { min: 0, max: 15 }),
    },
  },

  docker: {
    dryRun: readBool('DRY_RUN_DOCKER', true),
    fallbackToDryRun: readBool('DOCKER_FALLBACK_TO_DRY_RUN', true),
    socketPath: readString('DOCKER_SOCKET_PATH', ''),
    image: readString('DOCKER_IMAGE', 'nginx:alpine'),
    bindHost: readString('DOCKER_BIND_HOST', '127.0.0.1'),
    publicHost: readString('DOCKER_PUBLIC_HOST', 'localhost'),
    healthcheckHost: readString('DOCKER_HEALTHCHECK_HOST', '127.0.0.1'),
    hostArtifactsDir: readString('HOST_ARTIFACTS_DIR', ''),
    memoryBytes: 128 * 1024 * 1024,
    nanoCpus: 200_000_000, // 0.2 CPU
  },

  council: {
    approvalThreshold: readInt('COUNCIL_APPROVAL_THRESHOLD', 85, { min: 0, max: 100 }),
    concurrency: readInt('COUNCIL_CONCURRENCY', 2, { min: 1, max: 10 }),
  },

  forge: {
    coderMaxTokens: readInt('CODER_MAX_TOKENS', 12000, { min: 2000, max: 64000 }),
    concurrency: readInt('FORGE_CONCURRENCY', 1, { min: 1, max: 5 }),
  },

  scout: {
    autoIntervalMs: readInt('AUTO_SCOUT_INTERVAL_MS', 0, { min: 0 }),
    maxSignalsPerRun: readInt('SCOUT_MAX_SIGNALS_PER_RUN', 3, { min: 1, max: 10 }),
    minUrgency: readInt('SCOUT_MIN_URGENCY', 60, { min: 0, max: 100 }),
    hnLimit: readInt('SCOUT_HN_LIMIT', 20, { min: 1, max: 60 }),
    redditSubs: readList('SCOUT_REDDIT_SUBS', ['webdev', 'programming', 'sysadmin', 'devops', 'productivity', 'freelance']),
    githubToken: readString('GITHUB_TOKEN', ''),
  },

  evolution: {
    defaultTtlMs: readInt('DEFAULT_TTL_MS', 300_000, { min: 10_000 }),
    survivalPingThreshold: readInt('SURVIVAL_PING_THRESHOLD', 5, { min: 0 }),
  },

  paths: {
    root: ROOT_DIR,
    data: dataDir,
    artifacts: artifactsDir,
    logs: logsDir,
    public: resolve(ROOT_DIR, 'public'),
    graveyardArtifacts: resolve(dataDir, 'graveyard-artifacts'),
  },
});

/**
 * Güvenlik sigortaları: bütçe, yeniden deneme, kota ve sandbox sınırları.
 * Bu değerler aşıldığında ilgili organ görevi güvenli şekilde durdurur.
 */
export const CIRCUIT_BREAKERS = deepFreeze({
  MAX_BUDGET_PER_DNA_USD: readNumber('MAX_BUDGET_PER_DNA_USD', 0.5, { min: 0.001, max: 1000 }),
  MAX_TOTAL_BUDGET_USD: readNumber('MAX_TOTAL_BUDGET_USD', 10, { min: 0.001, max: 1_000_000 }),
  MAX_SELF_HEAL_RETRIES: readInt('MAX_SELF_HEAL_RETRIES', 3, { min: 0, max: 10 }),
  MAX_ACTIVE_CONTAINERS: readInt('MAX_ACTIVE_CONTAINERS', 10, { min: 1, max: 500 }),
  MAX_DEPLOY_WAIT_ATTEMPTS: readInt('MAX_DEPLOY_WAIT_ATTEMPTS', 30, { min: 0, max: 10_000 }),
  DEPLOY_WAIT_INTERVAL_MS: readInt('DEPLOY_WAIT_INTERVAL_MS', 60_000, { min: 1_000 }),
  LLM_MAX_RETRIES: readInt('LLM_MAX_RETRIES', 3, { min: 0, max: 8 }),
  LLM_TIMEOUT_MS: readInt('LLM_TIMEOUT_MS', 240_000, { min: 10_000, max: 900_000 }),
  MIN_COMPLETION_TOKENS: 256,
  MAX_HTML_BYTES: 512 * 1024,
  SANDBOX_STEP_TIMEOUT_MS: 1_000,
  SANDBOX_TOTAL_TIMEOUT_MS: 20_000,
  SANDBOX_MEMORY_MB: 128,
  TELEMETRY_RATE_LIMIT_PER_MINUTE: readInt('TELEMETRY_RATE_LIMIT_PER_MINUTE', 60, { min: 1, max: 100_000 }),
});

export function hasValidApiKey() {
  return Boolean(apiKey) && apiKey.length >= 10 && !PLACEHOLDER_KEYS.has(apiKey.toLowerCase());
}

export function getConfigWarnings() {
  const list = [...warnings];
  if (!hasValidApiKey()) {
    list.push('OPENROUTER_API_KEY tanımlı değil: Gözcü analizi, Konsey, Forge ve LLM tabanlı mutasyon çalışmaz. .env dosyasına gerçek anahtarı girin.');
  }
  if (config.controlToken === '' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    list.push(`HOST=${config.host} ile kontrol API'si ağa açık ve CONTROL_TOKEN boş. Bir jeton tanımlamanız önerilir.`);
  }
  return list;
}

/** Panel ve /api/state için gizli bilgi içermeyen konfigürasyon özeti. */
export function publicConfig() {
  return {
    version: config.version,
    public_base_url: config.publicBaseUrl,
    models: { ...config.models },
    language: { ...config.language },
    queue_mode_requested: config.queue.useInMemory ? 'memory' : 'bullmq',
    dry_run_docker: config.docker.dryRun,
    docker_image: config.docker.image,
    approval_threshold: config.council.approvalThreshold,
    default_ttl_ms: config.evolution.defaultTtlMs,
    survival_ping_threshold: config.evolution.survivalPingThreshold,
    auto_scout_interval_ms: config.scout.autoIntervalMs,
    control_token_required: Boolean(config.controlToken),
    api_key_configured: hasValidApiKey(),
    circuit_breakers: {
      max_budget_per_dna_usd: CIRCUIT_BREAKERS.MAX_BUDGET_PER_DNA_USD,
      max_total_budget_usd: CIRCUIT_BREAKERS.MAX_TOTAL_BUDGET_USD,
      max_self_heal_retries: CIRCUIT_BREAKERS.MAX_SELF_HEAL_RETRIES,
      max_active_containers: CIRCUIT_BREAKERS.MAX_ACTIVE_CONTAINERS,
    },
  };
}
