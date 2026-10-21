<script lang="ts">
import { MediaQuery } from "svelte/reactivity";
import { goto } from "$app/navigation";
import AdminNav from "$lib/components/admin/AdminNav.svelte";
import { webBase } from "$lib/paths.js";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();
const desktop = new MediaQuery("min-width: 64rem");

$effect(() => {
  if (desktop.current)
    void goto(`${webBase}/settings/account`, { replaceState: true });
});
</script>

<svelte:head>
  <title>Settings · Thalia</title>
</svelte:head>

{#if !desktop.current}
  <div class="mx-auto w-full max-w-3xl">
    <h1 class="mb-6 pt-4 pr-14 text-large-title">Settings</h1>
    <AdminNav variant="list" admin={data.me.admin} />
  </div>
{/if}
