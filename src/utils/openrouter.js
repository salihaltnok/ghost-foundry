/**
 * Ghost Core v1.0 — OpenRouter İstemcisi
 *
 * - Her çağrının token kullanımını ve USD maliyetini hesaplar, DNA'nın
 *   token_usage alanına (veya sistem defterine) yazar.
 * - Çağrıdan önce bütçe planlar (max_tokens'ı kalan bütçeye göre kısar);
 *   MAX_BUDGET_PER_DNA_USD / MAX_TOTAL_BUDGET_USD aşılırsa
 *   BudgetCircuitBreakerError fırlatır.
 * - Geçici hatalarda (429/5xx/ağ) üstel geri çekilme ile yeniden dener.
 * - JSON bekleyen çağrılarda markdown çitlerini temizler, bozuk JSON'u
 *   yerel olarak onarır, olmazsa tek bir LLM onarım turu yapar.
 */
import { config, CIRCUIT_BREAKERS, hasValidApiKey } from '../config/index.js';
import { store } from '../memory/evolution-store.js';
import { organLogger } from './logger.js';

const log = organLogger('openrouter');

export class BudgetCircuitBreakerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BudgetCircuitBreakerError';
    this.code = 'BUDGET_CIRCUIT_BREAKER';
    this.details = details;
  }
}

export class LLMRequestError extends Error {
  constructor(message, { status = null, retryable = false, retryAfterMs = null, configError = false } = {}) {
    super(message);
    this.name = 'LLMRequestError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    // Yapılandırma hatası (geçersiz/emekli model, anahtar, kredi): fikrin kendisiyle ilgisi yok.
    this.configError = configError;
  }
}

/** Hata, fikrin başarısızlığı değil de yapılandırma sorunu mu? (DNA gömülmez, park edilir) */
export function isConfigError(err) {
  return Boolean(err && err.configError);
}

function looksLikeConfigError(status, message) {
  if ([401, 402, 403, 404].includes(Number(status))) return true;
  return Number(status) === 400 && /model|api key|credit/i.test(String(message));
}

export class AgentOutputError extends Error {
  constructor(message, { raw = '' } = {}) {
    super(message);
    this.name = 'AgentOutputError';
    this.raw = raw;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MODEL_RETRY_AFTER_FAIL_MS = 5 * 60 * 1000;
const FALLBACK_PRICING = Object.freeze({
  prompt: config.openrouter.fallbackPromptPerMTok / 1e6,
  completion: config.openrouter.fallbackCompletionPerMTok / 1e6,
});

const modelCache = { fetchedAt: 0, failedAt: 0, models: new Map(), inflight: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'HTTP-Referer': config.publicBaseUrl,
    'X-Title': config.openrouter.appTitle,
  };
  if (hasValidApiKey()) headers.Authorization = `Bearer ${config.openrouter.apiKey}`;
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(60_000, Math.max(0, date - Date.now())) : null;
}

// ─── Model kataloğu (fiyat + maksimum çıktı) ─────────────────────────

async function loadModelCatalog(force = false) {
  const fresh = Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS && modelCache.models.size > 0;
  if (!force && fresh) return modelCache.models;
  if (!force && modelCache.failedAt && Date.now() - modelCache.failedAt < MODEL_RETRY_AFTER_FAIL_MS) return modelCache.models;
  if (modelCache.inflight) return modelCache.inflight;
  modelCache.inflight = (async () => {
    try {
      const res = await fetchWithTimeout(`${config.openrouter.baseUrl}/models`, { headers: baseHeaders() }, 20_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const map = new Map();
      for (const model of body?.data || []) {
        if (!model?.id) continue;
        const prompt = Number.parseFloat(model?.pricing?.prompt);
        const completion = Number.parseFloat(model?.pricing?.completion);
        map.set(model.id, {
          id: model.id,
          contextLength: Number(model.context_length) || null,
          maxCompletionTokens: Number(model?.top_provider?.max_completion_tokens) || null,
          pricing:
            Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0 ? { prompt, completion } : null,
          supportedParameters: Array.isArray(model.supported_parameters) ? model.supported_parameters : null,
        });
      }
      modelCache.models = map;
      modelCache.fetchedAt = Date.now();
      modelCache.failedAt = 0;
      return map;
    } catch (err) {
      modelCache.failedAt = Date.now();
      log.warn(`OpenRouter model kataloğu alınamadı (${err.message}); yedek fiyatlandırma kullanılacak.`);
      return modelCache.models;
    } finally {
      modelCache.inflight = null;
    }
  })();
  return modelCache.inflight;
}

async function getModelInfo(model) {
  const catalog = await loadModelCatalog();
  return catalog.get(model) || null;
}

/** Konfigüre edilen modellerin OpenRouter kataloğunda olup olmadığını denetler. */
export async function validateModels(models) {
  const catalog = await loadModelCatalog(true);
  if (!catalog.size) return { catalogAvailable: false, missing: [] };
  const unique = [...new Set(models.filter(Boolean))];
  return { catalogAvailable: true, missing: unique.filter((id) => !catalog.has(id)) };
}

// ─── Bütçe planlama ─────────────────────────────────────────────────

function estimateTokens(messages) {
  let chars = 0;
  for (const message of messages) chars += String(message.content ?? '').length + 16;
  return Math.ceil(chars / 3.2);
}

async function planBudget({ dnaId, capUsd, model, messages, maxTokens, agent }) {
  const totalCap = CIRCUIT_BREAKERS.MAX_TOTAL_BUDGET_USD;
  const totalSpent = store.getTotalCost();
  if (totalSpent >= totalCap) {
    throw new BudgetCircuitBreakerError(`Küresel bütçe sigortası attı: $${totalSpent.toFixed(4)} ≥ $${totalCap}`, {
      scope: 'global',
      spent: totalSpent,
      cap: totalCap,
      agent,
      dnaId,
    });
  }
  const cap = capUsd ?? CIRCUIT_BREAKERS.MAX_BUDGET_PER_DNA_USD;
  const spent = dnaId ? store.getDnaCost(dnaId) : 0;
  const remaining = Math.min(cap - spent, totalCap - totalSpent);
  if (remaining <= 0) {
    throw new BudgetCircuitBreakerError(`DNA bütçe sigortası attı: $${spent.toFixed(4)} ≥ $${cap}`, {
      scope: dnaId ? 'dna' : 'call',
      spent,
      cap,
      agent,
      dnaId,
    });
  }
  const info = await getModelInfo(model);
  const pricing = info?.pricing || FALLBACK_PRICING;
  const estPromptTokens = estimateTokens(messages);
  const estPromptCost = estPromptTokens * pricing.prompt;
  if (estPromptCost >= remaining) {
    throw new BudgetCircuitBreakerError(
      `Tahmini istem maliyeti ($${estPromptCost.toFixed(4)}) kalan bütçeyi ($${remaining.toFixed(4)}) aşıyor`,
      { scope: dnaId ? 'dna' : 'call', spent, cap, agent, dnaId },
    );
  }
  let allowed = maxTokens;
  if (pricing.completion > 0) allowed = Math.min(allowed, Math.floor((remaining - estPromptCost) / pricing.completion));
  if (info?.maxCompletionTokens) allowed = Math.min(allowed, info.maxCompletionTokens);
  if (allowed < CIRCUIT_BREAKERS.MIN_COMPLETION_TOKENS) {
    throw new BudgetCircuitBreakerError(
      `Kalan bütçe yalnızca ~${Math.max(0, allowed)} çıktı token'ına yetiyor (minimum ${CIRCUIT_BREAKERS.MIN_COMPLETION_TOKENS})`,
      { scope: dnaId ? 'dna' : 'call', spent, cap, agent, dnaId },
    );
  }
  return { maxTokens: allowed, pricing, pricingSource: info?.pricing ? 'catalog' : 'fallback', estPromptTokens, info };
}

function computeCost(usage, pricing) {
  if (usage && usage.cost !== undefined && usage.cost !== null && Number.isFinite(Number(usage.cost))) return Number(usage.cost);
  const prompt = Number(usage?.prompt_tokens) || 0;
  const completion = Number(usage?.completion_tokens) || 0;
  return prompt * pricing.prompt + completion * pricing.completion;
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('');
  }
  return '';
}

function supportsParam(info, param) {
  if (!info?.supportedParameters) return null;
  return info.supportedParameters.includes(param);
}

function looksLikeReasoningModel(model) {
  return /(^|\/)(o1|o3|o4)(-|$)/i.test(model);
}

// ─── HTTP çağrısı ───────────────────────────────────────────────────

async function requestCompletion(body, { agent, dnaId, onUsage }) {
  const maxRetries = CIRCUIT_BREAKERS.LLM_MAX_RETRIES;
  const timeoutMs = CIRCUIT_BREAKERS.LLM_TIMEOUT_MS;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(
        `${config.openrouter.baseUrl}/chat/completions`,
        { method: 'POST', headers: baseHeaders(), body: JSON.stringify(body) },
        timeoutMs,
      );
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const message = json?.error?.message || text.slice(0, 300) || res.statusText;
        throw new LLMRequestError(`OpenRouter HTTP ${res.status}: ${message}`, {
          status: res.status,
          retryable: RETRYABLE_STATUS.has(res.status),
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
          configError: looksLikeConfigError(res.status, message),
        });
      }
      if (!json) throw new LLMRequestError('OpenRouter geçersiz (JSON olmayan) yanıt döndürdü', { retryable: true });
      if (json.error) {
        const code = Number(json.error.code) || null;
        const message = json.error.message || JSON.stringify(json.error);
        throw new LLMRequestError(`OpenRouter hatası: ${message}`, {
          status: code,
          retryable: code ? RETRYABLE_STATUS.has(code) : true,
          configError: looksLikeConfigError(code, message),
        });
      }
      const choice = json.choices?.[0];
      const content = normalizeContent(choice?.message?.content);
      const finishReason = choice?.finish_reason || choice?.native_finish_reason || null;
      if (!content.trim()) {
        if (json.usage) await onUsage(json.usage, finishReason, false);
        throw new LLMRequestError(`Boş model yanıtı (finish_reason=${finishReason ?? 'yok'})`, { retryable: true });
      }
      return { json, content, finishReason };
    } catch (err) {
      const error =
        err instanceof LLMRequestError
          ? err
          : new LLMRequestError(
              err?.name === 'AbortError'
                ? `OpenRouter ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi`
                : `Ağ hatası: ${err?.message || err}`,
              { retryable: true },
            );
      lastError = error;
      if (!error.retryable || attempt === maxRetries) throw error;
      const backoff = error.retryAfterMs ?? Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 400);
      log.warn(`${agent} çağrısı başarısız (deneme ${attempt + 1}/${maxRetries + 1}): ${error.message} — ${backoff}ms sonra tekrar`, {
        dna_id: dnaId,
      });
      await sleep(backoff);
    }
  }
  throw lastError;
}

/**
 * Serbest metin çağrısı.
 * @returns {{ text: string, finishReason: string|null, usage: object, model: string }}
 */
export async function callAgentText({
  agent,
  model,
  system = null,
  messages = [],
  user = null,
  dnaId = null,
  capUsd = undefined,
  maxTokens = 4096,
  temperature = 0.7,
  jsonMode = false,
}) {
  if (!hasValidApiKey()) {
    throw new LLMRequestError('OPENROUTER_API_KEY tanımlı değil — .env dosyasına geçerli bir anahtar girin.', { retryable: false, configError: true });
  }
  if (!model) throw new LLMRequestError(`${agent} için model tanımlı değil.`, { retryable: false, configError: true });

  const fullMessages = [];
  if (system) fullMessages.push({ role: 'system', content: system });
  for (const message of messages) fullMessages.push({ role: message.role, content: String(message.content ?? '') });
  if (user) fullMessages.push({ role: 'user', content: user });

  const plan = await planBudget({ dnaId, capUsd, model, messages: fullMessages, maxTokens, agent });
  const body = { model, messages: fullMessages, max_tokens: plan.maxTokens, usage: { include: true } };

  const temperatureSupport = supportsParam(plan.info, 'temperature');
  const sendTemperature = temperatureSupport === null ? !looksLikeReasoningModel(model) : temperatureSupport;
  if (temperature !== null && temperature !== undefined && sendTemperature) body.temperature = temperature;
  if (jsonMode && supportsParam(plan.info, 'response_format') === true) body.response_format = { type: 'json_object' };

  const started = Date.now();
  const record = async (usage, finishReason, ok) => {
    const promptTokens = Number(usage?.prompt_tokens) || 0;
    const completionTokens = Number(usage?.completion_tokens) || 0;
    const entry = {
      agent,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage?.total_tokens) || promptTokens + completionTokens,
      cost_usd: computeCost(usage, plan.pricing),
      pricing_source: usage?.cost !== undefined && usage?.cost !== null ? 'openrouter' : usage?.estimated ? 'estimate' : plan.pricingSource,
      finish_reason: finishReason,
      ok,
      latency_ms: Date.now() - started,
      at: new Date().toISOString(),
    };
    if (dnaId) await store.recordUsage(dnaId, entry);
    else await store.recordSystemUsage(entry);
    return entry;
  };

  const result = await requestCompletion(body, { agent, dnaId, onUsage: record });
  const usage = result.json.usage || {
    prompt_tokens: plan.estPromptTokens,
    completion_tokens: Math.ceil(result.content.length / 3.2),
    estimated: true,
  };
  const entry = await record(usage, result.finishReason, true);

  const cap = capUsd ?? CIRCUIT_BREAKERS.MAX_BUDGET_PER_DNA_USD;
  if (dnaId) {
    const spent = store.getDnaCost(dnaId);
    if (spent > cap) {
      throw new BudgetCircuitBreakerError(`DNA bütçe sigortası attı: $${spent.toFixed(4)} > $${cap} (${agent})`, {
        scope: 'dna',
        spent,
        cap,
        agent,
        dnaId,
      });
    }
  } else if (entry.cost_usd > cap) {
    log.warn(`${agent} sistem çağrısı tek çağrı tavanını aştı: $${entry.cost_usd.toFixed(4)} > $${cap}`);
  }
  const totalSpent = store.getTotalCost();
  if (totalSpent > CIRCUIT_BREAKERS.MAX_TOTAL_BUDGET_USD) {
    throw new BudgetCircuitBreakerError(
      `Küresel bütçe sigortası attı: $${totalSpent.toFixed(4)} > $${CIRCUIT_BREAKERS.MAX_TOTAL_BUDGET_USD}`,
      { scope: 'global', spent: totalSpent, cap: CIRCUIT_BREAKERS.MAX_TOTAL_BUDGET_USD, agent, dnaId },
    );
  }

  return { text: result.content, finishReason: result.finishReason, usage: entry, model: result.json.model || model };
}

// ─── Dayanıklı JSON ayrıştırıcı ─────────────────────────────────────

function extractBalanced(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const LITERAL_FIXES = { True: 'true', False: 'false', None: 'null', undefined: 'null', NaN: 'null', Infinity: 'null' };

/** Yaygın LLM JSON bozulmalarını onarır: yorumlar, sondaki virgüller, kaçışsız satır sonları, kesilmiş çıktı. */
export function repairJson(source) {
  if (!source) throw new Error('JSON adayı bulunamadı');
  const start = source.search(/[[{]/);
  const src = start === -1 ? source : source.slice(start);
  let out = '';
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      else out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && src[i + 1] === '/') {
      const newline = src.indexOf('\n', i);
      i = newline === -1 ? src.length : newline - 1;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      out += ch;
    } else if (ch === '}' || ch === ']') {
      out = out.replace(/,\s*$/, '');
      if (stack.length && stack[stack.length - 1] === ch) stack.pop();
      out += ch;
      if (stack.length === 0) break;
    } else if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_]+/.exec(src.slice(i))[0];
      out += LITERAL_FIXES[word] ?? word;
      i += word.length - 1;
    } else {
      out += ch;
    }
  }
  if (inString) {
    if (escaped) out = out.slice(0, -1);
    out += '"';
  }
  // Kesilmiş çıktıda değeri olmayan sarkık anahtarı at: {"a":1,"b"  →  {"a":1
  if (stack.length && stack[stack.length - 1] === '}') {
    const dangling = /([{,])\s*"(?:[^"\\]|\\.)*"\s*$/.exec(out);
    if (dangling) out = out.slice(0, dangling.index + (dangling[1] === '{' ? 1 : 0));
  }
  out = out.replace(/:\s*$/, ': null').replace(/,\s*$/, '');
  while (stack.length) {
    out = out.replace(/,\s*$/, '');
    out += stack.pop();
  }
  return out;
}

/** Markdown çitli, önsözlü veya bozuk JSON metnini ayrıştırır. */
export function parseJsonLoose(input) {
  if (typeof input !== 'string') throw new Error('Girdi metin değil');
  let text = input.replace(/^﻿/, '').trim();
  try {
    return { value: JSON.parse(text), repaired: false };
  } catch {
    // devam
  }
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    try {
      return { value: JSON.parse(text), repaired: true };
    } catch {
      // devam
    }
  }
  const fence = text.match(/```(?:json|JSON|javascript|js)?\s*([\s\S]*?)```/);
  if (fence && fence[1].trim()) {
    try {
      return { value: JSON.parse(fence[1].trim()), repaired: true };
    } catch {
      text = fence[1].trim();
    }
  }
  const balanced = extractBalanced(text);
  if (balanced) {
    try {
      return { value: JSON.parse(balanced), repaired: true };
    } catch {
      // devam
    }
  }
  return { value: JSON.parse(repairJson(balanced || text)), repaired: true };
}

function tryParse(text, validate) {
  let parsed;
  try {
    parsed = parseJsonLoose(text);
  } catch (err) {
    return { ok: false, error: `JSON ayrıştırılamadı: ${err.message}` };
  }
  if (!parsed.value || typeof parsed.value !== 'object') return { ok: false, error: 'Kök değer bir nesne/dizi değil' };
  if (validate) {
    let verdict;
    try {
      verdict = validate(parsed.value);
    } catch (err) {
      verdict = err.message;
    }
    if (verdict !== true && verdict !== undefined) {
      return { ok: false, error: typeof verdict === 'string' ? verdict : 'Şema doğrulaması başarısız' };
    }
  }
  return { ok: true, value: parsed.value, repaired: parsed.repaired };
}

function sumUsage(entries) {
  return entries.filter(Boolean).reduce(
    (acc, entry) => ({
      prompt_tokens: acc.prompt_tokens + (entry.prompt_tokens || 0),
      completion_tokens: acc.completion_tokens + (entry.completion_tokens || 0),
      total_tokens: acc.total_tokens + (entry.total_tokens || 0),
      cost_usd: acc.cost_usd + (entry.cost_usd || 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 },
  );
}

/**
 * JSON döndürmesi beklenen ajan çağrısı.
 * @param {object} opts callAgentText seçenekleri + validate(value) → true | hata metni, schemaHint
 * @returns {{ data: object, raw: string, usage: object, repaired: boolean }}
 */
export async function callAgentJSON({ validate = null, schemaHint = '', ...opts }) {
  const first = await callAgentText({ ...opts, jsonMode: true, temperature: opts.temperature ?? 0.4 });
  const usages = [first.usage];
  if (first.finishReason === 'length') {
    log.warn(`${opts.agent} çıktısı token sınırında kesildi (max ${opts.maxTokens}); JSON onarımı devreye giriyor, bazı alanlar eksik kalabilir.`, { dna_id: opts.dnaId });
  }
  let parsed = tryParse(first.text, validate);
  if (parsed.ok) return { data: parsed.value, raw: first.text, usage: sumUsage(usages), repaired: parsed.repaired };

  log.warn(`${opts.agent} geçersiz JSON üretti (${parsed.error}); onarım turu başlatılıyor.`, { dna_id: opts.dnaId });
  const repair = await callAgentText({
    agent: `${opts.agent}:json-repair`,
    model: opts.model,
    dnaId: opts.dnaId,
    capUsd: opts.capUsd,
    maxTokens: opts.maxTokens,
    temperature: 0,
    jsonMode: true,
    system: 'You are a strict JSON repair tool. Return ONLY one valid JSON object. No markdown fences, no commentary.',
    user: [
      `The following output was supposed to be a single JSON object${schemaHint ? ` with this shape:\n${schemaHint}` : '.'}`,
      `Problem detected: ${parsed.error}`,
      'Rewrite it as valid JSON that satisfies the shape, keeping all of its meaningful content.',
      '',
      '<<<OUTPUT',
      first.text.slice(0, 60_000),
      'OUTPUT>>>',
    ].join('\n'),
  });
  usages.push(repair.usage);
  parsed = tryParse(repair.text, validate);
  if (parsed.ok) return { data: parsed.value, raw: repair.text, usage: sumUsage(usages), repaired: true };
  throw new AgentOutputError(`${opts.agent} geçerli JSON üretemedi: ${parsed.error}`, { raw: first.text.slice(0, 2000) });
}
