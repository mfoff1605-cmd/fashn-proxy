const express = require('express');
const app = express();
app.use(express.json());

const API_BASE = 'https://fashn-ai-fashn-vton-1-5.hf.space/gradio_api';

app.post('/api/tryon', async (req, res) => {
 try {
     const { person_url, garment_url } = req.body;
     
     // 1. Lancement de la génération
     const postRes = await fetch(`${API_BASE}/call/try_on`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
             data: [
                 { path: person_url, meta: { _type: "gradio.FileData" } },
                 { path: garment_url, meta: { _type: "gradio.FileData" } },
                 "tops", "model", 50, 1.5, 42, true
             ]
         })
     });
     
     const { event_id } = await postRes.json();
     if (!event_id) throw new Error('Erreur au lancement');
     
     // 2. Attente initiale de 20 secondes
     await new Promise(r => setTimeout(r, 20000)); 
     
     // 3. Boucle de vérification (toutes les 2 secondes)
     let resultUrl = null;
     for (let i = 0; i < 20; i++) { // On essaie 20 fois (40 secondes max après les 20 premières)
         const streamRes = await fetch(`${API_BASE}/call/try_on/${event_id}`);
         const text = await streamRes.text();
         
         if (text.includes('process_completed')) {
             const match = text.match(/"path":"(https:\/\/[^"]+)"/);
             if (match) {
                 resultUrl = match[1];
                 break; 
             }
         }
         await new Promise(r => setTimeout(r, 2000)); // Attend 2s entre chaque essai
     }
     
     if (!resultUrl) throw new Error('Génération trop longue ou impossible');
     
     res.json({ success: true, result_url: resultUrl });
 } catch (err) {
     res.status(500).json({ success: false, error: err.message });
 }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy prêt sur le port ${PORT}`));
