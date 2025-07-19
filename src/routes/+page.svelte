<script lang="ts">
	// @ts-expect-error -- no 1st or 3rd party types available
	import Atrament from 'atrament';
	import { Delaunay } from 'd3-delaunay';
	import createGraph, { type Link } from 'ngraph.graph';
	// @ts-expect-error -- no 1st or 3rd party type available
	import kruskal from 'ngraph.kruskal';
	import { untrack } from 'svelte';

	const WIDTH = 500;
	const HEIGHT = 500;
	const NUM_STARS_ATTEMPTS = 10_000;
	let canvas = $state<HTMLCanvasElement>();
	let ctx = $derived(canvas?.getContext('2d'));

	let brushSize = $state(5);
	let brushBlur = $state(2);
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

	let stars = $state<[number, number][]>([]);
	function generateStars() {
		if (!ctx) return;
		stars.length = 0;
		connections.length = 0;
		const imageData = ctx.getImageData(0, 0, WIDTH, HEIGHT);
		function getAlpha(x: number, y: number) {
			const index = y * WIDTH * 4 + x * 4 + 3;
			return imageData.data[index];
		}
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- we're not using this for reactivity, just temporary optimization
		const added = new Set<string>();
		for (let i = 0; i < NUM_STARS_ATTEMPTS; i++) {
			const x = Math.floor(Math.random() * WIDTH);
			const y = Math.floor(Math.random() * HEIGHT);
			if (!added.has(`${x},${y}`) && Math.random() < (getAlpha(x, y) / 255) ** 2) {
				added.add(`${x},${y}`);
				stars.push([x, y]);
			}
		}
	}

	let connectedness = $state(0.8);
	let maxConnectionLength = $state(50);
	let allowDisconnected = $state(false);
	let connections = $state<[[number, number], [number, number]][]>([]);
	function generateConnections() {
		connections.length = 0;
		if (stars.length < 3) return;
		const g = createGraph<[number, number], { distance: number; isMst?: boolean }>();
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
				if (!g.hasNode(id1)) g.addNode(id1, [this.x, this.y]);
				if (!g.hasNode(id2)) g.addNode(id2, [x, y]);
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

		// add connections to state
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not using for state
		const added = new Set<string>();
		g.forEachLink((link) => {
			const key = [link.toId, link.fromId].sort().toString();
			if (added.has(key)) return;
			added.add(key);
			connections.push([g.getNode(link.fromId)!.data, g.getNode(link.toId)!.data]);
		});
	}

	const BUTTON_CLASS = 'cursor-pointer bg-gray-700 p-2 hover:bg-gray-600';
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
			<circle cx={x} cy={y} r="1" fill="#FFFFFF" />
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
		<button type="button" class={BUTTON_CLASS} onclick={generateStars}>Generate Stars</button>
		<label>
			Connectedness
			<input type="range" min={0} max={1} step={0.01} bind:value={connectedness} />
		</label>
		<label>
			Max Connection Length
			<input type="range" min={0} max={WIDTH} step={1} bind:value={maxConnectionLength} />
		</label>
		<label>
			Allow Disconnected
			<input type="checkbox" bind:checked={allowDisconnected} />
		</label>
		<button type="button" class={BUTTON_CLASS} onclick={generateConnections}>
			Generate Connections
		</button>
	</form>
</div>
