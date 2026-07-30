const APP_ID = "bamahub-live";
const PROJECT_ID = "radiobama-hub";
const BASE_DATA_PATH = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/artifacts/${APP_ID}/public/data`;

const CHANNELS = [
  { id: "bama", url: "http://82.145.63.6:4004/status-json.xsl" },
  { id: "gold", url: "http://82.145.63.6:5532/status-json.xsl" },
  { id: "party", url: "http://212.84.160.1:5549/status-json.xsl" }
];

// Păstrăm istoricul în memorie pentru a evita citirile repetate inutile
const memoryHistory = {};

async function mainRobot() {
  console.log(`[${new Date().toLocaleTimeString()}] --- VERIFICARE CANALE ---`);

  for (const channel of CHANNELS) {
    try {
      // AbortController pentru timeout de 5 secunde per request
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(channel.url, { signal: controller.signal }).catch(() => null);
      clearTimeout(timeout);

      if (!response || !response.ok) {
        console.warn(`[${channel.id.toUpperCase()}] SERVER OFFLINE! HTTP Status: ${response ? response.status : 'No Response'}`);
        await saveOffline(channel.id);
        continue;
      }

      const data = await response.json();
      let source = data.icestats?.source;
      if (Array.isArray(source)) source = source[0];

      // Fix compatibilitate Icecast 2.5.0
      if (source && !source.title && source.metadata && source.metadata.x_icy_title) {
        source.title = source.metadata.x_icy_title;
      }

      if (!source || !source.title) {
        console.warn(`[${channel.id.toUpperCase()}] OFFLINE: Sursa nu trimite titlu.`);
        await saveOffline(channel.id);
        continue;
      }

      // 1. Extragere date
      const serverStats = {
        server_name: (source.server_name || "").toString(),
        listeners: (source.listeners || "0").toString(),
        bitrate: (source["ice-bitrate"] || source.bitrate || "0").toString(),
        genre: (source.genre ? fixEncoding(source.genre) : "N/A").toString()
      };

      // 2. Salvare Config
      await saveConfigToFirebase(channel.id, serverStats);

      // 3. Istoric melodi
      let songTitle = cleanSong(fixEncoding(source.title));

      if (songTitle.length >= 3) {
        if (!memoryHistory[channel.id]) {
          memoryHistory[channel.id] = await getHistory(channel.id);
        }

        const currentTrackInHistory = memoryHistory[channel.id].length > 0 ? memoryHistory[channel.id][0].title : "";

        if (songTitle !== currentTrackInHistory) {
          const artUrl = await getAlbumArt(songTitle);
          
          memoryHistory[channel.id].unshift({
            title: songTitle,
            art: artUrl,
            time: Date.now()
          });

          // Păstrăm doar ultimele 10 piese
          memoryHistory[channel.id] = memoryHistory[channel.id].slice(0, 10);

          await saveHistoryToFirebase(channel.id, memoryHistory[channel.id]);
          console.log(`[${channel.id.toUpperCase()}] Piesa noua salvata: ${songTitle}`);
        }
      }

    } catch (error) {
      console.error(`[${channel.id.toUpperCase()}] Eroare critica:`, error.message);
      await saveOffline(channel.id);
    }
  }
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
    console.error(`[${id.toUpperCase()}] Eroare salvat config in Firebase:`, e.message);
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

async function saveOffline(id) {
  await saveConfigToFirebase(id, {
    server_name: "OFFLINE",
    listeners: "0",
    bitrate: "0",
    genre: "NONE"
  });
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
  if (!song || song.toUpperCase().includes("BAMA") || song.length < 5) return defaultImg;
  
  try {
    const res = await fetch("https://itunes.apple.com/search?term=" + encodeURIComponent(song) + "&limit=1&entity=song");
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      return data.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
    }
  } catch (e) {}
  return defaultImg;
}

// Rulare continuă din 5 în 5 secunde
const INTERVAL_SECUNDE = 5;
console.log(`Botul Radio Bama a pornit! Verificare la fiecare ${INTERVAL_SECUNDE} secunde.`);

setInterval(mainRobot, INTERVAL_SECUNDE * 1000);
mainRobot();
