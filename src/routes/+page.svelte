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

	const Step = {
		PAINT: 'PAINT',
		STARS: 'STARS',
		HYPERLANES: 'HYPERLANES',
		MOD: 'MOD',
	} as const;
	type Step = (typeof Step)[keyof typeof Step];
	let paintStepOpen = $state(true);
	let starsStepOpen = $state(false);
	let hyperlanesStepOpen = $state(false);
	let modStepOpen = $state(false);
	let step = $derived.by(() => {
		if (paintStepOpen) return Step.PAINT;
		if (starsStepOpen) return Step.STARS;
		if (hyperlanesStepOpen) return Step.HYPERLANES;
		if (modStepOpen) return Step.MOD;
		return null;
	});

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

	let initialBitmap: ImageBitmap | null = $state(null);
	onMount(() => {
		const base64ImageData = localStorage.getItem('paint-a-galaxy-canvas');
		if (base64ImageData) {
			fetch(base64ImageData)
				.then((resp) => resp.blob())
				.then((blob) => createImageBitmap(blob))
				.then((bitmap) => {
					initialBitmap = bitmap;
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
		if (initialBitmap) {
			ctx.filter = 'blur(0)';
			ctx.globalAlpha = 1;
			ctx.drawImage(initialBitmap, 0, 0);
		}
		for (const stroke of strokes) {
			drawRecordedStroke(stroke);
		}
	}

	function undo() {
		if (step === Step.PAINT) {
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
	}

	function redo() {
		if (step === Step.PAINT) {
			if (!undoneStrokes.length) return;
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

	function toggleStar(point: [number, number]) {
		const index = stars.current.findIndex((s) => s[0] === point[0] && s[1] === point[1]);
		if (index === -1) {
			stars.current.push(point);
		} else {
			stars.current.splice(index, 1);
			connections.current = connections.current.filter(
				(c) =>
					!(
						(c[0][0] === point[0] && c[0][1] === point[1]) ||
						(c[1][0] === point[0] && c[1][1] === point[1])
					),
			);
		}
	}

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
					`Max star attempts reached; abandoned after creating ${added.size} of ${numberOfStars.current}`,
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
	let downloadDisabled = $derived(stars.current.length === 0 || connections.current.length === 0);
	let downloadLink = $state<HTMLAnchorElement>();
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

<div class="container">
	<div class="canvas" style:width={WIDTH} style:height={HEIGHT}>
		<canvas
			width={WIDTH}
			height={HEIGHT}
			bind:this={canvas}
			style:opacity={step === Step.PAINT ? '100%' : '50%'}
		></canvas>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<svg
			viewBox="0 0 {WIDTH} {HEIGHT}"
			width={WIDTH}
			height={HEIGHT}
			onclick={(e) => {
				if (step === Step.STARS) {
					toggleStar([e.offsetX, e.offsetY]);
				}
			}}
			onpointerdown={(e) => {
				if (step === Step.PAINT) {
					strokePoints = [{ x: e.offsetX, y: e.offsetY }];
				}
			}}
			onpointermove={(e) => {
				if (step === Step.PAINT) {
					if (strokePoints.length) strokePoints.push({ x: e.offsetX, y: e.offsetY });
				}
			}}
			style:cursor={step === Step.PAINT ? 'pointer' : step === Step.STARS ? 'crosshair' : ''}
		>
			<path
				d={strokePath}
				fill={brushMode.current === MODE_DRAW ? '#FFFFFF' : 'var(--pico-background-color)'}
				opacity={brushOpacity.current}
			/>
			{#each connections.current as [from, to] (`${[from, to]}`)}
				<line
					x1={from[0]}
					y1={from[1]}
					x2={to[0]}
					y2={to[1]}
					stroke="var(--pico-background-color)"
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
					r="2.5"
					fill={dev && potentialHomeStars.current.includes([x, y].toString()) ? 'red' : '#FFFFFF'}
					stroke="var(--pico-background-color)"
					stroke-width="1"
					onclick={(e) => {
						if (step === Step.STARS) {
							e.stopPropagation();
							toggleStar([x, y]);
						}
					}}
				/>
			{/each}
		</svg>
	</div>
	<form class="controls">
		<details name="step" bind:open={paintStepOpen}>
			<summary>1. Paint</summary>
			<fieldset>
				<label>
					Brush Size
					<input
						type="range"
						min={1}
						max={100}
						step={1}
						bind:value={brushSize.current}
						data-value={brushSize.current}
					/>
				</label>
				<label>
					Opacity
					<input
						type="range"
						min={0}
						max={1}
						step={0.01}
						bind:value={brushOpacity.current}
						data-value={brushOpacity.current}
					/>
				</label>
				<label>
					Blur
					<input
						type="range"
						min={0}
						max={2}
						step={0.1}
						bind:value={brushBlur.current}
						data-value={brushBlur.current}
					/>
				</label>
				<label>
					Mode
					<select class="bg-gray-800" bind:value={brushMode.current}>
						<option>{MODE_DRAW}</option>
						<option>{MODE_ERASE}</option>
					</select>
				</label>
				<div role="group">
					<button type="button" class="secondary" onclick={undo} disabled={strokes.length === 0}>
						Undo
					</button>
					<button
						type="button"
						class="secondary"
						onclick={redo}
						disabled={undoneStrokes.length === 0}
					>
						Redo
					</button>
				</div>
				<input type="button" class="secondary" onclick={clear} value="Clear Canvas" />
			</fieldset>
		</details>
		<hr />
		<details name="step" bind:open={starsStepOpen}>
			<summary>2. Stars</summary>
			<fieldset>
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
						data-value={clusterDiffusion.current}
					/>
				</label>
				<input type="button" onclick={generateStars} value="Generate Stars" />
				<small>Click the map to add more!</small>
			</fieldset>
		</details>
		<hr />
		<details name="step" bind:open={hyperlanesStepOpen}>
			<summary>3. Hyperlanes</summary>
			<fieldset>
				<label>
					Density
					<input
						type="range"
						min={0}
						max={1}
						step={0.01}
						bind:value={connectedness.current}
						data-value={connectedness.current}
					/>
				</label>
				<label>
					Max Distance
					<input
						type="range"
						min={0}
						max={MAX_CONNECTION_LENGTH}
						step={1}
						bind:value={maxConnectionLength.current}
						data-value={maxConnectionLength.current}
					/>
				</label>
				<fieldset>
					<label>
						Allow Disconnected
						<input type="checkbox" bind:checked={allowDisconnected.current} />
					</label>
				</fieldset>
				<input type="button" onclick={generateConnections} value="Generate Hyperlanes" />
			</fieldset>
		</details>
		<hr />
		<details name="step" bind:open={modStepOpen}>
			<summary>4. Mod</summary>
			<div>
				<a href={downloadUrl} hidden download="painted_galaxy.txt" bind:this={downloadLink}>
					Download Stellaris Map
				</a>
				<input
					type="button"
					disabled={downloadDisabled}
					onclick={() => {
						if (!downloadDisabled) downloadLink?.click();
					}}
					value="Download Map"
				/>
				{#if downloadDisabled}
					<input hidden aria-invalid="true" />
					<small>You must generate stars and hyperlanes first</small>
				{/if}
				<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3532904115" target="_blank">
					Subscribe and read instructions on the Workshop
				</a>
			</div>
		</details>
	</form>
</div>

<style>
	.container {
		display: flex;
		flex-flow: row;
	}
	.canvas {
		border: 1px solid white;
		position: relative;

		svg {
			position: absolute;
			top: 0;
			left: 0;
		}
	}
	.controls {
		padding: var(--pico-spacing);
		width: 100%;
	}
</style>
