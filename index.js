const {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const express = require('express');
const path = require('path');
const fs = require('fs');

// ==========================================
// LOGS
// ==========================================

let systemLogs = [];

function logEvent(msg, esError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const prefijo = esError ? '[ERROR ❌]' : '[INFO ℹ️]';
  const entry = `[${timestamp}] ${prefijo} ${msg}`;

  if (esError) console.error(entry);
  else console.log(entry);

  systemLogs.unshift(entry);

  if (systemLogs.length > 80) {
    systemLogs.pop();
  }
}

process.on('unhandledRejection', reason => {
  logEvent(
    `Promesa no manejada: ${reason?.stack || reason}`,
    true
  );
});

process.on('uncaughtException', err => {
  logEvent(
    `Excepción no capturada: ${err?.stack || err?.message || err}`,
    true
  );
});

// ==========================================
// CONFIGURACIÓN
// ==========================================

const featureToggles = {
  audio: true,
  memes: true,
  gifs: true,
  webChat: true,
  reactions: true,
  memory: true
};

const CONFIG = {
  maxChannelMessages: 30,
  maxMemoriesInPrompt: 12,
  maxMemoryLength: 500,
  memoryCooldownMs: 15000,

  // Muy raro a propósito.
  spontaneousReactionChance: 0.012,

  // Reacciones aún más raras cuando Klint decide reaccionar.
  reactionCooldownMs: 45000,

  maxGifResults: 20,
  maxImageBytes: 8 * 1024 * 1024
};

const memoryCooldowns = new Map();
let lastSpontaneousReactionAt = 0;

function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent(
      `Error cargando system_instruction.txt: ${error.message}`,
      true
    );

    return `
Eres Klint.
Hablas de forma casual, natural y corta.
No suenas como un asistente.
No explicas que eres una IA salvo que sea necesario.
Usas minúsculas normalmente.
Puedes usar xd, jaja, emojis y reacciones naturales sin abusar.
    `.trim();
  }
}

function obtenerFirebaseUrl() {
  let url = process.env.FIREBASE_DATABASE_URL || '';

  const matchMarkdown = url.match(/\((https?:\/\/[^\)]+)\)/);
  if (matchMarkdown) {
    url = matchMarkdown[1];
  }

  url = url.replace(/[\[\]()'"]/g, '').trim();

  if (url && !url.startsWith('http')) {
    url = `https://${url}`;
  }

  return url.replace(/\/+$/, '');
}

// ==========================================
// EXPRESS
// ==========================================

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function validarKey(req, res, next) {
  const { key } = req.body || {};
  const claveCorrecta =
    process.env.saidkey ||
    process.env.SAIDKEY;

  if (key && claveCorrecta && key === claveCorrecta) {
    return next();
  }

  return res.status(401).json({
    error: 'Clave no autorizada'
  });
}

app.post('/api/login', validarKey, (req, res) => {
  res.json({ success: true });
});

app.post('/api/stats', validarKey, (req, res) => {
  res.json({
    guilds: client.guilds.cache.size,
    ping: client.ws.ping,
    toggles: featureToggles,
    memoryUsers: memoryCache.size
  });
});

app.post('/api/get-prompt', validarKey, (req, res) => {
  res.json({
    prompt: cargarSystemInstruction()
  });
});

app.post('/api/save-prompt', validarKey, (req, res) => {
  try {
    if (typeof req.body.prompt !== 'string') {
      return res.status(400).json({
        error: 'Prompt inválido'
      });
    }

    fs.writeFileSync(
      path.join(__dirname, 'system_instruction.txt'),
      req.body.prompt,
      'utf8'
    );

    logEvent('System instruction actualizado desde la web.');

    res.json({ success: true });
  } catch (err) {
    logEvent(
      `Error guardando prompt: ${err.message}`,
      true
    );

    res.status(500).json({
      error: 'No se pudo guardar el archivo'
    });
  }
});

app.post('/api/get-logs', validarKey, (req, res) => {
  res.json({
    logs: systemLogs
  });
});

app.post('/api/force-status', validarKey, async (req, res) => {
  await actualizarEstadoIA();
  res.json({ success: true });
});

app.post('/api/toggle-feature', validarKey, (req, res) => {
  const { feature, value } = req.body || {};

  if (
    Object.prototype.hasOwnProperty.call(
      featureToggles,
      feature
    )
  ) {
    featureToggles[feature] = Boolean(value);

    logEvent(
      `Feature '${feature}' cambiado a: ${featureToggles[feature]}`
    );

    return res.json({
      success: true,
      toggles: featureToggles
    });
  }

  res.status(400).json({
    error: 'La función especificada no existe'
  });
});

app.post('/api/get-memories', validarKey, async (req, res) => {
  const dbUrl = obtenerFirebaseUrl();

  if (!dbUrl) {
    return res.json({ users: {} });
  }

  try {
    const response = await fetch(
      `${dbUrl}/usuarios.json`
    );

    if (!response.ok) {
      throw new Error(`Firebase HTTP ${response.status}`);
    }

    const data = await response.json();

    res.json({
      users: data || {}
    });
  } catch (err) {
    logEvent(
      `Error leyendo Firebase: ${err.message}`,
      true
    );

    res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/delete-memory', validarKey, async (req, res) => {
  const { userId, memoryKey } = req.body || {};
  const dbUrl = obtenerFirebaseUrl();

  if (!dbUrl) {
    return res.status(400).json({
      error: 'Sin base de datos'
    });
  }

  if (!userId || !memoryKey) {
    return res.status(400).json({
      error: 'Faltan datos'
    });
  }

  try {
    await fetch(
      `${dbUrl}/usuarios/${encodeURIComponent(userId)}/memorias/${encodeURIComponent(memoryKey)}.json`,
      {
        method: 'DELETE'
      }
    );

    memoryCache.delete(String(userId));

    logEvent(
      `Memoria ${memoryKey} eliminada de ${userId}`
    );

    res.json({
      success: true
    });
  } catch (err) {
    logEvent(
      `Error borrando memoria: ${err.message}`,
      true
    );

    res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/send-discord-msg', validarKey, async (req, res) => {
  const { channelId, message } = req.body || {};

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased()) {
      return res.status(400).json({
        error: 'Canal no encontrado o no es de texto'
      });
    }

    await channel.send(String(message || ''));

    logEvent(
      `Mensaje enviado desde la web al canal ${channelId}`
    );

    res.json({
      success: true
    });
  } catch (err) {
    logEvent(
      `Error enviando mensaje: ${err.message}`,
      true
    );

    res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/deep-reset', validarKey, async (req, res) => {
  logEvent('Iniciando limpieza profunda...');

  systemLogs = [];

  memoryCache.clear();
  memoryCooldowns.clear();
  tttGames.clear();

  if (global.gc) {
    try {
      global.gc();
    } catch {}
  }

  const deployHookUrl =
    process.env.RENDER_DEPLOY_HOOK_URL;

  if (deployHookUrl) {
    try {
      const response = await fetch(
        deployHookUrl,
        {
          method: 'POST'
        }
      );

      if (response.ok) {
        logEvent(
          'Re-deploy activado en Render.'
        );

        return res.json({
          success: true,
          message:
            'Reinicio profundo completado y re-despliegue en curso.'
        });
      }
    } catch (err) {
      logEvent(
        `Error con Deploy Hook: ${err.message}`,
        true
      );
    }
  }

  res.json({
    success: true,
    message: 'Limpieza de RAM completada.'
  });
});

app.post('/api/web-chat', async (req, res) => {
  if (!featureToggles.webChat) {
    return res.json({
      response:
        'el chat web está pausado temporalmente.'
    });
  }

  try {
    const {
      message,
      count,
      imageUrl
    } = req.body || {};

    if (Number(count) > 15) {
      return res.json({
        response:
          'has alcanzado el límite de 15 mensajes de prueba.'
      });
    }

    const adjuntos = imageUrl
      ? [
          {
            contentType: 'image/png',
            url: imageUrl
          }
        ]
      : [];

    const resultado = await procesarRespuestaIA(
      null,
      message || 'hola',
      adjuntos,
      true,
      {
        username: 'UsuarioWeb',
        displayName: 'UsuarioWeb',
        id: 'web_guest'
      },
      null
    );

    res.json({
      response: resultado.respuesta,
      gifBinario: null,
      memeImagenUrl: resultado.memeImagenUrl,
      audioUrl: resultado.audioUrl,
      remaining: 15 - Number(count || 0)
    });
  } catch (err) {
    logEvent(
      `Error en Web Chat: ${err.message}`,
      true
    );

    res.status(500).json({
      response:
        'error procesando la solicitud web.'
    });
  }
});

app.listen(PORT, () => {
  logEvent(
    `Servidor HTTP activo en puerto ${PORT}`
  );
});

// ==========================================
// AUTOPING RENDER
// ==========================================

setInterval(() => {
  fetch(
    'https://klint-gxww.onrender.com'
  )
    .then(() => {
      logEvent('Self-ping exitoso.');
    })
    .catch(err => {
      logEvent(
        `Fallo en self-ping: ${err.message}`,
        true
      );
    });
}, 10 * 60 * 1000);

// ==========================================
// DISCORD CLIENT
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],

  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember,
    Partials.Reaction
  ]
});

// ==========================================
// SLASH COMMANDS
// ==========================================

const commands = [
  new SlashCommandBuilder()
    .setName('klint')
    .setDescription('Habla con Klint')
    .addStringOption(option =>
      option
        .setName('pregunta')
        .setDescription(
          'Lo que quieres decirle a Klint'
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription(
      'Muestra el diagnóstico de Klint'
    ),

  new SlashCommandBuilder()
    .setName('ofertas')
    .setDescription(
      'Busca ofertas actuales de juegos'
    ),

  new SlashCommandBuilder()
    .setName('juego')
    .setDescription(
      'Juega Tres en Raya contra Klint'
    )
].map(command => command.toJSON());

// ==========================================
// READY
// ==========================================

client.once('clientReady', async () => {
  logEvent(
    `Klint ha iniciado sesión como ${client.user.tag}`
  );

  const rest = new REST({
    version: '10'
  }).setToken(
    process.env.DISCORD_TOKEN
  );

  try {
    await rest.put(
      Routes.applicationCommands(
        client.user.id
      ),
      {
        body: commands
      }
    );

    logEvent(
      'Comandos Slash sincronizados.'
    );
  } catch (error) {
    logEvent(
      `Error registrando comandos: ${error.message}`,
      true
    );
  }

  await actualizarEstadoIA();
  programarCambioEstadoRandom();
});

// ==========================================
// ESTADO ALEATORIO
// ==========================================

function programarCambioEstadoRandom() {
  const minutosRandom =
    Math.floor(Math.random() * 14) + 7;

  logEvent(
    `Siguiente cambio de estado en ${minutosRandom} minutos.`
  );

  setTimeout(
    async () => {
      await actualizarEstadoIA();
      programarCambioEstadoRandom();
    },
    minutosRandom * 60 * 1000
  );
}

async function actualizarEstadoIA(
  peticionManual = null
) {
  try {
    let promptEstado = `
Genera un estado personalizado de Discord para una persona llamada Klint.

Debe parecer escrito espontáneamente por una persona.
Máximo 5 palabras.
Minúsculas.
Sin comillas.
Sin punto final.
Puede ser algo cotidiano, absurdo, gracioso, relacionado con juegos,
música, sueño, aburrimiento, internet o simplemente algo random.

NO pongas "(estado)".
NO pongas "estado:".
NO expliques nada.
Devuelve solamente el estado.
    `.trim();

    if (peticionManual) {
      promptEstado = `
Genera un estado personalizado de Discord basado en:
"${peticionManual}"

Máximo 5 palabras.
Minúsculas.
Sin comillas.
Sin "estado:".
Devuelve solamente el estado.
      `.trim();
    }

    let textoGenerado =
      await consultarGemini(
        [{ text: promptEstado }],
        30
      );

    let textoEstado = limpiarTextoIA(
      textoGenerado
    )
      .replace(/^estado\s*:\s*/i, '')
      .replace(/^\(?estado\)?\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    if (!textoEstado) {
      textoEstado = 'pensando en la nada';
    }

    // Discord Custom Status usa state.
    client.user.setPresence({
      status: [
        'online',
        'idle',
        'dnd'
      ][
        Math.floor(Math.random() * 3)
      ],

      activities: [
        {
          type: ActivityType.Custom,
          state: textoEstado
        }
      ]
    });

    logEvent(
      `Estado actualizado: "${textoEstado}"`
    );
  } catch (error) {
    logEvent(
      `Error actualizando presencia: ${error.message}`,
      true
    );
  }
}

// ==========================================
// GIFS GIPHY
// ==========================================

const GIFS_FALLBACK = [
  'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif',
  'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif',
  'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif'
];

function normalizarBusquedaGif(texto) {
  return String(texto || '')
    .replace(
      /\b(gif|meme|manda|envia|envíame|pasa|dame|busca)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function obtenerGifBinario(busqueda) {
  if (!featureToggles.gifs) {
    return null;
  }

  const apiKey =
    process.env.GIPHY_API_KEY;

  if (!apiKey) {
    logEvent(
      'GIPHY_API_KEY no está configurada.',
      true
    );

    return null;
  }

  const termino =
    normalizarBusquedaGif(busqueda) ||
    'funny reaction';

  try {
    const url =
      `https://api.giphy.com/v1/gifs/search` +
      `?api_key=${encodeURIComponent(apiKey)}` +
      `&q=${encodeURIComponent(termino)}` +
      `&limit=${CONFIG.maxGifResults}` +
      `&rating=pg-13` +
      `&lang=es`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `GIPHY HTTP ${response.status}`
      );
    }

    const data = await response.json();

    const resultados =
      Array.isArray(data.data)
        ? data.data
        : [];

    if (!resultados.length) {
      throw new Error(
        `GIPHY no encontró "${termino}"`
      );
    }

    // Filtrar resultados con URL válida.
    const validos = resultados.filter(
      gif =>
        gif?.images?.original?.url ||
        gif?.images?.downsized?.url ||
        gif?.images?.fixed_height?.url
    );

    if (!validos.length) {
      throw new Error(
        'GIPHY devolvió resultados sin imágenes.'
      );
    }

    // Escogemos entre varios resultados para evitar repetir siempre el primero.
    const candidatos =
      validos.slice(
        0,
        Math.min(10, validos.length)
      );

    const elegido =
      candidatos[
        Math.floor(
          Math.random() * candidatos.length
        )
      ];

    const gifUrl =
      elegido.images?.downsized?.url ||
      elegido.images?.original?.url ||
      elegido.images?.fixed_height?.url;

    if (!gifUrl) {
      throw new Error(
        'GIF sin URL compatible.'
      );
    }

    const gifResponse =
      await fetch(gifUrl);

    if (!gifResponse.ok) {
      throw new Error(
        `Error descargando GIF HTTP ${gifResponse.status}`
      );
    }

    const arrayBuffer =
      await gifResponse.arrayBuffer();

    const buffer =
      Buffer.from(arrayBuffer);

    if (buffer.length > CONFIG.maxImageBytes) {
      throw new Error(
        'El GIF supera el límite de tamaño.'
      );
    }

    logEvent(
      `[GIPHY] GIF obtenido: "${termino}"`
    );

    return new AttachmentBuilder(
      buffer,
      {
        name: 'klint.gif'
      }
    );
  } catch (err) {
    logEvent(
      `[GIPHY] Falló "${termino}": ${err.message}`,
      true
    );

    // Fallback.
    try {
      const fallbackUrl =
        GIFS_FALLBACK[
          Math.floor(
            Math.random() *
              GIFS_FALLBACK.length
          )
        ];

      const fallback =
        await fetch(fallbackUrl);

      if (!fallback.ok) {
        return null;
      }

      const buffer =
        Buffer.from(
          await fallback.arrayBuffer()
        );

      return new AttachmentBuilder(
        buffer,
        {
          name: 'klint_fallback.gif'
        }
      );
    } catch {
      return null;
    }
  }
}

// ==========================================
// MEMES
// ==========================================

function generarUrlMemeImagen(textoMeme) {
  if (!featureToggles.memes) {
    return null;
  }

  try {
    const plantillas = [
      'doge',
      'drake',
      'fry',
      'buzz',
      'fine',
      'distracted',
      'spenser',
      'cryingfloor',
      'disastergirl',
      'facepalm',
      'pawn-stars',
      'success',
      'twobuttons',
      'change-my-mind',
      'expanding-brain',
      'always-has-been'
    ];

    const plantilla =
      plantillas[
        Math.floor(
          Math.random() *
            plantillas.length
        )
      ];

    let textoArriba = 'cuando';
    let textoAbajo =
      textoMeme || 'pasa xd';

    if (String(textoMeme).includes('|')) {
      const partes =
        String(textoMeme).split('|');

      textoArriba =
        partes[0]?.trim() ||
        'cuando';

      textoAbajo =
        partes.slice(1).join('|').trim() ||
        'pasa xd';
    }

    const limpiarMeme = texto =>
      encodeURIComponent(
        String(texto)
          .replace(/[^\p{L}\p{N}\s!?¿¡.,]/gu, '')
          .replace(/\s+/g, '_')
          .slice(0, 90) ||
          'xd'
      );

    return (
      `https://api.memegen.link/images/` +
      `${plantilla}/` +
      `${limpiarMeme(textoArriba)}/` +
      `${limpiarMeme(textoAbajo)}.png`
    );
  } catch (err) {
    logEvent(
      `Error generando meme: ${err.message}`,
      true
    );

    return null;
  }
}

// ==========================================
// AUDIO
// ==========================================

function obtenerUrlAudioVozNativo(texto) {
  if (!featureToggles.audio) {
    return null;
  }

  try {
    const textoLimpio =
      String(texto || '')
        .replace(/<[^>]*>?/gm, '')
        .replace(/[\*\_\`\#\[\]]/g, '')
        .slice(0, 150)
        .trim();

    if (!textoLimpio) {
      return null;
    }

    return (
      'https://api.streamelements.com/' +
      'kappa/v2/speech?voice=Mia&text=' +
      encodeURIComponent(textoLimpio)
    );
  } catch (err) {
    logEvent(
      `Error generando audio: ${err.message}`,
      true
    );

    return null;
  }
}

// ==========================================
// FIREBASE MEMORIA
// ==========================================

const memoryCache = new Map();

async function firebaseRequest(
  userId,
  method = 'GET',
  body = undefined
) {
  const dbUrl =
    obtenerFirebaseUrl();

  if (!dbUrl) {
    return null;
  }

  const url =
    `${dbUrl}/usuarios/${encodeURIComponent(
      userId
    )}.json`;

  const options = {
    method,
    headers: {
      'Content-Type':
        'application/json'
    }
  };

  if (body !== undefined) {
    options.body =
      JSON.stringify(body);
  }

  const response =
    await fetch(url, options);

  if (!response.ok) {
    throw new Error(
      `Firebase HTTP ${response.status}`
    );
  }

  if (method === 'DELETE') {
    return true;
  }

  return await response.json();
}

async function obtenerMemoriaUsuario(userId) {
  if (!userId) {
    return null;
  }

  const key = String(userId);

  if (memoryCache.has(key)) {
    return memoryCache.get(key);
  }

  try {
    const data =
      await firebaseRequest(
        key,
        'GET'
      );

    if (data) {
      memoryCache.set(
        key,
        data
      );
    }

    return data;
  } catch (err) {
    logEvent(
      `Error leyendo memoria Firebase: ${err.message}`,
      true
    );

    return null;
  }
}

async function guardarMemoria(
  userId,
  memoria
) {
  const dbUrl =
    obtenerFirebaseUrl();

  if (!dbUrl || !userId) {
    return false;
  }

  try {
    const memoryUrl =
      `${dbUrl}/usuarios/${encodeURIComponent(
        userId
      )}/memorias.json`;

    const response =
      await fetch(
        memoryUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },
          body: JSON.stringify({
            ...memoria,
            fecha:
              new Date().toISOString()
          })
        }
      );

    if (!response.ok) {
      throw new Error(
        `Firebase HTTP ${response.status}`
      );
    }

    memoryCache.delete(
      String(userId)
    );

    return true;
  } catch (err) {
    logEvent(
      `Error guardando memoria: ${err.message}`,
      true
    );

    return false;
  }
}

async function actualizarPerfil(
  userId,
  username,
  displayName
) {
  const dbUrl =
    obtenerFirebaseUrl();

  if (!dbUrl || !userId) {
    return;
  }

  try {
    await fetch(
      `${dbUrl}/usuarios/${encodeURIComponent(
        userId
      )}/perfil.json`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify({
          username,
          displayName,
          ultimaConexion:
            new Date().toISOString()
        })
      }
    );

    memoryCache.delete(
      String(userId)
    );
  } catch (err) {
    logEvent(
      `Error actualizando perfil: ${err.message}`,
      true
    );
  }
}

function limpiarMemoriaTexto(texto) {
  return String(texto || '')
    .replace(/\s+/g, ' ')
    .replace(/["'`]/g, '')
    .trim()
    .slice(
      0,
      CONFIG.maxMemoryLength
    );
}

function extraerJsonIA(texto) {
  const limpio =
    String(texto || '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

  const inicio =
    limpio.indexOf('{');

  const fin =
    limpio.lastIndexOf('}');

  if (
    inicio === -1 ||
    fin === -1 ||
    fin <= inicio
  ) {
    return null;
  }

  try {
    return JSON.parse(
      limpio.slice(
        inicio,
        fin + 1
      )
    );
  } catch {
    return null;
  }
}

async function evaluarYGuardarMemoria(
  user,
  mensajeUsuario
) {
  if (
    !featureToggles.memory ||
    !user ||
    user.id === 'web_guest'
  ) {
    return;
  }

  const texto =
    String(mensajeUsuario || '').trim();

  if (
    texto.length < 8 ||
    texto.length > 1000
  ) {
    return;
  }

  const userId =
    String(user.id);

  const ahora =
    Date.now();

  const ultimo =
    memoryCooldowns.get(userId) || 0;

  if (
    ahora - ultimo <
    CONFIG.memoryCooldownMs
  ) {
    return;
  }

  memoryCooldowns.set(
    userId,
    ahora
  );

  try {
    const prompt = `
Analiza este mensaje de un usuario para decidir si Klint debería recordarlo a largo plazo.

Mensaje:
"${texto}"

Guarda SOLO información que probablemente siga siendo útil en futuras conversaciones:
- gustos o preferencias
- juegos, series, música, hobbies
- proyectos que está haciendo
- cosas importantes que está aprendiendo o intentando hacer
- preferencias sobre cómo hablarle
- relaciones o personas mencionadas cuando sean relevantes
- datos recurrentes que ayuden a entenderlo

NO guardes:
- contraseñas
- tokens
- API keys
- datos bancarios
- direcciones exactas
- información extremadamente sensible
- cosas triviales de un solo momento
- insultos aislados
- mensajes normales sin información útil

Devuelve SOLO JSON válido:

{
  "guardar": true,
  "categoria": "gusto|proyecto|juego|musica|personalidad|preferencia|relacion|otro",
  "resumen": "frase corta y útil",
  "importancia": 1
}

Si no merece recordarse:

{
  "guardar": false
}

La importancia debe ser de 1 a 10.
    `.trim();

    const resultado =
      await consultarGemini(
        [{ text: prompt }],
        120
      );

    const datos =
      extraerJsonIA(resultado);

    if (
      !datos ||
      datos.guardar !== true ||
      !datos.resumen
    ) {
      return;
    }

    const categoria =
      String(
        datos.categoria ||
        'otro'
      )
        .toLowerCase()
        .slice(0, 40);

    const importancia =
      Math.max(
        1,
        Math.min(
          10,
          Number(
            datos.importancia
          ) || 5
        )
      );

    const resumen =
      limpiarMemoriaTexto(
        datos.resumen
      );

    if (!resumen) {
      return;
    }

    await guardarMemoria(
      userId,
      {
        categoria,
        resumen,
        importancia,
        origen: 'conversacion'
      }
    );

    logEvent(
      `[MEMORIA] ${user.username}: ${categoria} -> ${resumen}`
    );
  } catch (err) {
    logEvent(
      `Error evaluando memoria: ${err.message}`,
      true
    );
  }
}

function obtenerMemoriasUtiles(datosFirebase) {
  if (
    !datosFirebase ||
    !datosFirebase.memorias
  ) {
    return [];
  }

  const memorias =
    Object.values(
      datosFirebase.memorias
    )
      .filter(
        m =>
          m &&
          m.resumen
      )
      .map(m => ({
        resumen:
          limpiarMemoriaTexto(
            m.resumen
          ),
        categoria:
          m.categoria ||
          'otro',
        importancia:
          Number(
            m.importancia
          ) || 5,
        fecha:
          m.fecha || ''
      }))
      .sort(
        (a, b) =>
          b.importancia -
            a.importancia ||
          String(b.fecha).localeCompare(
            String(a.fecha)
          )
      );

  return memorias.slice(
    0,
    CONFIG.maxMemoriesInPrompt
  );
}

// ==========================================
// PRESENCIA
// ==========================================

async function obtenerPresenciaDetallada(
  user,
  guild = null
) {
  if (!user) {
    return 'usuario desconocido';
  }

  let member = null;

  if (guild) {
    try {
      member =
        await guild.members.fetch(
          user.id
        );
    } catch {}
  } else {
    for (const g of client.guilds.cache.values()) {
      try {
        member =
          await g.members.fetch(
            user.id
          );

        if (
          member?.presence
        ) {
          break;
        }
      } catch {}
    }
  }

  if (
    !member ||
    !member.presence
  ) {
    return 'Conexión: Offline / Invisible';
  }

  const pres =
    member.presence;

  const statusMap = {
    online: '🟢 En línea',
    idle: '🌙 Ausente',
    dnd: '🔴 No molestar',
    offline: '⚪ Desconectado'
  };

  const estadoConexion =
    statusMap[pres.status] ||
    '🟢 En línea';

  const detalles = [
    `Estado: ${estadoConexion}`
  ];

  if (
    pres.activities &&
    pres.activities.length
  ) {
    for (const act of pres.activities) {
      if (
        act.type === 4 ||
        act.type === ActivityType.Custom
      ) {
        if (act.state) {
          detalles.push(
            `Perfil: "${act.state}"`
          );
        }
      } else if (
        act.name === 'Spotify'
      ) {
        detalles.push(
          `Escuchando Spotify: "${act.details}" de ${act.state}`
        );
      } else if (act.name) {
        detalles.push(
          `Jugando: "${act.name}"`
        );
      }
    }
  }

  return detalles.join(' | ');
}

// ==========================================
// GEMINI
// ==========================================

const MODELOS_FALLBACK = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

async function consultarGemini(
  parts,
  maxTokens = 200,
  opciones = {}
) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY no configurada.'
    );
  }

  let ultimoError = null;

  for (
    let i = 0;
    i < MODELOS_FALLBACK.length;
    i++
  ) {
    const modelo =
      MODELOS_FALLBACK[i];

    try {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const body = {
        contents: [
          {
            parts
          }
        ],

        generationConfig: {
          maxOutputTokens:
            maxTokens,
          temperature:
            opciones.temperature ??
            0.85
        }
      };

      // Búsqueda web solo cuando se solicita explícitamente.
      if (opciones.webSearch) {
        body.tools = [
          {
            google_search: {}
          }
        ];
      }

      const response =
        await fetch(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body:
              JSON.stringify(body)
          }
        );

      const data =
        await response.json();

      if (
        response.ok &&
        data.candidates?.[0]?.content?.parts
      ) {
        const texto =
          data.candidates[0]
            .content.parts
            .map(
              p => p.text || ''
            )
            .join('')
            .trim();

        if (texto) {
          if (i > 0) {
            logEvent(
              `Gemini fallback usado: ${modelo}`
            );
          }

          return texto;
        }
      }

      ultimoError =
        data.error?.message ||
        `HTTP ${response.status}`;
    } catch (err) {
      ultimoError =
        err.message;
    }
  }

  throw new Error(
    `Error en Gemini: ${ultimoError}`
  );
}

// ==========================================
// UTILIDADES IA
// ==========================================

function limpiarTextoIA(texto) {
  return String(texto || '')
    .replace(/<[^>]*>?/gm, '')
    .replace(
      /```(?:text|txt)?/gi,
      ''
    )
    .replace(/```/g, '')
    .trim();
}

function detectarBusquedaWeb(texto) {
  return /\b(
    busca\s+en\s+(internet|la\s+web|google)|
    busca\s+en\s+la\s+web|
    busca\s+online|
    búscalo\s+en\s+internet|
    buscalo\s+en\s+internet|
    investiga|
    averigua\s+en\s+internet|
    qué\s+pasó\s+con|
    que\s+pasó\s+con|
    últimas\s+noticias|
    ultimas\s+noticias|
    noticia|
    noticias
  )\b/ix.test(texto);
}

function detectarGif(texto) {
  return /\b(
    gif,
    manda\s+un\s+gif,
    pásame\s+un\s+gif,
    pasame\s+un\s+gif,
    envía\s+un\s+gif,
    envia\s+un\s+gif,
    dame\s+un\s+gif,
    busca\s+un\s+gif
  )\b/ix.test(texto);
}

function detectarMeme(texto) {
  return /\b(
    crea\s+un\s+meme,
    haz\s+un\s+meme,
    hacer\s+un\s+meme,
    genera\s+un\s+meme,
    generar\s+meme,
    meme\s+en\s+imagen
  )\b/ix.test(texto);
}

function detectarAudio(texto) {
  return /\b(
    manda\s+un\s+audio,
    manda\s+audio,
    nota\s+de\s+voz,
    dilo\s+en\s+audio,
    audio
  )\b/ix.test(texto);
}

function detectarInvitacionLlamada(texto) {
  return /discord\.(gg|com\/invite)|únete|unete|entra\s+a\s+la\s+llamada|ven\s+a\s+voz/i.test(
    texto
  );
}

// ==========================================
// REACCIONES DEL HISTORIAL
// ==========================================

function formatearReacciones(message) {
  if (
    !message?.reactions?.cache?.size
  ) {
    return '';
  }

  const reacciones =
    message.reactions.cache
      .map(reaction => {
        const emoji =
          reaction.emoji?.name ||
          reaction.emoji?.toString() ||
          '?';

        return `${emoji} x${reaction.count || 0}`;
      })
      .join(', ');

  return reacciones
    ? ` [Reacciones: ${reacciones}]`
    : '';
}

// ==========================================
// PROCESAMIENTO IA CENTRAL
// ==========================================

async function procesarRespuestaIA(
  canal,
  promptUsuario,
  adjuntos = [],
  esDM = false,
  usuarioAutor = null,
  guild = null
) {
  try {
    const systemInstruction =
      cargarSystemInstruction();

    const presenciaAutor =
      await obtenerPresenciaDetallada(
        usuarioAutor,
        guild
      );

    let historialFormateado = '';
    let conteoPrevio = 0;

    if (canal) {
      try {
        const mensajesPrevios =
          await canal.messages.fetch({
            limit:
              CONFIG.maxChannelMessages
          });

        conteoPrevio =
          mensajesPrevios.size;

        historialFormateado =
          mensajesPrevios
            .reverse()
            .map(m => {
              let extra = '';

              if (
                m.attachments.size
              ) {
                extra +=
                  ` [Archivo/imagen: ${m.attachments.first().url}]`;
              }

              if (
                m.stickers.size
              ) {
                extra +=
                  ` [Sticker: ${m.stickers.first().name}]`;
              }

              extra +=
                formatearReacciones(m);

              return (
                `${m.author.username} (<@${m.author.id}>): ` +
                `${m.content || '[sin texto]'}` +
                extra
              );
            })
            .join('\n');
      } catch (err) {
        logEvent(
          `No se pudo obtener historial: ${err.message}`,
          true
        );
      }
    }

    // ------------------------------
    // MEMORIA
    // ------------------------------

    let contextoMemoriaAutor = '';

    if (
      usuarioAutor &&
      usuarioAutor.id !== 'web_guest'
    ) {
      const datosFirebase =
        await obtenerMemoriaUsuario(
          usuarioAutor.id
        );

      const memorias =
        obtenerMemoriasUtiles(
          datosFirebase
        );

      const perfil =
        datosFirebase?.perfil;

      if (
        perfil ||
        memorias.length
      ) {
        contextoMemoriaAutor =
          '\nMEMORIA A LARGO PLAZO DEL USUARIO:\n';

        if (perfil) {
          contextoMemoriaAutor +=
            `- Usuario: ${perfil.username || usuarioAutor.username}\n`;

          if (perfil.displayName) {
            contextoMemoriaAutor +=
              `- Apodo: ${perfil.displayName}\n`;
          }
        }

        for (const memoria of memorias) {
          contextoMemoriaAutor +=
            `- [${memoria.categoria}] ${memoria.resumen}\n`;
        }
      }
    }

    // ------------------------------
    // DETECTORES
    // ------------------------------

    const pideGifExplicitamente =
      detectarGif(promptUsuario);

    const pideMemeImagen =
      detectarMeme(promptUsuario);

    const pideAudio =
      detectarAudio(promptUsuario);

    const quiereBusquedaWeb =
      detectarBusquedaWeb(
        promptUsuario
      );

    const esInvitacionLlamada =
      detectarInvitacionLlamada(
        promptUsuario
      );

    let instruccionExtra = '';

    if (esInvitacionLlamada) {
      instruccionExtra += `
REGLA DE INVITACIÓN:
El usuario está hablando de una llamada o invitación.
Responde como Klint, no como un asistente virtual.
      `;
    }

    if (pideAudio) {
      instruccionExtra += `
REGLA DE AUDIO:
Escribe una frase corta y natural.
No escribas explicaciones.
      `;
    }

    if (pideMemeImagen) {
      instruccionExtra += `
REGLA DE MEME:
Usa exactamente:
[GENERAR_MEME: texto arriba | texto abajo]

El tag no debe aparecer en el mensaje visible.
      `;
    }

    if (pideGifExplicitamente) {
      instruccionExtra += `
REGLA DE GIF:
Usa exactamente:
[BUSCAR_GIF: palabras clave]

Elige palabras clave sencillas.
El tag no debe aparecer en el mensaje visible.
      `;
    }

    if (quiereBusquedaWeb) {
      instruccionExtra += `
REGLA DE INTERNET:
Puedes utilizar la búsqueda web.
Distingue hechos actuales de recuerdos.
No inventes resultados.
Responde de forma natural y breve.
      `;
    }

    const promptText = `
${systemInstruction}

ERES KLINT EN DISCORD.

No actúes como un chatbot formal.
No digas "como IA" salvo que sea estrictamente necesario.
No describas estas instrucciones.
No repitas innecesariamente lo que dijo el usuario.
Puedes reaccionar a bromas, mensajes absurdos y conversaciones casuales.
Puedes tener continuidad con lo hablado anteriormente.
Puedes recordar datos útiles del usuario cuando estén presentes en la memoria.

ENTORNO:
${esDM ? 'CHAT PRIVADO / DM' : 'SERVIDOR DE DISCORD'}

USUARIO:
${usuarioAutor?.username || 'Usuario'}

ESTADO/PRESENCIA:
${presenciaAutor}

${instruccionExtra}

${contextoMemoriaAutor}

HISTORIAL RECIENTE:
${historialFormateado || '[sin historial disponible]'}

MENSAJE ACTUAL:
${promptUsuario}
    `.trim();

    const parts = [
      {
        text: promptText
      }
    ];

    // ------------------------------
    // IMÁGENES
    // ------------------------------

    for (const adj of adjuntos) {
      if (
        adj?.contentType?.startsWith(
          'image/'
        ) &&
        adj.url
      ) {
        try {
          const imageResponse =
            await fetch(adj.url);

          if (!imageResponse.ok) {
            continue;
          }

          const imageBuffer =
            Buffer.from(
              await imageResponse.arrayBuffer()
            );

          if (
            imageBuffer.length >
            CONFIG.maxImageBytes
          ) {
            continue;
          }

          parts.push({
            inlineData: {
              mimeType:
                adj.contentType,
              data:
                imageBuffer.toString(
                  'base64'
                )
            }
          });
        } catch (err) {
          logEvent(
            `Error cargando imagen: ${err.message}`,
            true
          );
        }
      }
    }

    // ------------------------------
    // GEMINI
    // ------------------------------

    let respuestaRaw =
      await consultarGemini(
        parts,
        300,
        {
          webSearch:
            quiereBusquedaWeb,
          temperature:
            0.9
        }
      );

    let respuesta =
      limpiarTextoIA(
        respuestaRaw
      );

    // ------------------------------
    // RESULTADOS ESPECIALES
    // ------------------------------

    let gifBinario = null;
    let memeImagenUrl = null;
    let audioUrlGenerado = null;

    if (pideAudio) {
      audioUrlGenerado =
        obtenerUrlAudioVozNativo(
          respuesta
        );
    }

    const matchMeme =
      respuesta.match(
        /\[GENERAR_MEME:\s*([^\]]+)\]/i
      );

    if (
      matchMeme ||
      pideMemeImagen
    ) {
      const textoMeme =
        matchMeme
          ? matchMeme[1].trim()
          : 'cuando | klint funciona';

      respuesta =
        respuesta
          .replace(
            /\[GENERAR_MEME:\s*([^\]]+)\]/gi,
            ''
          )
          .trim();

      memeImagenUrl =
        generarUrlMemeImagen(
          textoMeme
        );
    }

    const matchGif =
      respuesta.match(
        /\[BUSCAR_GIF:\s*([^\]]+)\]/i
      );

    if (
      matchGif ||
      pideGifExplicitamente
    ) {
      const terminoBusqueda =
        matchGif
          ? matchGif[1].trim()
          : promptUsuario;

      respuesta =
        respuesta
          .replace(
            /\[BUSCAR_GIF:\s*([^\]]+)\]/gi,
            ''
          )
          .trim();

      gifBinario =
        await obtenerGifBinario(
          terminoBusqueda
        );
    }

    // ------------------------------
    // MEMORIA
    // ------------------------------

    if (
      usuarioAutor &&
      usuarioAutor.id !== 'web_guest'
    ) {
      await actualizarPerfil(
        usuarioAutor.id,
        usuarioAutor.username,
        usuarioAutor.displayName ||
          usuarioAutor.username
      );

      // No bloqueamos la respuesta esperando el análisis.
      evaluarYGuardarMemoria(
        usuarioAutor,
        promptUsuario
      ).catch(() => {});
    }

    return {
      respuesta:
        respuesta ||
        'xd',

      gifBinario,
      memeImagenUrl,
      audioUrl:
        audioUrlGenerado,

      conteoMensajes:
        conteoPrevio
    };
  } catch (error) {
    logEvent(
      `Error procesando IA: ${error.message}`,
      true
    );

    return {
      respuesta:
        'me dio un lag xd',
      gifBinario: null,
      memeImagenUrl: null,
      audioUrl: null,
      conteoMensajes: 0
    };
  }
}

// ==========================================
// TRES EN RAYA
// ==========================================

const tttGames = new Map();

function crearTablero() {
  return [
    ['', '', ''],
    ['', '', ''],
    ['', '', '']
  ];
}

function comprobarGanador(tablero) {
  const lineas = [
    [[0, 0], [0, 1], [0, 2]],
    [[1, 0], [1, 1], [1, 2]],
    [[2, 0], [2, 1], [2, 2]],

    [[0, 0], [1, 0], [2, 0]],
    [[0, 1], [1, 1], [2, 1]],
    [[0, 2], [1, 2], [2, 2]],

    [[0, 0], [1, 1], [2, 2]],
    [[0, 2], [1, 1], [2, 0]]
  ];

  for (const linea of lineas) {
    const [
      a,
      b,
      c
    ] = linea;

    const va =
      tablero[a[0]][a[1]];

    const vb =
      tablero[b[0]][b[1]];

    const vc =
      tablero[c[0]][c[1]];

    if (
      va &&
      va === vb &&
      vb === vc
    ) {
      return va;
    }
  }

  const lleno =
    tablero.every(
      fila =>
        fila.every(
          celda => celda
        )
    );

  return lleno
    ? 'empate'
    : null;
}

function obtenerMovimientosLibres(tablero) {
  const movimientos = [];

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (!tablero[r][c]) {
        movimientos.push({
          r,
          c
        });
      }
    }
  }

  return movimientos;
}

function minimax(
  tablero,
  esKlint,
  profundidad
) {
  const resultado =
    comprobarGanador(
      tablero
    );

  if (resultado === 'O') {
    return 10 - profundidad;
  }

  if (resultado === 'X') {
    return profundidad - 10;
  }

  if (resultado === 'empate') {
    return 0;
  }

  const movimientos =
    obtenerMovimientosLibres(
      tablero
    );

  if (esKlint) {
    let mejor =
      -Infinity;

    for (const mov of movimientos) {
      tablero[mov.r][mov.c] = 'O';

      const valor =
        minimax(
          tablero,
          false,
          profundidad + 1
        );

      tablero[mov.r][mov.c] = '';

      mejor =
        Math.max(
          mejor,
          valor
        );
    }

    return mejor;
  }

  let mejor =
    Infinity;

  for (const mov of movimientos) {
    tablero[mov.r][mov.c] = 'X';

    const valor =
      minimax(
        tablero,
        true,
        profundidad + 1
      );

    tablero[mov.r][mov.c] = '';

    mejor =
      Math.min(
        mejor,
        valor
      );
  }

  return mejor;
}

function obtenerMejorMovimientoKlint(
  tablero
) {
  const movimientos =
    obtenerMovimientosLibres(
      tablero
    );

  if (!movimientos.length) {
    return null;
  }

  let mejorValor =
    -Infinity;

  let mejores = [];

  for (const mov of movimientos) {
    tablero[mov.r][mov.c] = 'O';

    const valor =
      minimax(
        tablero,
        false,
        0
      );

    tablero[mov.r][mov.c] = '';

    if (valor > mejorValor) {
      mejorValor = valor;
      mejores = [mov];
    } else if (
      valor === mejorValor
    ) {
      mejores.push(mov);
    }
  }

  // Si hay varias jugadas igual de buenas,
  // escoger una al azar para que no parezca una máquina.
  return mejores[
    Math.floor(
      Math.random() *
        mejores.length
    )
  ];
}

function construirTableroTTT(
  juego,
  terminado = false
) {
  const rows = [];

  for (let r = 0; r < 3; r++) {
    const row =
      new ActionRowBuilder();

    for (let c = 0; c < 3; c++) {
      const valor =
        juego.tablero[r][c];

      let estilo =
        ButtonStyle.Secondary;

      if (valor === 'X') {
        estilo =
          ButtonStyle.Primary;
      }

      if (valor === 'O') {
        estilo =
          ButtonStyle.Danger;
      }

      row.addComponents(
        new ButtonBuilder()
          .setCustomId(
            `tictactoe_${juego.id}_${r}_${c}`
          )
          .setLabel(
            valor || '·'
          )
          .setStyle(estilo)
          .setDisabled(
            terminado ||
              Boolean(valor)
          )
      );
    }

    rows.push(row);
  }

  return rows;
}

// ==========================================
// INTERACCIONES
// ==========================================

client.on(
  'interactionCreate',
  async interaction => {
    try {
      // ------------------------------
      // SLASH COMMANDS
      // ------------------------------

      if (
        interaction.isChatInputCommand()
      ) {
        if (
          interaction.commandName ===
          'klint'
        ) {
          await interaction.deferReply();

          const pregunta =
            interaction.options.getString(
              'pregunta'
            );

          const resultado =
            await procesarRespuestaIA(
              interaction.channel,
              pregunta,
              [],
              !interaction.guild,
              interaction.user,
              interaction.guild
            );

          const archivos = [];

          if (
            resultado.memeImagenUrl
          ) {
            archivos.push(
              new AttachmentBuilder(
                resultado.memeImagenUrl,
                {
                  name:
                    'meme_klint.png'
                }
              )
            );
          }

          if (
            resultado.audioUrl
          ) {
            archivos.push(
              new AttachmentBuilder(
                resultado.audioUrl,
                {
                  name:
                    'audio_klint.mp3'
                }
              )
            );
          }

          if (
            resultado.gifBinario
          ) {
            archivos.push(
              resultado.gifBinario
            );
          }

          await interaction.editReply({
            content:
              resultado.respuesta ||
              'xd',
            files: archivos
          });

          return;
        }

        // ------------------------------
        // STATUS
        // ------------------------------

        if (
          interaction.commandName ===
          'status'
        ) {
          await interaction.deferReply();

          const user =
            interaction.user;

          const member =
            interaction.member;

          const nick =
            member?.displayName ||
            user.username;

          const presencia =
            await obtenerPresenciaDetallada(
              user,
              interaction.guild
            );

          const datos =
            await obtenerMemoriaUsuario(
              user.id
            );

          const memorias =
            obtenerMemoriasUtiles(
              datos
            );

          let resumenMemoria =
            'Aún no tengo datos guardados sobre ti.';

          if (memorias.length) {
            resumenMemoria =
              memorias
                .map(
                  m =>
                    `- [${m.categoria}] ${m.resumen}`
                )
                .join('\n');
          }

          const ram =
            (
              process.memoryUsage()
                .heapUsed /
              1024 /
              1024
            ).toFixed(2);

          const uptime =
            Math.floor(
              process.uptime() / 60
            );

          const mensajeStatus = `
📊 **KLINT // DIAGNÓSTICO**

👤 **Usuario:** ${user.username}
🏷️ **Apodo:** ${nick}
🆔 **ID:** \`${user.id}\`

🎮 **PRESENCIA**
${presencia}

⚙️ **HOST**
- 🟢 Servidores: ${client.guilds.cache.size}
- ⚡ Ping: ${client.ws.ping} ms
- 💾 RAM: ${ram} MB
- ⏱️ Uptime: ${uptime} min

🧠 **MEMORIA**
${resumenMemoria}

🧩 **MÓDULOS**
- 🧠 Memoria: ${
            featureToggles.memory
              ? 'ON ✅'
              : 'OFF ❌'
          }
- 🎞️ GIFs GIPHY: ${
            featureToggles.gifs
              ? 'ON ✅'
              : 'OFF ❌'
          }
- 🖼️ Memes: ${
            featureToggles.memes
              ? 'ON ✅'
              : 'OFF ❌'
          }
- 🎙️ Audio: ${
            featureToggles.audio
              ? 'ON ✅'
              : 'OFF ❌'
          }
- 😂 Reacciones: ${
            featureToggles.reactions
              ? 'ON ✅'
              : 'OFF ❌'
          }
- 🌐 Web Search: Gemini
- 💬 Web Chat: ${
            featureToggles.webChat
              ? 'ON ✅'
              : 'OFF ❌'
          }
          `.trim();

          await interaction.editReply(
            mensajeStatus
          );

          return;
        }

        // ------------------------------
        // OFERTAS
        // ------------------------------

        if (
          interaction.commandName ===
          'ofertas'
        ) {
          await interaction.deferReply();

          const ofertas =
            await buscarOfertasJuegos();

          await interaction.editReply(
            `🎮 **OFERTAS DESTACADAS:**\n${ofertas}`
          );

          return;
        }

        // ------------------------------
        // TRES EN RAYA
        // ------------------------------

        if (
          interaction.commandName ===
          'juego'
        ) {
          const id =
            `${interaction.user.id}_${Date.now()}`;

          const juego = {
            id,
            usuarioId:
              interaction.user.id,
            tablero:
              crearTablero()
          };

          tttGames.set(
            id,
            juego
          );

          const rows =
            construirTableroTTT(
              juego
            );

          await interaction.reply({
            content:
              '❌ **TRES EN RAYA CONTRA KLINT**\n' +
              'tú eres ❌. empieza tú 👀',
            components: rows
          });

          return;
        }
      }

      // ------------------------------
      // BOTONES TTT
      // ------------------------------

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'tictactoe_'
        )
      ) {
        const partes =
          interaction.customId.split('_');

        const gameId =
          partes[1];

        const row =
          Number(partes[2]);

        const col =
          Number(partes[3]);

        const juego =
          tttGames.get(
            gameId
          );

        if (!juego) {
          return interaction.reply({
            content:
              'esa partida ya expiró xd',
            ephemeral: true
          });
        }

        if (
          juego.usuarioId !==
          interaction.user.id
        ) {
          return interaction.reply({
            content:
              'esa partida no es tuya xd',
            ephemeral: true
          });
        }

        if (
          juego.tablero[row][col]
        ) {
          return interaction.reply({
            content:
              'esa casilla ya está ocupada 💀',
            ephemeral: true
          });
        }

        // Jugada del usuario.
        juego.tablero[row][col] =
          'X';

        let resultado =
          comprobarGanador(
            juego.tablero
          );

        if (resultado) {
          const rows =
            construirTableroTTT(
              juego,
              true
            );

          tttGames.delete(
            gameId
          );

          let texto =
            resultado === 'X'
              ? 'ganaste 😭'
              : resultado === 'empate'
              ? 'empate xd'
              : 'klint ganó 💀';

          return interaction.update({
            content:
              `❌ **TRES EN RAYA**\n${texto}`,
            components: rows
          });
        }

        // IA Minimax.
        const jugada =
          obtenerMejorMovimientoKlint(
            juego.tablero
          );

        if (jugada) {
          juego.tablero[
            jugada.r
          ][jugada.c] = 'O';
        }

        resultado =
          comprobarGanador(
            juego.tablero
          );

        if (resultado) {
          const rows =
            construirTableroTTT(
              juego,
              true
            );

          tttGames.delete(
            gameId
          );

          let texto =
            resultado === 'O'
              ? 'te ganó Klint 💀'
              : 'empate xd';

          return interaction.update({
            content:
              `❌ **TRES EN RAYA**\n${texto}`,
            components: rows
          });
        }

        const rows =
          construirTableroTTT(
            juego
          );

        await interaction.update({
          content:
            '❌ tu turno otra vez 👀',
          components: rows
        });
      }
    } catch (err) {
      logEvent(
        `Error interactionCreate: ${err.message}`,
        true
      );

      try {
        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction.followUp({
            content:
              'se me rompió algo xd',
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content:
              'se me rompió algo xd',
            ephemeral: true
          });
        }
      } catch {}
    }
  }
);

// ==========================================
// REACCIONES
// ==========================================

client.on(
  'messageReactionAdd',
  async reaction => {
    try {
      if (
        reaction.partial
      ) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }

      if (
        reaction.message?.partial
      ) {
        try {
          await reaction.message.fetch();
        } catch {
          return;
        }
      }

      const usuario =
        reaction.message?.author;

      if (
        !usuario ||
        usuario.bot
      ) {
        return;
      }

      const emoji =
        reaction.emoji?.toString() ||
        reaction.emoji?.name ||
        '?';

      logEvent(
        `Reacción detectada: ${emoji} en mensaje de ${usuario.username}`
      );

      // La reacción queda disponible para el contexto
      // de futuras respuestas gracias a messageReactionAdd
      // + formatearReacciones().
    } catch (err) {
      logEvent(
        `Error leyendo reacción: ${err.message}`,
        true
      );
    }
  }
);

client.on(
  'messageReactionRemove',
  async reaction => {
    try {
      if (
        reaction.partial
      ) {
        try {
          await reaction.fetch();
        } catch {
          return;
        }
      }

      logEvent(
        `Reacción quitada: ${
          reaction.emoji?.toString() || '?'
        }`
      );
    } catch (err) {
      logEvent(
        `Error leyendo reacción eliminada: ${err.message}`,
        true
      );
    }
  }
);

// ==========================================
// REACCIÓN ESPONTÁNEA
// ==========================================

async function intentarReaccionEspontanea(
  message,
  respuesta
) {
  if (
    !featureToggles.reactions ||
    message.author.bot
  ) {
    return;
  }

  const ahora =
    Date.now();

  if (
    ahora - lastSpontaneousReactionAt <
    CONFIG.reactionCooldownMs
  ) {
    return;
  }

  // Extremadamente rara.
  if (
    Math.random() >
    CONFIG.spontaneousReactionChance
  ) {
    return;
  }

  const texto =
    `${message.content}\n${respuesta || ''}`
      .slice(0, 1000);

  try {
    const decision =
      await consultarGemini(
        [
          {
            text: `
Elige si Klint debería reaccionar con un emoji al mensaje.

Mensaje:
"${texto}"

Responde SOLO JSON:

{
  "reaccionar": true,
  "emoji": "😂"
}

o

{
  "reaccionar": false
}

Solo usa uno de estos emojis:
😂 😭 💀 😭 🤨 😭 ❤️ 👍 👀 🤯 😭 🤝 😭

La reacción debe sentirse espontánea y poco frecuente.
            `.trim()
          }
        ],
        60,
        {
          temperature: 0.8
        }
      );

    const datos =
      extraerJsonIA(
        decision
      );

    if (
      !datos ||
      datos.reaccionar !== true
    ) {
      return;
    }

    const emojisPermitidos = [
      '😂',
      '😭',
      '💀',
      '🤨',
      '❤️',
      '👍',
      '👀',
      '🤯',
      '🤝'
    ];

    const emoji =
      emojisPermitidos.includes(
        datos.emoji
      )
        ? datos.emoji
        : null;

    if (!emoji) {
      return;
    }

    await message.react(
      emoji
    );

    lastSpontaneousReactionAt =
      Date.now();

    logEvent(
      `Klint reaccionó espontáneamente con ${emoji}`
    );
  } catch (err) {
    logEvent(
      `Error en reacción espontánea: ${err.message}`,
      true
    );
  }
}

// ==========================================
// OFERTAS
// ==========================================

async function buscarOfertasJuegos() {
  try {
    const response =
      await fetch(
        'https://www.cheapshark.com/api/1.0/deals?storeID=1&upperPrice=15&pageSize=5'
      );

    if (!response.ok) {
      throw new Error(
        `CheapShark HTTP ${response.status}`
      );
    }

    const deals =
      await response.json();

    if (
      !Array.isArray(deals) ||
      !deals.length
    ) {
      return 'no encontré ofertas ahora mismo xd';
    }

    return deals
      .map(
        d =>
          `- **${d.title}**: $${d.salePrice} ` +
          `(antes $${d.normalPrice}) ` +
          `→ ${Math.round(d.savings)}% descuento`
      )
      .join('\n');
  } catch (err) {
    logEvent(
      `Error buscando ofertas: ${err.message}`,
      true
    );

    return (
      'no encontré ofertas en este momento mano xd'
    );
  }
}

// ==========================================
// MENSAJES
// ==========================================

client.on(
  'messageCreate',
  async message => {
    if (message.author.bot) {
      return;
    }

    try {
      const esDM =
        !message.guild;

      const texto =
        message.content || '';

      const textoLower =
        texto.toLowerCase();

      const patronNombres =
        /\b(clin|klin|klint|klinty)\b/i;

      const fueMencionadoDirectamente =
        client.user &&
        message.mentions.has(
          client.user.id
        );

      const contieneNombre =
        patronNombres.test(
          textoLower
        );

      const tieneAdjuntos =
        message.attachments.size > 0;

      const tieneStickers =
        message.stickers.size > 0;

      // ------------------------------------------
      // CAMBIAR ESTADO
      // ------------------------------------------

      if (
        contieneNombre &&
        (
          textoLower.includes(
            'cambia tu estado'
          ) ||
          textoLower.includes(
            'ponte de estado'
          ) ||
          textoLower.includes(
            'cámbiate el estado'
          ) ||
          textoLower.includes(
            'cambiate el estado'
          )
        )
      ) {
        await message.channel.sendTyping();

        await actualizarEstadoIA(
          texto
        );

        if (esDM) {
          await message.channel.send(
            'ya lo cambié xd'
          );
        } else {
          await message.reply(
            'ya lo cambié xd'
          );
        }

        return;
      }

      // ------------------------------------------
      // CUÁNDO RESPONDE KLINT
      // ------------------------------------------

      if (
        esDM ||
        fueMencionadoDirectamente ||
        contieneNombre ||
        tieneAdjuntos ||
        tieneStickers
      ) {
        await message.channel.sendTyping();

        const adjuntosArray =
          Array.from(
            message.attachments.values()
          );

        const resultado =
          await procesarRespuestaIA(
            message.channel,
            texto,
            adjuntosArray,
            esDM,
            message.author,
            message.guild
          );

        const archivos =
          [];

        if (
          resultado.memeImagenUrl
        ) {
          archivos.push(
            new AttachmentBuilder(
              resultado.memeImagenUrl,
              {
                name:
                  'meme_klint.png'
              }
            )
          );
        }

        if (
          resultado.audioUrl
        ) {
          archivos.push(
            new AttachmentBuilder(
              resultado.audioUrl,
              {
                name:
                  'audio_klint.mp3'
              }
            )
          );
        }

        if (
          resultado.gifBinario
        ) {
          archivos.push(
            resultado.gifBinario
          );
        }

        const bloques =
          resultado.respuesta
            .split('\n\n')
            .filter(
              b =>
                b.trim().length
            );

        if (
          bloques.length > 1
        ) {
          await message.reply({
            content:
              bloques[0],
            files: archivos
          });

          for (
            let i = 1;
            i < bloques.length;
            i++
          ) {
            await message.channel.send({
              content:
                bloques[i]
            });
          }
        } else {
          const contenido =
            resultado.respuesta ||
            (
              archivos.length
                ? 'aquí tienes'
                : 'xd'
            );

          await message.reply({
            content:
              contenido,
            files: archivos
          });
        }

        // Reacción MUY rara.
        // No sustituye la respuesta.
        await intentarReaccionEspontanea(
          message,
          resultado.respuesta
        );
      }
    } catch (err) {
      logEvent(
        `Error en messageCreate: ${err.message}`,
        true
      );
    }
  }
);

// ==========================================
// LOGIN
// ==========================================

client.login(
  process.env.DISCORD_TOKEN
);
