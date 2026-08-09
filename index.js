'use strict';

/*
 * KLINT - Discord AI Bot
 * Reemplazo completo de index.js
 *
 * Requisitos:
 * - Node.js 18+
 * - discord.js v14+
 * - fetch nativo de Node 18+
 *
 * Variables de entorno recomendadas:
 * DISCORD_TOKEN
 * GEMINI_API_KEY
 * FIREBASE_DATABASE_URL
 * saidkey / SAIDKEY
 * TENOR_API_KEY
 * TENOR_CLIENT_KEY (opcional, default: klint-discord-bot)
 * RENDER_DEPLOY_HOOK_URL (opcional)
 *
 * Para búsqueda web real, Gemini usa Google Search Grounding cuando
 * WEB_SEARCH_ENABLED=true. No necesitas otra API de buscador.
 */

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
  ButtonStyle,
  EmbedBuilder
} = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');

// ============================================================
// CONFIGURACIÓN
// ============================================================

const PORT = Number(process.env.PORT || 10000);
const WEB_SEARCH_ENABLED = String(process.env.WEB_SEARCH_ENABLED ?? 'true').toLowerCase() !== 'false';
const TENOR_API_KEY = process.env.TENOR_API_KEY || '';
const TENOR_CLIENT_KEY = process.env.TENOR_CLIENT_KEY || 'klint-discord-bot';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || '';

const featureToggles = {
  audio: true,
  memes: true,
  gifs: true,
  webChat: true,
  webSearch: WEB_SEARCH_ENABLED,
  tictactoe: true
};

const systemLogs = [];
const activeGames = new Map();
const GAME_TTL_MS = 30 * 60 * 1000;
const MAX_HISTORY = 20;
const MAX_MEMORY_CONTEXT = 8;
const MAX_WEB_RESULTS = 5;

// ============================================================
// LOGS / ERRORES
// ============================================================

function logEvent(msg, isError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const prefix = isError ? '[ERROR ❌]' : '[INFO ℹ️]';
  const entry = `[${timestamp}] ${prefix} ${msg}`;

  if (isError) console.error(entry);
  else console.log(entry);

  systemLogs.unshift(entry);
  if (systemLogs.length > 100) systemLogs.pop();
}

process.on('unhandledRejection', reason => {
  logEvent(`Promesa no manejada: ${reason?.stack || reason}`, true);
});

process.on('uncaughtException', err => {
  logEvent(`Excepción no capturada: ${err?.stack || err?.message || err}`, true);
});

// ============================================================
// HELPERS GENERALES
// ============================================================

function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent(`No se pudo cargar system_instruction.txt: ${error.message}`, true);
    return 'Eres Klint. Habla casual, natural, breve y en minúsculas cuando tenga sentido.';
  }
}

function obtenerFirebaseUrl() {
  let url = FIREBASE_DATABASE_URL || '';
  const markdown = url.match(/\((https?:\/\/[^\)]+)\)/);
  if (markdown) url = markdown[1];
  url = url.replace(/[\[\]()'\"]/g, '').trim();
  if (url && !url.startsWith('http')) url = `https://${url}`;
  return url.replace(/\/$/, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function limpiarTexto(texto = '') {
  return String(texto)
    .replace(/<[^>]*>?/gm, '')
    .replace(/\u0000/g, '')
    .trim();
}

function limitarTexto(texto, max = 1800) {
  const clean = limpiarTexto(texto);
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function esUrlHttp(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function fetchConTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetchConTimeout(url, options, timeoutMs);
  const text = await response.text();
  const data = safeJsonParse(text, null);

  if (!response.ok) {
    const detail = data?.error?.message || data?.error || text.slice(0, 500);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  return data;
}

async function descargarBuffer(url, timeoutMs = 20000) {
  if (!esUrlHttp(url)) throw new Error('URL no válida');

  const response = await fetchConTimeout(url, {
    headers: { 'User-Agent': 'KlintDiscordBot/2.0' }
  }, timeoutMs);

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!buffer.length) throw new Error('Archivo vacío');

  return buffer;
}

// ============================================================
// EXPRESS / PANEL WEB
// ============================================================

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function validarKey(req, res, next) {
  const supplied = req.body?.key || req.headers['x-api-key'];
  const expected = process.env.saidkey || process.env.SAIDKEY;

  if (supplied && expected && supplied === expected) return next();

  return res.status(401).json({ error: 'Clave no autorizada' });
}

app.post('/api/login', validarKey, (req, res) => {
  res.json({ success: true });
});

app.post('/api/stats', validarKey, (req, res) => {
  res.json({
    guilds: client.guilds.cache.size,
    ping: client.ws.ping,
    uptime: process.uptime(),
    activeGames: activeGames.size,
    toggles: featureToggles
  });
});

app.post('/api/get-prompt', validarKey, (req, res) => {
  res.json({ prompt: cargarSystemInstruction() });
});

app.post('/api/save-prompt', validarKey, (req, res) => {
  try {
    if (typeof req.body?.prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt inválido' });
    }

    fs.writeFileSync(
      path.join(__dirname, 'system_instruction.txt'),
      req.body.prompt,
      'utf8'
    );

    logEvent('Instrucciones del sistema actualizadas desde la web.');

    return res.json({ success: true });
  } catch (err) {
    logEvent(`Error guardando prompt: ${err.message}`, true);
    return res.status(500).json({
      error: 'No se pudo guardar el archivo'
    });
  }
});

app.post('/api/get-logs', validarKey, (req, res) => {
  res.json({ logs: systemLogs });
});

app.post('/api/force-status', validarKey, async (req, res) => {
  try {
    await actualizarEstadoIA();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/toggle-feature', validarKey, (req, res) => {
  const { feature, value } = req.body || {};

  if (!Object.prototype.hasOwnProperty.call(featureToggles, feature)) {
    return res.status(400).json({
      error: 'La función especificada no existe'
    });
  }

  featureToggles[feature] = Boolean(value);

  logEvent(
    `Feature '${feature}' cambiado a: ${featureToggles[feature]}`
  );

  return res.json({
    success: true,
    toggles: featureToggles
  });
});

app.post('/api/get-memories', validarKey, async (req, res) => {
  const dbUrl = obtenerFirebaseUrl();

  if (!dbUrl) return res.json({ users: {} });

  try {
    const data = await fetchJson(`${dbUrl}/usuarios.json`);

    return res.json({
      users: data || {}
    });
  } catch (err) {
    logEvent(`Error leyendo Firebase: ${err.message}`, true);
    return res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/delete-memory', validarKey, async (req, res) => {
  const { userId, memoryKey } = req.body || {};

  if (!userId || !memoryKey) {
    return res.status(400).json({
      error: 'Faltan datos'
    });
  }

  const dbUrl = obtenerFirebaseUrl();

  if (!dbUrl) {
    return res.status(400).json({
      error: 'Sin base de datos'
    });
  }

  try {
    await fetchConTimeout(
      `${dbUrl}/usuarios/${encodeURIComponent(userId)}/memorias/${encodeURIComponent(memoryKey)}.json`,
      {
        method: 'DELETE'
      }
    );

    logEvent(`Memoria ${memoryKey} eliminada del usuario ${userId}`);

    return res.json({
      success: true
    });
  } catch (err) {
    logEvent(`Error borrando memoria: ${err.message}`, true);

    return res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/send-discord-msg', validarKey, async (req, res) => {
  const { channelId, message } = req.body || {};

  if (!channelId || typeof message !== 'string') {
    return res.status(400).json({
      error: 'Faltan datos'
    });
  }

  try {
    const channel = await client.channels.fetch(channelId);

    if (!channel?.isTextBased()) {
      return res.status(400).json({
        error: 'Canal no encontrado o no es de texto'
      });
    }

    await channel.send({
      content: limitarTexto(message, 2000)
    });

    logEvent(
      `Mensaje enviado desde la web al canal ${channelId}`
    );

    return res.json({
      success: true
    });
  } catch (err) {
    logEvent(
      `Error enviando mensaje a Discord: ${err.message}`,
      true
    );

    return res.status(500).json({
      error: err.message
    });
  }
});

app.post('/api/deep-reset', validarKey, async (req, res) => {
  logEvent('Iniciando limpieza profunda...');

  if (global.gc) {
    try {
      global.gc();
    } catch {}
  }

  const deployHookUrl = process.env.RENDER_DEPLOY_HOOK_URL;

  if (deployHookUrl && esUrlHttp(deployHookUrl)) {
    try {
      const response = await fetchConTimeout(
        deployHookUrl,
        { method: 'POST' },
        10000
      );

      if (response.ok) {
        logEvent('Re-deploy activado en Render.');

        return res.json({
          success: true,
          message: 'Reinicio profundo y re-despliegue iniciados.'
        });
      }
    } catch (err) {
      logEvent(
        `Error invocando Deploy Hook: ${err.message}`,
        true
      );
    }
  }

  return res.json({
    success: true,
    message: 'Limpieza de RAM completada.'
  });
});

app.post('/api/web-chat', async (req, res) => {
  if (!featureToggles.webChat) {
    return res.json({
      response: 'el chat web está pausado temporalmente.'
    });
  }

  try {
    const { message, count, imageUrl } = req.body || {};

    if (Number(count) > 15) {
      return res.json({
        response: 'has alcanzado el límite de 15 mensajes de prueba.'
      });
    }

    const adjuntos = imageUrl && esUrlHttp(imageUrl)
      ? [{
          contentType: 'image/png',
          url: imageUrl
        }]
      : [];

    const result = await procesarRespuestaIA(
      null,
      String(message || 'hola'),
      adjuntos,
      true,
      {
        username: 'UsuarioWeb',
        id: 'web_guest',
        displayName: 'UsuarioWeb'
      },
      null
    );

    return res.json({
      response: result.respuesta,
      gifBinario: null,
      memeImagenUrl: result.memeImagenUrl,
      audioUrl: result.audioUrl,
      webSources: result.webSources || [],
      remaining: Math.max(
        0,
        15 - Number(count || 0) - 1
      )
    });
  } catch (err) {
    logEvent(
      `Error en Web Chat: ${err.message}`,
      true
    );

    return res.status(500).json({
      response: 'error procesando la solicitud web.'
    });
  }
});

app.listen(PORT, () => {
  logEvent(`Servidor HTTP activo en puerto ${PORT}`);
});

// Auto-ping de Render, conservado del proyecto original.
setInterval(() => {
  const baseUrl =
    process.env.RENDER_EXTERNAL_URL ||
    'https://klint-gxww.onrender.com';

  fetchConTimeout(
    baseUrl,
    {},
    10000
  )
    .then(() => logEvent('Self-ping exitoso.'))
    .catch(err =>
      logEvent(
        `Fallo en self-ping: ${err.message}`,
        true
      )
    );
}, 10 * 60 * 1000);

// ============================================================
// CLIENTE DISCORD
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],

  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName('klint')
    .setDescription('Habla con Klint')
    .addStringOption(option =>
      option
        .setName('pregunta')
        .setDescription('Lo que quieres decirle a Klint')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription(
      'Muestra diagnóstico, memoria, actividad y módulos'
    ),

  new SlashCommandBuilder()
    .setName('ofertas')
    .setDescription(
      'Busca ofertas y descuentos actualizados de juegos'
    ),

  new SlashCommandBuilder()
    .setName('juego')
    .setDescription(
      'Inicia una partida mejorada de Tres en Raya'
    ),

  new SlashCommandBuilder()
    .setName('gif')
    .setDescription('Busca un GIF en Tenor')
    .addStringOption(option =>
      option
        .setName('busqueda')
        .setDescription('Qué GIF quieres')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('web')
    .setDescription(
      'Busca información actual en Internet'
    )
    .addStringOption(option =>
      option
        .setName('consulta')
        .setDescription('Qué quieres buscar')
        .setRequired(true)
    )
].map(command => command.toJSON());

client.once('clientReady', async () => {
  logEvent(
    `Klint ha iniciado sesión como ${client.user.tag}`
  );

  const rest = new REST({
    version: '10'
  }).setToken(process.env.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      {
        body: commands
      }
    );

    logEvent('Comandos Slash sincronizados.');
  } catch (error) {
    logEvent(
      `Error registrando comandos slash: ${error.message}`,
      true
    );
  }

  await actualizarEstadoIA();
  programarCambioEstadoRandom();
});

function programarCambioEstadoRandom() {
  const minutosRandom =
    Math.floor(Math.random() * 14) + 7;

  setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
}

// ============================================================
// TENOR: BUSCADOR REAL DE GIFS
// ============================================================

const GIFS_FALLBACK = [
  'https://media.tenor.com/yhe9to9A4E8AAAAC/cat-cat-typing.gif',
  'https://media.tenor.com/gKIn4D2o8p4AAAAC/funny-cat.gif',
  'https://media.tenor.com/2roX357_640AAAAC/meme-cat.gif',
  'https://media.tenor.com/vH1_fB6M3eIAAAAC/cat-meme.gif'
];

function obtenerUrlMediaTenor(result) {
  const formats =
    result?.media_formats || {};

  return (
    formats.gif?.url ||
    formats.mediumgif?.url ||
    formats.tinygif?.url ||
    formats.nanogif?.url ||
    null
  );
}

async function buscarGifsTenor(
  busqueda,
  limit = 8
) {
  if (!TENOR_API_KEY) {
    logEvent(
      'TENOR_API_KEY no configurada.',
      true
    );

    return [];
  }

  const termino = limitarTexto(
    busqueda || 'funny',
    120
  );

  const params = new URLSearchParams({
    q: termino,
    key: TENOR_API_KEY,
    client_key: TENOR_CLIENT_KEY,
    limit: String(
      Math.min(
        Math.max(limit, 1),
        20
      )
    ),
    locale: 'es_419',
    country: 'PE',
    contentfilter: 'medium',
    media_filter: 'gif,mediumgif,tinygif'
  });

  const data = await fetchJson(
    `https://tenor.googleapis.com/v2/search?${params}`,
    {},
    15000
  );

  return (data?.results || [])
    .map(result => ({
      id: result.id,
      title:
        result.content_description ||
        result.title ||
        termino,
      url: obtenerUrlMediaTenor(result),
      pageUrl:
        result.itemurl ||
        result.url ||
        null
    }))
    .filter(item => item.url);
}

async function obtenerGifBinario(busqueda) {
  if (!featureToggles.gifs) return null;

  const termino =
    busqueda || 'funny cat';

  try {
    const results =
      await buscarGifsTenor(
        termino,
        8
      );

    if (results.length) {
      const elegido =
        results[
          Math.floor(
            Math.random() *
            results.length
          )
        ];

      const buffer =
        await descargarBuffer(
          elegido.url,
          20000
        );

      logEvent(
        `[OK GIF: Tenor v2] "${termino}" -> ${elegido.id}`
      );

      return {
        attachment:
          new AttachmentBuilder(
            buffer,
            {
              name: 'klint.gif'
            }
          ),

        sourceUrl:
          elegido.pageUrl ||
          elegido.url,

        search: termino
      };
    }
  } catch (err) {
    logEvent(
      `[GIF] Tenor falló para "${termino}": ${err.message}`,
      true
    );
  }

  try {
    const fallbackUrl =
      GIFS_FALLBACK[
        Math.floor(
          Math.random() *
          GIFS_FALLBACK.length
        )
      ];

    const buffer =
      await descargarBuffer(
        fallbackUrl,
        15000
      );

    return {
      attachment:
        new AttachmentBuilder(
          buffer,
          {
            name: 'klint_fallback.gif'
          }
        ),

      sourceUrl: fallbackUrl,
      search: termino
    };
  } catch (err) {
    logEvent(
      `[GIF] Falló también fallback: ${err.message}`,
      true
    );

    return null;
  }
}

// ============================================================
// MEMES
// ============================================================

const MEME_TEMPLATES = [
  'drake',
  'doge',
  'fry',
  'buzz',
  'fine',
  'distracted',
  'success',
  'twobuttons',
  'facepalm',
  'disastergirl',
  'cryingfloor',
  'pawn-stars',
  'mordor',
  'aag',
  'ackbar',
  'afraid',
  'ants',
  'awesome',
  'awkward',
  'bad',
  'bd',
  'blank',
  'boat',
  'both',
  'captain',
  'cbg',
  'center',
  'change-my-mind',
  'cheems',
  'chosen',
  'clown',
  'db',
  'dd',
  'disastergirl',
  'dodgson',
  'dog',
  'domo',
  'double',
  'down',
  'ds',
  'elf',
  'ermg',
  'exit',
  'fbf',
  'firsttry',
  'futurama',
  'gb',
  'gears',
  'gru',
  'hagrid',
  'happening',
  'harold',
  'hipster',
  'incredibles',
  'interesting',
  'ive',
  'iw',
  'joker',
  'kermit',
  'keanu',
  'kn',
  'leo',
  'live',
  'mb',
  'morpheus',
  'mw',
  'nice',
  'officespace',
  'oprah',
  'philosoraptor',
  'pigeon',
  'pika',
  'pooh',
  'potter',
  'predator',
  'ptj',
  'rollsafe',
  'sadfrog',
  'saltbae',
  'sb',
  'spongebob',
  'stonks',
  'success',
  'surprised',
  'tenguy',
  'toohigh',
  'trump',
  'uno',
  'willsmith',
  'woman-cat',
  'yuno'
];
function generarUrlMemeImagen(textoMeme) {
  if (!featureToggles.memes) return null;

  try {
    const plantilla =
      MEME_TEMPLATES[
        Math.floor(
          Math.random() *
          MEME_TEMPLATES.length
        )
      ];

    let arriba = 'cuando';
    let abajo =
      textoMeme || 'pasa xd';

    if (
      String(textoMeme).includes('|')
    ) {
      const partes =
        String(textoMeme).split('|');

      arriba =
        partes.shift()?.trim() ||
        'cuando';

      abajo =
        partes.join('|').trim() ||
        'pasa xd';
    }

    const encodeMemeText =
      value =>
        encodeURIComponent(
          String(value)
            .replace(/_/g, '__')
            .replace(/-/g, '--')
            .replace(/\?/g, '~q')
            .replace(/%/g, '~p')
            .replace(/#/g, '~h')
            .replace(/\//g, '~s')
            .replace(/\\/g, '~b')
            .replace(/</g, '~l')
            .replace(/>/g, '~g')
            .replace(/"/g, "''")
            .replace(/\n/g, '~n')
            .replace(/\s+/g, '_')
        );

    return `https://api.memegen.link/images/${plantilla}/${encodeMemeText(arriba)}/${encodeMemeText(abajo)}.png`;
  } catch (err) {
    logEvent(
      `Error generando meme: ${err.message}`,
      true
    );

    return null;
  }
}

// ============================================================
// AUDIO
// ============================================================

function obtenerUrlAudioVozNativo(texto) {
  if (!featureToggles.audio) return null;

  const textoLimpio =
    limpiarTexto(texto)
      .replace(/[\*_`#\[\]]/g, '')
      .slice(0, 180)
      .trim();

  if (!textoLimpio) return null;

  return `https://api.streamelements.com/kappa/v2/speech?voice=Mia&text=${encodeURIComponent(textoLimpio)}`;
}

// ============================================================
// FIREBASE MEMORIA
// ============================================================

async function obtenerMemoriaUsuario(userId) {
  const dbUrl =
    obtenerFirebaseUrl();

  if (!dbUrl || !userId) return null;

  try {
    return await fetchJson(
      `${dbUrl}/usuarios/${encodeURIComponent(userId)}.json`,
      {},
      10000
    );
  } catch (err) {
    logEvent(
      `Error conectando con Firebase: ${err.message}`,
      true
    );

    return null;
  }
}

async function actualizarPerfilYMemoria(
  userId,
  username,
  displayName,
  mensaje,
  resumen
) {
  const dbUrl =
    obtenerFirebaseUrl();

  if (!dbUrl || !userId) return;

  try {
    const base =
      `${dbUrl}/usuarios/${encodeURIComponent(userId)}`;

    await fetchConTimeout(
      `${base}/perfil.json`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          username,
          displayName,
          ultimaConexion:
            new Date().toISOString()
        })
      },
      10000
    );

    if (resumen) {
      await fetchConTimeout(
        `${base}/memorias.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({
            mensaje:
              limitarTexto(
                mensaje,
                1000
              ),

            resumen:
              limitarTexto(
                resumen,
                400
              ),

            fecha:
              new Date().toISOString()
          })
        },
        10000
      );

      logEvent(
        `[Firebase] Memoria guardada para ${username}`
      );
    }
  } catch (err) {
    logEvent(
      `Error guardando en Firebase: ${err.message}`,
      true
    );
  }
}

async function evaluarYGuardarMemoria(
  user,
  mensajeUsuario
) {
  if (
    !user ||
    user.id === 'web_guest' ||
    !mensajeUsuario?.trim()
  ) {
    return;
  }

  try {
    const promptEvaluacion = `
Analiza este mensaje del usuario y decide si contiene una preferencia, dato útil sobre sus proyectos, gusto estable o información que razonablemente ayude a futuras conversaciones.

NO guardes contraseñas, secretos, datos financieros, direcciones precisas, información médica, sexual o cualquier dato sensible.

Si no vale la pena recordarlo responde exactamente NO.

Si sí vale la pena, responde una sola frase breve y neutral.

Usuario: ${user.username}

Mensaje:
${limitarTexto(
  mensajeUsuario,
  1200
)}
`;

    const resultado =
      await consultarGemini(
        [{ text: promptEvaluacion }],
        80,
        {
          webSearch: false
        }
      );

    const textoRespuesta =
      limpiarTexto(
        resultado
      ).trim();

    if (
      !textoRespuesta ||
      /^NO[.!]?$/i.test(
        textoRespuesta
      )
    ) {
      return;
    }

    await actualizarPerfilYMemoria(
      user.id,
      user.username,
      user.displayName ||
        user.username,
      mensajeUsuario,
      textoRespuesta
    );
  } catch (err) {
    logEvent(
      `Error evaluando memoria: ${err.message}`,
      true
    );
  }
}

// ============================================================
// PRESENCIA
// ============================================================

async function actualizarEstadoIA(
  peticionManual = null
) {
  try {
    let prompt =
      'Inventa un estado de Discord informal y espontáneo. Máximo 5 palabras. Solo texto, sin comillas.';

    if (peticionManual) {
      prompt =
        `Genera un estado de Discord casual basado en esto: ${limitarTexto(
          peticionManual,
          300
        )}. Máximo 5 palabras.`;
    }

    const textoGenerado =
      await consultarGemini(
        [{ text: prompt }],
        30,
        {
          webSearch: false
        }
      );

    const textoEstado =
      limpiarTexto(
        textoGenerado
      )
        .replace(
          /^['"]|['"]$/g,
          ''
        )
        .toLowerCase()
        .slice(0, 100) ||
      'pensando en la nada';

    const estados = [
      'online',
      'idle',
      'dnd'
    ];

    client.user.setPresence({
      status:
        estados[
          Math.floor(
            Math.random() *
            estados.length
          )
        ],

      activities: [
        {
          name: textoEstado,
          type: ActivityType.Custom
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

async function obtenerPresenciaDetallada(
  user,
  guild = null
) {
  if (!user) {
    return 'Conexión: desconocida';
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
    for (
      const g of client.guilds.cache.values()
    ) {
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

  if (!member?.presence) {
    return 'Conexión: Offline / Invisible';
  }

  const statusMap = {
    online: '🟢 En línea',
    idle: '🌙 Ausente',
    dnd: '🔴 No molestar',
    offline: '⚪ Desconectado'
  };

  const detalles = [
    `Estado: ${
      statusMap[
        member.presence.status
      ] ||
      '🟢 En línea'
    }`
  ];

  for (
    const activity of
    member.presence.activities || []
  ) {
    if (
      activity.type === 4 ||
      activity.type ===
        ActivityType.Custom
    ) {
      if (activity.state) {
        detalles.push(
          `Perfil: "${limitarTexto(
            activity.state,
            100
          )}"`
        );
      }
    } else if (
      activity.name === 'Spotify'
    ) {
      detalles.push(
        `Escuchando Spotify: "${limitarTexto(
          activity.details || '',
          100
        )}"`
      );
    } else if (
      activity.name
    ) {
      detalles.push(
        `Jugando: "${limitarTexto(
          activity.name,
          100
        )}"`
      );
    }
  }

  return detalles.join(' | ');
}

// ============================================================
// GEMINI: MODELOS + GOOGLE SEARCH GROUNDING
// ============================================================

const GEMINI_MODELS = [
  process.env.GEMINI_MODEL ||
    'gemini-3.6-flash',

  'gemini-3.5-flash',
  'gemini-2.5-flash'
];

function geminiEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
}

function getGeminiTools({
  webSearch = false
} = {}) {
  const tools = [
    {
      functionDeclarations: [
        {
          name: 'buscar_gif',

          description:
            'Busca un GIF real en Tenor y devuelve un GIF para Discord. Úsalo cuando el usuario quiera un GIF.',

          parameters: {
            type: 'OBJECT',

            properties: {
              query: {
                type: 'STRING',

                description:
                  'Descripción concreta del GIF, preferiblemente en inglés para mejorar resultados.'
              }
            },

            required: [
              'query'
            ]
          }
        },

        {
          name: 'crear_meme',

          description:
            'Genera una imagen de meme con una plantilla y texto. Úsalo cuando el usuario pida crear un meme.',

          parameters: {
            type: 'OBJECT',

            properties: {
              texto: {
                type: 'STRING',

                description:
                  'Texto del meme. Puedes usar formato texto arriba | texto abajo.'
              }
            },

            required: [
              'texto'
            ]
          }
        },

        {
          name: 'buscar_ofertas',

          description:
            'Busca ofertas actuales de juegos.',

          parameters: {
            type: 'OBJECT',

            properties: {
              consulta: {
                type: 'STRING',

                description:
                  'Juego o tipo de oferta.'
              }
            },

            required: [
              'consulta'
            ]
          }
        }
      ]
    }
  ];

  if (
    webSearch &&
    featureToggles.webSearch
  ) {
    tools.push({
      google_search: {}
    });
  }

  return tools;
}

function extraerTextoGemini(data) {
  const parts =
    data?.candidates?.[0]?.content?.parts ||
    [];

  return parts
    .filter(
      part =>
        typeof part.text ===
        'string'
    )
    .map(
      part => part.text
    )
    .join('\n')
    .trim();
}

function extraerFunctionCalls(data) {
  const parts =
    data?.candidates?.[0]?.content?.parts ||
    [];

  return parts
    .filter(
      part =>
        part.functionCall?.name
    )
    .map(part => ({
      name:
        part.functionCall.name,

      args:
        part.functionCall.args ||
        {}
    }));
}

function extraerGroundingSources(data) {
  const chunks =
    data?.candidates?.[0]
      ?.groundingMetadata
      ?.groundingChunks ||
    [];

  const sources = [];

  for (
    const chunk of chunks
  ) {
    const web =
      chunk?.web;

    if (!web?.uri) continue;

    sources.push({
      title:
        limitarTexto(
          web.title ||
            web.uri,
          180
        ),

      url: web.uri
    });
  }

  const seen =
    new Set();

  return sources
    .filter(source => {
      if (
        seen.has(
          source.url
        )
      ) {
        return false;
      }

      seen.add(
        source.url
      );

      return true;
    })
    .slice(
      0,
      MAX_WEB_RESULTS
    );
}

async function llamarGeminiRaw(
  contents,
  generationConfig = {},
  options = {}
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY no está configurada'
    );
  }

  let lastError = null;

  for (
    const model of GEMINI_MODELS
  ) {
    try {
      const body = {
        contents,

        generationConfig: {
          temperature:
            generationConfig.temperature ??
            0.75,

          maxOutputTokens:
            generationConfig.maxOutputTokens ??
            500,

          ...generationConfig
        }
      };

      if (options.tools) {
        body.tools =
          options.tools;
      }

      if (options.toolConfig) {
        body.toolConfig =
          options.toolConfig;
      }

      const response =
        await fetchJson(
          geminiEndpoint(
            model
          ),
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify(body)
          },
          30000
        );

      return {
        data: response,
        model
      };
    } catch (err) {
      lastError = err;

      logEvent(
        `Gemini ${model} falló: ${err.message}`,
        true
      );
    }
  }

  throw new Error(
    `Todos los modelos Gemini fallaron: ${
      lastError?.message ||
      'error desconocido'
    }`
  );
}

async function consultarGemini(
  parts,
  maxTokens = 300,
  options = {}
) {
  const { data } =
    await llamarGeminiRaw(
      [
        {
          role: 'user',
          parts
        }
      ],

      {
        maxOutputTokens:
          maxTokens
      },

      {
        tools:
          options.webSearch
            ? getGeminiTools({
                webSearch:
                  true
              })
            : undefined
      }
    );

  return (
    extraerTextoGemini(
      data
    ) || ''
  );
}

// ============================================================
// BÚSQUEDA WEB DIRECTA CON GEMINI GROUNDING
// ============================================================

async function buscarEnWebConGemini(
  consulta
) {
  if (
    !featureToggles.webSearch
  ) {
    return {
      text:
        'la búsqueda web está desactivada.',
      sources: []
    };
  }

  const prompt =
    `Busca en Internet información actual sobre esta consulta y responde en español de forma clara y breve.
No inventes datos. Si encuentras fuentes relevantes, usa sus datos.
Consulta: ${limitarTexto(
      consulta,
      1000
    )}`;

  try {
    const { data } =
      await llamarGeminiRaw(
        [
          {
            role: 'user',
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],

        {
          maxOutputTokens: 700,
          temperature: 0.35
        },

        {
          tools: [
            {
              google_search: {}
            }
          ]
        }
      );

    return {
      text:
        extraerTextoGemini(
          data
        ) ||
        'no encontré una respuesta útil.',

      sources:
        extraerGroundingSources(
          data
        )
    };
  } catch (err) {
    logEvent(
      `Búsqueda web Gemini falló: ${err.message}`,
      true
    );

    return {
      text:
        `no pude buscar eso ahora: ${err.message}`,

      sources: []
    };
  }
}

// ============================================================
// OFERTAS
// ============================================================

async function buscarOfertasJuegos(
  consulta = ''
) {
  try {
    const params =
      new URLSearchParams({
        storeID: '1',
        upperPrice: '15',
        pageSize: '8'
      });

    if (
      consulta?.trim()
    ) {
      params.set(
        'title',
        consulta.trim()
      );
    }

    const deals =
      await fetchJson(
        `https://www.cheapshark.com/api/1.0/deals?${params}`,
        {},
        15000
      );

    if (
      !Array.isArray(deals) ||
      !deals.length
    ) {
      return 'no encontré ofertas ahora mismo.';
    }

    return deals
      .slice(0, 8)
      .map(
        d =>
          `- **${d.title}**: $${d.salePrice} (antes $${d.normalPrice}) • **-${Math.round(Number(d.savings) || 0)}%**\n  ${
            d.dealID
              ? `https://www.cheapshark.com/redirect?dealID=${d.dealID}`
              : ''
          }`
      )
      .join('\n');
  } catch (err) {
    logEvent(
      `Error buscando ofertas: ${err.message}`,
      true
    );

    return 'no pude consultar las ofertas ahora mismo.';
  }
}

// ============================================================
// TRES EN RAYA: MOTOR REAL + MINIMAX
// ============================================================

function crearTablero() {
  return Array(9).fill(null);
}

function comprobarGanador(
  board
) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
  ];

  for (
    const [a, b, c] of lines
  ) {
    if (
      board[a] &&
      board[a] ===
        board[b] &&
      board[a] ===
        board[c]
    ) {
      return board[a];
    }
  }

  return board.every(Boolean)
    ? 'draw'
    : null;
}

function movimientosLibres(
  board
) {
  return board
    .map(
      (value, index) =>
        value
          ? null
          : index
    )
    .filter(
      index =>
        index !== null
    );
}

function minimax(
  board,
  depth,
  maximizing
) {
  const result =
    comprobarGanador(
      board
    );

  if (result === 'O') {
    return 10 - depth;
  }

  if (result === 'X') {
    return depth - 10;
  }

  if (result === 'draw') {
    return 0;
  }

  const libres =
    movimientosLibres(
      board
    );

  if (maximizing) {
    let best = -Infinity;

    for (
      const index of libres
    ) {
      board[index] = 'O';

      best = Math.max(
        best,
        minimax(
          board,
          depth + 1,
          false
        )
      );

      board[index] = null;
    }

    return best;
  }

  let best = Infinity;

  for (
    const index of libres
  ) {
    board[index] = 'X';

    best = Math.min(
      best,
      minimax(
        board,
        depth + 1,
        true
      )
    );

    board[index] = null;
  }

  return best;
}

function mejorMovimientoKlint(
  board
) {
  const libres =
    movimientosLibres(
      board
    );

  if (!libres.length) {
    return null;
  }

  let bestScore =
    -Infinity;

  let bestMoves = [];

  for (
    const index of libres
  ) {
    board[index] = 'O';

    const score =
      minimax(
        board,
        0,
        false
      );

    board[index] = null;

    if (
      score >
      bestScore
    ) {
      bestScore = score;
      bestMoves = [
        index
      ];
    } else if (
      score ===
      bestScore
    ) {
      bestMoves.push(
        index
      );
    }
  }

  return bestMoves[
    Math.floor(
      Math.random() *
      bestMoves.length
    )
  ];
}

function renderizarTablero(
  board,
  disabled = false
) {
  const rows = [];

  for (
    let row = 0;
    row < 3;
    row++
  ) {
    const actionRow =
      new ActionRowBuilder();

    for (
      let col = 0;
      col < 3;
      col++
    ) {
      const index =
        row * 3 + col;

      const value =
        board[index];

      const button =
        new ButtonBuilder()
          .setCustomId(
            `tictactoe_${index}`
          )
          .setLabel(
            value || '·'
          )
          .setStyle(
            value === 'X'
              ? ButtonStyle.Primary
              : value === 'O'
                ? ButtonStyle.Danger
                : ButtonStyle.Secondary
          )
          .setDisabled(
            disabled ||
              Boolean(value)
          );

      actionRow.addComponents(
        button
      );
    }

    rows.push(
      actionRow
    );
  }

  return rows;
}

function limpiarJuegosExpirados() {
  const now =
    Date.now();

  for (
    const [
      messageId,
      game
    ] of activeGames.entries()
  ) {
    if (
      now -
        game.createdAt >
      GAME_TTL_MS
    ) {
      activeGames.delete(
        messageId
      );
    }
  }
}

setInterval(
  limpiarJuegosExpirados,
  5 * 60 * 1000
);

function textoFinalJuego(
  game,
  result
) {
  if (result === 'X') {
    return '🏆 **ganaste.** Klint se quedó sin respuesta esta vez.';
  }

  if (result === 'O') {
    return '🤖 **gané yo.** el minimax hizo su trabajo xd.';
  }

  if (result === 'draw') {
    return '🤝 **empate.** tablero completamente bloqueado.';
  }

  return game.turn === 'X'
    ? '❌ **tu turno.**'
    : '🔴 **turno de Klint...**';
}

async function iniciarJuego(
  interaction
) {
  if (
    !featureToggles.tictactoe
  ) {
    return interaction.reply({
      content:
        '🎮 el tres en raya está desactivado.',
      ephemeral: true
    });
  }

  const board =
    crearTablero();

  const game = {
    ownerId:
      interaction.user.id,

    board,

    turn: 'X',

    createdAt:
      Date.now()
  };

  const message =
    await interaction.reply({
      content:
        `❌ **TRES EN RAYA DE KLINT**\n${textoFinalJuego(
          game,
          null
        )}\nSolo ${interaction.user} puede jugar esta partida.`,

      components:
        renderizarTablero(
          board
        ),

      fetchReply: true
    });

  game.messageId =
    message.id;

  activeGames.set(
    message.id,
    game
  );
}

async function manejarMovimientoTresEnRaya(
  interaction
) {
  const game =
    activeGames.get(
      interaction.message.id
    );

  if (!game) {
    return interaction.reply({
      content:
        'esta partida ya expiró. usa `/juego` para crear otra.',
      ephemeral: true
    });
  }

  if (
    interaction.user.id !==
    game.ownerId
  ) {
    return interaction.reply({
      content:
        'esta partida pertenece a otra persona 😼',
      ephemeral: true
    });
  }

  if (
    game.turn !== 'X'
  ) {
    return interaction.reply({
      content:
        'espera a que Klint haga su movimiento.',
      ephemeral: true
    });
  }

  const index =
    Number(
      interaction.customId
        .split('_')[1]
    );

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > 8 ||
    game.board[index]
  ) {
    return interaction.reply({
      content:
        'esa casilla no está disponible.',
      ephemeral: true
    });
  }

  game.board[index] =
    'X';

  let result =
    comprobarGanador(
      game.board
    );

  if (result) {
    activeGames.delete(
      interaction.message.id
    );

    return interaction.update({
      content:
        `${textoFinalJuego(
          game,
          result
        )}\n${
          result === 'X'
            ? '🎉 buena jugada.'
            : '🧱 la partida terminó.'
        }`,

      components:
        renderizarTablero(
          game.board,
          true
        )
    });
  }

  game.turn = 'O';

  await interaction.update({
    content:
      '❌ **hiciste tu jugada.** Klint está pensando...',

    components:
      renderizarTablero(
        game.board,
        true
      )
  });

  await sleep(450);

  const aiMove =
    mejorMovimientoKlint(
      game.board
    );

  if (
    aiMove !== null
  ) {
    game.board[aiMove] =
      'O';
  }

  result =
    comprobarGanador(
      game.board
    );

  if (result) {
    activeGames.delete(
      interaction.message.id
    );

    return interaction.editReply({
      content:
        textoFinalJuego(
          game,
          result
        ),

      components:
        renderizarTablero(
          game.board,
          true
        )
    });
  }

  game.turn = 'X';

  return interaction.editReply({
    content:
      '🔴 **Klint jugó.** ' +
      textoFinalJuego(
        game,
        null
      ),

    components:
      renderizarTablero(
        game.board
      )
  });
}
// ============================================================
// PROCESADOR CENTRAL DE KLINT
// ============================================================

function construirHistorial(
  canal
) {
  if (!canal) return '';

  return canal.messages
    .fetch({
      limit: MAX_HISTORY
    })

    .then(messages =>
      messages
        .reverse()
        .map(message => {
          let extra = '';

          if (
            message.attachments
              .size
          ) {
            extra +=
              ` [archivo/imagen: ${message.attachments.first().url}]`;
          }

          if (
            message.stickers
              .size
          ) {
            extra +=
              ` [sticker: ${message.stickers.first().name}]`;
          }

          return `${message.author.username} (<@${message.author.id}>): ${limitarTexto(
            message.content,
            700
          )}${extra}`;
        })
        .join('\n')
    )

    .catch(err => {
      logEvent(
        `No se pudo leer historial: ${err.message}`,
        true
      );

      return '';
    });
}

async function ejecutarToolCall(
  call
) {
  const name =
    call.name;

  const args =
    call.args || {};

  if (
    name === 'buscar_gif'
  ) {
    const gif =
      await obtenerGifBinario(
        args.query ||
          'funny'
      );

    return {
      toolResult: {
        name,
        ok: Boolean(gif),
        message:
          gif
            ? 'GIF encontrado y preparado para Discord.'
            : 'No se pudo obtener un GIF.'
      },

      output: {
        type: 'gif',
        data: gif
      }
    };
  }

  if (
    name === 'crear_meme'
  ) {
    const url =
      generarUrlMemeImagen(
        args.texto ||
          'cuando | pasa xd'
      );

    return {
      toolResult: {
        name,
        ok: Boolean(url),
        message:
          url
            ? 'Meme generado.'
            : 'No se pudo generar el meme.'
      },

      output: {
        type: 'meme',
        data: url
      }
    };
  }

  if (
    name ===
    'buscar_ofertas'
  ) {
    const text =
      await buscarOfertasJuegos(
        args.consulta ||
          ''
      );

    return {
      toolResult: {
        name,
        ok: true,
        result: text
      },

      output: {
        type: 'text',
        data: text
      }
    };
  }

  return {
    toolResult: {
      name,
      ok: false,
      message:
        `Herramienta desconocida: ${name}`
    },

    output: {
      type: 'text',
      data: ''
    }
  };
}

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

    const historialFormateado =
      await construirHistorial(
        canal
      );

    let contextoMemoriaAutor =
      '';

    if (
      usuarioAutor?.id &&
      usuarioAutor.id !==
        'web_guest'
    ) {
      const datosFirebase =
        await obtenerMemoriaUsuario(
          usuarioAutor.id
        );

      if (
        datosFirebase?.memorias
      ) {
        const memorias =
          Object.values(
            datosFirebase.memorias
          )
            .filter(
              m => m?.resumen
            )
            .slice(
              -MAX_MEMORY_CONTEXT
            );

        if (
          memorias.length
        ) {
          contextoMemoriaAutor =
            `\nRECUERDOS ÚTILES DEL USUARIO:\n${memorias
              .map(
                m =>
                  `- ${limitarTexto(
                    m.resumen,
                    300
                  )}`
              )
              .join('\n')}`;
        }
      }
    }

    const texto =
      String(
        promptUsuario || ''
      ).trim();

    const pideGif =
      /\b(gif|gif de|manda.*gif|pasa.*gif|envía.*gif|envia.*gif)\b/i.test(
        texto
      );

    const pideMeme =
      /\b(crea.*meme|haz.*meme|genera.*meme|meme en imagen|meme de)\b/i.test(
        texto
      );

    const pideAudio =
      /\b(manda.*audio|manda audio|nota de voz|dilo en audio|audio)\b/i.test(
        texto
      );

    const pideWeb =
      /\b(busca en internet|busca en la web|búscame|buscame|busca.*web|investiga|averigua|qué pasó hoy|que paso hoy|últimas noticias|ultimas noticias|actualmente|hoy en día|hoy en dia)\b/i.test(
        texto
      );

    let reglas = `
REGLAS DE HERRAMIENTAS:

- Si el usuario pide un GIF, usa buscar_gif. No inventes URLs.
- Si pide crear un meme en imagen, usa crear_meme.
- Si pide ofertas de juegos, usa buscar_ofertas.
- Si pregunta algo actual o explícitamente pide buscar en Internet, usa Google Search si está disponible.
- Si una herramienta devuelve un archivo, no digas que solo tienes un enlace. El programa adjuntará el archivo real.
- No escribas nombres técnicos de herramientas al usuario.
- No inventes resultados de búsquedas.
`;

    if (pideGif) {
      reglas +=
        '\nEl usuario claramente quiere un GIF. Prioriza buscar_gif y elige una consulta descriptiva en inglés cuando ayude a Tenor.';
    }

    if (pideMeme) {
      reglas +=
        '\nEl usuario claramente quiere un meme en imagen. Usa crear_meme.';
    }

    if (pideWeb) {
      reglas +=
        '\nEl usuario quiere información web actual. Usa Google Search Grounding.';
    }

    if (pideAudio) {
      reglas +=
        '\nEl usuario quiere audio. Responde con la frase que debería decirse en voz alta, breve.';
    }

    const promptText =
      `${systemInstruction}

ENTORNO: ${
        esDM
          ? 'CHAT PRIVADO'
          : 'CHAT PÚBLICO'
      }

USUARIO: ${
        usuarioAutor?.username ||
        'Usuario'
      }

ESTADO DEL USUARIO:
${presenciaAutor}

${contextoMemoriaAutor}

HISTORIAL RECIENTE:
${
        historialFormateado ||
        '(sin historial)'
      }

${reglas}

MENSAJE ACTUAL:
${texto}`;

    const parts = [
      {
        text: promptText
      }
    ];

    for (
      const adj of adjuntos || []
    ) {
      if (
        !adj?.url ||
        !adj?.contentType?.startsWith(
          'image/'
        )
      ) {
        continue;
      }

      try {
        const buffer =
          await descargarBuffer(
            adj.url,
            15000
          );

        parts.push({
          inlineData: {
            mimeType:
              adj.contentType,

            data:
              buffer.toString(
                'base64'
              )
          }
        });
      } catch (err) {
        logEvent(
          `No se pudo descargar imagen adjunta: ${err.message}`,
          true
        );
      }
    }

    const useWeb =
      featureToggles.webSearch &&
      (
        pideWeb ||
        /\b(busca|search|investiga)\b/i.test(
          texto
        )
      );

    const tools =
      getGeminiTools({
        webSearch:
          useWeb
      });

    let contents = [
      {
        role: 'user',
        parts
      }
    ];

    let respuestaRaw =
      '';

    let gifResult =
      null;

    let memeImagenUrl =
      null;

    let audioUrlGenerado =
      null;

    let webSources =
      [];

    // Bucle de tool calling:
    // Gemini puede pedir una herramienta,
    // JS la ejecuta y luego Gemini recibe
    // el resultado para redactar la respuesta.
    for (
      let round = 0;
      round < 3;
      round++
    ) {
      const { data } =
        await llamarGeminiRaw(
          contents,
          {
            maxOutputTokens: 700,
            temperature: 0.75
          },
          {
            tools
          }
        );

      webSources.push(
        ...extraerGroundingSources(
          data
        )
      );

      const calls =
        extraerFunctionCalls(
          data
        );

      const textFromModel =
        extraerTextoGemini(
          data
        );

      if (
        !calls.length
      ) {
        respuestaRaw =
          textFromModel;

        break;
      }

      const modelContent =
        data?.candidates?.[0]
          ?.content;

      if (modelContent) {
        contents.push(
          modelContent
        );
      }

      const functionResponses =
        [];

      for (
        const call of calls
      ) {
        const execution =
          await ejecutarToolCall(
            call
          );

        const output =
          execution.output;

        if (
          output.type ===
            'gif' &&
          output.data
        ) {
          gifResult =
            output.data;
        }

        if (
          output.type ===
            'meme' &&
          output.data
        ) {
          memeImagenUrl =
            output.data;
        }

        functionResponses.push({
          functionResponse: {
            name:
              call.name,

            response:
              execution.toolResult
          }
        });
      }

      contents.push({
        role: 'user',
        parts:
          functionResponses
      });
    }

    // Compatibilidad adicional:
    // seguimos aceptando los tags antiguos.
    let respuesta =
      limpiarTexto(
        respuestaRaw
      );

    const oldGif =
      respuesta.match(
        /\[BUSCAR_GIF:\s*([^\]]+)\]/i
      );

    if (
      !gifResult &&
      (oldGif || pideGif)
    ) {
      const query =
        oldGif?.[1]?.trim() ||
        texto;

      gifResult =
        await obtenerGifBinario(
          query
        );

      respuesta =
        respuesta
          .replace(
            /\[BUSCAR_GIF:\s*([^\]]+)\]/gi,
            ''
          )
          .trim();
    }

    const oldMeme =
      respuesta.match(
        /\[GENERAR_MEME:\s*([^\]]+)\]/i
      );

    if (
      !memeImagenUrl &&
      (oldMeme || pideMeme)
    ) {
      memeImagenUrl =
        generarUrlMemeImagen(
          oldMeme?.[1]?.trim() ||
            'cuando | pasa xd'
        );

      respuesta =
        respuesta
          .replace(
            /\[GENERAR_MEME:\s*([^\]]+)\]/gi,
            ''
          )
          .trim();
    }

    if (pideAudio) {
      audioUrlGenerado =
        obtenerUrlAudioVozNativo(
          respuesta
        );
    }

    // Fallback determinista:
    // si Gemini no llamó la herramienta
    // pero la petición es muy explícita,
    // la función sigue funcionando.

    if (
      pideGif &&
      !gifResult
    ) {
      gifResult =
        await obtenerGifBinario(
          texto
        );
    }

    if (
      pideMeme &&
      !memeImagenUrl
    ) {
      memeImagenUrl =
        generarUrlMemeImagen(
          texto
        );
    }

    if (
      usuarioAutor?.id &&
      usuarioAutor.id !==
        'web_guest'
    ) {
      evaluarYGuardarMemoria(
        usuarioAutor,
        texto
      ).catch(() => {});
    }

    const uniqueSources =
      [];

    const sourceSeen =
      new Set();

    for (
      const source of
        webSources
    ) {
      if (
        !source?.url ||
        sourceSeen.has(
          source.url
        )
      ) {
        continue;
      }

      sourceSeen.add(
        source.url
      );

      uniqueSources.push(
        source
      );
    }

    return {
      respuesta:
        respuesta ||
        (
          gifResult ||
          memeImagenUrl
            ? 'aquí tienes 👇'
            : 'xd'
        ),

      gifBinario:
        gifResult,

      memeImagenUrl,

      audioUrl:
        audioUrlGenerado,

      webSources:
        uniqueSources.slice(
          0,
          MAX_WEB_RESULTS
        ),

      conteoMensajes:
        historialFormateado
          ? historialFormateado.split(
              '\n'
            ).length
          : 0
    };
  } catch (error) {
    logEvent(
      `Error en procesarRespuestaIA: ${
        error.stack ||
        error.message
      }`,
      true
    );

    return {
      respuesta:
        'me dio un lag xd',

      gifBinario:
        null,

      memeImagenUrl:
        null,

      audioUrl:
        null,

      webSources:
        [],

      conteoMensajes:
        0
    };
  }
}

// ============================================================
// ADJUNTOS / FUENTES / RESPUESTAS DISCORD
// ============================================================

function crearAdjuntos(
  resultado
) {
  const archivos = [];

  if (
    resultado?.memeImagenUrl
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
    resultado?.audioUrl
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
    resultado
      ?.gifBinario
      ?.attachment
  ) {
    archivos.push(
      resultado.gifBinario
        .attachment
    );
  }

  return archivos;
}

function agregarFuentesTexto(
  texto,
  sources
) {
  if (
    !sources?.length
  ) {
    return texto;
  }

  const fuentes =
    sources
      .slice(0, 3)
      .map(
        (source, index) =>
          `${index + 1}. ${source.title}\n${source.url}`
      )
      .join('\n');

  return `${texto}\n\n**fuentes:**\n${fuentes}`;
}

async function enviarRespuestaDiscord(
  target,
  resultado,
  replyMode = 'send'
) {
  let content =
    agregarFuentesTexto(
      resultado.respuesta ||
        'aquí tienes',
      resultado.webSources
    );

  content =
    limitarTexto(
      content,
      2000
    );

  const files =
    crearAdjuntos(
      resultado
    );

  if (
    replyMode === 'reply' &&
    typeof target.reply ===
      'function'
  ) {
    return target.reply({
      content,
      files,

      allowedMentions: {
        repliedUser:
          false
      }
    });
  }

  return target.send({
    content,
    files
  });
}

// ============================================================
// INTERACCIONES
// ============================================================

client.on(
  'interactionCreate',
  async interaction => {
    try {
      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'tictactoe_'
        )
      ) {
        return manejarMovimientoTresEnRaya(
          interaction
        );
      }

      if (
        !interaction.isChatInputCommand()
      ) {
        return;
      }

      if (
        interaction.commandName ===
        'juego'
      ) {
        return iniciarJuego(
          interaction
        );
      }

      if (
        interaction.commandName ===
        'klint'
      ) {
        await interaction.deferReply();

        const pregunta =
          interaction.options.getString(
            'pregunta',
            true
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

        return interaction.editReply({
          content:
            agregarFuentesTexto(
              resultado.respuesta,
              resultado.webSources
            ).slice(0, 2000),

          files:
            crearAdjuntos(
              resultado
            )
        });
      }

      if (
        interaction.commandName ===
        'gif'
      ) {
        await interaction.deferReply();

        const query =
          interaction.options.getString(
            'busqueda',
            true
          );

        const gif =
          await obtenerGifBinario(
            query
          );

        if (!gif) {
          return interaction.editReply(
            'no pude conseguir ese GIF ahora mismo 😭'
          );
        }

        return interaction.editReply({
          content:
            `🎞️ **gif:** ${limitarTexto(
              query,
              150
            )}`,

          files: [
            gif.attachment
          ]
        });
      }

      if (
        interaction.commandName ===
        'web'
      ) {
        await interaction.deferReply();

        const query =
          interaction.options.getString(
            'consulta',
            true
          );

        const result =
          await buscarEnWebConGemini(
            query
          );

        return interaction.editReply({
          content:
            agregarFuentesTexto(
              result.text,
              result.sources
            ).slice(0, 2000)
        });
      }

      if (
        interaction.commandName ===
        'ofertas'
      ) {
        await interaction.deferReply();

        const ofertasTxt =
          await buscarOfertasJuegos();

        return interaction.editReply(
          `🎮 **OFERTAS DESTACADAS:**\n${ofertasTxt}`.slice(
            0,
            2000
          )
        );
      }

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

        const datosFirebase =
          await obtenerMemoriaUsuario(
            user.id
          );

        const ramUsage =
          (
            process.memoryUsage()
              .heapUsed /
            1024 /
            1024
          ).toFixed(2);

        const uptimeMin =
          Math.floor(
            process.uptime() /
              60
          );

        let resumenMemoria =
          'Aún no tengo datos guardados sobre ti.';

        if (
          datosFirebase?.memorias
        ) {
          const memorias =
            Object.values(
              datosFirebase.memorias
            ).filter(
              m => m?.resumen
            );

          if (
            memorias.length
          ) {
            resumenMemoria =
              memorias
                .slice(-8)
                .map(
                  m =>
                    `- ${m.resumen}`
                )
                .join(
                  '\n'
                );
          }
        }

        const embed =
          new EmbedBuilder()
            .setTitle(
              '📊 Diagnóstico y ficha de Klint'
            )

            .setDescription(
              `👤 **Usuario:** ${user.username} (${nick})\n🆔 **ID:** \`${user.id}\`\n\n🎮 **Actividad:**\n${presencia}`
            )

            .addFields(
              {
                name:
                  '⚙️ Host',

                value:
                  `Servidores: **${client.guilds.cache.size}**\nPing: **${client.ws.ping} ms**\nRAM: **${ramUsage} MB**\nUptime: **${uptimeMin} min**`
              },

              {
                name:
                  '🧩 Módulos',

                value:
                  `🎙️ Audio: ${
                    featureToggles.audio
                      ? 'ON'
                      : 'OFF'
                  }\n🖼️ Memes: ${
                    featureToggles.memes
                      ? 'ON'
                      : 'OFF'
                  }\n🎞️ GIFs: ${
                    featureToggles.gifs
                      ? 'ON'
                      : 'OFF'
                  }\n🌐 Web: ${
                    featureToggles.webSearch
                      ? 'ON'
                      : 'OFF'
                  }\n🎮 Tres en Raya: ${
                    featureToggles.tictactoe
                      ? 'ON'
                      : 'OFF'
                  }`
              },

              {
                name:
                  '🧠 Memoria Firebase',

                value:
                  limitarTexto(
                    resumenMemoria,
                    1000
                  )
              }
            )

            .setTimestamp();

        return interaction.editReply({
          embeds: [
            embed
          ]
        });
      }
    } catch (err) {
      logEvent(
        `Error en interactionCreate: ${
          err.stack ||
          err.message
        }`,
        true
      );

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        try {
          await interaction.editReply(
            'me dio un error procesando eso xd'
          );
        } catch {}
      } else {
        try {
          await interaction.reply({
            content:
              'me dio un error procesando eso xd',
            ephemeral: true
          });
        } catch {}
      }
    }
  }
);

// ============================================================
// MENSAJES NORMALES
// ============================================================

client.on(
  'messageCreate',
  async message => {
    if (
      message.author.bot
    ) {
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
        message.mentions.has(
          client.user.id
        );

      const contieneNombre =
        patronNombres.test(
          textoLower
        );

      const tieneAdjuntos =
        message.attachments
          .size > 0;

      const tieneStickers =
        message.stickers
          .size > 0;

      if (
        contieneNombre &&
        (
          textoLower.includes(
            'cambia tu estado'
          ) ||
          textoLower.includes(
            'ponte de estado'
          )
        )
      ) {
        await message.channel.sendTyping();

        await actualizarEstadoIA(
          texto
        );

        return message.reply(
          'ya lo cambié xd'
        );
      }

      if (
        !(
          esDM ||
          fueMencionadoDirectamente ||
          contieneNombre ||
          tieneAdjuntos ||
          tieneStickers
        )
      ) {
        return;
      }

      await message.channel.sendTyping();

      const adjuntosArray =
        Array.from(
          message.attachments.values()
        ).map(
          attachment => ({
            url:
              attachment.url,

            contentType:
              attachment.contentType ||
              'image/png'
          })
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

      return enviarRespuestaDiscord(
        message,
        resultado,
        'reply'
      );
    } catch (err) {
      logEvent(
        `Error enviando mensaje a Discord: ${
          err.stack ||
          err.message
        }`,
        true
      );

      try {
        await message.reply(
          'se me cruzaron los cables xd'
        );
      } catch {}
    }
  }
);

// ============================================================
// VALIDACIÓN DE ARRANQUE
// ============================================================

if (
  !process.env.DISCORD_TOKEN
) {
  logEvent(
    'Falta DISCORD_TOKEN.',
    true
  );
}

if (
  !GEMINI_API_KEY
) {
  logEvent(
    'Falta GEMINI_API_KEY.',
    true
  );
}

if (
  !obtenerFirebaseUrl()
) {
  logEvent(
    'FIREBASE_DATABASE_URL no configurada. La memoria estará desactivada.',
    true
  );
}

if (
  !TENOR_API_KEY
) {
  logEvent(
    'TENOR_API_KEY no configurada. Los GIFs reales no funcionarán hasta agregarla.',
    true
  );
}

client.login(
  process.env.DISCORD_TOKEN
);
