import { FALLEN_EMPIRE_SPAWN_RADIUS, HEIGHT, SPAWNS_PER_MAX_AI_EMPIRE, WIDTH } from './constants';
import { arePointsEqual } from './utils';

const COMMON = `
	priority = 10
	supports_shape = elliptical
	supports_shape = ring
	supports_shape = spiral_2
	supports_shape = spiral_3
	supports_shape = spiral_4
	supports_shape = spiral_6
	supports_shape = bar
	supports_shape = starburst
	supports_shape = cartwheel
	supports_shape = spoked
	random_hyperlanes = no

	num_wormhole_pairs = { min = 0 max = 5 }
	num_wormhole_pairs_default = 1
	num_gateways = { min = 0 max = 5 }
	num_gateways_default = 1
	num_hyperlanes = { min=0.5 max= 3 }
	num_hyperlanes_default = 1
	colonizable_planet_odds = 1.0
	primitive_odds = 1.0
`;

const TINY = `
	fallen_empire_default = 0
	fallen_empire_max = 1
	marauder_empire_default = 1
	marauder_empire_max = 1
	advanced_empire_default = 0
	crisis_strength = 0.5
	extra_crisis_strength = { 10 25 }
`;

const SMALL = `
	fallen_empire_default = 1
	fallen_empire_max = 2
	marauder_empire_default = 1
	marauder_empire_max = 2
	advanced_empire_default = 1
	crisis_strength = 0.75
	extra_crisis_strength = { 10 25 }
`;

const MEDIUM = `
	fallen_empire_default = 2
	fallen_empire_max = 3
	marauder_empire_default = 2
	marauder_empire_max = 2
	advanced_empire_default = 2
	crisis_strength = 1.0
	extra_crisis_strength = { 10 25 }
`;

const LARGE = `
	fallen_empire_default = 3
	fallen_empire_max = 4
	marauder_empire_default = 2
	marauder_empire_max = 3
	advanced_empire_default = 3
	crisis_strength = 1.25
	extra_crisis_strength = { 10 25 }
`;

const HUGE = `
	fallen_empire_default = 4
	fallen_empire_max = 6
	marauder_empire_default = 3
	marauder_empire_max = 3
	advanced_empire_default = 4
	crisis_strength = 1.5
	extra_crisis_strength = { 10 25 }
`;

export function generateStellarisGalaxy(
	name: string,
	stars: [number, number][],
	connections: [[number, number], [number, number]][],
	wormholes: [[number, number], [number, number]][],
	potentialHomeStars: string[],
	preferredHomeStars: string[],
): string {
	const aiEmpireSettings = `
 	num_empires = { min = 0 max = ${Math.round(potentialHomeStars.length / SPAWNS_PER_MAX_AI_EMPIRE)} }	#limits player customization; AI empires don't account for all spawns, so we need to set the max lower than the number of spawn points
	num_empire_default = ${Math.round(potentialHomeStars.length / SPAWNS_PER_MAX_AI_EMPIRE / 2)}
	`;

	let sizeBasedSettings = TINY;
	if (stars.length >= 400) sizeBasedSettings = SMALL;
	if (stars.length >= 600) sizeBasedSettings = MEDIUM;
	if (stars.length >= 800) sizeBasedSettings = LARGE;
	if (stars.length >= 1000) sizeBasedSettings = HUGE;

	const fallenEmpireSpawns: { star: [number, number]; direction: 'n' | 'e' | 's' | 'w' }[] = [];
	for (const star of stars) {
		for (const direction of ['n', 'e', 's', 'w'] as const) {
			if (
				canSpawnFallenEmpireInDirection(
					star,
					direction,
					stars,
					fallenEmpireSpawns.map((fe) => getFallenEmpireOrigin(fe.star, fe.direction)),
				)
			) {
				fallenEmpireSpawns.push({ star, direction });
			}
		}
	}

	const keyToId = Object.fromEntries(stars.map((coords, i) => [coords.toString(), i]));

	const systems = stars
		.map((star, i) => {
			const basics = `id = "${keyToId[star.toString()]}" position = { x = ${-(star[0] - WIDTH / 2)} y = ${star[1] - HEIGHT / 2} }`;
			const preferredModifier = preferredHomeStars.includes(star.toString())
				? 'modifier = { add = 100 always = yes }' // simply increasing the base weight doesn't work for some reason, need to use a modifier
				: '';
			// without any randomness, the player always spawns in the lowest ID spawn systems
			// adding some weight depending on the modulo of ruler age introduces that randomness (ruler age is random within a reasonable range)
			const randomModifier =
				// don't add randomModifier for preferred spawns; math seems to break if you add multiple modifiers to spawn weight
				preferredModifier === ''
					? `modifier = { add = 10 ruler = { check_variable_arithmetic = { which = trigger:leader_age modulo = 10 value = ${i % 10} } } }`
					: '';
			const empireSpawn = potentialHomeStars.includes(star.toString())
				? `initializer = random_empire_init_0${(i % 6) + 1} spawn_weight = { base = 10 ${preferredModifier} ${randomModifier} }`
				: '';

			const thisStarFallenEmpireSpawns = fallenEmpireSpawns.filter((fe) => fe.star === star);
			const feSpawnEffect =
				thisStarFallenEmpireSpawns.length > 0
					? `set_star_flag = painted_galaxy_fe_spawn ${thisStarFallenEmpireSpawns.map((fe) => `set_star_flag = painted_galaxy_fe_spawn_${fe.direction}`).join(' ')}`
					: '';

			const wormholeIndex = wormholes.findIndex(
				(wh) => arePointsEqual(star, wh[0]) || arePointsEqual(star, wh[1]),
			);
			const wormholeEffect =
				wormholeIndex >= 0 ? `set_star_flag = painted_galaxy_wormhole_${wormholeIndex}` : '';

			const effects = [feSpawnEffect, wormholeEffect];
			const effect = effects.some(Boolean) ? `effect = { ${effects.join(' ')} }` : '';
			return `\tsystem = { ${basics} ${empireSpawn} ${effect} }`;
		})
		.join('\n');
	const hyperlanes = connections
		.map(
			([a, b]) =>
				`\tadd_hyperlane = { from = "${keyToId[a.toString()]}" to = "${keyToId[b.toString()]}" }`,
		)
		.join('\n');
	return [
		`static_galaxy_scenario = {`,
		`\tname="${name}"`,
		COMMON,
		aiEmpireSettings,
		sizeBasedSettings,
		systems,
		hyperlanes,
		'}',
	].join('\n\n');
}

export function calcNumStartingStars(stars: [number, number][]) {
	// 6 per 200 is the vanilla num_empires max, but somethings cause additional empires to spawn (players, some origins), so lets increase by 50%
	return Math.round((stars.length / 200) * 6 * SPAWNS_PER_MAX_AI_EMPIRE);
}

function getFallenEmpireOrigin(
	star: [number, number],
	direction: 'n' | 's' | 'e' | 'w',
): [number, number] {
	switch (direction) {
		case 'n':
			return [star[0], star[1] - FALLEN_EMPIRE_SPAWN_RADIUS];
		case 's':
			return [star[0], star[1] + FALLEN_EMPIRE_SPAWN_RADIUS];
		case 'e':
			return [star[0] + FALLEN_EMPIRE_SPAWN_RADIUS, star[1]];
		case 'w':
			return [star[0] - FALLEN_EMPIRE_SPAWN_RADIUS, star[1]];
	}
}

function canSpawnFallenEmpireInDirection(
	star: [number, number],
	direction: 'n' | 's' | 'e' | 'w',
	stars: [number, number][],
	fallenEmpireSpawns: [number, number][],
) {
	const origin = getFallenEmpireOrigin(star, direction);
	// origin is not near edge of canvas
	if (
		origin[0] < FALLEN_EMPIRE_SPAWN_RADIUS ||
		origin[0] > WIDTH - FALLEN_EMPIRE_SPAWN_RADIUS ||
		origin[1] < FALLEN_EMPIRE_SPAWN_RADIUS ||
		origin[1] > HEIGHT - FALLEN_EMPIRE_SPAWN_RADIUS
	)
		return false;
	// spawn area does not contain any stars or overlap with another fallen empire spawn area
	return (
		stars.every(
			(point) =>
				Math.hypot(point[0] - origin[0], point[1] - origin[1]) >= FALLEN_EMPIRE_SPAWN_RADIUS,
		) &&
		fallenEmpireSpawns.every(
			(point) =>
				Math.hypot(point[0] - origin[0], point[1] - origin[1]) >= FALLEN_EMPIRE_SPAWN_RADIUS * 2,
		)
	);
}
