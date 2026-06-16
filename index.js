require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');

// --- Telegram (sin librería, usando fetch nativo) ---
async function enviarTelegram(texto) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: texto,
            parse_mode: 'Markdown',
        }),
    });
    if (!res.ok) {
        const detalle = await res.text();
        throw new Error(`Telegram error ${res.status}: ${detalle}`);
    }
    return res.json();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const pendingForms = new Map();

// Mantenemos /formulario como respaldo, pero el uso principal es el botón fijo
const commands = [
    new SlashCommandBuilder()
        .setName('formulario')
        .setDescription('Abre el formulario de operación P2P')
        .toJSON(),
];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
        Routes.applicationGuildCommands(
            process.env.DISCORD_CLIENT_ID,
            process.env.DISCORD_GUILD_ID
        ),
        { body: commands }
    );
    console.log('Comando registrado.');
}

// Publica (una sola vez) el mensaje fijo con el botón en el canal configurado.
// Antes de publicar, borra mensajes anteriores del bot para no duplicar el botón.
async function publicarBotonFijo() {
    try {
        const canal = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        if (!canal) {
            console.error('No se encontró el canal DISCORD_CHANNEL_ID.');
            return;
        }

        // Limpia mensajes previos del propio bot (botones antiguos)
        const mensajes = await canal.messages.fetch({ limit: 20 });
        const mios = mensajes.filter((m) => m.author.id === client.user.id);
        for (const m of mios.values()) {
            await m.delete().catch(() => { });
        }

        const boton = new ButtonBuilder()
            .setCustomId('abrir_formulario')
            .setLabel('📝 RELLENAR FORMULARIO P2P')
            .setStyle(ButtonStyle.Success);

        await canal.send({
            content:
                '# 🪙 FORMULARIO DE OPERACIÓN P2P\n\n' +
                '## ⚠️ LEE ANTES DE EMPEZAR:\n' +
                '### 📍 El P2P se realiza **EN PERSONA** y **OBLIGATORIAMENTE EN VALENCIA, ESPAÑA**.\n' +
                '### 💵 **SOLO DAMOS EFECTIVO** — NO recibimos efectivo por el momento.\n\n' +
                'No se realizan operaciones a distancia bajo ningún concepto.\n\n' +
                '👇 **Pulsa el botón verde de abajo para rellenar tu solicitud:**',
            components: [new ActionRowBuilder().addComponents(boton)],
        });

        console.log('Botón fijo publicado en el canal.');
    } catch (err) {
        console.error('Error publicando el botón fijo:', err);
    }
}

function generarOpcionesFecha() {
    const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const opciones = [];
    const hoy = new Date();

    for (let i = 0; i < 25; i++) {
        const fecha = new Date(hoy);
        fecha.setDate(hoy.getDate() + i);

        const yyyy = fecha.getFullYear();
        const mm = String(fecha.getMonth() + 1).padStart(2, '0');
        const dd = String(fecha.getDate()).padStart(2, '0');
        const valor = `${yyyy}-${mm}-${dd}`;

        let etiqueta = `${dias[fecha.getDay()]} ${dd} ${meses[fecha.getMonth()]} ${yyyy}`;
        if (i === 0) etiqueta = `Hoy · ${etiqueta}`;
        if (i === 1) etiqueta = `Mañana · ${etiqueta}`;

        opciones.push({ label: etiqueta, value: valor });
    }
    return opciones;
}

// Construye el modal del formulario (reutilizado por el botón y por /formulario)
function construirModal() {
    const modal = new ModalBuilder()
        .setCustomId('form_modal')
        .setTitle('Operación P2P · Cripto');

    const nombre = new TextInputBuilder()
        .setCustomId('nombre')
        .setLabel('Tu nombre completo')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const usuario = new TextInputBuilder()
        .setCustomId('usuario')
        .setLabel('Tu usuario de Discord')
        .setPlaceholder('Ej: brann0490')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const cantidad = new TextInputBuilder()
        .setCustomId('cantidad')
        .setLabel('Cantidad en dinero (€)')
        .setPlaceholder('Ej: 1500')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const mensaje = new TextInputBuilder()
        .setCustomId('mensaje')
        .setLabel('Nota adicional (opcional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nombre),
        new ActionRowBuilder().addComponents(usuario),
        new ActionRowBuilder().addComponents(cantidad),
        new ActionRowBuilder().addComponents(mensaje)
    );

    return modal;
}

client.on('interactionCreate', async (interaction) => {
    // Abrir el formulario al pulsar el botón fijo
    if (interaction.isButton() && interaction.customId === 'abrir_formulario') {
        await interaction.showModal(construirModal());
        return;
    }

    // Respaldo: /formulario sigue funcionando
    if (interaction.isChatInputCommand() && interaction.commandName === 'formulario') {
        if (interaction.channelId !== process.env.DISCORD_CHANNEL_ID) {
            await interaction.reply({
                content: `❌ Este comando solo se puede usar en <#${process.env.DISCORD_CHANNEL_ID}>.`,
                ephemeral: true,
            });
            return;
        }
        await interaction.showModal(construirModal());
        return;
    }

    // Procesar el modal → validar → pedir fecha
    if (interaction.isModalSubmit() && interaction.customId === 'form_modal') {
        const nombre = interaction.fields.getTextInputValue('nombre');
        const usuario = interaction.fields.getTextInputValue('usuario');
        const cantidadRaw = interaction.fields.getTextInputValue('cantidad');
        const mensaje = interaction.fields.getTextInputValue('mensaje') || '(sin notas)';

        const cantidadNum = parseFloat(cantidadRaw.replace(',', '.').replace(/[^\d.]/g, ''));
        if (isNaN(cantidadNum) || cantidadNum <= 0) {
            await interaction.reply({
                content: '❌ La cantidad introducida no es válida. Usa solo números (ej: 1500).',
                ephemeral: true,
            });
            return;
        }

        pendingForms.set(interaction.user.id, {
            nombre,
            usuario,
            cantidad: cantidadNum,
            mensaje,
        });

        const selectFecha = new StringSelectMenuBuilder()
            .setCustomId('select_fecha')
            .setPlaceholder('📅 Selecciona la fecha de la operación')
            .addOptions(generarOpcionesFecha());

        await interaction.reply({
            content:
                '🔴 **IMPORTANTE — LEE ANTES DE CONTINUAR** 🔴\n\n' +
                '# ⚠️ EL P2P ES EN PERSONA, OBLIGATORIAMENTE ⚠️\n' +
                '## 📍 TÚ DEBES DESPLAZARTE A **VALENCIA, ESPAÑA** PARA REALIZARLO.\n\n' +
                '## 💵 SOLO DAMOS EFECTIVO — NO RECIBIMOS EFECTIVO POR EL MOMENTO.\n\n' +
                'No se realizan operaciones a distancia bajo ningún concepto.\n\n' +
                '👇 Si estás de acuerdo, **selecciona la fecha** en la que acudirás:',
            components: [new ActionRowBuilder().addComponents(selectFecha)],
            ephemeral: true,
        });
        return;
    }

    // El usuario elige fecha → enviar a Telegram
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_fecha') {
        const datos = pendingForms.get(interaction.user.id);
        if (!datos) {
            await interaction.reply({
                content: '❌ La sesión expiró. Vuelve a pulsar el botón del formulario.',
                ephemeral: true,
            });
            return;
        }

        const fecha = interaction.values[0];

        const texto =
            `📋 *NUEVA OPERACIÓN P2P*\n\n` +
            `👤 *Usuario Discord (cuenta):* ${interaction.user.tag}\n` +
            `📝 *Nombre:* ${datos.nombre}\n` +
            `💬 *Usuario indicado:* ${datos.usuario}\n` +
            `💶 *Cantidad:* ${datos.cantidad.toLocaleString('es-ES')} €\n` +
            `📅 *Fecha acordada:* ${fecha}\n` +
            `📍 *Lugar:* VALENCIA, ESPAÑA (en persona)\n` +
            `💵 *Modalidad:* SOLO DAMOS EFECTIVO (no recibimos efectivo)\n` +
            `🗒️ *Nota:* ${datos.mensaje}`;

        try {
            await enviarTelegram(texto);
            pendingForms.delete(interaction.user.id);

            await interaction.update({
                content:
                    `✅ **¡Operación registrada correctamente!**\n\n` +
                    `📅 Fecha: **${fecha}**\n` +
                    `💶 Cantidad: **${datos.cantidad.toLocaleString('es-ES')} €**\n\n` +
                    `📍 Recuerda: debes acudir **EN PERSONA a VALENCIA, ESPAÑA**.\n` +
                    `💵 Modalidad: **solo damos efectivo** (no recibimos efectivo).`,
                components: [],
            });
        } catch (err) {
            console.error('Error enviando a Telegram:', err);
            await interaction.update({
                content: '❌ Hubo un error al registrar la operación. Inténtalo de nuevo.',
                components: [],
            });
        }
        return;
    }
});

client.once('ready', async () => {
    console.log(`Bot conectado como ${client.user.tag}`);
    await publicarBotonFijo();
});

registerCommands().catch(console.error);
client.login(process.env.DISCORD_TOKEN);