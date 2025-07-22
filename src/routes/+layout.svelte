<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>Paint a Galaxy</title>
</svelte:head>

{@render children()}
