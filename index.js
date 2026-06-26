const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  API_BASE:          'https://fashn-ai-fashn-vton-1-5.hf.space/gradio_api',
  INITIAL_WAIT_MS:   20_000,   // Attente initiale avant le premier polling
  POLL_INTERVAL_MS:   2_000,   // Intervalle entre deux polls
  MAX_POLL_ATTEMPTS:     30,   // 30 × 2s = 60s de polling max (total ~80s)
  REQUEST_TIMEOUT_MS: 15_000,  // Timeout par requête HTTP individuelle
  PORT:              process.env.PORT || 3000,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Promesse résolue après `ms` millisecondes — non-bloquante (I/O event). */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** fetch() avec AbortController pour couper proprement en cas de timeout. */
async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrait l'URL du résultat depuis le corps SSE/text renvoyé par Gradio.
 * Gradio renvoie des lignes "data: {...}" ; on cherche la dernière ligne
 * dont le JSON contient "process_completed" et un champ `path`.
 *
 * Stratégie :
 *  1. Chercher un bloc JSON valide contenant `process_completed`.
 *  2. Si plusieurs `path` existent, prendre la première URL https.
 */
function extractResultUrl(rawText) {
  // Chaque événement SSE est préfixé par "data: "
  const lines = rawText.split('\n').filter((l) => l.startsWith('data:'));

  for (const line of lines.reverse()) { // parcours du plus récent au plus ancien
    try {
      const json = JSON.parse(line.slice(5).trim()); // retire "data:"
      if (json?.msg !== 'process_completed') continue;

      // Cherche récursivement une clé "path" contenant une URL
      const url = findPath(json);
      if (url) return url;
    } catch {
      // JSON malformé sur cette ligne → on continue
    }
  }

  // Fallback : regex brute si le parsing SSE échoue (réponse non-standard)
  const match = rawText.match(/"path"\s*:\s*"(https:\/\/[^"]+)"/);
  return match ? match[1] : null;
}

/** Parcours récursif d'un objet pour trouver la première valeur de "path" en https. */
function findPath(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.path === 'string' && obj.path.startsWith('https://')) return obj.path;
  for (const val of Object.values(obj)) {
    const found = findPath(val);
    if (found) return found;
  }
  return null;
}

// ─── Middleware de validation ─────────────────────────────────────────────────

function validateTryOnRequest(req, res, next) {
  const { person_url, garment_url } = req.body ?? {};

  if (!person_url || typeof person_url !== 'string') {
    return res.status(400).json({ success: false, error: 'Champ `person_url` manquant ou invalide.' });
  }
  if (!garment_url || typeof garment_url !== 'string') {
    return res.status(400).json({ success: false, error: 'Champ `garment_url` manquant ou invalide.' });
  }

  // Vérification basique du format URL
  try {
    new URL(person_url);
    new URL(garment_url);
  } catch {
    return res.status(400).json({ success: false, error: 'Les URLs fournies sont mal formées.' });
  }

  next();
}

// ─── Route principale ─────────────────────────────────────────────────────────

app.post('/api/tryon', validateTryOnRequest, async (req, res) => {
  const { person_url, garment_url } = req.body;
  const requestId = Math.random().toString(36).slice(2, 9).toUpperCase(); // ID lisible dans les logs

  console.log(`[${requestId}] ▶ Nouvelle requête try-on`);
  console.log(`[${requestId}]   person_url  : ${person_url}`);
  console.log(`[${requestId}]   garment_url : ${garment_url}`);

  // ── Étape 1 : Lancement de la génération ───────────────────────────────────
  let event_id;
  try {
    console.log(`[${requestId}] 🚀 POST → ${CONFIG.API_BASE}/call/try_on`);

    const postRes = await fetchWithTimeout(
      `${CONFIG.API_BASE}/call/try_on`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: [
            { path: person_url,  meta: { _type: 'gradio.FileData' } },
            { path: garment_url, meta: { _type: 'gradio.FileData' } },
            'tops',  // category
            'model', // mode
            50,      // steps
            1.5,     // guidance_scale
            42,      // seed
            true,    // nsfw_filter
          ],
        }),
      },
    );

    if (!postRes.ok) {
      const body = await postRes.text();
      throw new Error(`Gradio a répondu ${postRes.status}: ${body.slice(0, 200)}`);
    }

    ({ event_id } = await postRes.json());
    if (!event_id) throw new Error('Réponse initiale de Gradio sans event_id.');

    console.log(`[${requestId}] ✅ event_id reçu : ${event_id}`);
  } catch (err) {
    console.error(`[${requestId}] ❌ Échec du lancement :`, err.message);
    return res.status(502).json({ success: false, error: `Erreur de lancement : ${err.message}` });
  }

  // ── Étape 2 : Attente initiale (la génération démarre côté HF) ─────────────
  console.log(`[${requestId}] ⏳ Attente initiale de ${CONFIG.INITIAL_WAIT_MS / 1000}s…`);
  await sleep(CONFIG.INITIAL_WAIT_MS);

  // ── Étape 3 : Boucle de polling ────────────────────────────────────────────
  const pollUrl = `${CONFIG.API_BASE}/call/try_on/${event_id}`;
  let resultUrl = null;

  for (let attempt = 1; attempt <= CONFIG.MAX_POLL_ATTEMPTS; attempt++) {
    console.log(`[${requestId}] 🔄 Poll #${attempt}/${CONFIG.MAX_POLL_ATTEMPTS} → ${pollUrl}`);

    try {
      const pollRes = await fetchWithTimeout(pollUrl, {}, CONFIG.REQUEST_TIMEOUT_MS);

      if (!pollRes.ok) {
        console.warn(`[${requestId}]   ⚠ HTTP ${pollRes.status} — on continue…`);
      } else {
        const text = await pollRes.text();

        if (text.includes('process_completed')) {
          resultUrl = extractResultUrl(text);

          if (resultUrl) {
            console.log(`[${requestId}] 🎉 Résultat prêt au poll #${attempt} : ${resultUrl}`);
            break;
          } else {
            console.warn(`[${requestId}]   ⚠ process_completed détecté mais aucun path extrait. Réponse brute :`);
            console.warn(text.slice(0, 500));
          }
        } else if (text.includes('process_errored')) {
          console.error(`[${requestId}] ❌ Gradio a signalé une erreur de traitement.`);
          return res.status(502).json({ success: false, error: 'Gradio a renvoyé process_errored.' });
        } else {
          // Statuts intermédiaires attendus : queue_full, estimation, heartbeat…
          const statusMatch = text.match(/"msg"\s*:\s*"([^"]+)"/);
          const status = statusMatch ? statusMatch[1] : 'en cours';
          console.log(`[${requestId}]   ↻ Statut : ${status}`);
        }
      }
    } catch (err) {
      // Timeout réseau ou coupure transitoire → on ne plante pas, on ré-essaie
      console.warn(`[${requestId}]   ⚠ Erreur réseau au poll #${attempt} : ${err.message}`);
    }

    // Pause avant le prochain poll (sauf si c'était le dernier)
    if (attempt < CONFIG.MAX_POLL_ATTEMPTS) {
      await sleep(CONFIG.POLL_INTERVAL_MS);
    }
  }

  // ── Étape 4 : Réponse finale ───────────────────────────────────────────────
  if (!resultUrl) {
    const totalWaitSec = (CONFIG.INITIAL_WAIT_MS + CONFIG.MAX_POLL_ATTEMPTS * CONFIG.POLL_INTERVAL_MS) / 1000;
    console.error(`[${requestId}] ⏰ Timeout : aucun résultat après ${totalWaitSec}s.`);
    return res.status(504).json({
      success: false,
      error:   `Génération trop longue : aucun résultat après ${totalWaitSec}s.`,
    });
  }

  return res.json({ success: true, result_url: resultUrl });
});

// ─── Health-check (utile pour Render) ────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Gestion des erreurs non capturées ───────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠ unhandledRejection :', reason);
});
process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException :', err);
  // Ne pas killer le process sur Render pour une erreur isolée
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`✅ Proxy prêt sur le port ${CONFIG.PORT}`);
  console.log(`   Config : attente initiale=${CONFIG.INITIAL_WAIT_MS}ms | poll=${CONFIG.POLL_INTERVAL_MS}ms | max tentatives=${CONFIG.MAX_POLL_ATTEMPTS}`);
});
