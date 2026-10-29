require('dotenv').config();
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { REST, Routes, EmbedBuilder } = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? process.env.TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_AUTH;
const { GITHUB_WEBHOOK_SECRET, CHANNEL_ID } = process.env;
const PORT = process.env.PORT ?? 8080;

// ? - Liste des repos suivis : repos.json par défaut, ou la variable REPOS_JSON (même format)
const loadRepos = () => {
	const raw = process.env.REPOS_JSON
		?? fs.readFileSync(process.env.REPOS_FILE ?? path.join(__dirname, 'repos.json'), 'utf8');
	const repos = {};
	for (const [fullName, options] of Object.entries(JSON.parse(raw).repos ?? {})) {
		repos[fullName.toLowerCase()] = {
			fullName,
			label: fullName.split('/')[1],
			colour: '#5865F2',
			channelId: CHANNEL_ID,
			...options,
		};
	}
	return repos;
};

const repos = loadRepos();

const missing = [];
if (!DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
if (Object.keys(repos).length === 0) missing.push('repos (repos.json ou REPOS_JSON)');
for (const repo of Object.values(repos)) {
	if (!repo.channelId) missing.push(`CHANNEL_ID (ou channelId pour ${repo.fullName})`);
}
if (missing.length > 0) {
	console.error('ERREUR : configuration manquante :', missing.join(', '));
	process.exit(1);
}
if (!GITHUB_WEBHOOK_SECRET) console.warn('ATTENTION : GITHUB_WEBHOOK_SECRET absent, les webhooks ne sont pas vérifiés');
if (!GITHUB_TOKEN) console.warn('ATTENTION : GITHUB_TOKEN absent, seuls les repos publics marcheront (60 requêtes/h)');

console.log('Repos suivis :', Object.values(repos).map(repo => repo.fullName).join(', '));

// ? - Discord en REST uniquement : pas de connexion gateway, donc compatible avec Cloud Run (scale à zéro)
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

let botUserId;
const getBotUserId = async () => {
	botUserId ??= (await rest.get(Routes.user())).id;
	return botUserId;
};

// ? - Les 100 derniers messages du bot qui contiennent un embed de PR
const fetchPrMessages = async (channelId) => {
	const [messages, botId] = await Promise.all([
		rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '100' }) }),
		getBotUserId(),
	]);
	return messages.filter(message => message.author.id === botId && message.embeds[0]?.url);
};

const findPrMessage = async (repo, prUrl) =>
	(await fetchPrMessages(repo.channelId)).find(message => message.embeds[0].url === prUrl);

const github = async (route) => {
	const response = await fetch(`https://api.github.com${route}`, {
		headers: {
			'Accept': 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			...(GITHUB_TOKEN && { Authorization: `Bearer ${GITHUB_TOKEN}` }),
		},
	});
	if (!response.ok) throw new Error(`GitHub ${response.status} sur ${route}`);
	return response.json();
};

const buildEmbed = (repo, pr) => new EmbedBuilder()
	.setColor(repo.colour)
	.setTitle(`#${pr.number} : ${pr.title}`.slice(0, 256))
	.setURL(pr.html_url)
	.setAuthor({ name: pr.user.login, iconURL: pr.user.avatar_url, url: pr.user.html_url })
	.setDescription(`\`${pr.head.ref}\` → \`${pr.base.ref}\``)
	.addFields({ name: 'Repo', value: repo.fullName, inline: true }, { name: 'Projet', value: repo.label, inline: true })
	.setTimestamp(new Date(pr.created_at))
	.toJSON();

// ? - Crée le message de la PR s'il n'existe pas, le met à jour si update est vrai
const upsertPrMessage = async (repo, pr, { update = false } = {}) => {
	const existing = await findPrMessage(repo, pr.html_url);
	const body = { embeds: [buildEmbed(repo, pr)] };
	if (existing) {
		if (update) await rest.patch(Routes.channelMessage(repo.channelId, existing.id), { body });
		return existing;
	}
	if (repo.mentionRoleId) {
		body.content = `<@&${repo.mentionRoleId}>`;
		body.allowed_mentions = { roles: [repo.mentionRoleId] };
	}
	console.log('Nouvelle PR postée :', pr.html_url);
	return rest.post(Routes.channelMessages(repo.channelId), { body });
};

const deletePrMessage = async (repo, prUrl) => {
	const existing = await findPrMessage(repo, prUrl);
	if (existing) await rest.delete(Routes.channelMessage(repo.channelId, existing.id));
};

const reactions = { APPROVED: '✅', CHANGES_REQUESTED: '❌', COMMENTED: '💬' };

const react = (repo, message, emoji) =>
	rest.put(Routes.channelMessageOwnReaction(repo.channelId, message.id, encodeURIComponent(emoji)));

const applyReview = async (repo, message, state) => {
	if (state === 'DISMISSED') {
		await rest.delete(Routes.channelMessageOwnReaction(repo.channelId, message.id, encodeURIComponent(reactions.APPROVED)));
		return;
	}
	if (reactions[state]) await react(repo, message, reactions[state]);
};

const reactToPr = async (repo, prUrl, state) => {
	const message = await findPrMessage(repo, prUrl);
	if (message) await applyReview(repo, message, state.toUpperCase());
};

// ? - Aligne le salon avec les PR ouvertes du repo : ajoute les manquantes, supprime les fermées ou en draft
const syncRepo = async (repo) => {
	const openPrs = (await github(`/repos/${repo.fullName}/pulls?state=open&per_page=100`)).filter(pr => !pr.draft);
	const messages = (await fetchPrMessages(repo.channelId))
		.filter(message => message.embeds[0].fields?.[0]?.value?.toLowerCase() === repo.fullName.toLowerCase());

	for (const pr of openPrs) {
		if (messages.some(message => message.embeds[0].url === pr.html_url)) continue;
		const message = await upsertPrMessage(repo, pr);
		for (const review of await github(`/repos/${repo.fullName}/pulls/${pr.number}/reviews`)) {
			await applyReview(repo, message, review.state);
		}
	}

	const openUrls = new Set(openPrs.map(pr => pr.html_url));
	for (const message of messages) {
		if (!openUrls.has(message.embeds[0].url)) await rest.delete(Routes.channelMessage(repo.channelId, message.id));
	}
};

const handleEvent = async (event, payload, repo) => {
	const { action } = payload;

	if (event === 'pull_request') {
		const pr = payload.pull_request;
		switch (action) {
		case 'opened':
		case 'reopened':
		case 'ready_for_review':
			if (!pr.draft) await upsertPrMessage(repo, pr);
			break;
		case 'edited':
			if (!pr.draft) await upsertPrMessage(repo, pr, { update: true });
			break;
		case 'closed':
		case 'converted_to_draft':
			await deletePrMessage(repo, pr.html_url);
			break;
		default:
			return `Action ignorée : pull_request.${action}`;
		}
		await syncRepo(repo);
		return `OK : pull_request.${action}`;
	}

	if (event === 'pull_request_review' && action === 'submitted') {
		await reactToPr(repo, payload.pull_request.html_url, payload.review.state);
		return `OK : review ${payload.review.state}`;
	}

	if (event === 'pull_request_review_comment' && action === 'created') {
		await reactToPr(repo, payload.pull_request.html_url, 'COMMENTED');
		return 'OK : commentaire de review';
	}

	if (event === 'issue_comment' && action === 'created' && payload.issue.pull_request) {
		await reactToPr(repo, payload.issue.html_url, 'COMMENTED');
		return 'OK : commentaire';
	}

	return `Événement ignoré : ${event}.${action}`;
};

// ? - Les webhooks sont traités un par un pour éviter les doublons de messages
let queue = Promise.resolve();
const enqueue = (task) => {
	const run = queue.catch(() => undefined).then(task);
	queue = run;
	return run;
};

const isValidSignature = (req) => {
	if (!GITHUB_WEBHOOK_SECRET) return true;
	const signature = Buffer.from(req.get('X-Hub-Signature-256') ?? '');
	const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(req.rawBody ?? '').digest('hex')}`);
	return signature.length === expected.length && crypto.timingSafeEqual(signature, expected);
};

const app = express();

app.get('/', (_req, res) => res.send('OK'));

app.post('/', express.json({ limit: '5mb', verify: (req, _res, buffer) => { req.rawBody = buffer; } }), async (req, res) => {
	if (!isValidSignature(req)) return res.status(401).send('Signature invalide');

	const event = req.get('X-GitHub-Event');
	if (event === 'ping') return res.send('pong');

	const repo = repos[req.body.repository?.full_name?.toLowerCase()];
	if (!repo) return res.status(202).send(`Repo non suivi : ${req.body.repository?.full_name}`);

	try {
		res.send(await enqueue(() => handleEvent(event, req.body, repo)));
	}
	catch (error) {
		console.error(`Erreur sur ${event}.${req.body.action} (${repo.fullName}) :`, error);
		res.status(500).send('Erreur interne');
	}
});

app.listen(PORT, () => console.log(`En écoute sur le port ${PORT}`));
