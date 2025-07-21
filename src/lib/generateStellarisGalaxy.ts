const COMMON = `
	name = "Painted Galaxy"
	priority = 10
	supports_shape = elliptical
	random_hyperlanes = no
`;

const TINY = `
	num_empires = { min = 0 max = 6 }	#limits player customization
	num_empire_default = 3
	fallen_empire_default = 0
	fallen_empire_max = 1
	marauder_empire_default = 1
	marauder_empire_max = 1
	advanced_empire_default = 0
	colonizable_planet_odds = 1.0
	primitive_odds = 1.0
	crisis_strength = 0.5
	extra_crisis_strength = { 10 25 }

	# num_nebulas	= 2
	# nebula_size = 60
	# nebula_min_dist = 100

	num_wormhole_pairs = { min = 0 max = 5 }
	num_wormhole_pairs_default = 1
	num_gateways = { min = 0 max = 5 }
	num_gateways_default = 1
	num_hyperlanes = { min=0.5 max= 3 }
	num_hyperlanes_default = 1
`;

const SMALL = `
	num_empires = { min = 0 max = 12 }	#limits player customization
	num_empire_default = 6
	fallen_empire_default = 1
	fallen_empire_max = 2
	marauder_empire_default = 1
	marauder_empire_max = 2
	advanced_empire_default = 1
	colonizable_planet_odds = 1.0
	primitive_odds = 1.0
	crisis_strength = 0.75
	extra_crisis_strength = { 10 25 }

	# num_nebulas	= 3
	# nebula_size = 60
	# nebula_min_dist = 100

	num_wormhole_pairs = { min = 0 max = 5 }
	num_wormhole_pairs_default = 1
	num_gateways = { min = 0 max = 5 }
	num_gateways_default = 1
	num_hyperlanes = { min=0.5 max= 3 }
	num_hyperlanes_default = 1
`;

const MEDIUM = `
	num_empires = { min = 0 max = 18 }	#limits player customization
	num_empire_default = 9
	fallen_empire_default = 2
	fallen_empire_max = 3
	marauder_empire_default = 2
	marauder_empire_max = 2
	advanced_empire_default = 2
	colonizable_planet_odds = 1.0
	primitive_odds = 1.0
	crisis_strength = 1.0
	extra_crisis_strength = { 10 25 }

	# num_nebulas	= 6
	# nebula_size = 60
	# nebula_min_dist = 200

	num_wormhole_pairs = { min = 0 max = 5 }
	num_wormhole_pairs_default = 1
	num_gateways = { min = 0 max = 5 }
	num_gateways_default = 1
	num_hyperlanes = { min=0.5 max= 3 }
	num_hyperlanes_default = 1
`;

const LARGE = `
	num_empires = { min = 0 max = 24 }	#limits player customization
	num_empire_default = 12
	fallen_empire_default = 3
	fallen_empire_max = 4
	marauder_empire_default = 2
	marauder_empire_max = 3
	advanced_empire_default = 3
	colonizable_planet_odds = 1.0
	primitive_odds = 1.0
	crisis_strength = 1.25
	extra_crisis_strength = { 10 25 }

	# num_nebulas	= 8
	# nebula_size = 60
	# nebula_min_dist = 200

	num_wormhole_pairs = { min = 0 max = 5 }
	num_wormhole_pairs_default = 1
	num_gateways = { min = 0 max = 5 }
	num_gateways_default = 1
	num_hyperlanes = { min=0.5 max= 3 }
	num_hyperlanes_default = 1
`;

const HUGE = `
 	num_empires = { min = 0 max = 30 }	#limits player customization
	num_empire_default = 15
	fallen_empire_default = 4
	fallen_empire_max = 6
	marauder_empire_default = 3
	marauder_empire_max = 3
	advanced_empire_default = 4
	colonizable_planet_odds = 1.0
	primitive_odds = 1.0
	crisis_strength = 1.5
	extra_crisis_strength = { 10 25 }

	# num_nebulas	= 10
	# nebula_size = 60
	# nebula_min_dist = 200

	num_wormhole_pairs = { min = 0 max = 5 }
	num_wormhole_pairs_default = 1
	num_gateways = { min = 0 max = 5 }
	num_gateways_default = 1
	num_hyperlanes = { min=0.5 max= 3 }
	num_hyperlanes_default = 1
`;

export function generateStellarisGalaxy(
	stars: [number, number][],
	connections: [[number, number], [number, number]][]
): string {
	let sizeBasedSettings = TINY;
	if (stars.length >= 400) sizeBasedSettings = SMALL;
	if (stars.length >= 600) sizeBasedSettings = MEDIUM;
	if (stars.length >= 800) sizeBasedSettings = LARGE;
	if (stars.length >= 1000) sizeBasedSettings = HUGE;

	const keyToId = Object.fromEntries(stars.map((coords, i) => [coords.toString(), i]));

	// 6 per 200 is the vanilla num_empires max, but some origins spawn additional empires, so let's double this to be safe
	const numSpawnSystems = Math.ceil((stars.length / 200) * 6) * 2;
	const systems = stars
		.map(
			(star, i) =>
				`\tsystem = { id = "${keyToId[star.toString()]}" position = { x = ${-(star[0] - 450)} y = ${star[1] - 450} } ${i < numSpawnSystems ? `initializer = random_empire_init_0${(i % 6) + 1} spawn_weight = { base = 1 }` : ''} }`
		)
		.join('\n');
	const hyperlanes = connections
		.map(
			([a, b]) =>
				`\tadd_hyperlane = { from = "${keyToId[a.toString()]}" to = "${keyToId[b.toString()]}" }`
		)
		.join('\n');
	return [`static_galaxy_scenario = {`, COMMON, sizeBasedSettings, systems, hyperlanes, '}'].join(
		'\n\n'
	);
}
