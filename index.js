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
} = require('discord.js');

// Escapa los caracteres especiales de Markdown para que Telegram no falle
function escaparMarkdown(texto) {
    return String(texto).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// --- Telegram (sin librería, usando fetch nativo) ---
async function enviarTelegram(texto) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: texto,
            parse_mode: 'MarkdownV2',
        }),
    });
    if (!res.ok) {
        const detalle = await res.text();
        throw new Error(`Telegram error ${res.status}: ${detalle}`);
    }
    return res.json();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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

// Publica el mensaje fijo con el botón en el canal configurado.
async function publicarBotonFijo() {
    try {
        const canal = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        if (!canal) {
            console.error('No se encontró el canal DISCORD_CHANNEL_ID.');
            return;
        }

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

// Valida una fecha en formato DD/MM/AAAA. Devuelve {ok, valor} o {ok:false, error}
function validarFecha(entrada) {
    const limpio = entrada.trim();
    const m = limpio.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) {
        return { ok: false, error: 'El formato debe ser DD/MM/AAAA. Ejemplo: 25/12/2026' };
    }

    const dia = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    const anio = parseInt(m[3], 10);

    if (mes < 1 || mes > 12) return { ok: false, error: 'El mes debe estar entre 01 y 12.' };
    if (dia < 1 || dia > 31) return { ok: false, error: 'El día no es válido.' };

    const fecha = new Date(anio, mes - 1, dia);
    // Comprueba que la fecha exista de verdad (ej: 31/02 no existe)
    if (fecha.getDate() !== dia || fecha.getMonth() !== mes - 1 || fecha.getFullYear() !== anio) {
        return { ok: false, error: 'Esa fecha no existe. Revísala (ejemplo válido: 25/12/2026).' };
    }

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    if (fecha < hoy) {
        return { ok: false, error: 'La fecha no puede ser anterior a hoy.' };
    }

    const dd = String(dia).padStart(2, '0');
    const mm = String(mes).padStart(2, '0');
    return { ok: true, valor: `${dd}/${mm}/${anio}` };
}

// Construye el modal del formulario, con la fecha como campo de texto
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

    const fecha = new TextInputBuilder()
        .setCustomId('fecha')
        .setLabel('Fecha (DD/MM/AAAA)')
        .setPlaceholder('Ej: 25/12/2026')
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
        new ActionRowBuilder().addComponents(fecha),
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

    // Procesar el modal → validar todo → enviar a Telegram
    if (interaction.isModalSubmit() && interaction.customId === 'form_modal') {
        const nombre = interaction.fields.getTextInputValue('nombre');
        const usuario = interaction.fields.getTextInputValue('usuario');
        const cantidadRaw = interaction.fields.getTextInputValue('cantidad');
        const fechaRaw = interaction.fields.getTextInputValue('fecha');
        const mensaje = interaction.fields.getTextInputValue('mensaje') || '(sin notas)';

        // Validar cantidad
        const cantidadNum = parseFloat(cantidadRaw.replace(',', '.').replace(/[^\d.]/g, ''));
        if (isNaN(cantidadNum) || cantidadNum <= 0) {
            await interaction.reply({
                content: '❌ La **cantidad** no es válida. Usa solo números (ejemplo: 1500). Vuelve a pulsar el botón e inténtalo de nuevo.',
                ephemeral: true,
            });
            return;
        }

        // Validar fecha
        const fechaCheck = validarFecha(fechaRaw);
        if (!fechaCheck.ok) {
            await interaction.reply({
                content: `❌ La **fecha** no es válida: ${fechaCheck.error}\n\nVuelve a pulsar el botón e inténtalo de nuevo.`,
                ephemeral: true,
            });
            return;
        }
        const fecha = fechaCheck.valor;

        // Construir mensaje para Telegram (datos del usuario escapados)
        const texto =
            `📋 *NUEVA OPERACIÓN P2P*\n\n` +
            `👤 *Usuario Discord \\(cuenta\\):* ${escaparMarkdown(interaction.user.tag)}\n` +
            `📝 *Nombre:* ${escaparMarkdown(nombre)}\n` +
            `💬 *Usuario indicado:* ${escaparMarkdown(usuario)}\n` +
            `💶 *Cantidad:* ${escaparMarkdown(cantidadNum.toLocaleString('es-ES'))} €\n` +
            `📅 *Fecha acordada:* ${escaparMarkdown(fecha)}\n` +
            `📍 *Lugar:* VALENCIA, ESPAÑA \\(en persona\\)\n` +
            `💵 *Modalidad:* SOLO DAMOS EFECTIVO \\(no recibimos efectivo\\)\n` +
            `🗒️ *Nota:* ${escaparMarkdown(mensaje)}`;

        try {
            await enviarTelegram(texto);

            await interaction.reply({
                content:
                    `✅ **¡Operación registrada correctamente!**\n\n` +
                    `📝 Nombre: **${nombre}**\n` +
                    `💶 Cantidad: **${cantidadNum.toLocaleString('es-ES')} €**\n` +
                    `📅 Fecha: **${fecha}**\n\n` +
                    `📍 Recuerda: debes acudir **EN PERSONA a VALENCIA, ESPAÑA**.\n` +
                    `💵 Modalidad: **solo damos efectivo** (no recibimos efectivo).`,
                ephemeral: true,
            });
        } catch (err) {
            console.error('Error enviando a Telegram:', err);
            await interaction.reply({
                content: '❌ Hubo un error al registrar la operación. Inténtalo de nuevo en unos minutos.',
                ephemeral: true,
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