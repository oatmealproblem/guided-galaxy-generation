<script lang="ts">
	import { getStroke } from 'perfect-freehand';
	import { Delaunay } from 'd3-delaunay';
	import { forceManyBody, forceSimulation } from 'd3-force';
	import createGraph, { type Link } from 'ngraph.graph';
	// @ts-expect-error -- no 1st or 3rd party type available
	import kruskal from 'ngraph.kruskal';
	import { onMount } from 'svelte';

	import { dev } from '$app/environment';
	import { calcNumStartingStars, generateStellarisGalaxy } from '$lib/generateStellarisGalaxy';
	import { LocalStorageState } from '$lib/state.svelte';
	import { HEIGHT, MAX_CONNECTION_LENGTH, WIDTH } from '$lib/constants';

	let canvas = $state<HTMLCanvasElement>();
	let ctx = $derived(canvas?.getContext('2d'));

	const MODE_DRAW = 'draw';
	const MODE_ERASE = 'erase';
	type BrushMode = typeof MODE_DRAW | typeof MODE_ERASE;

	let brushSize = new LocalStorageState('brushSize', 25);
	let brushOpacity = new LocalStorageState('brushOpacity', 0.5);
	let brushBlur = new LocalStorageState('brushBlur', 0);
	let brushMode = new LocalStorageState<BrushMode>('brushMode', MODE_DRAW);

	let strokePoints = $state<{ x: number; y: number }[]>([]);
	let stroke = $derived(
		getStroke(strokePoints, {
			size: brushSize.current,
			thinning: 0.5,
			streamline: 0.5,
			smoothing: 1,
		}),
	);
	function makePathData(stroke: number[][]) {
		if (stroke.length === 0) return '';
		return stroke
			.reduce(
				(acc, [x0, y0], i, arr) => {
					if (i === arr.length - 1) return acc;
					const [x1, y1] = arr[i + 1];
					return acc.concat(` ${x0},${y0} ${(x0 + x1) / 2},${(y0 + y1) / 2}`);
				},
				['M ', `${stroke[0][0]},${stroke[0][1]}`, ' Q'],
			)
			.concat('Z')
			.join('');
	}
	let strokePath = $derived(makePathData(stroke));

	type StrokeConfig = {
		size: number;
		blur: number;
		mode: BrushMode;
		opacity: number;
	};
	type RecordedStroke = {
		points: { x: number; y: number }[];
		config: StrokeConfig;
	};
	let strokes = $state<RecordedStroke[]>([]);
	let imageDataStack = $state<ImageData[]>([]);
	let undoneStrokes = $state<RecordedStroke[]>([]);
	let imageDataUndoStack = $state<ImageData[]>([]);

	function recordStroke() {
		strokes.push({
			points: strokePoints.slice(),
			config: {
				size: brushSize.current,
				blur: brushBlur.current,
				mode: brushMode.current,
				opacity: brushOpacity.current,
			},
		});
		pushImageData();
		undoneStrokes.length = 0;
		imageDataUndoStack.length = 0;
		saveCanvas();
	}

	const MAX_IMAGE_DATA_STACK_SIZE = 10;
	function pushImageData() {
		imageDataStack.push(ctx!.getImageData(0, 0, WIDTH, HEIGHT));
		while (imageDataStack.length > MAX_IMAGE_DATA_STACK_SIZE) {
			imageDataStack.shift();
		}
	}

	function saveCanvas() {
		if (!canvas) return;
		const dataUrl = canvas.toDataURL();
		localStorage.setItem('paint-a-galaxy-canvas', dataUrl);
	}

	onMount(() => {
		const base64ImageData = localStorage.getItem('paint-a-galaxy-canvas');
		if (base64ImageData) {
			fetch(base64ImageData)
				.then((resp) => resp.blob())
				.then((blob) => createImageBitmap(blob))
				.then((bitmap) => {
					if (ctx) {
						ctx.drawImage(bitmap, 0, 0);
					}
				});
		}
	});

	function drawStroke(path: string, config: StrokeConfig) {
		if (!ctx) return;
		const p = new Path2D(strokePath);
		ctx.globalAlpha = config.opacity;
		// big blur on erase mode feels like the eraser just isn't working; multiply by 0.5 to compensate
		ctx.filter = `blur(${config.size * config.blur * (config.mode === MODE_ERASE ? 0.5 : 1)}px)`;
		ctx.fillStyle = config.mode === MODE_DRAW ? '#FFFFFF' : '#000000';
		ctx.fill(p);
		if (config.mode === MODE_ERASE) {
			ctx.save();
			ctx.clip(p);
			const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
			for (let i = 0; i < imageData.data.length; i += 4) {
				// convert grayscale to transparency
				imageData.data[i + 3] = Math.round((imageData.data[i] / 255) * imageData.data[i + 3]);
				imageData.data[i] = 255;
				imageData.data[i + 1] = 255;
				imageData.data[i + 2] = 255;
			}
			ctx.putImageData(imageData, 0, 0);
			ctx.restore();
		}
	}

	function drawRecordedStroke(stroke: RecordedStroke) {
		if (!ctx) return;
		const p = makePathData(
			getStroke(stroke.points, {
				size: stroke.config.size,
				thinning: 0.5,
				streamline: 0.5,
				smoothing: 1,
			}),
		);
		drawStroke(p, stroke.config);
	}

	function redraw() {
		if (!ctx) return;
		ctx.clearRect(0, 0, WIDTH, HEIGHT);
		for (const stroke of strokes) {
			drawRecordedStroke(stroke);
		}
	}

	function undo() {
		if (!strokes.length) return;
		undoneStrokes.push(strokes.pop()!);
		if (imageDataStack.length) imageDataUndoStack.push(imageDataStack.pop()!);
		const lastImageData = imageDataStack.at(-1);
		if (lastImageData) {
			ctx?.clearRect(0, 0, WIDTH, HEIGHT);
			ctx?.putImageData(lastImageData, 0, 0);
			saveCanvas();
		} else {
			redraw();
			saveCanvas();
		}
	}

	function redo() {
		if (undoneStrokes.length) {
			const stroke = undoneStrokes.pop()!;
			const imageData = imageDataUndoStack.pop();
			if (imageData) {
				ctx?.putImageData(imageData, 0, 0);
				imageDataStack.push(imageData);
				saveCanvas();
			} else {
				drawRecordedStroke(stroke);
				pushImageData();
				saveCanvas();
			}
			strokes.push(stroke);
		}
	}

	function clear() {
		if (!ctx) return;
		ctx.clearRect(0, 0, WIDTH, HEIGHT);
		strokes.length = 0;
		undoneStrokes.length = 0;
		imageDataStack.length = 0;
		imageDataUndoStack.length = 0;
		saveCanvas();
	}

	let numberOfStars = new LocalStorageState('numberOfStars', 600);
	let clusterDiffusion = new LocalStorageState('clusterDiffusion', 10);
	let stars = new LocalStorageState<[number, number][]>('stars', []);
	function generateStars() {
		if (!ctx) return;
		stars.current.length = 0;
		connections.current.length = 0;
		potentialHomeStars.current.length = 0;
		const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
		function getAlpha(x: number, y: number) {
			const index = y * WIDTH * 4 + x * 4 + 3;
			return imageData.data[index];
		}
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- we're not using this for reactivity, just temporary optimization
		const added = new Set<string>();
		let attempts = 0;
		while (added.size < numberOfStars.current) {
			if (attempts >= numberOfStars.current * 1000) {
				console.error(
					`Max star attempts reached; abandoned after creating ${added.size} of ${numberOfStars}`,
				);
				break;
			}
			attempts++;
			const x = Math.floor(Math.random() * WIDTH);
			const y = Math.floor(Math.random() * HEIGHT);
			if (!added.has(`${x},${y}`) && Math.random() < (getAlpha(x, y) / 255) ** 2) {
				added.add(`${x},${y}`);
				stars.current.push([x, y]);
			}
		}
		diffuseClusters();
	}

	function diffuseClusters() {
		const simulation = forceSimulation(stars.current.map(([x, y]) => ({ x, y })))
			.stop()
			.force('manyBody', forceManyBody().strength(-1));
		simulation.tick(Math.round(clusterDiffusion.current));
		stars.current = Array.from(
			new Set(simulation.nodes().map(({ x, y }) => [Math.round(x), Math.round(y)].toString())),
		).map((v) => v.split(',').map((s) => parseInt(s)) as [number, number]);
	}

	let connectedness = new LocalStorageState('connectedness', 0.5);
	let maxConnectionLength = new LocalStorageState('maxConnectionLength', 100);
	let allowDisconnected = new LocalStorageState('allowDisconnected', false);
	let connections = new LocalStorageState<[[number, number], [number, number]][]>(
		'connections',
		[],
	);
	let potentialHomeStars = new LocalStorageState<string[]>('potentialHomeStars', []);
	function generateConnections() {
		connections.current.length = 0;
		potentialHomeStars.current.length = 0;
		if (stars.current.length < 3) return;
		const g = createGraph<
			{ coords: [number, number]; d: number },
			{ distance: number; isMst?: boolean }
		>();
		// generate triangulation
		const delaunay = new Delaunay(stars.current.flat());
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
			closePath() {},
		};
		delaunay.render(renderContext);

		// find minimum spanning tree
		const mst: { fromId: string; toId: string }[] = kruskal(
			g,
			(link: Link<{ distance: number; isMst?: boolean }>) => link.data.distance,
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
				(link.data.distance > maxConnectionLength.current &&
					(!link.data.isMst || allowDisconnected.current)) ||
				(Math.random() > connectedness.current && !link.data.isMst)
			) {
				g.removeLink(link);
			}
		}

		// find home stars
		const numPotentialHomeStars = calcNumStartingStars(stars.current);
		const newPotentialHomeStars: [number, number][] = [];
		for (let i = 0; i < numPotentialHomeStars; i++) {
			newPotentialHomeStars.push(stars.current[i]);
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
						// avoid dead ends; they can be unfair/unfun home systems
						const isDeadEnd = node.links == null || node.links.size <= 1;
						if (node.data.d === Infinity && !isDeadEnd) {
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
					false,
				);
			}
			// move this starting system to the farthest star (random for tie)
			if (maxDistance > 0 && maxDistanceStars.length > 0) {
				newPotentialHomeStars[index] =
					maxDistanceStars[Math.floor(Math.random() * maxDistanceStars.length)];
			}
		});
		potentialHomeStars.current = newPotentialHomeStars.map((s) => s.toString());

		// add connections to state
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not using for state
		const added = new Set<string>();
		g.forEachLink((link) => {
			const key = [link.toId, link.fromId].sort().toString();
			if (added.has(key)) return;
			added.add(key);
			connections.current.push([
				g.getNode(link.fromId)!.data.coords,
				g.getNode(link.toId)!.data.coords,
			]);
		});
	}

	let downloadUrl = $derived(
		URL.createObjectURL(
			new Blob(
				[generateStellarisGalaxy(stars.current, connections.current, potentialHomeStars.current)],
				{
					type: 'text/plain',
				},
			),
		),
	);

	const BUTTON_CLASS = 'cursor-pointer bg-gray-700 p-2 hover:bg-gray-600 text-center';
</script>

<svelte:document
	onkeydown={(e) => {
		if (document.activeElement?.tagName === 'INPUT') return;
		if (e.key === 'z' && e.ctrlKey) {
			undo();
		} else if (
			(e.key === 'y' && e.ctrlKey) ||
			(e.key.toLowerCase() === 'z' && e.ctrlKey && e.shiftKey)
		) {
			redo();
		}
	}}
	onpointerup={() => {
		if (ctx && strokePoints.length) {
			drawStroke(strokePath, {
				size: brushSize.current,
				blur: brushBlur.current,
				mode: brushMode.current,
				opacity: brushOpacity.current,
			});
			recordStroke();
			strokePoints = [];
		}
	}}
/>

<div class="flex">
	<div class="relative box-content border border-white" style:width={WIDTH} style:height={HEIGHT}>
		<canvas
			width={WIDTH}
			height={HEIGHT}
			bind:this={canvas}
			onpointerdown={(e) => {
				strokePoints = [{ x: e.offsetX, y: e.offsetY }];
			}}
			onpointermove={(e) => {
				if (strokePoints.length) strokePoints.push({ x: e.offsetX, y: e.offsetY });
			}}
		></canvas>
		<svg
			class="pointer-events-none absolute top-0 left-0"
			viewBox="0 0 {WIDTH} {HEIGHT}"
			width={WIDTH}
			height={HEIGHT}
		>
			<path
				d={strokePath}
				fill={brushMode.current === MODE_DRAW ? '#FFFFFF' : 'var(--color-gray-900)'}
				opacity={brushOpacity.current}
			/>
			{#each connections.current as [from, to] (`${[from, to]}`)}
				<line
					x1={from[0]}
					y1={from[1]}
					x2={to[0]}
					y2={to[1]}
					stroke="var(--color-gray-900)"
					stroke-opacity="0.5"
					stroke-width="3"
				/>
				<line
					x1={from[0]}
					y1={from[1]}
					x2={to[0]}
					y2={to[1]}
					stroke="#FFFFFF"
					stroke-opacity="0.5"
					stroke-width="1"
				/>
			{/each}
			{#each stars.current as [x, y] (`${[x, y]}`)}
				<circle
					cx={x}
					cy={y}
					r="2"
					fill={dev && potentialHomeStars.current.includes([x, y].toString()) ? 'red' : '#FFFFFF'}
					stroke="#000000"
					stroke-width="1"
				/>
			{/each}
		</svg>
	</div>
	<form class="flex flex-col gap-2 p-4">
		<h2 class="text-2xl">Paint</h2>
		<label>
			Brush Size
			<input type="range" min={1} max={100} step={1} bind:value={brushSize.current} />
		</label>
		<label>
			Brush Opacity
			<input type="range" min={0} max={1} step={0.01} bind:value={brushOpacity.current} />
		</label>
		<label>
			Brush Blur
			<input type="range" min={0} max={2} step={0.1} bind:value={brushBlur.current} />
		</label>
		<label>
			Mode
			<select class="bg-gray-800" bind:value={brushMode.current}>
				<option>{MODE_DRAW}</option>
				<option>{MODE_ERASE}</option>
			</select>
		</label>
		<button type="button" class={BUTTON_CLASS} onclick={undo}>Undo Stroke</button>
		<button type="button" class={BUTTON_CLASS} onclick={redo}>Redo Stroke</button>
		<button type="button" class={BUTTON_CLASS} onclick={clear}>Clear Canvas</button>

		<hr class="my-2 border-gray-800" />
		<h2 class="text-2xl">Stars</h2>
		<label>
			Number of Stars
			<input class="bg-gray-800" type="number" step={1} bind:value={numberOfStars.current} />
		</label>
		<label>
			Loosen Clusters
			<input
				class="bg-gray-800"
				type="range"
				min={0}
				max={20}
				step={1}
				bind:value={clusterDiffusion.current}
			/>
		</label>
		<button type="button" class={BUTTON_CLASS} onclick={generateStars}>Generate Stars</button>

		<hr class="my-2 border-gray-800" />
		<h2 class="text-2xl">Hyperlanes</h2>
		<label>
			Hyperlane Density
			<input type="range" min={0} max={1} step={0.01} bind:value={connectedness.current} />
		</label>
		<label>
			Max Hyperlane Distance
			<input
				type="range"
				min={0}
				max={MAX_CONNECTION_LENGTH}
				step={1}
				bind:value={maxConnectionLength.current}
			/>
		</label>
		<label>
			Allow Disconnected
			<input type="checkbox" bind:checked={allowDisconnected.current} />
		</label>
		<button type="button" class={BUTTON_CLASS} onclick={generateConnections}>
			Generate Hyperlanes
		</button>

		<hr class="my-2 border-gray-800" />
		<h2 class="text-2xl">Mod</h2>
		<a href={downloadUrl} download="painted_galaxy.txt" class={BUTTON_CLASS}>
			Download Stellaris Map
		</a>
	</form>
</div>
