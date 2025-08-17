<script lang="ts">
	import { getStroke } from 'perfect-freehand';
	import { Delaunay } from 'd3-delaunay';
	import { forceManyBody, forceSimulation } from 'd3-force';
	import createGraph, { type Graph, type Link } from 'ngraph.graph';
	// @ts-expect-error -- no 1st or 3rd party type available
	import kruskal from 'ngraph.kruskal';
	import { onMount, untrack } from 'svelte';

	import { calcNumStartingStars, generateStellarisGalaxy } from '$lib/generateStellarisGalaxy';
	import { LocalStorageState } from '$lib/state.svelte';
	import { CENTER_MARK_SIZE, HEIGHT, MAX_CONNECTION_LENGTH, WIDTH } from '$lib/constants';
	import { arePointsEqual } from '$lib/utils';

	let canvas = $state<HTMLCanvasElement>();
	let ctx = $derived(canvas?.getContext('2d'));

	const Step = {
		PAINT: 'PAINT',
		STARS: 'STARS',
		HYPERLANES: 'HYPERLANES',
		WORMHOLES: 'WORMHOLES',
		SPAWNS: 'SPAWNS',
		MOD: 'MOD',
	} as const;
	type Step = (typeof Step)[keyof typeof Step];
	let paintStepOpen = $state(true);
	let starsStepOpen = $state(false);
	let hyperlanesStepOpen = $state(false);
	let wormholesStepOpen = $state(false);
	let spawnsStepOpen = $state(false);
	let modStepOpen = $state(false);
	let step = $derived.by(() => {
		if (paintStepOpen) return Step.PAINT;
		if (starsStepOpen) return Step.STARS;
		if (hyperlanesStepOpen) return Step.HYPERLANES;
		if (wormholesStepOpen) return Step.WORMHOLES;
		if (spawnsStepOpen) return Step.SPAWNS;
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
						// ctx.filter = 'grayscale(1)';
						// ctx.drawImage(img!, 0, 0, 900, 900);
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
			convertGrayscaleToOpacity();
			ctx.restore();
		}
	}

	function convertGrayscaleToOpacity() {
		if (!ctx) return;
		const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
		for (let i = 0; i < imageData.data.length; i += 4) {
			// convert grayscale to transparency
			imageData.data[i + 3] = Math.round((imageData.data[i] / 255) * imageData.data[i + 3]);
			imageData.data[i] = 255;
			imageData.data[i + 1] = 255;
			imageData.data[i + 2] = 255;
		}
		ctx.putImageData(imageData, 0, 0);
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
		const index = stars.current.findIndex((star) => arePointsEqual(star, point));
		if (index === -1) {
			stars.current.push(point);
		} else {
			stars.current.splice(index, 1);
			connections.current = connections.current.filter(
				(c) => !(arePointsEqual(c[0], point) || arePointsEqual(c[1], point)),
			);
			wormholes.current = wormholes.current.filter(
				(c) => !(arePointsEqual(c[0], point) || arePointsEqual(c[1], point)),
			);
		}
	}

	function generateStars() {
		if (!ctx) return;
		stars.current.length = 0;
		connections.current.length = 0;
		wormholes.current.length = 0;
		potentialHomeStars.current.length = 0;
		preferredHomeStars.current.length = 0;
		const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
		function getAlpha(x: number, y: number) {
			const index = y * WIDTH * 4 + x * 4 + 3;
			return imageData.data[index];
		}

		// count image and row alpha totals, to use for random weighted
		let total = 0;
		const rows: { total: number; values: number[] }[] = [];
		for (let y = 0; y < HEIGHT; y++) {
			const row = { total: 0, values: [] as number[] };
			rows.push(row);
			for (let x = 0; x < WIDTH; x++) {
				const value = getAlpha(x, y);
				total += value;
				row.total += value;
				row.values.push(value);
			}
		}

		// find a random pixel, using the alpha as weight
		for (let i = 0; i < numberOfStars.current; i++) {
			if (total === 0) {
				// we've used all pixels with nonzero alpha
				console.warn(`Generated ${i} stars; no more valid locations`);
				break;
			}
			const random = Math.floor(Math.random() * total);
			let current = 0;
			for (let y = 0; y < HEIGHT; y++) {
				const row = rows[y];
				if (current + row.total > random) {
					for (let x = 0; x < WIDTH; x++) {
						const value = row.values[x];
						if (current + value > random) {
							stars.current.push([x, y]);
							row.values[x] = 0;
							row.total -= value;
							total -= value;
							break;
						} else {
							current += value;
						}
					}
					break;
				} else {
					current += row.total;
				}
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
	let preferredHomeStars = new LocalStorageState<string[]>('preferredHomeStars', []);
	let starDelaunay = $derived(
		step === Step.HYPERLANES || step === Step.WORMHOLES || step === Step.SPAWNS
			? new Delaunay(stars.current.flat())
			: null,
	);
	let togglingHyperlaneFrom = $state<null | [number, number]>(null);

	function toggleHomeStar(star: [number, number], { preferred }: { preferred: boolean }) {
		const index = potentialHomeStars.current.findIndex((s) => s === star.toString());
		const preferredIndex = preferredHomeStars.current.findIndex((s) => s === star.toString());
		if (index === -1 && preferredIndex === -1) {
			potentialHomeStars.current.push(star.toString());
			if (preferred) preferredHomeStars.current.push(star.toString());
		} else if (index >= 0 && preferredIndex >= 0) {
			potentialHomeStars.current.splice(index, 1);
			preferredHomeStars.current.splice(preferredIndex, 1);
		} else if (index >= 0 && preferredIndex === -1) {
			if (preferred) {
				preferredHomeStars.current.push(star.toString());
			} else {
				potentialHomeStars.current.splice(index, 1);
			}
		}
	}

	function toggleHyperlane(from: [number, number], to: [number, number]) {
		const index = connections.current.findIndex(
			(c) =>
				(arePointsEqual(c[0], from) && arePointsEqual(c[1], to)) ||
				(arePointsEqual(c[1], from) && arePointsEqual(c[0], to)),
		);
		if (index === -1) {
			connections.current.push([from, to]);
		} else {
			connections.current.splice(index, 1);
		}
	}

	function generateConnections() {
		connections.current.length = 0;
		potentialHomeStars.current.length = 0;
		preferredHomeStars.current.length = 0;
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

		randomizeHomeSystems(g);

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

	function randomizeHomeSystems(
		graph: Graph<{ coords: [number, number]; d: number }, { distance: number; isMst?: boolean }>,
	) {
		// find home stars
		const numPotentialHomeStars = calcNumStartingStars(stars.current);
		const newPotentialHomeStars: [number, number][] = [];
		const startIndex = Math.floor(Math.random() * (stars.current.length - numPotentialHomeStars));
		for (let i = startIndex; i < startIndex + numPotentialHomeStars; i++) {
			if (stars.current[i]) newPotentialHomeStars.push(stars.current[i]);
		}
		// move each to the star furthest from all other stars
		// a single iteration of this seems to be good enough
		newPotentialHomeStars.forEach((star, index) => {
			// reset distance to inf
			graph.forEachNode((node) => {
				node.data.d = Infinity;
			});
			const edge: [number, number][] = [];
			// set distance of other potential homes to 0, and add them to the edge
			newPotentialHomeStars
				.filter((other) => other !== star)
				.forEach((other) => {
					const node = graph.getNode(other.toString());
					node!.data.d = 0;
					edge.push(other);
				});
			let maxDistance = 0;
			let maxDistanceStars: [number, number][] = [];
			// modified Dijkstra's to find stars furthest from other home systems
			// (simplified since all edge weights are 1)
			while (edge.length) {
				const s = edge.pop()!;
				graph.forEachLinkedNode(
					s.toString(),
					(node) => {
						// avoid dead ends; they can be unfair/unfun home systems
						const isDeadEnd = node.links == null || node.links.size <= 1;
						if (node.data.d === Infinity && !isDeadEnd) {
							node.data.d = graph.getNode(s.toString())!.data.d + 1;
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
		preferredHomeStars.current = [];
	}

	function makeGraphFromConnections() {
		const g = createGraph<
			{ coords: [number, number]; d: number },
			{ distance: number; isMst?: boolean }
		>();
		for (const star of stars.current) {
			g.addNode(`${star[0]},${star[1]}`, { coords: star, d: Infinity });
		}
		for (const [from, to] of connections.current) {
			g.addLink(`${from[0]},${from[1]}`, `${to[0]},${to[1]}`, {
				distance: Math.hypot(from[0] - to[0], from[1] - to[1]),
			});
		}
		return g;
	}

	let wormholes = new LocalStorageState<[[number, number], [number, number]][]>('wormholes', []);
	let togglingWormholeFrom = $state<null | [number, number]>(null);

	function toggleWormhole(from: [number, number], to: [number, number]) {
		const index = wormholes.current.findIndex(
			(c) =>
				(arePointsEqual(c[0], from) && arePointsEqual(c[1], to)) ||
				(arePointsEqual(c[1], from) && arePointsEqual(c[0], to)),
		);
		if (index === -1) {
			// each system can only have 1 wormhole, so remove any wormholes that share an origin or destination
			wormholes.current = wormholes.current.filter(
				(c) =>
					!(
						arePointsEqual(c[0], from) ||
						arePointsEqual(c[0], to) ||
						arePointsEqual(c[1], from) ||
						arePointsEqual(c[1], to)
					),
			);
			wormholes.current.push([from, to]);
		} else {
			wormholes.current.splice(index, 1);
		}
	}

	let galaxyName = new LocalStorageState('name', 'Painted Galaxy');
	let fileName = $derived(
		galaxyName.current
			.toLowerCase()
			.replaceAll(' ', '_')
			.replaceAll(/\/\\<>:"\|\?\*/g, ''),
	);

	// debounce mod generation
	let downloadUrl = $state('');
	$effect(() => {
		untrack(() => {
			downloadUrl = '';
		});
		if (step === Step.MOD && galaxyName.current) {
			// get the params now to trigger reactivity (untracked once we're in the timeout)
			const params: Parameters<typeof generateStellarisGalaxy> = [
				galaxyName.current,
				stars.current,
				connections.current,
				wormholes.current,
				potentialHomeStars.current,
				preferredHomeStars.current,
			];
			const timeout = setTimeout(() => {
				downloadUrl = URL.createObjectURL(
					new Blob([generateStellarisGalaxy(...params)], { type: 'text/plain' }),
				);
			}, 500);
			return () => clearTimeout(timeout);
		}
	});
	let downloadInvalid = $derived(stars.current.length === 0 || connections.current.length === 0);
	let downloadDisabled = $derived(downloadUrl.length === 0 || downloadInvalid);
	let downloadLink = $state<HTMLAnchorElement>();

	function throttle<Args extends unknown[]>(fn: (...args: Args) => void, ms: number) {
		let last = 0;
		return function (...args: Args) {
			var now = Date.now();
			if (now - last >= ms) {
				fn(...args);
				last = now;
			}
		};
	}
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
			onclick={throttle((e) => {
				if (step === Step.STARS) {
					toggleStar([e.offsetX, e.offsetY]);
				} else if (step === Step.HYPERLANES) {
					const starIndex = starDelaunay?.find(e.offsetX, e.offsetY);
					if (starIndex == null) return;
					if (togglingHyperlaneFrom) {
						if (stars.current[starIndex] !== togglingHyperlaneFrom) {
							toggleHyperlane(togglingHyperlaneFrom, stars.current[starIndex]);
						}
						togglingHyperlaneFrom = null;
					} else {
						togglingHyperlaneFrom = stars.current[starIndex];
					}
				} else if (step === Step.WORMHOLES) {
					console.log('wormhole step click');
					const starIndex = starDelaunay?.find(e.offsetX, e.offsetY);
					if (starIndex == null) return;
					if (togglingWormholeFrom) {
						if (stars.current[starIndex] !== togglingWormholeFrom) {
							toggleWormhole(togglingWormholeFrom, stars.current[starIndex]);
						}
						togglingWormholeFrom = null;
					} else {
						togglingWormholeFrom = stars.current[starIndex];
					}
				} else if (step === Step.SPAWNS) {
					const starIndex = starDelaunay?.find(e.offsetX, e.offsetY);
					if (starIndex == null) return;
					toggleHomeStar(stars.current[starIndex], { preferred: e.shiftKey });
				}
				// some users were experiencing duplicate clicks that instantly toggled on/off; add a small throttle
			}, 250)}
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
			style:cursor={step === Step.PAINT
				? 'pointer'
				: step === Step.STARS
					? 'crosshair'
					: step === Step.HYPERLANES || step === Step.WORMHOLES || step === Step.SPAWNS
						? 'pointer'
						: ''}
		>
			<path
				d={strokePath}
				fill={brushMode.current === MODE_DRAW ? '#FFFFFF' : 'var(--pico-background-color)'}
				opacity={brushOpacity.current}
			/>
			<path
				d="M {WIDTH / 2} {HEIGHT / 2 - CENTER_MARK_SIZE}
				   L {WIDTH / 2} {HEIGHT / 2 + CENTER_MARK_SIZE}
				   M {WIDTH / 2 - CENTER_MARK_SIZE} {HEIGHT / 2}
				   L {WIDTH / 2 + CENTER_MARK_SIZE} {HEIGHT / 2}"
				fill="none"
				stroke="#FFF"
				stroke-width="1"
				stroke-opacity="0.9"
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
			{#each wormholes.current as [from, to] (`${[from, to]}`)}
				<line
					x1={from[0]}
					y1={from[1]}
					x2={to[0]}
					y2={to[1]}
					stroke="#FF00FF"
					stroke-opacity="1"
					stroke-width="1"
					stroke-dasharray="3"
				/>
			{/each}
			{#each stars.current as [x, y] (`${[x, y]}`)}
				{#if step === Step.SPAWNS && preferredHomeStars.current.includes([x, y].toString())}
					<circle cx={x} cy={y} r="5" fill="none" stroke="var(--pico-primary)" stroke-width="2" />
				{/if}
				<circle
					cx={x}
					cy={y}
					r={(togglingHyperlaneFrom && arePointsEqual([x, y], togglingHyperlaneFrom)) ||
					(togglingWormholeFrom && arePointsEqual([x, y], togglingWormholeFrom))
						? '3.5'
						: step === Step.SPAWNS && potentialHomeStars.current.includes([x, y].toString())
							? '3.5'
							: '2.5'}
					fill={(togglingHyperlaneFrom && arePointsEqual([x, y], togglingHyperlaneFrom)) ||
					(togglingWormholeFrom && arePointsEqual([x, y], togglingWormholeFrom))
						? 'var(--pico-primary)'
						: step === Step.SPAWNS && potentialHomeStars.current.includes([x, y].toString())
							? 'var(--pico-primary)'
							: '#FFFFFF'}
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
			<summary>
				<small>1.</small>
				Paint
			</summary>
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
				<hr />
				<label>
					...or upload an image
					<input
						type="file"
						accept=".png,.jpg,.jpeg,.webp"
						oninput={async (e) => {
							const input = e.currentTarget;
							const file = input.files?.item(0);
							if (ctx && file) {
								ctx.filter = 'grayscale(1)';
								ctx.drawImage(await createImageBitmap(file), 0, 0, 900, 900);
								convertGrayscaleToOpacity();
								saveCanvas();
								canvas?.toBlob(async (blob) => {
									if (blob) {
										initialBitmap = await createImageBitmap(blob);
										strokes = [];
										undoneStrokes = [];
										imageDataStack = [];
										imageDataUndoStack = [];
									}
								});
							}
						}}
					/>
				</label>
			</fieldset>
		</details>
		<hr />
		<details name="step" bind:open={starsStepOpen}>
			<summary>
				<small>2.</small>
				Stars
			</summary>
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
				<small>Click the map to add and remove stars</small>
			</fieldset>
		</details>
		<hr />
		<details
			name="step"
			bind:open={
				() => hyperlanesStepOpen,
				(value) => {
					hyperlanesStepOpen = value;
					if (!value) {
						togglingHyperlaneFrom = null;
					}
				}
			}
		>
			<summary>
				<small>3.</small>
				Hyperlanes
			</summary>
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
				<small>Click one star then another to customize hyperlanes</small>
			</fieldset>
		</details>
		<hr />
		<details
			name="step"
			bind:open={
				() => wormholesStepOpen,
				(value) => {
					wormholesStepOpen = value;
					if (!value) {
						togglingWormholeFrom = null;
					}
				}
			}
		>
			<summary>
				<small>4.</small>
				Wormholes
				<small>(Optional)</small>
			</summary>
			<fieldset>
				<small>
					Click one star then another to customize wormholes. Random wormholes will still spawn
					according to your galaxy settings.
				</small>
			</fieldset>
		</details>
		<hr />
		<details name="step" bind:open={spawnsStepOpen}>
			<summary>
				<small>5.</small>
				Spawns
				<small>(optional)</small>
			</summary>
			<fieldset>
				<input
					type="button"
					value="Randomize"
					onclick={() => randomizeHomeSystems(makeGraphFromConnections())}
				/>
				<small>
					Click the map to customize spawn systems. Shift+click to make it a <span
						data-tooltip="These are used first, before normal spawns"
					>
						preferred spawn.
					</span>
					In a single-player game with only one preferred spawn, the player will always spawn there.
				</small>
				<small></small>
			</fieldset>
		</details>
		<hr />
		<details name="step" bind:open={modStepOpen}>
			<summary>
				<small>6.</small>
				Mod
			</summary>
			<fieldset>
				<label>
					Name <input bind:value={galaxyName.current} />
				</label>
				<a href={downloadUrl} hidden download="{fileName}.txt" bind:this={downloadLink}>
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
				{#if downloadInvalid}
					<input hidden aria-invalid="true" />
					<small>You must generate stars and hyperlanes first</small>
				{/if}
				<a href="https://steamcommunity.com/sharedfiles/filedetails/?id=3532904115" target="_blank">
					Subscribe and read instructions on the Workshop
				</a>
			</fieldset>
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
		align-self: start;

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
