<script lang="ts">
import { page } from "$app/state";
import type { PageProps } from "./$types";
import GroupEditor from "./GroupEditor.svelte";

const { data }: PageProps = $props();
</script>

{#key page.params.id}
  <GroupEditor id={page.params.id ?? ""} admin={data.me.admin} />
{/key}
