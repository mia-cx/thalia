<script lang="ts">
import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import { groupSummary } from "$lib/access.ts";
import { client } from "$lib/api.ts";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Badge } from "$lib/components/ui/badge/index.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import { Input } from "$lib/components/ui/input/index.ts";
import { readFailure } from "$lib/errors.ts";
import { webBase } from "$lib/paths.js";
import { resource } from "$lib/resource.svelte.ts";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();
const adminLocked = $derived(!data.me.admin);

const list = resource(() => client.groups.list());
const denied = $derived(
  list.failure?.code === "FORBIDDEN" || list.failure?.code === "UNAUTHORIZED",
);

type FailureShape = ReturnType<typeof readFailure>;

let addName = $state("");
let addBusy = $state(false);
let addFailure = $state<FailureShape | undefined>(undefined);

async function addGroup(event: SubmitEvent) {
  event.preventDefault();
  addBusy = true;
  addFailure = undefined;
  const name = addName;
  try {
    const created = await client.groups.create({ name });
    if (addName === name) addName = "";
    toast.success(`${created.name} created`);
    await goto(`${webBase}/admin/groups/${created.id}`);
  } catch (error) {
    addFailure = readFailure(error);
  } finally {
    addBusy = false;
  }
}
</script>

<AdminPage title="Groups">
  <FormGroup
    loading={list.data === undefined && !list.failure ? 3 : undefined}
    failure={list.failure ?? undefined}
    description="Admins and users are built in. Admins can do everything, and every new account joins users.{adminLocked
      ? ' Only an admin can change groups.'
      : ''}"
  >
    {#each list.data ?? [] as row (row.id)}
      <ListRow
        title={row.name}
        caption={groupSummary(row)}
        href="{webBase}/admin/groups/{row.id}"
      >
        {#if row.builtIn}
          <Badge variant="outline">Built in</Badge>
        {/if}
      </ListRow>
    {/each}
    {#snippet actions()}
      {#if list.failure}
        <Button
          variant="secondary"
          onclick={() => list.reload()}
          disabled={list.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  {#if !denied}
    <FormGroup
      title="New group"
      onsubmit={addGroup}
      failure={addFailure}
    >
      <FormRow label="Name" for="addName">
        <Input
          id="addName"
          name="name"
          required
          bind:value={addName}
          disabled={adminLocked}
        />
      </FormRow>
      {#snippet actions()}
        <Button type="submit" disabled={addBusy || adminLocked}
          >Create group</Button
        >
      {/snippet}
    </FormGroup>
  {/if}
</AdminPage>
