// ... (garde le début de ton code avec express, etc.)

app.post('/api/tryon', async (req, res) => {
  try {
    const { person_url, garment_url } = req.body;

    // 1. Lancement de la génération
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

    const { event_id } = await postRes.json();
    if (!event_id) throw new Error('No event_id');

    // 2. BOUCLE DE POLL (On attend la fin)
    let resultUrl = null;
    let attempts = 0;
    while (!resultUrl && attempts < 20) { // On essaie 20 fois
      await new Promise(r => setTimeout(r, 2000)); // Attente 2s entre chaque essai
      const streamRes = await fetch(`${GRADIO_URL}/${event_id}`);
      const text = await streamRes.text();
      
      // On cherche si le résultat final est arrivé dans le texte
      if (text.includes('"process_completed"')) {
         // Logique simplifiée pour extraire l'URL
         const match = text.match(/"url":"(https:\/\/[^"]+)"/);
         if (match) resultUrl = match[1];
      }
      attempts++;
    }

    if (!resultUrl) throw new Error('Result not ready or parsing failed');

    res.json({ success: true, result_url: resultUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
