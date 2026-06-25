const express = require('express');
const app = express();

app.use(express.json());

// CORS pour autoriser Bubble
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const GRADIO_URL = 'https://merve-fashn-vton-1-5.hf.space/gradio_api/call/try_on';

app.post('/api/tryon', async (req, res) => {
  try {
    const { person_url, garment_url, category, photo_type, steps, guidance, seed, segmentation_free } = req.body;

    // Étape 1 : POST pour obtenir l'event_id
    const postRes = await fetch(GRADIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          { path: person_url, meta: { _type: "gradio.FileData" } },
          { path: garment_url, meta: { _type: "gradio.FileData" } },
          category,          // ex: "tops"
          photo_type,        // ex: "model"
          steps,             // ex: 50
          guidance,          // ex: 1.5
          seed,              // ex: 42
          segmentation_free  // ex: true
        ]
      })
    });

    if (!postRes.ok) throw new Error('Gradio POST failed');
    const { event_id } = await postRes.json();
    if (!event_id) throw new Error('No event_id returned');

    // Étape 2 : GET pour récupérer le stream SSE
    const streamRes = await fetch(`${GRADIO_URL}/${event_id}`);
    if (!streamRes.ok) throw new Error('Gradio GET failed');

    const text = await streamRes.text();

    // Parse les lignes SSE (data: ...)
    const lines = text.split('\n');
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload) dataLines.push(payload);
      }
    }

    // Le résultat est dans le dernier "data:" valide
    let resultUrl = null;
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(dataLines[i]);
        // Gradio retourne souvent : [ {path: "..."} ] ou [ "url" ]
        if (Array.isArray(parsed) && parsed[0]) {
          if (typeof parsed[0] === 'string' && parsed[0].startsWith('http')) {
            resultUrl = parsed[0];
            break;
          }
          if (parsed[0].path) {
            resultUrl = parsed[0].path;
            break;
          }
        }
        if (typeof parsed === 'string' && parsed.startsWith('http')) {
          resultUrl = parsed;
          break;
        }
      } catch (e) {
        // ignore non-JSON lines
      }
    }

    if (!resultUrl) throw new Error('Cannot parse result from Gradio stream');

    // Réponse propre pour Bubble
    res.json({ success: true, result_url: resultUrl });

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy Fashn-VTON ready on port ${PORT}`));