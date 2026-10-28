# The Foundry — Ghost Core v1.0

İnternetteki geliştirici darboğazlarını tarayan, 3 ajanlı çatışmalı bir konseyde fikirleri puanlayan, onaylananları tek dosyalık (zero-backend) mikro-web araçlarına dönüştürüp kendi hatalarını onaran, yayına alan ve gerçek kullanım telemetrisine göre Darwinci seçilimle evrimleşen kapalı devre sistem.

```
Gözcü (scout) → Konsey (council) → Forge (self-heal) → Dağıtıcı (deploy) → Reaper (Darwin + mutasyon)
      ↑                                                                          │
      └──────────────── evolutionary_rules.json (genom) ◄────────────────────────┘
```

## Hızlı başlangıç (Redis ve Docker gerekmez)

```bash
npm install
# .env içinde OPENROUTER_API_KEY değerini girin
npm start            # veya geliştirme için: npm run dev
```

Panel: **http://localhost:4040** (Flight Recorder)

1. Soldaki **Sinyal enjekte et** formuna bir darboğaz yazın veya **Radarı tara** ile HackerNews/GitHub/Reddit'i tarayın.
2. Konsey tartışması sol akışta canlı görünür; skor ≥ `COUNCIL_APPROVAL_THRESHOLD` ise Forge kodu yazar, doğrular, gerekirse kendini onarır.
3. Araç `http://localhost:4040/apps/<dna_id>/` adresinde yayına çıkar. Açıp kullandıkça telemetri sayacı artar.
4. TTL dolduğunda (veya **Darwin testine sok** ile hemen) ping sayısı `SURVIVAL_PING_THRESHOLD` altındaysa araç imha edilir; üstündeyse ölümsüz olur. Her kararda genom yeniden yazılır (Gen +1).

## Üretim modu (Redis + gerçek Docker konteynerleri)

```bash
# .env: DRY_RUN_DOCKER=false   (isteğe bağlı: DEFAULT_TTL_MS=172800000 → 48 saat)
docker compose up -d --build
```

- Kuyruk BullMQ/Redis'e geçer (Redis erişilemezse otomatik olarak bellek kuyruğuna düşer).
- Her araç `nginx:alpine` konteynerinde: 128 MB RAM, 0.2 CPU, tüm yetkiler düşürülmüş, salt-okunur bağlama, `127.0.0.1` üzerinde rastgele port.
- Docker'ı compose olmadan kullanmak için: Docker Desktop açıkken `.env` içinde `DRY_RUN_DOCKER=false` yapıp `npm start`.

## GitHub'a yükleme

Proje klasöründeki **`github-yukle.bat`** dosyasına çift tıkla.

- İlk çalıştırmada: Git yoksa kurmayı önerir, GitHub girişini tarayıcıdan yaptırır, repoyu oluşturur (GitHub CLI varsa otomatik) ve ilk commit'i gönderir.
- Sonraki çalıştırmalarda: değişiklikleri commit'leyip doğrudan gönderir, hiçbir şey sormaz. Özel mesaj için: `github-yukle.bat "Konsey eşiği 80 yapıldı"`
- `.env`, `data/`, `artifacts/`, `logs/` ve `node_modules/` asla yüklenmez. Gönderimden önce dosyalarda API anahtarı veya GitHub jetonu taranır; bulunursa hiçbir şey gönderilmez.

## Güvenlik sigortaları

| Değişken | Etki |
|---|---|
| `MAX_BUDGET_PER_DNA_USD` | DNA başına LLM harcama tavanı; çağrı öncesi `max_tokens` kalan bütçeye göre kısılır, aşılırsa `BudgetCircuitBreakerError` |
| `MAX_TOTAL_BUDGET_USD` | Tüm sistemin harcama tavanı |
| `MAX_SELF_HEAL_RETRIES` | Forge yama turu limiti |
| `MAX_ACTIVE_CONTAINERS` | Aynı anda yayındaki araç kotası (doluysa dağıtım sıraya girer) |
| `CONTROL_TOKEN` | Doluysa kontrol API'si ve panel jeton ister |
| `AUTO_SCOUT_INTERVAL_MS` | 0 = yalnızca manuel tarama; >0 = otonom periyodik tarama |

Üretilen araçlar sıkı bir CSP ile sunulur: yalnızca kendi telemetri ucuna istek atabilir, kontrol API'sine erişemez.

## Model kimlikleri

`.env` içindeki model kimlikleri OpenRouter kataloğuna göre açılışta denetlenir; bulunamayan bir model varsa günlükte ve panelde uyarı çıkar. Güncel kimlikler: https://openrouter.ai/models

Yapılandırma hataları (emekli/geçersiz model, geçersiz anahtar, yetersiz kredi) fikrin başarısızlığı sayılmaz: DNA mezarlığa gömülmez, **park edilir**. `.env` düzeltilip sunucu yeniden başlatılınca park edilen DNA'lar kaldıkları aşamadan kendiliğinden devam eder; panelde **Yeniden dene** ile de tetiklenebilir.

## Dosya haritası

```
src/config/index.js          merkezi konfigürasyon + circuit breaker sabitleri
src/utils/logger.js          winston + Socket.IO canlı kara kutu
src/utils/openrouter.js      maliyet muhasebeli, bütçe sigortalı, JSON onarımlı LLM istemcisi
src/queues/queue-manager.js  hibrit kuyruk (bellek ⇄ BullMQ/Redis)
src/memory/evolution-store.js data/ altındaki kalıcı hafıza (atomik yazım)
src/organs/scout.js          ORGAN 1 — radar
src/organs/council.js        ORGAN 2 — Vizyoner / Eleştirmen / Hakem
src/organs/forge.js          ORGAN 3 — kodlayıcı + vm/worker sandbox doğrulayıcı + self-heal
src/organs/deployer.js       ORGAN 4 — dry-run veya nginx:alpine konteyneri
src/organs/reaper.js         ORGAN 5 — Kill-Switch + genetik mutasyon
src/server.js                orkestratör, API, Socket.IO
public/index.html            Flight Recorder paneli
```

## API

| Yöntem | Yol | Açıklama |
|---|---|---|
| GET | `/api/state` | DNA'lar, genom, kuyruk istatistikleri, mezarlık |
| GET | `/api/dna/:dna_id` | Tek DNA'nın tüm kaydı ve tartışması |
| POST | `/api/scout/trigger` | Canlı radar taraması |
| POST | `/api/scout/inject` | `{ title, description, target_user?, tool_concept?, url? }` |
| POST | `/api/telemetry/:dna_id` | Araçlardan gelen ping (CORS açık, `text/plain` JSON) |
| POST | `/api/reaper/evaluate/:dna_id` | Anında Darwin testi + mutasyon |
| POST | `/api/dna/:dna_id/terminate` | Operatör imhası (kota boşaltma) |
| POST | `/api/dna/:dna_id/retry` | Park edilen veya teknik hatayla düşen DNA'yı kaldığı aşamadan yeniden dener |
| GET | `/apps/:dna_id/` | Üretilen aracı canlı çalıştırır |

Kontrol uçları `Content-Type: application/json` ister.
