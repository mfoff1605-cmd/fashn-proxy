const express = require('express');
const app = express();

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
    console.log("POST BODY:", req.body);

    const { person_url, garment_url } = req.body;

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

    if (!postRes.ok) {
      throw new Error(`Gradio POST failed: ${postRes.status}`);
    }

    const postData = await postRes.json();
    console.log("POST RESPONSE:", postData);

    const event_id = postData.event_id;
    if (!event_id) {
      throw new Error('No event_id returned');
    }

    console.log("EVENT ID:", event_id);

    await new Promise(resolve => setTimeout(resolve, 5000));

    const streamUrl = `${GRADIO_URL}/${event_id}`;
    console.log("STREAM URL:", streamUrl);

    const streamRes = await fetch(streamUrl);

    if (!streamRes.ok) {
      throw new Error(`Gradio GET failed: ${streamRes.status}`);
    }

    const text = await streamRes.text();

    console.log("FULL STREAM:");
    console.log(text);

    if (text.includes("event: error")) {
      throw new Error("Gradio internal error");
    }

    const lines = text.split('\n');
    let resultUrl = null;

    for (const line of lines) {
      if (line.includes('data:')) {
        const payload = line.replace('data:', '').trim();

        try {
          const parsed = JSON.parse(payload);

          if (Array.isArray(parsed) && parsed[0]) {
            if (typeof parsed[0] === 'string' && parsed[0].startsWith('http')) {
              resultUrl = parsed[0];
            }

            if (parsed[0]?.path) {
              resultUrl = parsed[0].path;
            }
          }

          if (typeof parsed === 'string' && parsed.startsWith('http')) {
            resultUrl = parsed;
          }

        } catch (e) {}
      }
    }

    if (!resultUrl) {
      throw new Error('Cannot parse result from Gradio stream');
    }

    res.json({
      success: true,
      result_url: resultUrl
    });

  } catch (err) {
    console.error("PROXY ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
