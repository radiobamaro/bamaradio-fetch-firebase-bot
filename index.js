const http = require('http');
const PORT = process.env.PORT || 3000;

// Server HTTP nativ pentru ca Render să detecteze portul deschis și să mențină botul activ 24/7
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Botul Radio BAMA rulează 24/7 și sincronizează Firebase!');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[HTTP] Server pornit pe portul ${PORT}`);
});

// --- 1. CONFIGURAȚIA ---
const APP_ID = "bamahub-live"; 
const PROJECT_ID = "radiobama-hub";
const BASE_DATA_PATH = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artifacts/${APP_ID}/public/data`;

const CHANNELS = [
  { id: "bama", url: "http://82.145.63.6:4004/status-json.xsl" },
  { id: "gold", url: "http://82.145.63.6:5532/status-json.xsl" }, 
  { id: "party", url: "http://212.84.160.1:5549/status-json.xsl" }
];

async function mainRobot() {
  console.log("--- START CICLU VERIFICARE CANALE ---");

  for (const channel of CHANNELS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      const response = await fetch(channel.url, { signal: controller.signal }).catch(() => null);
      clearTimeout(timeout);

      if (!response || !response.ok) {
        console.warn(`[${channel.id.toUpperCase()}] SERVER DOWN! Cod răspuns: ${response ? response.status : 'No Response'}`);
        await saveOffline(channel.id);
        continue;
      }

      const data = await response.json();
      let source = data.icestats ? data.icestats.source : null;
      if (Array.isArray(source)) source = source[0];

      // --- REPARARE COMPATIBILITATE ICECAST 2.5.0 ---
      if (source && !source.title && source.metadata && source.metadata.x_icy_title) {
        source.title = source.metadata.x_icy_title;
      }

      if (!source || !source.title) {
        console.warn(`[${channel.id.toUpperCase()}] OFFLINE: Sursa nu trimite date.`);
        await saveOffline(channel.id);
        continue;
      }

      // --- 1. EXTRACȚIE DATE DIN ICECAST ---
      const serverStats = {
        server_name: (source.server_name || "").toString(),
        listeners: (source.listeners || "0").toString(),
        bitrate: (source["ice-bitrate"] || source.bitrate || "0").toString(),
        genre: (source.genre ? fixEncoding(source.genre) : "N/A").toString()
      };

      // --- 2. ACȚIUNE: SALVARE CONFIGURAȚIE ---
      await saveConfigToFirebase(channel.id, serverStats);
      console.log(`[${channel.id.toUpperCase()}] Config Icecast actualizat: ${serverStats.listeners} ascultători, ${serverStats.bitrate} kbps, Gen: ${serverStats.genre}.`);

      // --- 3. ACȚIUNE: SALVARE ISTORIC ---
      let songTitle = fixEncoding(source.title);
      songTitle = cleanSong(songTitle);

      if (songTitle.length >= 3) {
        const historyList = await getHistory(channel.id);
        const currentTrackInHistory = historyList.length > 0 ? historyList[0].title : "";

        if (songTitle !== currentTrackInHistory) {
          const artUrl = await getAlbumArt(songTitle);
          historyList.unshift({ title: songTitle, art: artUrl, time: Date.now() });

          await saveHistoryToFirebase(channel.id, historyList.slice(0, 10));
          console.log(`[${channel.id.toUpperCase()}] Istoric actualizat. Piesă nouă: ${songTitle}`);
        } else {
          console.log(`[${channel.id.toUpperCase()}] Piesa este aceeași. Fără update în istoric.`);
        }
      }

    } catch (error) {
      const errText = error.toString();
      console.error(`[${channel.id.toUpperCase()}] Eroare critică: ${errText}`);
      await saveOffline(channel.id);
    }
  }

  console.log("--- SFÂRȘIT CICLU VERIFICARE ---");
}

async function saveOffline(id) {
  await saveConfigToFirebase(id, {
    server_name: "OFFLINE",
    listeners: "0",
    bitrate: "0",
    genre: "NONE"
  });
  console.log(`[${id.toUpperCase()}] Status setat pe OFFLINE.`);
}

async function saveConfigToFirebase(id, stats) {
  const url = `${BASE_DATA_PATH}/config_server_icecast/${id}`;
  const payload = {
    fields: {
      server_name: { stringValue: stats.server_name },
      listeners: { stringValue: stats.listeners },
      bitrate: { stringValue: stats.bitrate },
      genre: { stringValue: stats.genre },
      updated: { integerValue: Date.now().toString() }
    }
  };
  try {
    await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error(`[${id.toUpperCase()}] Eroare salvare config:`, e.message);
  }
}

async function getHistory(id) {
  try {
    const res = await fetch(`${BASE_DATA_PATH}/song_history/${id}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.fields || !data.fields.list) return [];
    return data.fields.list.arrayValue.values.map(item => ({
      title: item.mapValue.fields.title.stringValue,
      art: item.mapValue.fields.art.stringValue,
      time: item.mapValue.fields.time ? parseInt(item.mapValue.fields.time.integerValue) : Date.now()
    }));
  } catch (e) {
    return [];
  }
}

async function saveHistoryToFirebase(id, list) {
  const url = `${BASE_DATA_PATH}/song_history/${id}`;
  const payload = {
    fields: {
      list: {
        arrayValue: {
          values: list.map(item => ({
            mapValue: {
              fields: {
                title: { stringValue: item.title },
                art: { stringValue: item.art },
                time: { integerValue: (item.time || Date.now()).toString() }
              }
            }
          }))
        }
      }
    }
  };
  try {
    await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error(`[${id.toUpperCase()}] Eroare salvare istoric:`, e.message);
  }
}

function fixEncoding(t) { 
  try { 
    return decodeURIComponent(escape(t)); 
  } catch (e) { 
    return t; 
  } 
}

function cleanSong(t) { 
  if (!t) return "";

  return t
    .replace(/(https?:\/\/|www\.)\S+/gi, "")
    .replace(/\S+\.(ro|com|net|org|online|site|it|info|me|eu|biz)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s-\s?$/g, "")
    .trim();
}

async function getAlbumArt(song) {
  const defaultImg = "https://radiobamaromania.is-best.net/assets/img/girl-listen-music-bama-vdark.png";
  const s = song.toUpperCase();
  if (!song || s.includes("RADIO BAMA") || s.includes("BAMA") || song.length < 5) return defaultImg;
  try {
    const res = await fetch("https://itunes.apple.com/search?term=" + encodeURIComponent(song) + "&limit=1&entity=song");
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      return data.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
    }
  } catch (e) {}
  return defaultImg;
}

// Verificare din 5 în 5 secunde
const INTERVAL_SECUNDE = 5;
setInterval(mainRobot, INTERVAL_SECUNDE * 1000);
mainRobot();
