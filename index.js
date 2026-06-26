const express = require('express');
const app = express();
app.use(express.json());

const API_BASE = 'https://fashn-ai-fashn-vton-1-5.hf.space/gradio_api';

app.post('/api/tryon', async (req, res) => {
    try {
        const { person_url, garment_url, category, photo_type, steps, guidance, seed, segmentation_free } = req.body;

        // 1. Appel POST pour obtenir l'event_id
        const postRes = await fetch(`${API_BASE}/call/try_on`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [
                    { path: person_url, meta: { _type: "gradio.FileData" } },
                    { path: garment_url, meta: { _type: "gradio.FileData" } },
                    category, photo_type, steps, guidance, seed, segmentation_free
                ]
            })
        });

        const { event_id } = await postRes.json();
        if (!event_id) throw new Error('Aucun event_id reçu');

        // 2. Appel GET pour récupérer le résultat (Event Stream)
        const streamRes = await fetch(`${API_BASE}/call/try_on/${event_id}`);
        const text = await streamRes.text();

        // 3. Extraction de l'URL du résultat
        // Le résultat se trouve dans une ligne "data" sous forme de JSON
        const lines = text.split('\n');
        let resultUrl = null;
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const payload = JSON.parse(line.slice(6));
                // Selon l'API, le résultat est souvent dans le premier élément du tableau
                if (Array.isArray(payload) && payload[0]?.path) {
                    resultUrl = payload[0].path;
                }
            }
        }

        res.json({ success: true, result_url: resultUrl });
    } catch (err) {
        console.error("ERREUR PROXY:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(3000, () => console.log("Proxy en ligne sur le port 3000"));
