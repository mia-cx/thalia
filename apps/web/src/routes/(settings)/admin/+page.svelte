<script lang="ts">
import { MediaQuery } from "svelte/reactivity";
import { goto } from "$app/navigation";
import { webBase } from "$lib/paths.js";
import Overview from "./Overview.svelte";

const desktop = new MediaQuery("min-width: 64rem");

// The phone list lives at /settings; /admin only serves the desktop Overview.
$effect(() => {
  if (!desktop.current)
    void goto(`${webBase}/settings`, { replaceState: true });
});
</script>

<svelte:head>
  <title>Settings · Thalia</title>
</svelte:head>

{#if desktop.current}
  <Overview />
{/if}
