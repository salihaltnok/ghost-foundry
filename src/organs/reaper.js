/**
 * ORGAN 5 — Darwinci Evrim Motoru & Self-Mutation
 *
 * TTL dolduğunda (veya panelden "Darwin Testi" ile hemen) bir aracın gerçek
 * kullanıcı etkileşimini (telemetry_pings) ölçer:
 *   - Kill-Switch: ping < SURVIVAL_PING_THRESHOLD → konteyner durdurulup silinir,
 *     DNA TERMINATED olur, otopsi raporu mezarlığa yazılır.
 *   - Aksi halde IMMORTALIZED (Ölümsüz) ilan edilir ve yayında kalır.
 * Ardından yaşayan ve ölen araçların özelliklerini LLM ile analiz edip
 * evolutionary_rules.json genomunu yeniden yazar (mutation_generation +1).
 */
import { config, CIRCUIT_BREAKERS, hasValidApiKey } from '../config/index.js';
import { store, DNA_STATUS, LIVE_STATUSES } from '../memory/evolution-store.js';
import { queues, STAGES } from '../queues/queue-manager.js';
import { callAgentJSON } from '../utils/openrouter.js';
import { organLogger, emitDebateMessage, emitAgentThinking } from '../utils/logger.js';
import { stopApp, archiveArtifact } from './deployer.js';

const log = organLogger('reaper');

const LIMITS = { preferred_patterns: 10, banned_ideas: 12, ui_guidelines: 10, learned_insights: 10 };
const MAX_RULE_LENGTH = 280;

export class ReaperStateError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = 'ReaperStateError';
    this.statusCode = statusCode;
  }
}

function sanitizeRuleList(value, fallback, limit) {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim().slice(0, MAX_RULE_LENGTH);
    const key = text.toLowerCase();
    if (text.length < 6 || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out.length ? out : fallback;
}

function describeTool(dna) {
  const spec = dna.council?.upgraded_spec || dna.council?.proposer_spec || {};
  return {
    title: spec.tool_name || dna.title,
    tagline: spec.tagline || dna.signal?.tool_concept || '',
    pain_point: (dna.signal?.pain_point || '').slice(0, 300),
    source: dna.signal?.source,
    core_features: Array.isArray(spec.core_features) ? spec.core_features.slice(0, 6) : [],
    council_score: dna.council?.final_score ?? null,
    heal_attempts: dna.forge?.heal_attempts ?? null,
    telemetry_pings: dna.telemetry_pings,
    unique_visitors: dna.telemetry?.unique_visitors ?? 0,
    events: dna.telemetry?.events || {},
    generation: dna.generation,
  };
}

function gatherEvolutionContext(currentId) {
  const all = store.listDnas();
  const survivors = all
    .filter((dna) => dna.status === DNA_STATUS.IMMORTALIZED && dna.id !== currentId)
    .slice(0, 8)
    .map(describeTool);
  const dead = store
    .getGraveyard(30)
    .filter((entry) => entry.dna_id !== currentId)
    .slice(0, 12)
    .map((entry) => ({
      title: entry.title,
      concept: entry.tool_concept,
      cause: entry.cause,
      council_score: entry.score,
      telemetry_pings: entry.telemetry_pings,
      summary: (entry.summary || '').slice(0, 200),
    }));
  return { survivors, dead };
}

function mutationPrompt() {
  return `You are the DARWINIAN MUTATION ENGINE of "The Foundry". After every life-or-death evaluation you rewrite the system's genome (evolutionary_rules.json), which steers the Scout, the Council and the Forge in the next generation.

Inputs: the tool that was just evaluated (with real telemetry), recent survivors (IMMORTALIZED), recent deaths (TERMINATED, rejected or failed) and the current genome.

Rules:
- Base every conclusion ONLY on evidence in the data (telemetry counts and event types, council scores, causes of death). Never invent statistics.
- Keep what works, prune what the evidence contradicts, add sharp new rules. Each rule is one specific, actionable sentence.
- Limits: preferred_patterns ≤ ${LIMITS.preferred_patterns}, banned_ideas ≤ ${LIMITS.banned_ideas}, ui_guidelines ≤ ${LIMITS.ui_guidelines}, learned_insights ≤ ${LIMITS.learned_insights}.
- Do not ban a whole category because of a single weak data point; record uncertain lessons as learned_insights instead.
- Keep the hard constraints intact: single-file, zero-backend browser tools.

Return ONLY a JSON object:
{"autopsy":"2-4 sentences on why THIS tool lived or died","preferred_patterns":["..."],"banned_ideas":["..."],"ui_guidelines":["..."],"learned_insights":["..."],"mutation_summary":"1-3 sentences: what changed in the genome and why"}
Write all human-readable values in ${config.language.agents}.`;
}

function heuristicMutation(rules, dna, survived) {
  const tool = describeTool(dna);
  const concept = `${tool.title}: ${tool.tagline}`.slice(0, 200);
  const next = {
    preferred_patterns: [...rules.preferred_patterns],
    banned_ideas: [...rules.banned_ideas],
    ui_guidelines: [...rules.ui_guidelines],
    learned_insights: [...rules.learned_insights],
  };
  if (survived) {
    next.preferred_patterns = [`Kanıtlanmış ilgi (${tool.telemetry_pings} ping): ${concept}`, ...next.preferred_patterns].slice(0, LIMITS.preferred_patterns);
  } else {
    next.learned_insights = [`Düşük etkileşim (${tool.telemetry_pings} ping) — benzerlerinden kaçın: ${concept}`, ...next.learned_insights].slice(0, LIMITS.learned_insights);
  }
  return {
    ...next,
    autopsy: survived
      ? `${tool.title} TTL boyunca ${tool.telemetry_pings} etkileşim alarak eşiği (${config.evolution.survivalPingThreshold}) geçti.`
      : `${tool.title} TTL boyunca yalnızca ${tool.telemetry_pings} etkileşim aldı; eşik ${config.evolution.survivalPingThreshold}. Kullanıcı ilgisi yakalanamadı.`,
    mutation_summary: survived ? 'Hayatta kalan konsept tercih edilen paternlere eklendi (sezgisel mutasyon).' : 'Ölen konsept içgörü olarak kaydedildi (sezgisel mutasyon).',
    engine: 'heuristic',
  };
}

async function llmMutation(rules, dna, survived) {
  const context = gatherEvolutionContext(dna.id);
  const payload = {
    evaluated_tool: { ...describeTool(dna), verdict: survived ? 'IMMORTALIZED' : 'TERMINATED', survival_threshold: config.evolution.survivalPingThreshold },
    recent_survivors: context.survivors,
    recent_deaths: context.dead,
    current_genome: {
      generation: rules.mutation_generation,
      preferred_patterns: rules.preferred_patterns,
      banned_ideas: rules.banned_ideas,
      ui_guidelines: rules.ui_guidelines,
      learned_insights: rules.learned_insights,
    },
  };
  const { data, usage } = await callAgentJSON({
    agent: 'reaper-mutation',
    model: config.models.mutation,
    dnaId: null,
    capUsd: CIRCUIT_BREAKERS.MAX_BUDGET_PER_DNA_USD,
    maxTokens: 5000,
    temperature: 0.4,
    system: mutationPrompt(),
    user: JSON.stringify(payload, null, 2),
    schemaHint: '{"autopsy":"","preferred_patterns":[],"banned_ideas":[],"ui_guidelines":[],"learned_insights":[],"mutation_summary":""}',
    validate: (value) => (value && typeof value === 'object' && Array.isArray(value.preferred_patterns) ? true : '"preferred_patterns" dizisi eksik'),
  });
  return {
    preferred_patterns: sanitizeRuleList(data.preferred_patterns, rules.preferred_patterns, LIMITS.preferred_patterns),
    banned_ideas: sanitizeRuleList(data.banned_ideas, rules.banned_ideas, LIMITS.banned_ideas),
    ui_guidelines: sanitizeRuleList(data.ui_guidelines, rules.ui_guidelines, LIMITS.ui_guidelines),
    learned_insights: sanitizeRuleList(data.learned_insights, rules.learned_insights, LIMITS.learned_insights),
    autopsy: String(data.autopsy || '').slice(0, 2000),
    mutation_summary: String(data.mutation_summary || '').slice(0, 1000),
    engine: 'llm',
    cost_usd: usage.cost_usd,
  };
}

function diffRules(before, after) {
  const lines = [];
  for (const key of Object.keys(LIMITS)) {
    const added = after[key].filter((rule) => !before[key].includes(rule));
    const removed = before[key].filter((rule) => !after[key].includes(rule));
    for (const rule of added) lines.push(`+ [${key}] ${rule}`);
    for (const rule of removed) lines.push(`- [${key}] ${rule}`);
  }
  return lines;
}

async function mutateGenome(dna, survived) {
  const rules = store.getRules();
  let mutation;
  if (hasValidApiKey()) {
    emitAgentThinking({ dnaId: dna.id, role: 'reaper', active: true, label: 'Genom yeniden yazılıyor' });
    try {
      mutation = await llmMutation(rules, dna, survived);
    } catch (err) {
      log.warn(`LLM mutasyonu başarısız (${err.message}); sezgisel mutasyon uygulanıyor.`, { dna_id: dna.id });
      mutation = heuristicMutation(rules, dna, survived);
    } finally {
      emitAgentThinking({ dnaId: dna.id, role: 'reaper', active: false });
    }
  } else {
    mutation = heuristicMutation(rules, dna, survived);
  }

  const generation = rules.mutation_generation + 1;
  const next = {
    ...rules,
    preferred_patterns: mutation.preferred_patterns,
    banned_ideas: mutation.banned_ideas,
    ui_guidelines: mutation.ui_guidelines,
    learned_insights: mutation.learned_insights,
    mutation_generation: generation,
    survival_stats: {
      immortalized: rules.survival_stats.immortalized + (survived ? 1 : 0),
      terminated: rules.survival_stats.terminated + (survived ? 0 : 1),
    },
    mutation_log: [
      {
        generation,
        at: new Date().toISOString(),
        trigger_dna: dna.id,
        trigger_title: describeTool(dna).title,
        verdict: survived ? 'IMMORTALIZED' : 'TERMINATED',
        telemetry_pings: dna.telemetry_pings,
        threshold: config.evolution.survivalPingThreshold,
        summary: mutation.mutation_summary,
        engine: mutation.engine,
        cost_usd: mutation.cost_usd ?? 0,
      },
      ...rules.mutation_log,
    ],
  };
  const saved = await store.replaceRules(next);
  return { mutation, rules: saved, diff: diffRules(rules, saved) };
}

/**
 * Darwin testi: hayatta kalma kararı + genetik mutasyon.
 * @param {string} dnaId
 * @param {{manual?: boolean}} opts
 */
export async function runReaper(dnaId, { manual = false } = {}) {
  const current = store.getDna(dnaId);
  if (!current) {
    log.warn(`Reaper: DNA bulunamadı (${dnaId}).`);
    return { skipped: true };
  }
  if (![DNA_STATUS.DEPLOYED, DNA_STATUS.EVALUATING].includes(current.status)) {
    log.info(`Reaper: DNA ${current.status} durumunda; değerlendirme atlandı.`, { dna_id: dnaId });
    return { skipped: true };
  }

  const threshold = config.evolution.survivalPingThreshold;
  await store.setStatus(dnaId, DNA_STATUS.EVALUATING, manual ? 'Manuel Darwin testi başladı' : 'TTL doldu — Darwin testi başladı');
  const toolName = current.council?.upgraded_spec?.tool_name || current.title;
  emitDebateMessage({
    dnaId,
    role: 'reaper',
    title: `Darwin testi: «${toolName}» (${manual ? 'manuel tetik' : 'TTL doldu'})`,
    content: `Telemetri: ${current.telemetry_pings} ping · ${current.telemetry?.unique_visitors ?? 0} tekil ziyaretçi · eşik ${threshold}`,
  });

  try {
    // Mutasyon analizi sırasında gelen pingler de sayılsın diye kararı en güncel değerle ver.
    const snapshot = store.getDna(dnaId);
    const pings = snapshot.telemetry_pings;
    const survived = pings >= threshold;

    let archived = null;
    if (!survived) {
      await stopApp(snapshot);
      archived = await archiveArtifact(dnaId);
    }

    const { mutation, rules, diff } = await mutateGenome(snapshot, survived);
    const evaluation = {
      verdict: survived ? 'IMMORTALIZED' : 'TERMINATED',
      pings_at_eval: pings,
      unique_visitors: snapshot.telemetry?.unique_visitors ?? 0,
      threshold,
      manual,
      evaluated_at: new Date().toISOString(),
      autopsy: mutation.autopsy,
      mutation_engine: mutation.engine,
      generation_after: rules.mutation_generation,
      archived_artifact: archived,
    };

    if (survived) {
      await store.setStatus(dnaId, DNA_STATUS.IMMORTALIZED, `ÖLÜMSÜZ ilan edildi (${pings}/${threshold} ping)`, (draft) => {
        draft.evaluation = evaluation;
        if (draft.deployment) draft.deployment.expires_at = null;
      });
      emitDebateMessage({
        dnaId,
        role: 'reaper',
        title: `☀ ÖLÜMSÜZ: «${toolName}» hayatta kaldı (${pings}/${threshold} ping)`,
        content: mutation.autopsy,
      });
    } else {
      const dead = await store.setStatus(dnaId, DNA_STATUS.TERMINATED, `İMHA edildi (${pings}/${threshold} ping)`, (draft) => {
        draft.evaluation = evaluation;
      });
      await store.bury(dead, 'TERMINATED', { summary: `${pings}/${threshold} ping — Kill-Switch`, autopsy: mutation.autopsy });
      emitDebateMessage({
        dnaId,
        role: 'reaper',
        title: `☠ İMHA: «${toolName}» Kill-Switch (${pings}/${threshold} ping)`,
        content: `Otopsi: ${mutation.autopsy}`,
      });
    }

    emitDebateMessage({
      dnaId,
      role: 'reaper',
      title: `🧬 Genetik mutasyon → Nesil #${rules.mutation_generation} (${mutation.engine === 'llm' ? 'LLM analizi' : 'sezgisel'})`,
      content: [mutation.mutation_summary, diff.length ? diff.slice(0, 14).join('\n') : 'Genomda kural değişikliği yok.'].filter(Boolean).join('\n\n'),
    });
    log.info(`Darwin kararı: ${survived ? 'IMMORTALIZED' : 'TERMINATED'} (${pings}/${threshold}) → nesil #${rules.mutation_generation}`, { dna_id: dnaId });
    return { verdict: evaluation.verdict, pings, generation: rules.mutation_generation };
  } catch (err) {
    log.error(`Reaper hatası: ${err.message}`, { dna_id: dnaId, stack: err.stack });
    // Değerlendirme başarısızsa aracı yayında bırak; bir sonraki tetiklemede yeniden denenebilir.
    await store.setStatus(dnaId, DNA_STATUS.DEPLOYED, `Darwin testi hata ile durdu: ${err.message}`).catch(() => {});
    emitDebateMessage({ dnaId, role: 'reaper', title: 'Darwin testi hata ile durdu — araç yayında bırakıldı', content: err.message });
    throw err;
  }
}

/** Panelden "Darwin Testine Sok": bekleyen TTL görevini iptal edip hemen değerlendirir. */
export async function requestEvaluation(dnaId) {
  const dna = store.peekDna(dnaId);
  if (!dna) throw new ReaperStateError('DNA bulunamadı.', 404);
  if (dna.status === DNA_STATUS.EVALUATING) throw new ReaperStateError('Bu DNA zaten değerlendiriliyor.');
  if (dna.status !== DNA_STATUS.DEPLOYED) {
    throw new ReaperStateError(`Yalnızca yayındaki (DEPLOYED) araçlar Darwin testine girebilir; mevcut durum: ${dna.status}.`);
  }
  await queues.removeJob(STAGES.reaper.queue, STAGES.reaper.jobId(dnaId));
  const job = await queues.add(STAGES.reaper.queue, 'evaluate-manual', { dnaId, manual: true }, { jobId: `reap-${dnaId}-manual-${Date.now()}` });
  log.info('Manuel Darwin testi kuyruğa alındı.', { dna_id: dnaId });
  return { queued: true, job_id: job.id };
}

/** Operatörün bir aracı elle imha etmesi (kota boşaltmak için). Mutasyon tetiklemez. */
export async function terminateManually(dnaId, reason = 'Operatör tarafından imha edildi') {
  const dna = store.getDna(dnaId);
  if (!dna) throw new ReaperStateError('DNA bulunamadı.', 404);
  if (!LIVE_STATUSES.has(dna.status) && dna.status !== DNA_STATUS.DEPLOY_WAITING) {
    throw new ReaperStateError(`Yalnızca yayındaki veya kuyrukta bekleyen araçlar imha edilebilir; mevcut durum: ${dna.status}.`);
  }
  if (dna.status === DNA_STATUS.EVALUATING) throw new ReaperStateError('Darwin testi sürerken imha edilemez.');
  await queues.removeJob(STAGES.reaper.queue, STAGES.reaper.jobId(dnaId));
  await stopApp(dna);
  const archived = await archiveArtifact(dnaId);
  const dead = await store.setStatus(dnaId, DNA_STATUS.TERMINATED, reason, (draft) => {
    draft.evaluation = {
      verdict: 'TERMINATED',
      manual_kill: true,
      pings_at_eval: draft.telemetry_pings,
      threshold: config.evolution.survivalPingThreshold,
      evaluated_at: new Date().toISOString(),
      autopsy: reason,
      archived_artifact: archived,
    };
    if (draft.deployment) draft.deployment.expires_at = null;
  });
  await store.bury(dead, 'MANUAL_KILL', { summary: reason });
  emitDebateMessage({ dnaId, role: 'reaper', title: `☠ Operatör imhası: «${dead.council?.upgraded_spec?.tool_name || dead.title}»`, content: reason });
  return store.summarize(store.peekDna(dnaId));
}
