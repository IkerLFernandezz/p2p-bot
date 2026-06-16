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

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'formulario') {
        if (interaction.channelId !== process.env.DISCORD_CHANNEL_ID) {
            await interaction.reply({
                content: `❌ Este comando solo se puede usar en <#${process.env.DISCORD_CHANNEL_ID}>.`,
                ephemeral: true,
            });
            return;
        }

        const modal = new ModalBuilder()
            .setCustomId('form_modal')
            .setTitle('Operación P2P · Cripto');

        const nombre = new TextInputBuilder()
            .setCustomId('nombre')
            .setLabel('Tu nombre / contacto')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const cripto = new TextInputBuilder()
            .setCustomId('cripto')
            .setLabel('Cripto y operación (ej: Compro USDT)')
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
            .setLabel('Notas adicionales')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(nombre),
            new ActionRowBuilder().addComponents(cripto),
            new ActionRowBuilder().addComponents(cantidad),
            new ActionRowBuilder().addComponents(mensaje)
        );

        await interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'form_modal') {
        const nombre = interaction.fields.getTextInputValue('nombre');
        const cripto = interaction.fields.getTextInputValue('cripto');
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
            cripto,
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
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_fecha') {
        const datos = pendingForms.get(interaction.user.id);
        if (!datos) {
            await interaction.reply({
                content: '❌ La sesión expiró. Vuelve a usar /formulario.',
                ephemeral: true,
            });
            return;
        }

        const fecha = interaction.values[0];

        const texto =
            `📋 *NUEVA OPERACIÓN P2P*\n\n` +
            `👤 *Usuario Discord:* ${interaction.user.tag}\n` +
            `📝 *Nombre/Contacto:* ${datos.nombre}\n` +
            `🪙 *Operación:* ${datos.cripto}\n` +
            `💶 *Cantidad:* ${datos.cantidad.toLocaleString('es-ES')} €\n` +
            `📅 *Fecha acordada:* ${fecha}\n` +
            `📍 *Lugar:* VALENCIA, ESPAÑA (en persona)\n` +
            `💵 *Modalidad:* SOLO DAMOS EFECTIVO (no recibimos efectivo)\n` +
            `💬 *Notas:* ${datos.mensaje}`;

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
    }
});

client.once('ready', () => {
    console.log(`Bot conectado como ${client.user.tag}`);
});

registerCommands().catch(console.error);
client.login(process.env.DISCORD_TOKEN);