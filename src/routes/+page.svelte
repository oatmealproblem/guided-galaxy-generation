<script lang="ts">
	// @ts-expect-error -- no 1st or 3rd party types available
	import Atrament from 'atrament';
	import { Delaunay } from 'd3-delaunay';
	import { forceManyBody, forceSimulation } from 'd3-force';
	import createGraph, { type Link } from 'ngraph.graph';
	// @ts-expect-error -- no 1st or 3rd party type available
	import kruskal from 'ngraph.kruskal';
	import { untrack } from 'svelte';

	import { dev } from '$app/environment';
	import { calcNumStartingStars, generateStellarisGalaxy } from '$lib/generateStellarisGalaxy';

	const WIDTH = 900;
	const HEIGHT = 900;
	const MAX_CONNECTION_LENGTH = Math.max(WIDTH, HEIGHT) / 2;
	let canvas = $state<HTMLCanvasElement>();
	let ctx = $derived(canvas?.getContext('2d'));

	let brushSize = $state(10);
	let brushBlur = $state(3);
	let filter = $derived(`blur(${brushSize * brushBlur}px)`);

	let sketchpad = $derived(
		canvas
			? new Atrament(canvas, {
					width: WIDTH,
					height: HEIGHT,
					weight: untrack(() => brushSize),
					color: '#FFFFFF'
				})
			: null
	);

	let strokes = $state<[unknown, number, number][]>([]);
	let undoneStrokes = $state<[unknown, number, number][]>([]);
	$effect(() => {
		if (!sketchpad) return;
		function strokeHandler({ stroke }: { stroke: unknown }) {
			console.log('recording stroke');
			strokes.push([stroke, brushSize, brushBlur]);
			undoneStrokes.length = 0;
		}
		sketchpad.recordStrokes = true;
		sketchpad.addEventListener('strokerecorded', strokeHandler);

		return () => sketchpad.removeEventListener('strokerecorded', strokeHandler);
	});

	$effect(() => {
		if (ctx) {
			ctx.filter = filter;
		}
	});

	function redraw() {
		if (!sketchpad || !ctx) return;
		sketchpad.clear();
		sketchpad.recordStrokes = false;

		for (const [stroke, recordedBrushSize, recordedBrushBlur] of strokes) {
			sketchpad.weight = recordedBrushSize;
			ctx.filter = `blur(${recordedBrushSize * recordedBrushBlur}px)`;

			// don't want to modify original data
			const segments = (
				stroke as { segments: { pressure: number; point: { x: number; y: number } }[] }
			).segments.slice();

			const firstPoint = segments.shift()!.point;
			// beginStroke moves the "pen" to the given position and starts the path
			sketchpad.beginStroke(firstPoint.x, firstPoint.y);

			let prevPoint = firstPoint;
			while (segments.length > 0) {
				const segment = segments.shift()!;

				// the `draw` method accepts the current real coordinates
				// (i. e. actual cursor position), and the previous processed (filtered)
				// position. It returns an object with the current processed position.
				const { x, y } = sketchpad.draw(
					segment.point.x,
					segment.point.y,
					prevPoint.x,
					prevPoint.y,
					segment.pressure
				);

				// the processed position is the one where the line is actually drawn to
				// so we have to store it and pass it to `draw` in the next step
				prevPoint = { x, y };
			}

			// endStroke closes the path
			sketchpad.endStroke(prevPoint.x, prevPoint.y);
		}

		sketchpad.recordStrokes = true;
		sketchpad.weight = brushSize;
		ctx.filter = filter;
	}

	function undo() {
		if (!sketchpad) return;
		if (strokes.length) undoneStrokes.push(strokes.pop()!);
		redraw();
	}

	function redo() {
		if (!sketchpad) return;
		if (undoneStrokes.length) strokes.push(undoneStrokes.pop()!);
		redraw();
	}

	function clear() {
		if (!sketchpad) return;
		sketchpad.clear();
		strokes.length = 0;
	}

	let numberOfStars = $state(600);
	let clusterDiffusion = $state(10);
	let stars = $state<[number, number][]>([]);
	function generateStars() {
		if (!ctx) return;
		stars.length = 0;
		connections.length = 0;
		potentialHomeStars.length = 0;
		const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
		function getAlpha(x: number, y: number) {
			const index = y * WIDTH * 4 + x * 4 + 3;
			return imageData.data[index];
		}
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- we're not using this for reactivity, just temporary optimization
		const added = new Set<string>();
		let attempts = 0;
		while (added.size < numberOfStars) {
			if (attempts >= numberOfStars * 1000) {
				console.error(
					`Max star attempts reached; abandoned after creating ${added.size} of ${numberOfStars}`
				);
				break;
			}
			attempts++;
			const x = Math.floor(Math.random() * WIDTH);
			const y = Math.floor(Math.random() * HEIGHT);
			if (!added.has(`${x},${y}`) && Math.random() < (getAlpha(x, y) / 255) ** 2) {
				added.add(`${x},${y}`);
				stars.push([x, y]);
			}
		}
		diffuseClusters();
	}

	function diffuseClusters() {
		const simulation = forceSimulation(stars.map(([x, y]) => ({ x, y })))
			.stop()
			.force('manyBody', forceManyBody().strength(-1));
		simulation.tick(Math.round(clusterDiffusion));
		stars = Array.from(
			new Set(simulation.nodes().map(({ x, y }) => [Math.round(x), Math.round(y)].toString()))
		).map((v) => v.split(',').map((s) => parseInt(s)) as [number, number]);
	}

	let connectedness = $state(0.5);
	let maxConnectionLength = $state(100);
	let allowDisconnected = $state(false);
	let connections = $state<[[number, number], [number, number]][]>([]);
	let potentialHomeStars = $state<string[]>([]);
	function generateConnections() {
		connections.length = 0;
		potentialHomeStars.length = 0;
		if (stars.length < 3) return;
		const g = createGraph<
			{ coords: [number, number]; d: number },
			{ distance: number; isMst?: boolean }
		>();
		// generate triangulation
		const delaunay = new Delaunay(stars.flat());
		const renderContext = {
			x: 0,
			y: 0,
			moveTo(x: number, y: number) {
				this.x = x;
				this.y = y;
			},
			lineTo(x: number, y: number) {
				const id1 = `${this.x},${this.y}`;
				const id2 = `${x},${y}`;
				const distance = Math.hypot(this.x - x, this.y - y);
				if (!g.hasNode(id1)) g.addNode(id1, { coords: [this.x, this.y], d: Infinity });
				if (!g.hasNode(id2)) g.addNode(id2, { coords: [x, y], d: Infinity });
				g.addLink(id1, id2, { distance });

				this.x = x;
				this.y = y;
			},
			closePath() {}
		};
		delaunay.render(renderContext);

		// find minimum spanning tree
		const mst: { fromId: string; toId: string }[] = kruskal(
			g,
			(link: Link<{ distance: number; isMst?: boolean }>) => link.data.distance
		);
		for (const treeLink of mst) {
			const link = g.getLink(treeLink.fromId, treeLink.toId);
			if (link) link.data.isMst = true;
		}

		// remove links
		// - greater than maxConnectionLength (MST allowed if allowDisconnected)
		// - non-MST removed randomly based on connectedness
		const links: Link<{ distance: number; isMst?: boolean }>[] = [];
		g.forEachLink((link) => {
			links.push(link);
		});
		for (const link of links) {
			if (
				(link.data.distance > maxConnectionLength && (!link.data.isMst || allowDisconnected)) ||
				(Math.random() > connectedness && !link.data.isMst)
			) {
				g.removeLink(link);
			}
		}

		// find home stars
		const numPotentialHomeStars = calcNumStartingStars(stars);
		const newPotentialHomeStars: [number, number][] = [];
		for (let i = 0; i < numPotentialHomeStars; i++) {
			newPotentialHomeStars.push(stars[i]);
		}
		// move each to the star furthest from all other stars
		// a single iteration of this seems to be good enough
		newPotentialHomeStars.forEach((star, index) => {
			// reset distance to inf
			g.forEachNode((node) => {
				node.data.d = Infinity;
			});
			const edge: [number, number][] = [];
			// set distance of other potential homes to 0, and add them to the edge
			newPotentialHomeStars
				.filter((other) => other !== star)
				.forEach((other) => {
					const node = g.getNode(other.toString());
					node!.data.d = 0;
					edge.push(other);
				});
			let maxDistance = 0;
			let maxDistanceStars: [number, number][] = [];
			// modified Dijkstra's to find stars furthest from other home systems
			// (simplified since all edge weights are 1)
			while (edge.length) {
				const s = edge.pop()!;
				g.forEachLinkedNode(
					s.toString(),
					(node) => {
						if (node.data.d === Infinity) {
							node.data.d = g.getNode(s.toString())!.data.d + 1;
							if (node.data.d > maxDistance) {
								maxDistance = node.data.d;
								maxDistanceStars = [node.data.coords];
							} else if (node.data.d === maxDistance) {
								maxDistanceStars.push(node.data.coords);
							}
							edge.unshift(node.data.coords);
						}
					},
					false
				);
			}
			// move this starting system to the farthest star (random for tie)
			if (maxDistance > 0 && maxDistanceStars.length > 0) {
				newPotentialHomeStars[index] =
					maxDistanceStars[Math.floor(Math.random() * maxDistanceStars.length)];
			}
		});
		potentialHomeStars = newPotentialHomeStars.map((s) => s.toString());

		// add connections to state
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not using for state
		const added = new Set<string>();
		g.forEachLink((link) => {
			const key = [link.toId, link.fromId].sort().toString();
			if (added.has(key)) return;
			added.add(key);
			connections.push([g.getNode(link.fromId)!.data.coords, g.getNode(link.toId)!.data.coords]);
		});
	}

	let downloadUrl = $derived(
		URL.createObjectURL(
			new Blob([generateStellarisGalaxy(stars, connections, potentialHomeStars)], {
				type: 'text/plain'
			})
		)
	);

	const BUTTON_CLASS = 'cursor-pointer bg-gray-700 p-2 hover:bg-gray-600 text-center';
</script>

<div class="relative flex">
	<canvas width={WIDTH} height={HEIGHT} bind:this={canvas} class="border border-white"></canvas>
	<svg
		class="pointer-events-none absolute top-0 left-0"
		viewBox="0 0 {WIDTH} {HEIGHT}"
		width={WIDTH}
		height={HEIGHT}
	>
		{#each connections as [from, to] (`${[from, to]}`)}
			<line
				x1={from[0]}
				y1={from[1]}
				x2={to[0]}
				y2={to[1]}
				stroke="#FFFFFF"
				stroke-opacity="0.25"
				stroke-width="1"
			/>
		{/each}
		{#each stars as [x, y] (`${[x, y]}`)}
			<circle
				cx={x}
				cy={y}
				r="2"
				fill={dev && potentialHomeStars.includes([x, y].toString()) ? 'red' : '#FFFFFF'}
				stroke="#000000"
				stroke-width="1"
			/>
		{/each}
	</svg>
	<form class="flex flex-col gap-2 p-4">
		<label>
			Brush Size
			<input
				type="range"
				min={1}
				max={20}
				step={1}
				bind:value={
					() => brushSize,
					(value) => {
						brushSize = value;
						if (sketchpad) {
							sketchpad.weight = value;
						}
					}
				}
			/>
		</label>
		<label>
			Brush Blur
			<input type="range" min={0} max={5} step={0.1} bind:value={brushBlur} />
		</label>
		<button type="button" class={BUTTON_CLASS} onclick={undo}>Undo Stroke</button>
		<button type="button" class={BUTTON_CLASS} onclick={redo}>Redo Stroke</button>
		<button type="button" class={BUTTON_CLASS} onclick={clear}>Clear Canvas</button>
		<label>
			Number of Stars
			<input class="bg-gray-800" type="number" step={1} bind:value={numberOfStars} />
		</label>
		<label>
			Loosen Clusters
			<input
				class="bg-gray-800"
				type="range"
				min={0}
				max={20}
				step={1}
				bind:value={clusterDiffusion}
			/>
		</label>
		<button type="button" class={BUTTON_CLASS} onclick={generateStars}>Generate Stars</button>
		<label>
			Hyperlane Density
			<input type="range" min={0} max={1} step={0.01} bind:value={connectedness} />
		</label>
		<label>
			Max Hyperlane Distance
			<input
				type="range"
				min={0}
				max={MAX_CONNECTION_LENGTH}
				step={1}
				bind:value={maxConnectionLength}
			/>
		</label>
		<label>
			Allow Disconnected
			<input type="checkbox" bind:checked={allowDisconnected} />
		</label>
		<button type="button" class={BUTTON_CLASS} onclick={generateConnections}>
			Generate Hyperlanes
		</button>
		<a href={downloadUrl} download="painted_galaxy.txt" class={BUTTON_CLASS}>
			Download Stellaris Map
		</a>
	</form>
</div>
