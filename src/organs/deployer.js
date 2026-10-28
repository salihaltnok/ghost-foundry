/**
 * ORGAN 4 — Dış Dünya Teması & Docker Spawner
 *
 * - MAX_ACTIVE_CONTAINERS kotasını denetler; kota doluysa DNA'yı bekleme
 *   kuyruğunda tutar ve periyodik olarak yeniden dener.
 * - DRY_RUN_DOCKER=false: dockerode ile ./artifacts/:dna_id klasörünü salt-okunur
 *   bağlayan, 128MB RAM / 0.2 CPU sınırlı, yetkileri düşürülmüş bir nginx:alpine
 *   konteyneri açar ve boş bir yerel porta bağlar.
 * - DRY_RUN_DOCKER=true: konteyner davranışını simüle eder; araç anında
 *   http://localhost:4040/apps/:dna_id/ adresinde canlıya çıkar.
 * - Dağıtım bitince reaper-queue'ya DEFAULT_TTL_MS gecikmeli değerlendirme bırakır.
 */
import { existsSync, promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { config, CIRCUIT_BREAKERS } from '../config/index.js';
import { store, DNA_STATUS, LIVE_STATUSES } from '../memory/evolution-store.js';
import { enqueueStage } from '../queues/queue-manager.js';
import { organLogger, emitDebateMessage } from '../utils/logger.js';

const log = organLogger('deployer');

const LABEL_FOUNDRY = 'ghost.foundry';
const LABEL_DNA = 'ghost.dna';

let dockerClient = null;
let hostArtifactsRoot = null;

function docker() {
  if (!dockerClient) {
    dockerClient = config.docker.socketPath ? new Docker({ socketPath: config.docker.socketPath }) : new Docker();
  }
  return dockerClient;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function isDockerReachable() {
  try {
    await withTimeout(docker().ping(), 5_000, 'Docker ping zaman aşımı');
    return true;
  } catch (err) {
    log.warn(`Docker daemon erişilemedi: ${err.message}`);
    return false;
  }
}

async function ensureImage(image) {
  try {
    await docker().getImage(image).inspect();
    return;
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  log.info(`${image} imajı yerelde yok; çekiliyor...`);
  const stream = await docker().pull(image);
  await new Promise((resolve, reject) => {
    docker().modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
  });
  log.info(`${image} imajı hazır.`);
}

/** artifacts klasörünün Docker HOST'u üzerindeki yolunu bulur (Ghost Core konteyner içindeyse). */
async function resolveHostArtifactsRoot() {
  if (config.docker.hostArtifactsDir) return config.docker.hostArtifactsDir;
  if (hostArtifactsRoot) return hostArtifactsRoot;
  if (existsSync('/.dockerenv')) {
    try {
      const self = await docker().getContainer(os.hostname()).inspect();
      const target = path.posix.normalize(config.paths.artifacts.replace(/\\/g, '/'));
      const mount = (self.Mounts || []).find((m) => path.posix.normalize(String(m.Destination)) === target);
      if (mount?.Source) {
        hostArtifactsRoot = mount.Source;
        log.info(`artifacts host yolu otomatik bulundu: ${hostArtifactsRoot}`);
        return hostArtifactsRoot;
      }
      log.warn('Konteyner içinde çalışılıyor ama artifacts bağlama noktası bulunamadı; HOST_ARTIFACTS_DIR tanımlayın.');
    } catch (err) {
      log.warn(`Öz-konteyner incelemesi başarısız (${err.message}); yerel yol kullanılacak.`);
    }
  }
  hostArtifactsRoot = config.paths.artifacts;
  return hostArtifactsRoot;
}

function joinHostPath(root, child) {
  const trimmed = String(root).replace(/[\\/]+$/, '');
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/';
  return `${trimmed}${separator}${child}`;
}

const containerNameFor = (dnaId) => `ghost-${dnaId.slice(0, 8)}`;

async function removeContainerByName(name) {
  try {
    await docker().getContainer(name).remove({ force: true });
    log.info(`Eski konteyner kaldırıldı: ${name}`);
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
}

async function probeHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status < 500) return true;
    } catch {
      // konteyner henüz hazır değil
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function spawnContainer(dna) {
  const image = config.docker.image;
  await ensureImage(image);
  const name = containerNameFor(dna.id);
  await removeContainerByName(name);
  const hostDir = joinHostPath(await resolveHostArtifactsRoot(), dna.id);

  const container = await docker().createContainer({
    name,
    Image: image,
    Labels: { [LABEL_FOUNDRY]: 'true', [LABEL_DNA]: dna.id, 'ghost.generation': String(dna.generation) },
    ExposedPorts: { '80/tcp': {} },
    HostConfig: {
      Mounts: [{ Type: 'bind', Source: hostDir, Target: '/usr/share/nginx/html', ReadOnly: true }],
      PortBindings: { '80/tcp': [{ HostIp: config.docker.bindHost, HostPort: '' }] },
      Memory: config.docker.memoryBytes,
      MemorySwap: config.docker.memoryBytes,
      NanoCpus: config.docker.nanoCpus,
      PidsLimit: 64,
      RestartPolicy: { Name: 'unless-stopped' },
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'NET_BIND_SERVICE', 'DAC_OVERRIDE'],
      SecurityOpt: ['no-new-privileges:true'],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    },
  });

  try {
    await container.start();
    const info = await container.inspect();
    const binding = info.NetworkSettings?.Ports?.['80/tcp']?.[0];
    const hostPort = binding?.HostPort ? Number(binding.HostPort) : null;
    if (!info.State?.Running || !hostPort) {
      throw new Error(`Konteyner çalışmıyor veya port atanmadı (durum: ${info.State?.Status ?? 'bilinmiyor'})`);
    }
    const healthy = await probeHttp(`http://${config.docker.healthcheckHost}:${hostPort}/`, 8_000);
    if (!healthy) log.warn(`${name} HTTP sağlık kontrolüne yanıt vermedi (Ghost Core konteyner içindeyse bu beklenebilir).`, { dna_id: dna.id });
    return {
      mode: 'docker',
      container_id: info.Id,
      container_name: name,
      host_port: hostPort,
      image,
      healthy,
      url: `http://${config.docker.publicHost}:${hostPort}/`,
      limits: { memory_mb: config.docker.memoryBytes / 1024 / 1024, cpus: config.docker.nanoCpus / 1e9 },
    };
  } catch (err) {
    await container.remove({ force: true }).catch(() => {});
    throw err;
  }
}

function simulateContainer(dna) {
  return {
    mode: 'dry-run',
    container_id: `dryrun-${randomBytes(6).toString('hex')}`,
    container_name: `${containerNameFor(dna.id)} (simülasyon)`,
    host_port: config.port,
    image: `${config.docker.image} (simülasyon)`,
    healthy: true,
    url: `${config.publicBaseUrl}/apps/${dna.id}/`,
    limits: { memory_mb: config.docker.memoryBytes / 1024 / 1024, cpus: config.docker.nanoCpus / 1e9 },
  };
}

/** Konteyneri durdurup siler (dry-run'da no-op; /apps rotası durum kontrolü ile kapanır). */
export async function stopApp(dna) {
  const deployment = dna?.deployment;
  if (!deployment || deployment.mode !== 'docker' || !deployment.container_id) return { stopped: false, mode: deployment?.mode || null };
  const container = docker().getContainer(deployment.container_id);
  try {
    await container.stop({ t: 5 });
  } catch (err) {
    if (![304, 404].includes(err.statusCode)) log.warn(`Konteyner durdurulamadı (${deployment.container_name}): ${err.message}`, { dna_id: dna.id });
  }
  try {
    await container.remove({ force: true });
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }
  log.info(`Konteyner imha edildi: ${deployment.container_name}`, { dna_id: dna.id });
  return { stopped: true, mode: 'docker' };
}

async function failDeploy(dnaId, message) {
  const dna = await store.setStatus(dnaId, DNA_STATUS.DEPLOY_FAILED, message, (draft) => {
    draft.error = { stage: 'deploy', message };
  });
  await store.bury(dna, 'DEPLOY_FAILED', { summary: message });
  emitDebateMessage({ dnaId, role: 'deployer', title: '✕ Dağıtım başarısız — DNA mezarlığa gömüldü', content: message });
}

/**
 * DNA'yı yayına alır.
 * @param {string} dnaId
 * @param {{isFinalAttempt?: boolean}} opts kuyruk yeniden denemeleri için
 */
export async function runDeploy(dnaId, { isFinalAttempt = true } = {}) {
  const dna = store.getDna(dnaId);
  if (!dna) {
    log.warn(`Dağıtım: DNA bulunamadı (${dnaId}).`);
    return { skipped: true };
  }
  if (![DNA_STATUS.FORGED, DNA_STATUS.DEPLOY_WAITING, DNA_STATUS.DEPLOYING].includes(dna.status)) {
    log.info(`Dağıtım: DNA ${dna.status} durumunda; atlandı.`, { dna_id: dnaId });
    return { skipped: true };
  }
  const artifactFile = path.join(config.paths.artifacts, dnaId, 'index.html');
  if (!existsSync(artifactFile)) {
    await failDeploy(dnaId, `Artefakt bulunamadı: ${path.relative(config.paths.root, artifactFile)}`);
    return { ok: false };
  }

  // Kota kontrolü
  const active = store.activeAppCount();
  if (active >= CIRCUIT_BREAKERS.MAX_ACTIVE_CONTAINERS) {
    const waits = (dna.deployment?.wait_attempts || 0) + 1;
    if (waits > CIRCUIT_BREAKERS.MAX_DEPLOY_WAIT_ATTEMPTS) {
      await failDeploy(dnaId, `Aktif uygulama kotası (${CIRCUIT_BREAKERS.MAX_ACTIVE_CONTAINERS}) ${waits - 1} denemede boşalmadı.`);
      return { ok: false };
    }
    await store.setStatus(dnaId, DNA_STATUS.DEPLOY_WAITING, `Kota dolu (${active}/${CIRCUIT_BREAKERS.MAX_ACTIVE_CONTAINERS}) — bekleme #${waits}`, (draft) => {
      draft.deployment = { ...(draft.deployment || {}), wait_attempts: waits };
    });
    if (waits === 1) {
      emitDebateMessage({
        dnaId,
        role: 'deployer',
        title: `Kota dolu (${active}/${CIRCUIT_BREAKERS.MAX_ACTIVE_CONTAINERS}) — dağıtım sırada`,
        content: `Her ${Math.round(CIRCUIT_BREAKERS.DEPLOY_WAIT_INTERVAL_MS / 1000)} sn'de bir yeniden denenecek. Reaper bir aracı imha ettiğinde yer açılır.`,
      });
    }
    await enqueueStage('deploy', dnaId, { delay: CIRCUIT_BREAKERS.DEPLOY_WAIT_INTERVAL_MS, jobId: `deploy-${dnaId}-w${waits}` });
    return { ok: false, waiting: true };
  }

  await store.setStatus(dnaId, DNA_STATUS.DEPLOYING, 'Dağıtım başladı');
  let mode = config.docker.dryRun ? 'dry-run' : 'docker';
  try {
    if (mode === 'docker' && !(await isDockerReachable())) {
      if (!config.docker.fallbackToDryRun) throw new Error('Docker daemon erişilemedi ve DOCKER_FALLBACK_TO_DRY_RUN=false.');
      log.warn('Docker erişilemedi; bu DNA dry-run modunda yayınlanıyor.', { dna_id: dnaId });
      emitDebateMessage({ dnaId, role: 'deployer', title: 'Docker erişilemedi → dry-run moduna düşüldü', content: 'Araç Ghost Core üzerinden /apps rotasında yayınlanacak.' });
      mode = 'dry-run';
    }
    const spawned = mode === 'docker' ? await spawnContainer(dna) : simulateContainer(dna);
    const ttl = config.evolution.defaultTtlMs;
    const deployedAt = Date.now();
    const deployment = {
      ...spawned,
      deployed_at: new Date(deployedAt).toISOString(),
      expires_at: new Date(deployedAt + ttl).toISOString(),
      ttl_ms: ttl,
      wait_attempts: dna.deployment?.wait_attempts || 0,
    };
    await store.setStatus(dnaId, DNA_STATUS.DEPLOYED, `Yayında (${mode}) — TTL ${Math.round(ttl / 1000)} sn`, (draft) => {
      draft.deployment = deployment;
      draft.error = null;
    });
    await enqueueStage('reaper', dnaId, { delay: ttl });

    const toolName = dna.council?.upgraded_spec?.tool_name || dna.title;
    emitDebateMessage({
      dnaId,
      role: 'deployer',
      title: `Canlıda: «${toolName}» → ${deployment.url}`,
      content: [
        mode === 'docker'
          ? `Konteyner ${deployment.container_name} (${deployment.container_id.slice(0, 12)}) · ${deployment.image} · ${deployment.limits.memory_mb}MB / ${deployment.limits.cpus} CPU · salt-okunur bağlama`
          : `Simüle konteyner ${deployment.container_name} · ${deployment.limits.memory_mb}MB / ${deployment.limits.cpus} CPU sınırları taklit edildi`,
        `Darwin testi: ${new Date(deployedAt + ttl).toLocaleTimeString('tr-TR')} itibarıyla (TTL ${Math.round(ttl / 1000)} sn) · hayatta kalma eşiği ${config.evolution.survivalPingThreshold} ping`,
      ].join('\n'),
    });
    log.info(`Yayına alındı (${mode}): ${deployment.url}`, { dna_id: dnaId });
    return { ok: true, url: deployment.url };
  } catch (err) {
    log.error(`Dağıtım hatası: ${err.message}`, { dna_id: dnaId, stack: err.stack });
    if (!isFinalAttempt) {
      await store.setStatus(dnaId, DNA_STATUS.FORGED, `Dağıtım hatası, yeniden denenecek: ${err.message}`);
      throw err;
    }
    await failDeploy(dnaId, `Dağıtım hatası: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Açılışta durum uzlaştırma: canlı DNA'ların konteynerlerini doğrular/yeniden
 * başlatır, sahipsiz Ghost konteynerlerini temizler.
 */
export async function reconcileDeployments() {
  const live = store.listDnas().filter((dna) => LIVE_STATUSES.has(dna.status) && dna.deployment?.mode === 'docker');
  const needsDocker = live.length > 0 || !config.docker.dryRun;
  if (!needsDocker) return { checked: 0 };
  if (!(await isDockerReachable())) {
    if (live.length) log.warn(`${live.length} Docker dağıtımı doğrulanamadı: Docker daemon erişilemiyor.`);
    return { checked: 0, dockerUnavailable: true };
  }

  let restarted = 0;
  let respawned = 0;
  for (const dna of live) {
    try {
      const info = await docker().getContainer(dna.deployment.container_id).inspect();
      if (!info.State?.Running) {
        await docker().getContainer(dna.deployment.container_id).start();
        restarted += 1;
      }
    } catch (err) {
      if (err.statusCode !== 404) {
        log.warn(`Konteyner incelenemedi (${dna.deployment.container_name}): ${err.message}`, { dna_id: dna.id });
        continue;
      }
      try {
        const spawned = await spawnContainer(dna);
        await store.updateDna(dna.id, (draft) => {
          draft.deployment = { ...draft.deployment, ...spawned };
        }, { note: 'Konteyner yeniden oluşturuldu (uzlaştırma)' });
        respawned += 1;
      } catch (spawnErr) {
        log.error(`Konteyner yeniden oluşturulamadı: ${spawnErr.message}`, { dna_id: dna.id });
      }
    }
  }

  let removed = 0;
  try {
    const containers = await docker().listContainers({ all: true, filters: { label: [`${LABEL_FOUNDRY}=true`] } });
    for (const summary of containers) {
      const dnaId = summary.Labels?.[LABEL_DNA];
      const owner = dnaId ? store.peekDna(dnaId) : null;
      if (!owner || !LIVE_STATUSES.has(owner.status) || owner.deployment?.container_id !== summary.Id) {
        await docker().getContainer(summary.Id).remove({ force: true }).catch(() => {});
        removed += 1;
      }
    }
  } catch (err) {
    log.warn(`Sahipsiz konteyner taraması başarısız: ${err.message}`);
  }
  if (restarted || respawned || removed) {
    log.info(`Docker uzlaştırma: ${restarted} yeniden başlatıldı, ${respawned} yeniden oluşturuldu, ${removed} sahipsiz kaldırıldı.`);
  }
  return { checked: live.length, restarted, respawned, removed };
}

/** Artefaktı mezarlık arşivine taşır (imha edilen araçlar için adli kayıt). */
export async function archiveArtifact(dnaId) {
  const source = path.join(config.paths.artifacts, dnaId, 'index.html');
  const target = path.join(config.paths.graveyardArtifacts, `${dnaId}.html`);
  try {
    await fsp.mkdir(config.paths.graveyardArtifacts, { recursive: true });
    await fsp.copyFile(source, target);
    await fsp.rm(path.join(config.paths.artifacts, dnaId), { recursive: true, force: true });
    return path.relative(config.paths.root, target);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Artefakt arşivlenemedi: ${err.message}`, { dna_id: dnaId });
    return null;
  }
}
