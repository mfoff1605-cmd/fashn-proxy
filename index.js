let resultUrl = null;

const lines = text.split('\n');

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // on cherche le event complete
  if (line.includes('event: complete')) {

    // la ligne suivante contient le data JSON
    const dataLine = lines[i + 1];

    if (dataLine && dataLine.startsWith('data:')) {
      const jsonStr = dataLine.replace('data:', '').trim();

      try {
        const parsed = JSON.parse(jsonStr);

        if (parsed?.[0]?.url) {
          resultUrl = parsed[0].url;
        } 
        else if (parsed?.[0]?.path) {
          resultUrl = parsed[0].path;
        }

      } catch (e) {
        console.log("JSON parse error:", e);
      }
    }
  }
}
