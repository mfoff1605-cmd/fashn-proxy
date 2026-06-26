const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  API_BASE:           'https://fashn-ai-fashn-vton-1-5.hf.space/gradio_api',
  INITIAL_WAIT_MS:    20_000,
  POLL_INTERVAL_MS:    2_000,
  MAX_POLL_ATTEMPTS:      30,   // 30 × 2s = 60s de polling max après les 20s initiales
  REQUEST_TIMEOUT_MS: 15_000,
  JOB_TTL_MS:        600_000,  // Nettoie les jobs en mémoire après 10 min
  PORT:               process.env.PORT || 3000,
};

// ─── Store en mémoire des jobs ────────────────────────────────────────────────
// Structure : { [jobId]: { status, result_url, error, createdAt } }
const jobs = new Map();

// Nettoyage périodique pour éviter les fuites mémoire
setInterval(() => {
  const cutoff = Date.now() - CONFIG.JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) {
      jobs.delete(id);
      console.log(`[GC] Job ${id} expiré et supprimé.`);
    }
  }
}, 60_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractResultUrl(rawText) {
  const lines = rawText.split('\n').filter((l) => l.startsWith('data:'));
  for (const line of lines.reverse()) {
    try {
      const json = JSON.parse(line.slice(5).trim());
      if (json?.msg !== 'process_completed') continue;
      const url = findPath(json);
      if (url) return url;
    } catch { /* ligne mal formée, on continue */ }
  }
  // Fallback regex
  const match = rawText.match(/"path"\s*:\s*"(https:\/\/[^"]+)"/);
  return match ? match[1] : null;
}

function findPath(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.path === 'string' && obj.path.startsWith('https://')) return obj.path;
  for (const val of Object.values(obj)) {
    const found = findPath(val);
    if (found) return found;
  }
  return null;
}

function generateJobId() {
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}

// ─── Worker asynchrone (tourne en arrière-plan, sans bloquer la réponse HTTP) ─
async function runTryOnJob(jobId, person_url, garment_url) {
  const job = jobs.get(jobId);

  // Étape 1 : Lancement
  let event_id;
  try {
    console.log(`[${jobId}] 🚀 POST → ${CONFIG.API_BASE}/call/try_on`);
    const postRes = await fetchWithTimeout(
      `${CONFIG.API_BASE}/call/try_on`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            { path: person_url,  meta: { _type: 'gradio.FileData' } },
            { path: garment_url, meta: { _type: 'gradio.FileData' } },
            'tops', 'model', 50, 1.5, 42, true,
          ],
        }),
      },
    );

    if (!postRes.ok) {
      const body = await postRes.text();
      throw new Error(`Gradio HTTP ${postRes.status}: ${body.slice(0, 200)}`);
    }

    ({ event_id } = await postRes.json());
    if (!event_id) throw new Error('Réponse initiale sans event_id.');

    console.log(`[${jobId}] ✅ event_id : ${event_id}`);
    job.event_id = event_id;
  } catch (err) {
    console.error(`[${jobId}] ❌ Échec du lancement :`, err.message);
    job.status = 'failed';
    job.error   = `Erreur de lancement : ${err.message}`;
    return;
  }

  // Étape 2 : Attente initiale
  console.log(`[${jobId}] ⏳ Attente initiale ${CONFIG.INITIAL_WAIT_MS / 1000}s…`);
  job.status = 'processing';
  await sleep(CONFIG.INITIAL_WAIT_MS);

  // Étape 3 : Polling
  const pollUrl = `${CONFIG.API_BASE}/call/try_on/${event_id}`;

  for (let attempt = 1; attempt <= CONFIG.MAX_POLL_ATTEMPTS; attempt++) {
    console.log(`[${jobId}] 🔄 Poll #${attempt}/${CONFIG.MAX_POLL_ATTEMPTS}`);
    try {
      const pollRes = await fetchWithTimeout(pollUrl);

      if (pollRes.ok) {
        const text = await pollRes.text();

        if (text.includes('process_completed')) {
          const url = extractResultUrl(text);
          if (url) {
            console.log(`[${jobId}] 🎉 Résultat au poll #${attempt} : ${url}`);
            job.status     = 'completed';
            job.result_url = url;
            return;
          }
          console.warn(`[${jobId}] ⚠ process_completed sans path. Brut :`, text.slice(0, 400));
        } else if (text.includes('process_errored')) {
          job.status = 'failed';
          job.error  = 'Gradio a renvoyé process_errored.';
          console.error(`[${jobId}] ❌ process_errored`);
          return;
        } else {
          const m = text.match(/"msg"\s*:\s*"([^"]+)"/);
          console.log(`[${jobId}]   ↻ ${m ? m[1] : 'en cours'}`);
        }
      } else {
        console.warn(`[${jobId}]   ⚠ HTTP ${pollRes.status}`);
      }
    } catch (err) {
      console.warn(`[${jobId}]   ⚠ Réseau poll #${attempt} : ${err.message}`);
    }

    if (attempt < CONFIG.MAX_POLL_ATTEMPTS) await sleep(CONFIG.POLL_INTERVAL_MS);
  }

  const total = (CONFIG.INITIAL_WAIT_MS + CONFIG.MAX_POLL_ATTEMPTS * CONFIG.POLL_INTERVAL_MS) / 1000;
  job.status = 'failed';
  job.error  = `Timeout : aucun résultat après ${total}s.`;
  console.error(`[${jobId}] ⏰ ${job.error}`);
}

// ─── Middleware de validation ─────────────────────────────────────────────────
function validateTryOnRequest(req, res, next) {
  const { person_url, garment_url } = req.body ?? {};
  if (!person_url  || typeof person_url  !== 'string') return res.status(400).json({ success: false, error: '`person_url` manquant ou invalide.' });
  if (!garment_url || typeof garment_url !== 'string') return res.status(400).json({ success: false, error: '`garment_url` manquant ou invalide.' });
  try { new URL(person_url); new URL(garment_url); } catch {
    return res.status(400).json({ success: false, error: 'URLs mal formées.' });
  }
  next();
}

// ─── Route 1 : Lancer un job (réponse immédiate < 1s) ────────────────────────
app.post('/api/tryon', validateTryOnRequest, (req, res) => {
  const { person_url, garment_url } = req.body;
  const jobId = generateJobId();

  jobs.set(jobId, {
    status:    'queued',
    result_url: null,
    error:      null,
    createdAt:  Date.now(),
  });

  console.log(`[${jobId}] ▶ Job créé | person=${person_url} | garment=${garment_url}`);

  // Lance le worker EN ARRIÈRE-PLAN (pas de await ici)
  runTryOnJob(jobId, person_url, garment_url).catch((err) => {
    console.error(`[${jobId}] 💥 Erreur inattendue dans le worker :`, err);
    const job = jobs.get(jobId);
    if (job) { job.status = 'failed'; job.error = err.message; }
  });

  // Réponse immédiate à Bubble — aucun timeout possible
  res.json({ success: true, job_id: jobId });
});

// ─── Route 2 : Consulter le résultat d'un job ─────────────────────────────────
// Bubble doit appeler cette route en polling (ex. toutes les 3s) jusqu'à status !== 'queued'/'processing'
app.get('/api/result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ success: false, error: 'Job introuvable ou expiré.' });
  }

  // Statuts possibles : queued | processing | completed | failed
  if (job.status === 'completed') {
    return res.json({ success: true,  status: 'completed', result_url: job.result_url });
  }
  if (job.status === 'failed') {
    return res.status(502).json({ success: false, status: 'failed', error: job.error });
  }
  // queued ou processing : Bubble doit re-poller
  return res.json({ success: true, status: job.status });
});

// ─── Health-check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', jobs_in_memory: jobs.size });
});

// ─── Sécurité processus ───────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => console.error('⚠ unhandledRejection :', reason));
process.on('uncaughtException',  (err)    => console.error('💥 uncaughtException :', err));

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`✅ Proxy prêt sur le port ${CONFIG.PORT}`);
});
