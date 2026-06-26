const express = require('express');
const app = express();
app.use(express.json());

const API_BASE = 'https://fashn-ai-fashn-vton-1-5.hf.space/gradio_api';

app.post('/api/tryon', async (req, res) => {
    try {
        const { person_url, garment_url, category, photo_type, steps, guidance, seed, segmentation_free } = req.body;

        // 1. Envoi de la requête initiale
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

        const postData = await postRes.json();
        const event_id = postData.event_id;
        if (!event_id) throw new Error('Impossible d\'obtenir un event_id');

        // 2. Récupération du résultat (avec une attente plus longue)
        const streamRes = await fetch(`${API_BASE}/call/try_on/${event_id}`);
        const text = await streamRes.text();

        // 3. Extraction de l'URL (Logique de recherche robuste)
        const lines = text.split('\n');
        let resultUrl = null;

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                try {
                    const parsed = JSON.parse(line.slice(6));
                    // Cherche l'URL dans la structure de Gradio
                    if (parsed && typeof parsed === 'object') {
                        // Parfois l'URL est directement dans un tableau ou un objet path
                        const findUrl = (obj) => {
                            if (obj.path) return obj.path;
                            for (let key in obj) {
                                if (typeof obj[key] === 'object') {
                                    const res = findUrl(obj[key]);
                                    if (res) return res;
                                }
                            }
                            return null;
                        };
                        resultUrl = findUrl(parsed);
                    }
                } catch (e) {}
            }
        }

        res.json({ success: true, result_url: resultUrl });
    } catch (err) {
        console.error("ERREUR:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy actif sur le port ${PORT}`));
