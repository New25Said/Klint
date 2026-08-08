const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const path = require('path');

// Express Server para servir index.html y mantener Render activo
const app = express();
const PORT = process.env.PORT || 10000;

// Servir el archivo index.html en la raíz "/"
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP activo en puerto ${PORT}`);
});

// Auto-ping con la URL en duro para Render Free Tier (cada 10 minutos)
const RENDER_URL = 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => console.log('Self-ping exitoso para mantener Klint activo.'))
    .catch((err) => console.error('Error en self-ping:', err));
}, 10 * 60 * 1000);

// Inicialización de la API de Gemini con el modelo gratuito compatible
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-8b' });

// Inicialización del Cliente de Discord con los Intents necesarios
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Prompt base del sistema para definir la personalidad de Klint
const SYSTEM_INSTRUCTION = `
Eres Klint, un usuario más de la comunidad de Discord. 
- Tu estilo es natural, relajado, informal y casual. Usa abreviaciones o formas de escribir comunes en internet de forma orgánica, sin sonar robótico ni forzado a ser humano.
- Responde de forma concisa o detallada según lo requiera el contexto del chat.
- Analiza todo el historial reciente enviado para entender si te están hablando a ti, si la conversación terminó, o si están escribiendo ideas en varios mensajes separados.
- No interrumpas conversaciones ajenas si no te están invocando o mencionando directamente.
`;

// Registro de Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('klint')
    .setDescription('Hazle una pregunta a Klint')
    .addStringOption(option =>
      option.setName('pregunta')
        .setDescription('Lo que quieres preguntarle a Klint')
        .setRequired(true)
    )
].map(command => command.toJSON());

// Evento clientReady
client.once('clientReady', async () => {
  console.log(`Klint ha iniciado sesión como ${client.user.tag}`);

  // Registrar comandos slash globalmente
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Comandos /klint registrados correctamente.');
  } catch (error) {
    console.error('Error al registrar comandos slash:', error);
  }

  // Bucle autónomo para cambiar estado y actividad de forma independiente
  actualizarEstadoAutonomo();
  setInterval(actualizarEstadoAutonomo, 20 * 60 * 1000); // Cambia cada 20 minutos
});

// Función para cambiar de estado (Online, Idle, DND) y actividad sin depender de mensajes
async function actualizarEstadoAutonomo() {
  try {
    const promptEstado = 'Genera un estado corto de Discord para un usuario casual (máximo 5 palabras). Responde SOLO con el texto del estado, sin comillas ni explicaciones.';
    const result = await model.generateContent(promptEstado);
    const response = await result.response;
    const textoEstado = response.text()?.trim() || 'viendo el chat';

    const estados = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estados[Math.floor(Math.random() * estados.length)];

    client.user.setPresence({
      status: estadoAleatorio,
      activities: [{ name: textoEstado, type: ActivityType.Custom }]
    });
    console.log(`Estado cambiado a [${estadoAleatorio}]: ${textoEstado}`);
  } catch (error) {
    console.error('Error al actualizar estado autónomo:', error);
  }
}

// Función auxiliar para compilar contexto del canal e interactuar con la IA
async function procesarRespuestaIA(canal, promptUsuario) {
  try {
    // Obtener los últimos 10 mensajes del canal para mantener contexto
    const mensajesPrevios = await canal.messages.fetch({ limit: 10 });
    const historialFormateado = mensajesPrevios.reverse().map(m => {
      const usuario = m.author.username;
      const contenido = m.content;
      
      let actividad = '';
      if (m.member?.presence?.activities?.length) {
        const act = m.member.presence.activities[0];
        actividad = ` [Actividad: ${act.name}]`;
      }
      return `${usuario}${actividad}: ${contenido}`;
    }).join('\n');

    const promptCompleto = `${SYSTEM_INSTRUCTION}

HISTORIAL RECIENTE DEL CHAT:
${historialFormateado}

PREGUNTA/MENSAJE ACTUAL A RESPONDER:
${promptUsuario}`;

    const result = await model.generateContent(promptCompleto);
    const response = await result.response;

    return response.text() || 'banco de memoria vacío, no sé qué decir jsjs';
  } catch (error) {
    console.error('Error en Gemini API:', error);
    return 'me dio un lag en el cerebro, intenta de nuevo en un rato.';
  }
}

// Manejo de Slash Commands (/klint)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'klint') {
    await interaction.deferReply();
    const pregunta = interaction.options.getString('pregunta');
    const respuesta = await procesarRespuestaIA(interaction.channel, pregunta);
    
    if (respuesta.length > 2000) {
      await interaction.editReply(respuesta.slice(0, 1995) + '...');
    } else {
      await interaction.editReply(respuesta);
    }
  }
});

// Manejo de Mensajes Directos y menciones por nombre en Servidores
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const esDM = !message.guild;
  const textoLower = message.content.toLowerCase();
  
  // Detección de nombres: clin, klin, klint, klinty
  const patronNombres = /\b(clin|klin|klint|klinty)\b/i;
  const fueMencionadoDirectamente = message.mentions.has(client.user.id);
  const contieneNombre = patronNombres.test(textoLower);

  if (esDM || fueMencionadoDirectamente || contieneNombre) {
    await message.channel.sendTyping();
    const respuesta = await procesarRespuestaIA(message.channel, message.content);
    
    if (respuesta.length > 2000) {
      await message.reply(respuesta.slice(0, 1995) + '...');
    } else {
      await message.reply(respuesta);
    }
  }
});

// Login en Discord
client.login(process.env.DISCORD_TOKEN);
