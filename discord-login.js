// ? - À lancer une seule fois : Discord exige qu'un bot se soit connecté au gateway avant de pouvoir poster en REST
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => {
	console.log(`Connecté en tant que ${client.user.tag}, c'est bon.`);
	client.destroy();
});
const login = client.login(process.env.DISCORD_TOKEN ?? process.env.TOKEN);
console.log('Connexion au gateway Discord...', login.then((e) => 'OK ' + e).catch(err => `ERREUR : ${err}`));