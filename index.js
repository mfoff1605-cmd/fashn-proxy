const express = require('express');
const app = express();
app.use(express.json());

const { Client } = require("@gradio/client");

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.post('/api/tryon', async (req, res) => {
  try {
    const { person_url, garment_url, category, photo_type, steps, guidance, seed, segmentation_free } = req.body;

    // Connexion à l'espace HuggingFace
    const client = await Client.connect("merve/fashn-vton-1-5");

    // L'appel .predict gère tout le cycle de vie du stream tout seul
    const result = await client.predict("/tryon", {
      person: { path: person_url },
      garment: { path: garment_url },
      category: category,
      photo_type: photo_type,
      steps: steps,
      guidance: guidance,
      seed: seed,
      segmentation_free: segmentation_free
    });

    // Gradio retourne les résultats dans result.data
    // Selon le modèle, l'image est souvent dans le premier élément
    const resultUrl = result.data[0].url || result.data[0].path;

    res.json({ success: true, result_url: resultUrl });

  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy Fashn-VTON ready on port ${PORT}`));
