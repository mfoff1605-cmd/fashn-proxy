const express = require('express');
const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const GRADIO_URL = 'https://merve-fashn-vton-1-5.hf.space/gradio_api/call/try_on';

app.post('/api/tryon', async (req, res) => {
  try {
    console.log("POST BODY:", req.body);

    const {
      person_url,
      garment_url,
      category,
      photo_type,
      steps,
      guidance,
      seed,
      segmentation_free
    } = req.body;

    // STEP 1: POST to Gradio
    const postRes = await fetch(GRADIO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          { path: person_url, meta: { _type: "gradio.FileData" } },
          { path: garment_url, meta: { _type: "gradio.FileData" } },
          category,
          photo_type,
          steps,
          guidance,
          seed,
          segmentation_free
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

    // WAIT before GET
    await new Promise(resolve => setTimeout(resolve, 7000));

    // STEP 2: GET stream
    const streamUrl = `${GRADIO_URL}/${event_id}`;
    console.log("STREAM URL:", streamUrl);

    const streamRes = await fetch(streamUrl);

    if (!streamRes.ok) {
      throw new Error(`Gradio GET failed: ${streamRes.status}`);
    }

    const text = await streamRes.text();

    console.log("FULL STREAM:");
    console.log(text);

    const lines = text.split('\n');
    const dataLines = [];

    for (const line of lines) {
      console.log("LINE:", line);

      if (line.includes('data:')) {
        const payload = line.replace('data:', '').trim();
        if (payload) dataLines.push(payload);
      }
    }

    console.log("DATA LINES:", dataLines);

    let resultUrl = null;

    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(dataLines[i]);
        console.log("PARSED:", parsed);

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
        console.log("PARSE FAIL:", dataLines[i]);
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
