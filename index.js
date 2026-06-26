const express = require('express');
const app = express(); // Création de l'application déclarée ici en premier

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const GRADIO_URL = 'https://sm4ll-vton-sm4ll-vton-demo.hf.space/gradio_api/call/generate';

app.post('/api/tryon', async (req, res) => {
  try {
    const { person_url, garment_url } = req.body;

    // 1. Envoi de la demande à l'API
    const postRes = await fetch(GRADIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          { path: person_url, meta: { _type: "gradio.FileData" } },
          { path: garment_url, meta: { _type: "gradio.FileData" } },
          "eyewear",
          { path: person_url, meta: { _type: "gradio.FileData" } }
        ]
      })
    });

    const postData = await postRes.json();
    const event_id = postData.event_id;
    if (!event_id) throw new Error('No event_id returned');

    // 2. Boucle d'attente du résultat (polling)
    let resultUrl = null;
    let attempts = 0;
    while (!resultUrl && attempts < 25) {
      await new Promise(r => setTimeout(r, 2000)); // Attente 2s
      const streamRes = await fetch(`${GRADIO_URL}/${event_id}`);
      const text = await streamRes.text();
      
      // Extraction de l'URL dans la réponse
      if (text.includes('"process_completed"')) {
         const match = text.match(/"url":"(https:\/\/[^"]+)"/);
         if (match) resultUrl = match[1];
      }
      attempts++;
    }

    if (!resultUrl) throw new Error('Result not ready or parsing failed');

    res.json({ success: true, result_url: resultUrl });
  } catch (err) {
    console.error("PROXY ERROR:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
